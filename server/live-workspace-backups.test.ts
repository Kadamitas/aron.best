import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';
import { createController, readControllerConfiguration } from './controller.js';
import { createApp, readConfiguration } from './app.js';
import { createBackupArchive, downloadBackup } from './backup-archive.js';
import { WorkspaceActivity } from './workspace-activity.js';
import { inviteCookie } from './invite-session.js';
import type { InstalledServer, ServerTarget } from './loader-installation.js';

const token = 'live-workspace-backup-fixture-'.repeat(3);
const authorization = { authorization: `Bearer ${token}` };
const target: ServerTarget = { minecraftVersion: '26.3', loader: 'Fabric', loaderVersion: '0.19.5' };
const manifest = { minecraft: { version: '26.3', modLoaders: [{ id: 'fabric-0.19.5', primary: true }] }, manifestType: 'minecraftModpack', manifestVersion: 1, name: 'Test pack', version: '1.0.0', files: [], overrides: 'overrides' };
const runningProcess = `process.stdout.write('Done (0.01s)!\\n'); process.stdin.on('data', input => { if (input.toString().includes('stop')) process.exit(0); });`;

async function installed(directory: string, requested = target): Promise<InstalledServer> {
  const result: InstalledServer = { ...requested, javaMajor: 25, launchArgs: ['-jar', 'fabric-server-launch.jar'], installedAt: new Date().toISOString() };
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'fabric-server-launch.jar'), 'fixture');
  await writeFile(path.join(directory, 'installation.json'), JSON.stringify(result));
  return result;
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'aron-live-workspace-'));
  const directory = path.join(root, 'minecraft');
  await installed(directory);
  for (const folder of ['config', 'mods', 'world', 'defaultconfigs', 'kubejs', 'scripts', 'datapacks', 'resourcepacks', 'shaderpacks']) await mkdir(path.join(directory, folder));
  await writeFile(path.join(directory, 'mods', 'original.jar'), 'original-mod');
  await writeFile(path.join(directory, 'config', 'original.json'), '{}');
  await writeFile(path.join(directory, 'world', 'level.dat'), 'original-world');
  await writeFile(path.join(directory, 'eula.txt'), 'eula=true\n');
  await writeFile(path.join(directory, 'server.properties'), 'online-mode=true\nserver-ip=127.0.0.1\nserver-port=25566\n');
  await writeFile(path.join(root, '.env'), 'private-host-secret');
  const create = () => createController(readControllerConfiguration({ CONTROLLER_TOKEN: token, RUNTIME_DIRECTORY: root, MINECRAFT_GATEWAY: 'false' }), {
    isolated: true,
    minecraft: { launch: (_command, _args, options) => spawn(process.execPath, ['-e', runningProcess], { ...options, shell: false, stdio: 'pipe' }) },
    installationFactory: destination => ({
      catalog: async () => ({ versions: [target.minecraftVersion], minecraftVersion: target.minecraftVersion, loaders: [{ loader: target.loader, loaderVersion: target.loaderVersion }] }),
      install: requested => installed(destination, requested),
    }),
  });
  let app = await create();
  return { root, directory, get app() { return app; }, restart: async () => { await app.close(); app = await create(); }, dispose: async () => { await app.close(); await rm(root, { recursive: true, force: true }); } };
}

test('running servers accept only new mod uploads and pack downloads without allowing other live writes', async () => {
  const setup = await fixture();
  const request = (url: string, payload: unknown, method: 'POST' | 'PUT' = 'POST') => setup.app.inject({ method, url, headers: authorization, payload });
  const status = async () => (await setup.app.inject({ url: '/status', headers: authorization })).json();
  try {
    assert.equal((await status()).workspace.updatedAt, null);
    const staleConfig = (await request('/workspace/uploads', { path: 'config/new.json', size: 2, replace: false, address: 'friend' })).json();
    assert.equal((await request(`/workspace/uploads/${staleConfig.id}/chunks`, { index: 0, data: Buffer.from('{}').toString('base64'), address: 'friend' })).statusCode, 200);
    const staleReplacement = (await request('/workspace/uploads', { path: 'mods/original.jar', size: 1, replace: true, address: 'friend' })).json();
    assert.equal((await request(`/workspace/uploads/${staleReplacement.id}/chunks`, { index: 0, data: 'eA==', address: 'friend' })).statusCode, 200);
    assert.equal((await request('/action', { action: 'start' })).statusCode, 200);
    for (const id of [staleConfig.id, staleReplacement.id]) assert.equal((await request(`/workspace/uploads/${id}/complete`, { address: 'friend' })).statusCode, 409);
    assert.equal((await request(`/workspace/uploads/${staleConfig.id}/chunks`, { index: 1, data: 'eA==', address: 'friend' })).statusCode, 409);
    for (const id of [staleConfig.id, staleReplacement.id]) await setup.app.inject({ method: 'DELETE', url: `/workspace/uploads/${id}`, headers: authorization, payload: { address: 'friend' } });
    for (const [destination, replace] of [['config/new.json', false], ['mods/original.jar', true], ['mods/original.jar', false], ['mods/nested/new.jar', false], ['mods/a.jar.disabled', false], ['mods/new.jar', true]] as const) {
      assert.equal((await request('/workspace/uploads', { path: destination, replace, size: 1, address: 'friend' })).statusCode, 409);
    }
    const upload = await request('/workspace/uploads', { path: 'mods/new.jar', size: 7, replace: false, address: 'friend' });
    assert.equal(upload.statusCode, 200, upload.body);
    assert.equal((await status()).workspace.updatedAt, null);
    const id = upload.json().id;
    assert.equal((await request(`/workspace/uploads/${id}/chunks`, { index: 0, data: Buffer.from('new-mod').toString('base64'), address: 'friend' })).statusCode, 200);
    assert.equal((await status()).workspace.updatedAt, null);
    assert.equal((await request(`/workspace/uploads/${id}/complete`, { address: 'friend' })).statusCode, 200);
    const changed = (await status()).workspace.updatedAt;
    assert.equal(new Date(changed).toISOString(), changed);
    assert.equal(await readFile(path.join(setup.directory, 'mods', 'new.jar'), 'utf8'), 'new-mod');
    assert.equal(await readFile(path.join(setup.directory, 'mods', 'original.jar'), 'utf8'), 'original-mod');
    assert.equal((await request('/workspace/mods/action', { path: 'mods/original.jar', action: 'disable' })).statusCode, 409);
    assert.equal((await request('/workspace/text', { path: 'config/new.json', contents: '{}', revision: 'new' }, 'PUT')).statusCode, 409);
    const archive = await request('/workspace/archive', { manifest });
    assert.equal(archive.statusCode, 200, archive.body);
    assert(archive.rawPayload.includes(Buffer.from('overrides/mods/new.jar')));
    assert(!archive.rawPayload.includes(Buffer.from('private-host-secret')));
    assert(!archive.rawPayload.includes(Buffer.from('original-world')));
    const final = await status();
    assert.equal(final.server.state, 'running');
    assert.equal(final.workspace.updatedAt, changed);
    const metadata = new WorkspaceActivity(setup.root);
    await metadata.initialize();
    assert.equal(metadata.updatedAt, changed);
  } finally { await setup.dispose(); }
});

test('workspace change timestamps cover file and mod mutations, remain independent by slot and survive restart', async () => {
  const setup = await fixture();
  let activeId = (await setup.app.inject({ url: '/status', headers: authorization })).json().profiles.activeId as string;
  let workspaceId = activeId;
  const originalId = activeId;
  const headers = () => ({ ...authorization, 'x-server-profile': activeId, 'x-workspace-profile': workspaceId });
  const status = async () => (await setup.app.inject({ url: '/status', headers: headers() })).json();
  const mutation = async (url: string, payload: unknown, method: 'POST' | 'PUT' = 'POST') => {
    const before = (await status()).workspace.updatedAt;
    await delay(3);
    const response = await setup.app.inject({ method, url, headers: headers(), payload });
    assert.equal(response.statusCode, 200, `${url}: ${response.body}`);
    const after = (await status()).workspace.updatedAt;
    assert.equal(new Date(after).toISOString(), after);
    if (before !== null) assert(Date.parse(after) > Date.parse(before), `${url} did not update its timestamp`);
    return response.json();
  };
  try {
    const created = await mutation('/workspace/text', { path: 'config/new.txt', contents: 'created', revision: 'new' }, 'PUT');
    await mutation('/workspace/text', { path: created.path, contents: 'edited', revision: created.revision }, 'PUT');
    const editedAt = (await status()).workspace.updatedAt;
    assert.equal((await setup.app.inject({ method: 'PUT', url: '/workspace/text', headers: headers(), payload: { path: created.path, contents: 'stale', revision: created.revision } })).statusCode, 409);
    assert.equal((await setup.app.inject({ method: 'PUT', url: '/workspace/text', headers: headers(), payload: { path: 'server.properties', contents: 'unsafe', revision: 'new' } })).statusCode, 400);
    assert.equal((await status()).workspace.updatedAt, editedAt);
    await mutation('/workspace/directories', { path: 'config/folder' });
    await mutation('/workspace/entries/move', { path: 'config/new.txt', destination: 'config/renamed.txt' });
    await mutation('/workspace/entries/move', { path: 'config/renamed.txt', destination: 'config/folder/renamed.txt' });
    await mutation('/workspace/entries/move', { path: 'config/folder', destination: 'config/renamed-folder' });
    await mutation('/workspace/directories', { path: 'config/parent' });
    await mutation('/workspace/entries/move', { path: 'config/renamed-folder', destination: 'config/parent/moved-folder' });
    await mutation('/workspace/entries/remove', { path: 'config/parent/moved-folder/renamed.txt' });
    await mutation('/workspace/entries/remove', { path: 'config/parent/moved-folder' });
    await mutation('/workspace/mods/action', { path: 'mods/original.jar', action: 'disable' });
    await mutation('/workspace/mods/action', { path: 'mods/original.jar.disabled', action: 'enable' });
    await mutation('/workspace/mods/action', { path: 'mods/original.jar', action: 'uninstall' });
    const originalStamp = (await status()).workspace.updatedAt;
    assert.equal((await setup.app.inject({ method: 'POST', url: '/action', headers: headers(), payload: { action: 'start' } })).statusCode, 200);
    assert.equal((await setup.app.inject({ method: 'POST', url: '/workspace/directories', headers: headers(), payload: { path: 'config/denied-live-folder' } })).statusCode, 409);
    assert.equal((await status()).workspace.updatedAt, originalStamp);
    assert.equal((await setup.app.inject({ method: 'POST', url: '/action', headers: headers(), payload: { action: 'stop' } })).statusCode, 200);
    assert.equal((await status()).workspace.updatedAt, originalStamp);
    const next = await setup.app.inject({ method: 'POST', url: '/profiles', headers: headers(), payload: { name: 'Other workspace' } });
    assert.equal(next.statusCode, 202, next.body);
    let current = await status();
    for (let attempt = 0; current.server.busy && attempt < 100; attempt++) { await delay(25); current = await status(); }
    assert.equal(current.server.busy, false);
    assert.equal(current.server.profileError, undefined);
    activeId = current.profiles.activeId;
    assert.notEqual(activeId, originalId);
    assert.equal((await status()).workspace.updatedAt, originalStamp);
    workspaceId = activeId;
    const secondInitial = (await status()).workspace.updatedAt;
    assert.equal(new Date(secondInitial).toISOString(), secondInitial);
    workspaceId = originalId;
    await mutation('/workspace/text', { path: 'config/slot-one.txt', contents: 'first slot', revision: 'new' }, 'PUT');
    const originalFinal = (await status()).workspace.updatedAt;
    workspaceId = activeId;
    assert.equal((await status()).workspace.updatedAt, secondInitial);
    await mutation('/workspace/text', { path: 'config/slot-two.txt', contents: 'second slot', revision: 'new' }, 'PUT');
    const secondFinal = (await status()).workspace.updatedAt;
    workspaceId = originalId;
    assert.equal((await status()).workspace.updatedAt, originalFinal);
    await setup.restart();
    assert.equal((await status()).workspace.updatedAt, originalFinal);
    workspaceId = activeId;
    assert.equal((await status()).workspace.updatedAt, secondFinal);
  } finally { await setup.dispose(); }
});

test('saved backup downloads stay bound to their original server after an active-profile switch', { skip: process.platform !== 'linux' }, async () => {
  const setup = await fixture();
  const appRoot = await mkdtemp(path.join(tmpdir(), 'aron-backup-web-'));
  let web: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    await writeFile(path.join(setup.directory, 'defaultconfigs', 'settings.toml'), 'enabled=true');
    await writeFile(path.join(setup.directory, 'kubejs', 'startup.js'), 'const value = 1;');
    await setup.app.listen({ host: '127.0.0.1', port: 0 });
    const address = setup.app.server.address();
    assert(address && typeof address !== 'string');
    const secret = 'backup-invitation-'.repeat(4);
    web = await createApp(readConfiguration({ NODE_ENV: 'test', RUNTIME_DIRECTORY: appRoot, CONTROLLER_URL: `http://127.0.0.1:${address.port}`, CONTROLLER_TOKEN: token, FRIEND_ACCESS_TOKEN: secret, IP_GRANTS: 'false', PUBLIC_ORIGIN: 'http://localhost:3300' }));
    const cookie = inviteCookie(secret, false).split(';')[0]!;
    const headers = { host: 'localhost:3300', origin: 'http://localhost:3300', cookie };
    const originalId = (await setup.app.inject({ url: '/status', headers: authorization })).json().profiles.activeId;
    for (const url of ['/api/server/backups', `/api/server/backups/${randomUUID()}`, `/api/server/backups/${randomUUID()}/download`]) {
      const response = await web.inject({ url, method: url === '/api/server/backups' ? 'POST' : 'GET', headers: { host: 'localhost:3300', origin: headers.origin }, ...(url === '/api/server/backups' ? { payload: {} } : {}) });
      assert.equal(response.statusCode, 401);
    }
    assert.equal((await setup.app.inject({ method: 'POST', url: '/action', headers: authorization, payload: { action: 'start' } })).statusCode, 200);
    const creation = await web.inject({ method: 'POST', url: '/api/server/backups', headers: { ...headers, 'x-server-profile': originalId }, payload: {} });
    assert.equal(creation.statusCode, 202, creation.body);
    const job = creation.json();
    assert.equal(job.profileId, originalId);
    let current = (await setup.app.inject({ url: `/backups/${job.id}`, headers: authorization })).json();
    for (let attempt = 0; current.state === 'running' && attempt < 200; attempt++) {
      await delay(25);
      current = (await setup.app.inject({ url: `/backups/${job.id}`, headers: authorization })).json();
    }
    assert.equal(current.state, 'ready', JSON.stringify(current));
    assert.match(current.filename, /\.tar\.gz$/);
    const afterBackup = (await setup.app.inject({ url: '/status', headers: authorization })).json();
    assert.equal(afterBackup.server.state, 'running');
    assert.equal(afterBackup.workspace.updatedAt, null);
    const next = await setup.app.inject({ method: 'POST', url: '/profiles', headers: { ...authorization, 'x-server-profile': originalId }, payload: { name: 'Second server' } });
    assert.equal(next.statusCode, 202, next.body);
    let state = (await setup.app.inject({ url: '/status', headers: authorization })).json();
    for (let attempt = 0; state.server.busy && attempt < 200; attempt++) { await delay(25); state = (await setup.app.inject({ url: '/status', headers: authorization })).json(); }
    assert.notEqual(state.profiles.activeId, originalId);
    const ready = await web.inject({ url: `/api/server/backups/${job.id}`, headers: { ...headers, 'x-server-profile': state.profiles.activeId } });
    assert.equal(ready.statusCode, 200, ready.body);
    assert.equal(ready.json().profileId, originalId);
    const download = await web.inject({ url: `/api/server/backups/${job.id}/download`, headers });
    assert.equal(download.statusCode, 200, download.body);
    assert.match(String(download.headers['content-type']), /application\/gzip/);
    const tar = gunzipSync(download.rawPayload);
    for (const included of ['world/level.dat', 'original-world', 'mods/original.jar', 'defaultconfigs/settings.toml', 'kubejs/startup.js', 'installation.json']) assert(tar.includes(Buffer.from(included)), included);
    assert(!tar.includes(Buffer.from('private-host-secret')));
    assert.equal((await readdir(path.join(setup.root, 'backups'))).filter(name => name.endsWith('.tar.gz')).length, 1);
  } finally { await web?.close(); await setup.dispose(); await rm(appRoot, { recursive: true, force: true }); }
});

test('failed backup jobs settle to an error, preserve the running server and reject a download', async () => {
  const setup = await fixture();
  try {
    await symlink(path.join(setup.root, '.env'), path.join(setup.directory, 'mods', 'unsafe.jar'));
    assert.equal((await setup.app.inject({ method: 'POST', url: '/action', headers: authorization, payload: { action: 'start' } })).statusCode, 200);
    const creation = await setup.app.inject({ method: 'POST', url: '/backups', headers: authorization, payload: {} });
    assert.equal(creation.statusCode, 202, creation.body);
    const id = creation.json().id;
    let current = (await setup.app.inject({ url: `/backups/${id}`, headers: authorization })).json();
    for (let attempt = 0; current.state === 'running' && attempt < 200; attempt++) {
      await delay(25);
      current = (await setup.app.inject({ url: `/backups/${id}`, headers: authorization })).json();
    }
    assert.equal(current.state, 'failed', JSON.stringify(current));
    assert.match(current.error, /could not be prepared/);
    assert.equal(current.filename, undefined);
    assert.equal((await setup.app.inject({ url: `/backups/${id}/download`, headers: authorization })).statusCode, 409);
    const final = (await setup.app.inject({ url: '/status', headers: authorization })).json();
    assert.equal(final.server.state, 'running');
    assert.equal(final.server.busy, false);
    assert.equal(final.workspace.updatedAt, null);
    assert.equal(await readFile(path.join(setup.root, '.env'), 'utf8'), 'private-host-secret');
  } finally { await setup.dispose(); }
});

test('backup archiving rejects symlinks and hard links and validates the saved artifact', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'aron-backup-archive-'));
  try {
    const outside = path.join(root, 'private.txt');
    await writeFile(outside, 'do not download');
    for (const kind of ['symbolic', 'hard'] as const) {
      const snapshot = path.join(root, kind);
      await mkdir(snapshot);
      if (kind === 'symbolic') await symlink(outside, path.join(snapshot, 'linked.txt'));
      else await link(outside, path.join(snapshot, 'linked.txt'));
      await assert.rejects(createBackupArchive(snapshot), /linked|unsupported/);
    }
    const snapshot = path.join(root, 'safe');
    await mkdir(snapshot);
    const longName = `${'config-name-'.repeat(14)}.json`;
    await writeFile(path.join(snapshot, longName), 'long-path-data');
    const archive = await createBackupArchive(snapshot);
    const { stream } = await downloadBackup(archive);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const tar = gunzipSync(Buffer.concat(chunks));
    assert(tar.includes(Buffer.from(`path=${longName}\n`)));
    assert(tar.includes(Buffer.from('long-path-data')));
    await writeFile(archive.path, 'replaced');
    await assert.rejects(downloadBackup(archive), /changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
