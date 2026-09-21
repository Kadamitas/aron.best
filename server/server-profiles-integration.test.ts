import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createController, readControllerConfiguration } from './controller.js';
import { createApp, readConfiguration } from './app.js';
import { ControllerClient } from './controller-client.js';
import { ServerProfiles } from './server-profiles.js';
import type { InstalledServer, ServerTarget } from './loader-installation.js';

const token = 'saved-server-controller-fixture-'.repeat(3);
const authorization = { authorization: `Bearer ${token}` };
const target: ServerTarget = { minecraftVersion: '26.3', loader: 'Fabric', loaderVersion: '0.19.5' };
const originalContents = '{"server":"original"}';
const runningProcess = `process.stdout.write('Done (0.01s)!\\n'); process.stdin.on('data', input => { if (input.toString().includes('stop')) process.exit(0); });`;

async function writeInstalled(directory: string, requested = target): Promise<InstalledServer> {
  const launcher = requested.loader === 'Forge' ? `forge-${requested.minecraftVersion}-${requested.loaderVersion}-universal.jar` : 'fabric-server-launch.jar';
  const installed: InstalledServer = { ...requested, javaMajor: requested.loader === 'Forge' ? 8 : 25, launchArgs: ['-jar', launcher], installedAt: new Date().toISOString() };
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, launcher), 'Synthetic launcher, never executed.');
  await writeFile(path.join(directory, 'installation.json.tmp'), JSON.stringify(installed));
  await rename(path.join(directory, 'installation.json.tmp'), path.join(directory, 'installation.json'));
  return installed;
}

async function fixture(beforeProvision?: () => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'aron-saved-servers-'));
  const directory = path.join(root, 'minecraft');
  await writeInstalled(directory);
  for (const folder of ['config', 'mods', 'world']) await mkdir(path.join(directory, folder));
  await mkdir(path.join(root, 'backups'));
  await writeFile(path.join(directory, 'config', 'identity.json'), originalContents);
  await writeFile(path.join(directory, 'mods', 'original.jar'), 'original-mod');
  await writeFile(path.join(directory, 'world', 'level.dat'), 'original-world');
  await writeFile(path.join(root, 'backups', 'original.txt'), 'original-backup');
  await writeFile(path.join(root, 'untouched.txt'), 'runtime-root-file');
  await writeFile(path.join(directory, 'eula.txt'), 'eula=true\n');
  await writeFile(path.join(directory, 'server.properties'), 'online-mode=true\nserver-ip=127.0.0.1\nserver-port=25566\n');
  const configuration = readControllerConfiguration({ CONTROLLER_TOKEN: token, RUNTIME_DIRECTORY: root, MINECRAFT_GATEWAY: 'false' });
  const children: ChildProcessWithoutNullStreams[] = [];
  const provisions: string[] = [];
  const dependencies = {
    isolated: true,
    minecraft: { launch: (_command: string, _args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => {
      const child = spawn(process.execPath, ['-e', runningProcess], { ...options, shell: false, stdio: 'pipe' });
      children.push(child);
      return child;
    } },
    installationFactory: (destination: string) => ({
      catalog: async () => ({ versions: [target.minecraftVersion], minecraftVersion: target.minecraftVersion, loaders: [{ loader: target.loader, loaderVersion: target.loaderVersion }] }),
      install: async (requested: ServerTarget) => { provisions.push(destination); await beforeProvision?.(); return writeInstalled(destination, requested); },
    }),
  };
  let app = await createController(configuration, dependencies);
  return {
    root, directory, children, provisions,
    get app() { return app; },
    restartController: async () => { await app.close(); app = await createController(configuration, dependencies); },
    dispose: async () => { await app.close(); await rm(root, { recursive: true, force: true }); },
  };
}

type Controller = Awaited<ReturnType<typeof createController>>;
const headers = (id: string) => ({ ...authorization, 'x-server-profile': id });
const status = async (app: Controller) => {
  const response = await app.inject({ url: '/status', headers: authorization });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
};

async function change(app: Controller, url: string, payload: unknown, id: string) {
  const response = await app.inject({ method: 'POST', url, headers: headers(id), payload });
  assert.equal(response.statusCode, 202, response.body);
  let current = await status(app);
  for (let attempt = 0; attempt < 100 && current.server.busy; attempt++) { await delay(25); current = await status(app); }
  assert.equal(current.server.busy, false, 'Saved-server operation did not finish within the bounded polling window.');
  assert.equal(current.server.profileError, undefined);
  assert.equal(current.server.state, 'stopped');
  return current;
}

test('saved servers enforce five slots and support renaming without changing the active server', async () => {
  const setup = await fixture();
  try {
    let current = await status(setup.app);
    assert.equal(current.profiles.limit, 5);
    assert.equal(current.profiles.profiles.length, 1);
    const original = current.profiles.activeId;
    const ids = [original];
    for (let index = 1; index < 5; index++) {
      current = await change(setup.app, '/profiles', { name: `Saved server ${index}` }, current.profiles.activeId);
      assert.equal(current.profiles.profiles.length, index + 1);
      assert(!ids.includes(current.profiles.activeId));
      ids.push(current.profiles.activeId);
      const selected = current.profiles.profiles.find((profile: { id: string }) => profile.id === current.profiles.activeId);
      assert.equal(selected.name, `Saved server ${index}`);
      assert.equal(selected.minecraftVersion, target.minecraftVersion);
      assert.equal(selected.loader, target.loader);
      assert.equal(selected.loaderVersion, target.loaderVersion);
    }
    const active = current.profiles.activeId;
    const overflow = await setup.app.inject({ method: 'POST', url: '/profiles', headers: headers(active), payload: { name: 'Sixth server' } });
    assert([400, 409].includes(overflow.statusCode), overflow.body);
    assert.equal((await status(setup.app)).profiles.profiles.length, 5);
    assert.equal(setup.provisions.length, 4);
    const renamed = await setup.app.inject({ method: 'POST', url: '/profiles/rename', headers: headers(active), payload: { id: original, name: 'Original world' } });
    assert.equal(renamed.statusCode, 200, renamed.body);
    const final = await status(setup.app);
    assert.equal(final.profiles.activeId, active);
    assert.equal(final.profiles.profiles.find((profile: { id: string }) => profile.id === original).name, 'Original world');
    assert.equal((await setup.app.inject({ method: 'POST', url: '/profiles/remove', headers: headers(active), payload: { id: active } })).statusCode, 409);
  } finally { await setup.dispose(); }
});

test('switching stops the current process, preserves separate worlds and rejects stale writes after returning to one slot', async () => {
  const setup = await fixture();
  try {
    const originalId = (await status(setup.app)).profiles.activeId;
    assert.equal((await setup.app.inject({ method: 'POST', url: '/action', headers: headers(originalId), payload: { action: 'start' } })).statusCode, 200);
    const created = await change(setup.app, '/profiles', { name: 'Second world' }, originalId);
    const secondId = created.profiles.activeId;
    assert.equal(setup.children.length, 1);
    assert.equal(setup.children[0]!.exitCode, 0);
    const second = path.join(setup.root, 'server-profiles', secondId, 'minecraft');
    for (const filename of ['config/identity.json', 'mods/original.jar', 'world/level.dat']) await assert.rejects(access(path.join(second, filename)), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(second, 'eula.txt'), 'utf8'), 'eula=true\n');
    assert.match(await readFile(path.join(second, 'server.properties'), 'utf8'), /^server-ip=127\.0\.0\.1$/m);
    assert.match(await readFile(path.join(second, 'server.properties'), 'utf8'), /^server-port=25566$/m);
    assert.match(await readFile(path.join(second, 'server.properties'), 'utf8'), /^online-mode=true$/m);
    const saved = await setup.app.inject({ method: 'PUT', url: '/workspace/text', headers: headers(secondId), payload: { path: 'config/identity.json', contents: '{"server":"second"}', revision: 'new' } });
    assert.equal(saved.statusCode, 200, saved.body);
    for (const folder of ['mods', 'world']) await mkdir(path.join(second, folder), { recursive: true });
    await writeFile(path.join(second, 'mods', 'second.jar'), 'second-mod');
    await writeFile(path.join(second, 'world', 'level.dat'), 'second-world');
    assert.equal((await setup.app.inject({ method: 'POST', url: '/action', headers: headers(secondId), payload: { action: 'start' } })).statusCode, 200);
    await change(setup.app, '/profiles/select', { id: originalId }, secondId);
    assert.equal(setup.children.length, 2);
    assert.equal(setup.children[1]!.exitCode, 0);
    const originalText = (await setup.app.inject({ url: '/workspace/text?path=config/identity.json', headers: headers(originalId) })).json();
    assert.equal(originalText.contents, originalContents);
    assert.equal(await readFile(path.join(setup.directory, 'mods', 'original.jar'), 'utf8'), 'original-mod');
    assert.equal(await readFile(path.join(setup.directory, 'world', 'level.dat'), 'utf8'), 'original-world');
    for (const staleHeaders of [headers(secondId), authorization]) {
      const rejected = await setup.app.inject({ method: 'PUT', url: '/workspace/text', headers: staleHeaders, payload: { path: 'config/identity.json', contents: 'must not replace original', revision: originalText.revision } });
      assert([400, 409].includes(rejected.statusCode), rejected.body);
    }
    assert.equal((await setup.app.inject({ method: 'POST', url: '/action', headers: headers(secondId), payload: { action: 'start' } })).statusCode, 409);
    assert.equal((await setup.app.inject({ method: 'POST', url: '/installation', headers: headers(secondId), payload: target })).statusCode, 409);
    assert.equal(setup.children.length, 2);
    assert.equal(setup.provisions.length, 1);
    assert.equal(await readFile(path.join(setup.directory, 'config', 'identity.json'), 'utf8'), originalContents);
    await change(setup.app, '/profiles/select', { id: secondId }, originalId);
    await setup.restartController();
    const restarted = await status(setup.app);
    assert.equal(restarted.profiles.activeId, secondId);
    assert.equal(restarted.server.state, 'stopped');
    assert.equal((await setup.app.inject({ url: '/workspace/text?path=config/identity.json', headers: headers(secondId) })).json().contents, '{"server":"second"}');
    assert.equal(await readFile(path.join(second, 'world', 'level.dat'), 'utf8'), 'second-world');
    assert.equal(await readFile(path.join(second, 'mods', 'second.jar'), 'utf8'), 'second-mod');
    await change(setup.app, '/profiles/select', { id: originalId }, secondId);
    const removed = await setup.app.inject({ method: 'POST', url: '/profiles/remove', headers: headers(originalId), payload: { id: secondId } });
    assert.equal(removed.statusCode, 200, removed.body);
    const recovery = path.join(setup.root, 'deleted-server-profiles', secondId, 'runtime', 'minecraft');
    assert.equal(await readFile(path.join(recovery, 'world', 'level.dat'), 'utf8'), 'second-world');
    assert.equal(await readFile(path.join(recovery, 'mods', 'second.jar'), 'utf8'), 'second-mod');
    assert.equal((await status(setup.app)).profiles.profiles.length, 1);
    await setup.restartController();
    const missingContext = await setup.app.inject({ method: 'PUT', url: '/workspace/text', headers: authorization, payload: { path: 'config/identity.json', contents: 'stale after deleting other servers', revision: originalText.revision } });
    assert([400, 409].includes(missingContext.statusCode), missingContext.body);
    assert.equal(await readFile(path.join(setup.directory, 'config', 'identity.json'), 'utf8'), originalContents);
  } finally { await setup.dispose(); }
});

test('deleting an inactive original server retains its data without moving the runtime registry or unrelated files', async () => {
  const setup = await fixture();
  try {
    const originalId = (await status(setup.app)).profiles.activeId;
    const created = await change(setup.app, '/profiles', { name: 'Keep this world' }, originalId);
    const activeId = created.profiles.activeId;
    const removed = await setup.app.inject({ method: 'POST', url: '/profiles/remove', headers: headers(activeId), payload: { id: originalId } });
    assert.equal(removed.statusCode, 200, removed.body);
    const recovery = path.join(setup.root, 'deleted-server-profiles', originalId);
    assert.equal(await readFile(path.join(recovery, 'minecraft', 'world', 'level.dat'), 'utf8'), 'original-world');
    assert.equal(await readFile(path.join(recovery, 'backups', 'original.txt'), 'utf8'), 'original-backup');
    assert.equal(await readFile(path.join(setup.root, 'untouched.txt'), 'utf8'), 'runtime-root-file');
    await access(path.join(setup.root, 'server-profiles.json'));
    await setup.restartController();
    const restarted = await status(setup.app);
    assert.equal(restarted.profiles.activeId, activeId);
    assert.equal(restarted.profiles.profiles.length, 1);
    assert.equal(restarted.server.state, 'stopped');
  } finally { await setup.dispose(); }
});

test('website requests preserve each tab profile context when identical paths and revisions exist on different servers', async () => {
  const setup = await fixture();
  const appRoot = await mkdtemp(path.join(tmpdir(), 'aron-profile-website-'));
  let web: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    await setup.app.listen({ host: '127.0.0.1', port: 0 });
    const address = setup.app.server.address();
    assert.ok(address && typeof address !== 'string');
    const secret = 'profile-website-invitation-'.repeat(3);
    const origin = 'http://localhost:3300';
    const host = 'localhost:3300';
    web = await createApp(readConfiguration({ NODE_ENV: 'test', RUNTIME_DIRECTORY: appRoot, FRIEND_ACCESS_TOKEN: secret, PUBLIC_ORIGIN: origin,
      CONTROLLER_URL: `http://127.0.0.1:${address.port}`, CONTROLLER_TOKEN: token, IP_GRANTS: 'false',
    }));
    const redemption = await web.inject({ method: 'POST', url: '/api/access/redeem', headers: { host, origin, authorization: `Bearer ${secret}` }, payload: {} });
    assert.equal(redemption.statusCode, 200);
    const cookie = String(redemption.headers['set-cookie']).split(';')[0]!;
    const base = { host, origin, cookie };
    const originalId = (await web.inject({ url: '/api/status', headers: base })).json().profiles.activeId;
    for (const header of ['x-server-profile', 'x-workspace-profile']) {
      for (const value of ['', 'invalid', '../minecraft']) {
        const invalid = await web.inject({ url: '/api/status', headers: { ...base, [header]: value } });
        assert.equal(invalid.statusCode, 400, `Invalid ${header} must not default to a different server.`);
      }
    }
    const originalHeaders = { ...base, 'x-server-profile': originalId };
    const original = (await web.inject({ url: '/api/workspace/files/text?path=config/identity.json', headers: originalHeaders })).json();
    assert.equal(original.contents, originalContents);
    const created = await web.inject({ method: 'POST', url: '/api/server/profiles', headers: originalHeaders, payload: { name: 'Second browser tab' } });
    assert.equal(created.statusCode, 202, created.body);
    let current = (await web.inject({ url: '/api/status', headers: base })).json();
    for (let attempt = 0; attempt < 100 && current.server.busy; attempt++) { await delay(25); current = (await web.inject({ url: '/api/status', headers: base })).json(); }
    assert.equal(current.server.busy, false);
    assert.equal(current.server.profileError, undefined);
    const secondId = current.profiles.activeId;
    assert.notEqual(secondId, originalId);
    const selectedHeaders = { ...base, 'x-server-profile': secondId };
    const identical = await web.inject({ method: 'PUT', url: '/api/workspace/files/text', headers: selectedHeaders, payload: { path: 'config/identity.json', contents: originalContents, revision: 'new' } });
    assert.equal(identical.statusCode, 200, identical.body);
    assert.equal(identical.json().revision, original.revision);
    const [stale, selected] = await Promise.all([
      web.inject({ method: 'PUT', url: '/api/workspace/files/text', headers: originalHeaders, payload: { path: 'config/identity.json', contents: 'a stale tab must not replace this', revision: original.revision } }),
      web.inject({ url: '/api/workspace/files/text?path=config/identity.json', headers: selectedHeaders }),
    ]);
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(selected.statusCode, 200, selected.body);
    assert.equal(selected.json().contents, originalContents);
    const missing = await web.inject({ method: 'PUT', url: '/api/workspace/files/text', headers: base, payload: { path: 'config/identity.json', contents: 'missing profile context', revision: original.revision } });
    assert.equal(missing.statusCode, 409, missing.body);
    const saved = await web.inject({ method: 'PUT', url: '/api/workspace/files/text', headers: selectedHeaders, payload: { path: 'config/identity.json', contents: '{"server":"selected"}', revision: original.revision } });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal((await web.inject({ method: 'POST', url: '/api/server/profiles/select', headers: originalHeaders, payload: { id: originalId } })).statusCode, 409);
    assert.equal((await web.inject({ method: 'POST', url: '/api/server/installation', headers: originalHeaders, payload: target })).statusCode, 409);
    assert.equal((await web.inject({ method: 'POST', url: '/api/server/action', headers: originalHeaders, payload: { action: 'start' } })).statusCode, 409);
    assert.equal(setup.provisions.length, 1);
    assert.equal(setup.children.length, 0);
    assert.equal(await readFile(path.join(setup.directory, 'config', 'identity.json'), 'utf8'), originalContents);
    assert.equal(await readFile(path.join(setup.root, 'server-profiles', secondId, 'minecraft', 'config', 'identity.json'), 'utf8'), '{"server":"selected"}');
  } finally { await web?.close(); await setup.dispose(); await rm(appRoot, { recursive: true, force: true }); }
});

test('status and profile listings remain responsive while a new server is being provisioned', async () => {
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const provisioning = new Promise<void>(resolve => { entered = resolve; });
  const setup = await fixture(async () => { entered(); await pending; });
  try {
    const originalId = (await status(setup.app)).profiles.activeId;
    const accepted = await setup.app.inject({ method: 'POST', url: '/profiles', headers: headers(originalId), payload: { name: 'Slow provision fixture' } });
    assert.equal(accepted.statusCode, 202, accepted.body);
    await provisioning;
    const responsive = await Promise.race([status(setup.app), delay(1500).then(() => undefined)]);
    assert.ok(responsive, 'Status must not wait for the long-running profile provision operation.');
    assert.equal(responsive.server.busy, true);
    assert.equal(responsive.profiles.activeId, originalId);
    assert.equal(responsive.profiles.profiles.length, 1);
    const conflicting = await setup.app.inject({ method: 'POST', url: '/profiles', headers: headers(originalId), payload: { name: 'Conflicting provision' } });
    assert.equal(conflicting.statusCode, 409, conflicting.body);
    release();
    let finished = await status(setup.app);
    for (let attempt = 0; attempt < 100 && finished.server.busy; attempt++) { await delay(25); finished = await status(setup.app); }
    assert.equal(finished.server.busy, false);
    assert.equal(finished.server.profileError, undefined);
    assert.equal(finished.profiles.profiles.length, 2);
    assert.notEqual(finished.profiles.activeId, originalId);
  } finally { release(); await setup.dispose(); }
});

test('a new saved server does not silently accept the EULA when the current server has not accepted it', async () => {
  const setup = await fixture();
  try {
    await writeFile(path.join(setup.directory, 'eula.txt'), 'eula=false\n');
    const originalId = (await status(setup.app)).profiles.activeId;
    const created = await change(setup.app, '/profiles', { name: 'No EULA acceptance' }, originalId);
    const selectedId = created.profiles.activeId;
    const eula = await readFile(path.join(setup.root, 'server-profiles', selectedId, 'minecraft', 'eula.txt'), 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; });
    assert(!/^eula=true\s*$/m.test(eula));
    const start = await setup.app.inject({ method: 'POST', url: '/action', headers: headers(selectedId), payload: { action: 'start' } });
    assert.notEqual(start.statusCode, 200);
    assert.equal(setup.children.length, 0);
  } finally { await setup.dispose(); }
});

test('failed provisioning reports the error and preserves the original stopped server and committed slots', async () => {
  const setup = await fixture(async () => { throw new Error('Fixture loader installation failed.'); });
  try {
    const originalId = (await status(setup.app)).profiles.activeId;
    const accepted = await setup.app.inject({ method: 'POST', url: '/profiles', headers: headers(originalId), payload: { name: 'Must not become active' } });
    assert.equal(accepted.statusCode, 202);
    let current = await status(setup.app);
    for (let attempt = 0; attempt < 100 && current.server.busy; attempt++) { await delay(25); current = await status(setup.app); }
    assert.equal(current.server.busy, false);
    assert.match(current.server.profileError, /Fixture loader installation failed/);
    assert.equal(current.profiles.activeId, originalId);
    assert.equal(current.profiles.profiles.length, 1);
    assert.equal(current.server.state, 'stopped');
    assert.equal(await readFile(path.join(setup.directory, 'world', 'level.dat'), 'utf8'), 'original-world');
    assert.equal(await readFile(path.join(setup.directory, 'mods', 'original.jar'), 'utf8'), 'original-mod');
    await setup.restartController();
    assert.equal((await status(setup.app)).profiles.activeId, originalId);
  } finally { await setup.dispose(); }
});

test('inactive workspaces accept files, mods and installations without affecting the running server', async () => {
  const setup = await fixture();
  try {
    const originalId = (await status(setup.app)).profiles.activeId;
    const activeId = (await change(setup.app, '/profiles', { name: 'Running world' }, originalId)).profiles.activeId;
    const selected = { ...headers(activeId), 'x-workspace-profile': originalId };
    const active = { ...headers(activeId), 'x-workspace-profile': activeId };
    assert.equal((await setup.app.inject({ method: 'POST', url: '/action', headers: active, payload: { action: 'start' } })).statusCode, 200);
    const current = (await setup.app.inject({ url: '/status', headers: selected })).json();
    assert.equal(current.server.state, 'running');
    assert.equal(current.workspace.profileId, originalId);
    assert.equal(current.workspace.server.state, 'stopped');
    const original = (await setup.app.inject({ url: '/workspace/text?path=config/identity.json', headers: selected })).json();
    const write = await setup.app.inject({ method: 'PUT', url: '/workspace/text', headers: selected, payload: { path: original.path, revision: original.revision, contents: '{"edited":"inactive"}' } });
    assert.equal(write.statusCode, 200, write.body);
    assert.equal((await setup.app.inject({ method: 'PUT', url: '/workspace/text', headers: active, payload: { path: 'config/blocked.json', revision: 'new', contents: '{}' } })).statusCode, 409);
    const bytes = Buffer.from('Synthetic mod fixture, never executed.');
    const upload = await setup.app.inject({ method: 'POST', url: '/workspace/uploads', headers: selected, payload: { path: 'mods/inactive.jar', size: bytes.length, replace: false, address: 'friend' } });
    assert.equal(upload.statusCode, 200, upload.body);
    const uploadedId = upload.json().id;
    assert.equal((await setup.app.inject({ method: 'POST', url: `/workspace/uploads/${uploadedId}/chunks`, headers: selected, payload: { index: 0, data: bytes.toString('base64'), address: 'friend' } })).statusCode, 200);
    assert.equal((await setup.app.inject({ method: 'POST', url: `/workspace/uploads/${uploadedId}/complete`, headers: selected, payload: { address: 'friend' } })).statusCode, 200);
    assert.equal((await setup.app.inject({ method: 'POST', url: '/workspace/mods/action', headers: selected, payload: { path: 'mods/inactive.jar', action: 'disable' } })).statusCode, 200);
    assert.equal(await readFile(path.join(setup.directory, 'mods', 'inactive.jar.disabled'), 'utf8'), bytes.toString());
    const activeDirectory = path.join(setup.root, 'server-profiles', activeId, 'minecraft');
    await assert.rejects(access(path.join(activeDirectory, 'mods', 'inactive.jar.disabled')), { code: 'ENOENT' });
    const installed = { minecraftVersion: '1.7.10', loader: 'Forge' as const, loaderVersion: '10.13.4.1614' };
    assert.equal((await setup.app.inject({ method: 'POST', url: '/installation', headers: selected, payload: installed })).statusCode, 202);
    const initialRefresh = await setup.app.inject({ url: '/status', headers: selected });
    assert.equal(initialRefresh.statusCode, 200, initialRefresh.body);
    let refreshed = initialRefresh.json();
    for (let attempt = 0; attempt < 100 && refreshed.workspace.server.busy; attempt++) {
      await delay(25);
      refreshed = (await setup.app.inject({ url: '/status', headers: selected })).json();
    }
    assert.equal(refreshed.workspace.server.busy, false);
    assert.equal(refreshed.workspace.server.version, installed.minecraftVersion);
    assert.equal(refreshed.workspace.server.loader, installed.loader);
    assert.equal(refreshed.server.version, target.minecraftVersion);
    assert.equal(refreshed.server.state, 'running');
    assert.equal(setup.children.length, 1);
    assert.equal(setup.children[0]!.exitCode, null);
    const unfinished = (await setup.app.inject({ method: 'POST', url: '/workspace/uploads', headers: selected, payload: { path: 'config/unfinished.txt', size: 1, replace: false, address: 'friend' } })).json();
    await change(setup.app, '/profiles/select', { id: originalId }, activeId);
    assert.equal(setup.children[0]!.exitCode, 0);
    assert.equal((await setup.app.inject({ method: 'POST', url: `/workspace/uploads/${unfinished.id}/chunks`, headers: { ...headers(originalId), 'x-workspace-profile': originalId }, payload: { index: 0, data: 'YQ==', address: 'friend' } })).statusCode, 404);
    assert.equal((await setup.app.inject({ method: 'PUT', url: '/workspace/text', headers: selected, payload: { path: original.path, revision: write.json().revision, contents: 'stale edit' } })).statusCode, 409);
    const removedWorkspace = { ...headers(originalId), 'x-workspace-profile': activeId };
    const pending = await setup.app.inject({ method: 'POST', url: '/workspace/uploads', headers: removedWorkspace, payload: { path: 'config/remove.txt', size: 1, replace: false, address: 'friend' } });
    assert.equal(pending.statusCode, 200, pending.body);
    assert.equal((await setup.app.inject({ method: 'POST', url: '/profiles/remove', headers: headers(originalId), payload: { id: activeId } })).statusCode, 200);
    for (const url of ['/workspace/files', '/versions']) assert.equal((await setup.app.inject({ url, headers: removedWorkspace })).statusCode, 404);
    assert.equal((await setup.app.inject({ method: 'PUT', url: '/workspace/text', headers: removedWorkspace, payload: { path: 'config/removed.txt', revision: 'new', contents: 'must not fall back' } })).statusCode, 404);
    const recovered = (await setup.app.inject({ url: '/status', headers: removedWorkspace })).json();
    assert.equal(recovered.workspace.profileId, originalId);
    assert.equal(recovered.profiles.profiles.length, 1);
    await assert.rejects(access(activeDirectory), { code: 'ENOENT' });
    await assert.rejects(access(path.join(setup.directory, 'config', 'removed.txt')), { code: 'ENOENT' });
    for (const workspaceId of ['../minecraft', 'not-a-uuid', '']) {
      assert.equal((await setup.app.inject({ url: '/status', headers: { ...headers(originalId), 'x-workspace-profile': workspaceId } })).statusCode, 400);
    }
    assert.equal((await setup.app.inject({ method: 'POST', url: '/action', headers: headers(originalId), payload: { action: 'start' } })).statusCode, 200);
    assert.equal(setup.children.length, 2);
  } finally { await setup.dispose(); }
});

test('activation and deletion cannot race an inactive workspace installation', async () => {
  let blocked = false;
  let release!: () => void;
  let enter!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const setup = await fixture(async () => {
    if (!blocked) return;
    const staging = `${setup.directory}.installation-fixture`;
    await rename(setup.directory, staging);
    enter();
    await pending;
    await rename(staging, setup.directory);
  });
  try {
    const originalId = (await status(setup.app)).profiles.activeId;
    const activeId = (await change(setup.app, '/profiles', { name: 'Current world' }, originalId)).profiles.activeId;
    assert.equal((await setup.app.inject({ method: 'POST', url: '/action', headers: headers(activeId), payload: { action: 'start' } })).statusCode, 200);
    blocked = true;
    const selected = { ...headers(activeId), 'x-workspace-profile': originalId };
    assert.equal((await setup.app.inject({ method: 'POST', url: '/installation', headers: selected, payload: target })).statusCode, 202);
    await entered;
    for (const url of ['/profiles/select', '/profiles/remove']) {
      const response = await setup.app.inject({ method: 'POST', url, headers: headers(activeId), payload: { id: originalId } });
      assert.equal(response.statusCode, 409, response.body);
    }
    assert.equal((await setup.app.inject({ method: 'PUT', url: '/workspace/text', headers: selected, payload: { path: 'config/race.txt', revision: 'new', contents: 'not while installing' } })).statusCode, 409);
    assert.equal((await status(setup.app)).server.state, 'running');
    assert.equal(setup.children[0]!.exitCode, null);
    release();
    let current = await status(setup.app);
    for (let attempt = 0; attempt < 100 && current.server.busy; attempt++) { await delay(25); current = await status(setup.app); }
    assert.equal(current.server.busy, false);
    assert.equal(current.profiles.activeId, activeId);
    assert.equal(current.server.state, 'running');
  } finally { release(); await setup.dispose(); }
});

test('website requests and client snapshots keep independent edit selections while another server runs', async () => {
  const setup = await fixture();
  const appRoot = await mkdtemp(path.join(tmpdir(), 'aron-independent-workspaces-'));
  let web: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    const originalId = (await status(setup.app)).profiles.activeId;
    const activeId = (await change(setup.app, '/profiles', { name: 'Running server' }, originalId)).profiles.activeId;
    assert.equal((await setup.app.inject({ method: 'POST', url: '/action', headers: headers(activeId), payload: { action: 'start' } })).statusCode, 200);
    await setup.app.listen({ host: '127.0.0.1', port: 0 });
    const address = setup.app.server.address();
    assert.ok(address && typeof address !== 'string');
    const controllerOrigin = `http://127.0.0.1:${address.port}`;
    const client = new ControllerClient(controllerOrigin, token);
    await client.initialize();
    let releaseSnapshots!: () => void;
    let observed = 0;
    const snapshotsReady = new Promise<void>(resolve => { releaseSnapshots = resolve; });
    await Promise.all([originalId, activeId].map(workspaceId => client.forProfile(activeId, async () => {
      const snapshot = await client.refresh();
      observed++;
      if (observed === 2) releaseSnapshots();
      await snapshotsReady;
      assert.equal(snapshot.workspace.profileId, workspaceId);
      assert.equal(client.workspaceStatus().state, workspaceId === activeId ? 'running' : 'stopped');
      assert.equal(client.status().state, 'running');
    }, workspaceId)));
    assert.equal(client.workspaceStatus().state, 'running');
    const secret = 'workspace-invitation-fixture-'.repeat(3);
    const host = 'localhost:3300';
    const origin = `http://${host}`;
    web = await createApp(readConfiguration({ NODE_ENV: 'test', RUNTIME_DIRECTORY: appRoot, FRIEND_ACCESS_TOKEN: secret,
      PUBLIC_ORIGIN: origin, CONTROLLER_URL: controllerOrigin, CONTROLLER_TOKEN: token, IP_GRANTS: 'false',
    }));
    const redemption = await web.inject({ method: 'POST', url: '/api/access/redeem', headers: { host, origin, authorization: `Bearer ${secret}` }, payload: {} });
    assert.equal(redemption.statusCode, 200, redemption.body);
    const cookie = String(redemption.headers['set-cookie']).split(';')[0]!;
    const base = { host, origin, cookie, 'x-server-profile': activeId };
    const selected = { ...base, 'x-workspace-profile': originalId };
    const active = { ...base, 'x-workspace-profile': activeId };
    for (let attempt = 0; attempt < 3; attempt++) {
      const responses = await Promise.all([selected, active].map(headers => web!.inject({ url: '/api/status', headers })));
      for (const [index, response] of responses.entries()) {
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().workspace.profileId, index === 0 ? originalId : activeId);
        assert.equal(response.json().workspace.server.state, index === 0 ? 'stopped' : 'running');
        assert.equal(response.json().server.state, 'running');
      }
    }
    const original = (await web.inject({ url: '/api/workspace/files/text?path=config/identity.json', headers: selected })).json();
    const [saved, concurrentStatus] = await Promise.all([
      web.inject({ method: 'PUT', url: '/api/workspace/files/text', headers: selected, payload: { path: original.path, revision: original.revision, contents: '{"independent":true}' } }),
      web.inject({ url: '/api/status', headers: active }),
    ]);
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(concurrentStatus.json().workspace.profileId, activeId);
    const blockedWrite = await web.inject({ method: 'PUT', url: '/api/workspace/files/text', headers: active, payload: { path: 'config/running.txt', revision: 'new', contents: 'blocked' } });
    assert.equal(blockedWrite.statusCode, 409, blockedWrite.body);
    assert.equal(await readFile(path.join(setup.directory, 'config', 'identity.json'), 'utf8'), '{"independent":true}');
    assert.equal(setup.children.length, 1);
    assert.equal(setup.children[0]!.exitCode, null);
  } finally { await web?.close(); await setup.dispose(); await rm(appRoot, { recursive: true, force: true }); }
});

test('status captures runtime state after asynchronous profile metadata has finished loading', async t => {
  const setup = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const originalList = ServerProfiles.prototype.list;
  let reads = 0;
  try {
    const activeId = (await status(setup.app)).profiles.activeId;
    t.mock.method(ServerProfiles.prototype, 'list', async function(this: ServerProfiles, refresh = true) {
      const result = await originalList.call(this, refresh);
      if (++reads === 2) { entered(); await pending; }
      return result;
    });
    const response = setup.app.inject({ url: '/status', headers: headers(activeId) });
    await reading;
    assert.equal((await setup.app.inject({ method: 'POST', url: '/action', headers: headers(activeId), payload: { action: 'start' } })).statusCode, 200);
    release();
    const snapshot = await response;
    assert.equal(snapshot.statusCode, 200, snapshot.body);
    assert.equal(snapshot.json().server.state, 'running');
    assert.equal(snapshot.json().workspace.server.state, 'running');
    assert.equal(snapshot.json().profiles.activeId, activeId);
  } finally { release(); t.mock.restoreAll(); await setup.dispose(); }
});
