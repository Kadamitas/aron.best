import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';
import { createController, readControllerConfiguration } from './controller.js';
import { createApp, readConfiguration } from './app.js';
import { inviteCookie } from './invite-session.js';
import { BackupObjects } from './backup-objects.js';
import type { MinecraftDependencies } from './minecraft.js';

const token = 'recovery-fixture-token-'.repeat(3);
const authorization = { authorization: `Bearer ${token}` };
const target = { minecraftVersion: '26.3', loader: 'Fabric' as const, loaderVersion: '0.19.5' };

async function fixture(minecraft: Partial<MinecraftDependencies> = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'aron-recovery-')));
  const directory = path.join(root, 'minecraft');
  await mkdir(path.join(directory, 'config'), { recursive: true });
  await writeFile(path.join(directory, 'config', 'settings.json'), '{"original":true}');
  await writeFile(path.join(directory, 'fabric-server-launch.jar'), 'never executed');
  await writeFile(path.join(directory, 'eula.txt'), 'eula=true\n');
  const configuration = readControllerConfiguration({ CONTROLLER_TOKEN: token, RUNTIME_DIRECTORY: root, MINECRAFT_GATEWAY: 'false' });
  const dependencies = { isolated: true, minecraft: { launch: (_command: string, _args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => spawn(process.execPath, ['-e', "process.stdout.write('Done (0.01s)!\\n');process.stdin.on('data',data=>{if(data.toString().includes('stop'))process.exit(0)})"], { ...options, stdio: 'pipe' as const }), ...minecraft },
    installationFactory: (destination: string) => ({
      catalog: async () => ({ versions: ['26.3'], minecraftVersion: '26.3', loaders: [{ loader: target.loader, loaderVersion: target.loaderVersion }] }),
      install: async () => {
        const installed = { ...target, javaMajor: 25 as const, launchArgs: ['-jar', 'fabric-server-launch.jar'], installedAt: new Date().toISOString() };
        await writeFile(path.join(destination, 'fabric-server-launch.jar'), 'never executed');
        await writeFile(path.join(destination, 'installation.json'), JSON.stringify(installed));
        return installed;
      },
    }),
  };
  let app = await createController(configuration, dependencies);
  return { root, directory, get app() { return app; }, restart: async () => { await app.close(); app = await createController(configuration, dependencies); }, dispose: async () => { await app.close(); await rm(root, { recursive: true, force: true }); } };
}

test('operation status names the action for every browser and clears on completion or failure', async () => {
  let announce!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { announce = resolve; });
  const setup = await fixture({ launch: (_command, _args, options) => {
    const child = spawn(process.execPath, ['-e', "process.stdin.on('data',data=>{if(data.toString().includes('ready'))process.stdout.write('Done (0.01s)!\\n');if(data.toString().includes('stop'))process.exit(0)})"], { ...options, stdio: 'pipe' });
    release = () => child.stdin.write('ready\n');
    announce();
    return child;
  } });
  try {
    const starting = setup.app.inject({ method: 'POST', url: '/action', headers: authorization, payload: { action: 'start' } });
    await entered;
    const busy = (await setup.app.inject({ url: '/status', headers: authorization })).json();
    assert.equal(busy.server.operation, 'Starting server');
    assert.equal(busy.workspace.server.operation, 'Starting server');
    release();
    assert.equal((await starting).statusCode, 200);
    assert.equal((await setup.app.inject({ url: '/status', headers: authorization })).json().server.operation, undefined);
    const failure = await setup.app.inject({ method: 'POST', url: '/profiles/restore', headers: authorization, payload: { id: busy.profiles.activeId } });
    assert.equal(failure.statusCode, 409);
    assert.equal((await setup.app.inject({ url: '/status', headers: authorization })).json().server.operation, undefined);
  } finally { release?.(); await setup.dispose(); }
});

test('editing automatically preserves the previous configuration outside Advanced', async () => {
  const setup = await fixture();
  try {
    const original = (await setup.app.inject({ url: '/workspace/text?path=config/settings.json', headers: authorization })).json();
    const change = await setup.app.inject({ method: 'PUT', url: '/workspace/text', headers: authorization, payload: { path: original.path, revision: original.revision, contents: '{"edited":true}' } });
    assert.equal(change.statusCode, 200, change.body);
    const recovery = (await setup.app.inject({ url: '/recovery', headers: authorization })).json();
    assert.equal(recovery.automatic.retained, 6);
    assert.equal(recovery.backups.length, 1);
    assert.equal(recovery.backups[0].kind, 'automatic');
    const snapshot = JSON.parse(await readFile(path.join(setup.root, 'backups', recovery.backups[0].id, 'backup.json'), 'utf8'));
    const entry = snapshot.files.find((file: { path: string }) => file.path === 'config/settings.json');
    const handle = await new BackupObjects(path.join(setup.root, 'backup-objects')).openObject(entry.sha256, entry.size);
    try { assert.equal(await handle.readFile('utf8'), '{"original":true}'); } finally { await handle.close(); }
    const listing = (await setup.app.inject({ url: '/workspace/files', headers: authorization })).json();
    assert(!JSON.stringify(listing).includes('backup-objects'));
    assert(!JSON.stringify(listing).includes('backups/'));
    assert.equal((await setup.app.inject({ url: '/workspace/download?path=../backup-objects', headers: authorization })).statusCode, 400);
    const second = (await setup.app.inject({ url: '/workspace/text?path=config/settings.json', headers: authorization })).json();
    assert.equal((await setup.app.inject({ method: 'PUT', url: '/workspace/text', headers: authorization, payload: { path: second.path, revision: second.revision, contents: '{}' } })).statusCode, 200);
    assert.equal((await setup.app.inject({ url: '/recovery', headers: authorization })).json().backups.length, 1);
  } finally { await setup.dispose(); }
});

test('a failed safety snapshot blocks the edit and publishes an actionable warning', async () => {
  const setup = await fixture({ availableBytes: async () => 0n });
  try {
    const original = (await setup.app.inject({ url: '/workspace/text?path=config/settings.json', headers: authorization })).json();
    const change = await setup.app.inject({ method: 'PUT', url: '/workspace/text', headers: authorization, payload: { path: original.path, revision: original.revision, contents: 'lost' } });
    assert.equal(change.statusCode, 409, change.body);
    assert.match(change.json().error, /safety backup/);
    assert.equal(await readFile(path.join(setup.directory, original.path), 'utf8'), original.contents);
    assert.match((await setup.app.inject({ url: '/status', headers: authorization })).json().server.backupError, /safety backup/);
  } finally { await setup.dispose(); }
});

test('deleted servers keep persistent backup downloads and restore without changing the active slot', { skip: process.platform !== 'linux' }, async () => {
  const setup = await fixture();
  try {
    const originalId = (await setup.app.inject({ url: '/status', headers: authorization })).json().profiles.activeId;
    assert.equal((await setup.app.inject({ method: 'POST', url: '/action', headers: authorization, payload: { action: 'backup' } })).statusCode, 200);
    assert.equal((await setup.app.inject({ method: 'POST', url: '/profiles', headers: authorization, payload: { name: 'Still active' } })).statusCode, 202);
    let status = (await setup.app.inject({ url: '/status', headers: authorization })).json();
    for (let index = 0; status.server.busy && index < 100; index++) { await delay(25); status = (await setup.app.inject({ url: '/status', headers: authorization })).json(); }
    const active = status.profiles.activeId;
    assert.notEqual(active, originalId);
    const headers = { ...authorization, 'x-server-profile': active };
    assert.equal((await setup.app.inject({ method: 'POST', url: '/profiles/remove', headers, payload: { id: originalId } })).statusCode, 200);
    await setup.restart();
    const recovery = await setup.app.inject({ url: '/recovery', headers: authorization });
    assert.equal(recovery.statusCode, 200, recovery.body);
    assert.equal(recovery.json().servers.find((entry: { id: string }) => entry.id === originalId).deleted, true);
    const snapshot = recovery.json().backups.find((entry: { profileId: string }) => entry.profileId === originalId);
    assert(snapshot);
    const url = `/recovery/backups/${originalId}/${snapshot.id}/download`;
    assert.equal((await setup.app.inject({ url })).statusCode, 401);
    for (let attempt = 0; attempt < 2; attempt++) {
      const downloaded = await setup.app.inject({ url, headers: authorization });
      assert.equal(downloaded.statusCode, 200, downloaded.body);
      const tar = gunzipSync(downloaded.rawPayload);
      assert(tar.includes(Buffer.from('config/settings.json')));
      assert(tar.includes(Buffer.from('{"original":true}')));
    }
    const archived = path.join(setup.root, 'deleted-server-profiles', originalId, 'backups');
    assert(!(await readdir(archived)).some(name => name.endsWith('.tar.gz')));
    const restored = await setup.app.inject({ method: 'POST', url: '/profiles/restore', headers, payload: { id: originalId } });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.deepEqual(restored.json(), { restored: true });
    status = (await setup.app.inject({ url: '/status', headers: authorization })).json();
    assert.equal(status.profiles.activeId, active);
    assert.equal(status.server.state, 'stopped');
    assert.equal(await readFile(path.join(setup.root, 'minecraft', 'config', 'settings.json'), 'utf8'), '{"original":true}');
    assert.equal((await setup.app.inject({ url, headers: authorization })).statusCode, 200);
  } finally { await setup.dispose(); }
});

test('the recovery web API uses the existing invitation and rejects cross-origin restore requests', async () => {
  const setup = await fixture();
  const webRoot = await mkdtemp(path.join(tmpdir(), 'aron-recovery-web-'));
  let web: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    await setup.app.listen({ host: '127.0.0.1', port: 0 });
    const address = setup.app.server.address();
    assert(address && typeof address !== 'string');
    const secret = 'recovery-invitation-'.repeat(3);
    web = await createApp(readConfiguration({ NODE_ENV: 'test', RUNTIME_DIRECTORY: webRoot, CONTROLLER_URL: `http://127.0.0.1:${address.port}`, CONTROLLER_TOKEN: token, FRIEND_ACCESS_TOKEN: secret, IP_GRANTS: 'false', PUBLIC_ORIGIN: 'http://localhost:3300' }));
    const headers = { host: 'localhost:3300', origin: 'http://localhost:3300', cookie: inviteCookie(secret, false).split(';')[0]! };
    assert.equal((await web.inject({ url: '/api/server/recovery', headers: { host: headers.host } })).statusCode, 401);
    const response = await web.inject({ url: '/api/server/recovery', headers });
    assert.equal(response.statusCode, 200, response.body);
    const id = response.json().servers[0].id;
    assert.equal((await web.inject({ method: 'POST', url: '/api/server/profiles/restore', headers: { ...headers, origin: 'https://untrusted.test' }, payload: { id } })).statusCode, 403);
  } finally { await web?.close(); await setup.dispose(); await rm(webRoot, { recursive: true, force: true }); }
});
