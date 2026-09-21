import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createController, readControllerConfiguration } from './controller.js';
import { createApp, readConfiguration } from './app.js';
import { inspectManifest } from './modpack.js';
import { inviteCookie, validInviteCookie } from './invite-session.js';
import type { InstalledServer, LoaderInstallation, ServerTarget } from './loader-installation.js';

const token = 'controller-test-token-'.repeat(3);
const authorization = { authorization: `Bearer ${token}` };
const archiveManifest = { minecraft: { version: '26.3', modLoaders: [{ id: 'fabric-0.19.5', primary: true }] }, manifestType: 'minecraftModpack', manifestVersion: 1, name: 'Test pack', version: '1.0.0', files: [], overrides: 'overrides' };
const runningServer = `process.stdout.write('Done (0.01s)!\\n'); process.stdin.on('data', data => { if (data.toString().includes('stop')) process.exit(0); });`;

async function fixture(isolated: boolean, installations?: Pick<LoaderInstallation, 'catalog' | 'install'>) {
  const root = await mkdtemp(path.join(tmpdir(), 'aron-controller-'));
  await mkdir(path.join(root, 'minecraft', 'config'), { recursive: true });
  await mkdir(path.join(root, 'minecraft', 'mods'));
  await writeFile(path.join(root, 'minecraft', 'fabric-server-launch.jar'), 'test fixture');
  await writeFile(path.join(root, 'minecraft', 'eula.txt'), 'eula=true\n');
  await writeFile(path.join(root, 'minecraft', 'config', 'settings.json'), '{"original":true}');
  await writeFile(path.join(root, 'minecraft', 'mods', 'example.jar'), 'jar fixture');
  const app = await createController(readControllerConfiguration({ CONTROLLER_TOKEN: token, RUNTIME_DIRECTORY: root, MINECRAFT_GATEWAY: 'false' }), {
    isolated, installations, minecraft: { launch: (_command, _args, options) => spawn(process.execPath, ['-e', runningServer], { ...options, stdio: 'pipe' }) },
  });
  return { root, app, dispose: async () => { await app.close(); await rm(root, { recursive: true, force: true }); } };
}

test('controller authentication, schemas and container boundary reject unsafe requests', async () => {
  const setup = await fixture(false);
  try {
    assert.equal((await setup.app.inject({ url: '/health' })).statusCode, 200);
    for (const url of ['/status', '/logs', '/workspace/files', '/workspace/mods', '/workspace/download?path=config/settings.json']) {
      assert.equal((await setup.app.inject({ url })).statusCode, 401);
    }
    assert.equal((await setup.app.inject({ method: 'POST', url: '/action', headers: authorization, payload: { action: 'exec', command: 'id' } })).statusCode, 400);
    assert.equal((await setup.app.inject({ method: 'POST', url: '/action', headers: authorization, payload: { action: 'update', downloads: [{ localPath: '/etc/passwd' }] } })).statusCode, 400);
    const write = await setup.app.inject({ method: 'PUT', url: '/workspace/text', headers: authorization, payload: { path: 'config/settings.json', contents: '{}', revision: 'wrong' } });
    assert.equal(write.statusCode, 409);
    assert.match(write.json().error, /isolated/);
    for (const [url, payload] of [
      ['/workspace/directories', { path: 'config/new-folder' }],
      ['/workspace/entries/move', { path: 'config/settings.json', destination: 'config/renamed.json' }],
      ['/workspace/entries/remove', { path: 'config/settings.json' }],
      ['/installation', { minecraftVersion: '1.7.10', loader: 'Forge', loaderVersion: '10.13.4.1614' }],
    ] as const) {
      assert.equal((await setup.app.inject({ method: 'POST', url, payload })).statusCode, 401);
      assert.equal((await setup.app.inject({ method: 'POST', url, headers: authorization, payload })).statusCode, 409);
    }
  } finally { await setup.dispose(); }
});

test('controller serializes lifecycle and file changes and preserves stale edits', async () => {
  const setup = await fixture(true);
  try {
    const original = (await setup.app.inject({ url: '/workspace/text?path=config/settings.json', headers: authorization })).json();
    const saved = await setup.app.inject({ method: 'PUT', url: '/workspace/text', headers: authorization, payload: { path: original.path, contents: '{"saved":true}', revision: original.revision } });
    assert.equal(saved.statusCode, 200);
    assert.equal((await setup.app.inject({ method: 'PUT', url: '/workspace/text', headers: authorization, payload: { path: original.path, contents: '{}', revision: original.revision } })).statusCode, 409);
    assert.equal(await readFile(path.join(setup.root, 'minecraft', original.path), 'utf8'), '{"saved":true}');
    assert.equal((await setup.app.inject({ method: 'POST', url: '/workspace/archive', headers: authorization, payload: { manifest: { ...archiveManifest, minecraft: { ...archiveManifest.minecraft, version: '1.0' } } } })).statusCode, 409);
    const upload = (await setup.app.inject({ method: 'POST', url: '/workspace/uploads', headers: authorization, payload: { path: 'config/cancel-me.txt', size: 1, replace: false, address: 'test-client' } })).json();
    assert.equal((await setup.app.inject({ method: 'POST', url: '/action', headers: authorization, payload: { action: 'start' } })).statusCode, 200);
    assert.equal((await setup.app.inject({ method: 'POST', url: '/workspace/archive', headers: authorization, payload: { manifest: archiveManifest } })).statusCode, 200);
    assert.equal((await setup.app.inject({ method: 'DELETE', url: `/workspace/uploads/${upload.id}`, headers: authorization, payload: { address: 'test-client' } })).statusCode, 200);
    const mutation = await setup.app.inject({ method: 'POST', url: '/workspace/mods/action', headers: authorization, payload: { path: 'mods/example.jar', action: 'disable' } });
    assert.equal(mutation.statusCode, 409);
    assert.match(mutation.json().error, /Stop/);
    for (const [url, payload] of [
      ['/workspace/directories', { path: 'config/locked' }],
      ['/workspace/entries/move', { path: 'config/settings.json', destination: 'config/renamed.json' }],
      ['/workspace/entries/remove', { path: 'config/settings.json' }],
    ] as const) assert.equal((await setup.app.inject({ method: 'POST', url, headers: authorization, payload })).statusCode, 409);
    assert.equal((await setup.app.inject({ method: 'POST', url: '/action', headers: authorization, payload: { action: 'stop' } })).statusCode, 200);
    assert.equal((await setup.app.inject({ method: 'POST', url: '/workspace/mods/action', headers: authorization, payload: { path: 'mods/example.jar', action: 'disable' } })).statusCode, 200);
    assert.equal((await setup.app.inject({ url: '/workspace/mods', headers: authorization })).json().mods[0].enabled, false);
  } finally { await setup.dispose(); }
});

test('one invite unlocks both views without granting a shared Docker IP and remote controller state is used', async () => {
  const setup = await fixture(true);
  const appRoot = await mkdtemp(path.join(tmpdir(), 'aron-remote-app-'));
  let web: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    await setup.app.listen({ host: '127.0.0.1', port: 0 });
    const address = setup.app.server.address();
    assert.ok(address && typeof address !== 'string');
    const secret = 'friend-invite-'.repeat(4);
    web = await createApp(readConfiguration({ NODE_ENV: 'test', RUNTIME_DIRECTORY: appRoot, FRIEND_ACCESS_TOKEN: secret,
      CONTROLLER_URL: `http://127.0.0.1:${address.port}`, CONTROLLER_TOKEN: token, IP_GRANTS: 'false', PUBLIC_ORIGIN: 'http://localhost:3300', PORTFOLIO_HOSTS: 'portfolio.test',
    }));
    const response = await web.inject({ method: 'POST', url: '/api/access/redeem', headers: { host: 'localhost:3300', origin: 'http://localhost:3300', authorization: `Bearer ${secret}` }, payload: {} });
    assert.equal(response.statusCode, 200);
    const cookie = String(response.headers['set-cookie']).split(';')[0]!;
    assert.match(String(response.headers['set-cookie']), /HttpOnly; SameSite=Strict/);
    const headers = { host: 'localhost:3300', cookie, origin: 'http://localhost:3300' };
    const status = await web.inject({ url: '/api/status', headers });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().capabilities.workspaceWrite, true);
    assert.equal(status.json().capabilities.ipWhitelisted, false);
    assert.equal(status.json().pack.name, 'Dictionary Minecraft Server');
    assert.equal((await web.inject({ url: '/api/status', headers: { host: 'localhost:3300' } })).statusCode, 401);
    assert.equal((await web.inject({ url: '/api/workspace/files', headers })).statusCode, 200);
    assert.equal((await web.inject({ method: 'POST', url: '/api/workspace/mods/action', headers: { ...headers, origin: 'https://evil.test' }, payload: { path: 'mods/example.jar', action: 'disable' } })).statusCode, 403);
    assert.equal((await web.inject({ method: 'POST', url: '/api/workspace/directories', headers, payload: { path: 'config/folder' } })).statusCode, 200);
    const listing = (await web.inject({ url: '/api/workspace/files', headers })).json();
    assert(listing.directories.some((directory: { path: string }) => directory.path === 'config/folder'));
    assert.equal((await web.inject({ method: 'POST', url: '/api/workspace/entries/move', headers, payload: { path: 'config/settings.json', destination: 'config/folder/renamed.json' } })).statusCode, 200);
    assert.equal((await web.inject({ method: 'POST', url: '/api/workspace/entries/move', headers, payload: { path: 'config/folder', destination: 'config/renamed-folder' } })).statusCode, 200);
    assert.equal((await web.inject({ method: 'POST', url: '/api/workspace/entries/remove', headers: { ...headers, origin: 'https://evil.test' }, payload: { path: 'config/renamed-folder' } })).statusCode, 403);
    assert.equal((await web.inject({ method: 'POST', url: '/api/workspace/entries/remove', headers, payload: { path: 'config/renamed-folder' } })).statusCode, 200);
    assert(!(await web.inject({ url: '/api/workspace/files', headers })).json().directories.some((directory: { path: string }) => directory.path === 'config/renamed-folder'));
    const zip = await web.inject({ url: '/api/pack/download', headers });
    assert.equal(zip.statusCode, 200);
    assert.equal(zip.headers['content-type'], 'application/zip');
    assert.equal((await inspectManifest(zip.rawPayload)).manifest.minecraft.version, '26.3');
    assert.equal((await inspectManifest(zip.rawPayload)).manifest.name, 'Dictionary Minecraft Server');
    assert.equal(zip.headers['content-disposition'], 'attachment; filename="dictionary-minecraft-server.zip"');
    assert.equal((await web.inject({ url: '/api/workspace/files', headers: { host: 'portfolio.test', cookie } })).statusCode, 404);
    await web.close();
    web = undefined;
    assert.equal((await setup.app.inject({ url: '/status', headers: authorization })).statusCode, 200);
  } finally { await web?.close(); await setup.dispose(); await rm(appRoot, { recursive: true, force: true }); }
});

test('invite cookies reject tampering and rotated invitation secrets', () => {
  const secret = 'invite-cookie-test'.repeat(4);
  const cookie = inviteCookie(secret, true);
  assert.match(cookie, /; Secure$/);
  assert.equal(validInviteCookie(cookie, secret), true);
  assert.equal(validInviteCookie(cookie, 'rotated-secret'.repeat(4)), false);
  assert.equal(validInviteCookie(cookie.replace('workshop_access=', 'workshop_access=x'), secret), false);
  assert.equal(validInviteCookie(cookie.replace(/\.[A-Za-z0-9_-]{43};/, `.${'é'.repeat(43)};`), secret), false);
  assert.equal(validInviteCookie(undefined, secret), false);
});

test('an invited website installation updates the controller target and downloaded pack without starting Minecraft', async () => {
  const target: ServerTarget = { minecraftVersion: '1.7.10', loader: 'Forge', loaderVersion: '10.13.4.1614' };
  const installed: InstalledServer = { ...target, javaMajor: 8, launchArgs: ['-jar', 'forge-1.7.10-10.13.4.1614-1.7.10-universal.jar'], installedAt: new Date().toISOString() };
  const calls: ServerTarget[] = [];
  let runtime = '';
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const setup = await fixture(true, {
    catalog: async () => ({ versions: ['26.3', '1.7.10'], minecraftVersion: target.minecraftVersion, loaders: [{ loader: target.loader, loaderVersion: target.loaderVersion }] }),
    install: async requested => {
      calls.push(requested);
      await pending;
      const directory = path.join(runtime, 'minecraft');
      await writeFile(path.join(directory, installed.launchArgs[1]!), 'Synthetic Forge launcher, never executed.');
      await writeFile(path.join(directory, 'installation.json'), JSON.stringify(installed));
      return installed;
    },
  });
  runtime = setup.root;
  const appRoot = await mkdtemp(path.join(tmpdir(), 'aron-installation-app-'));
  let web: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    await setup.app.listen({ host: '127.0.0.1', port: 0 });
    const address = setup.app.server.address();
    assert.ok(address && typeof address !== 'string');
    const secret = 'installation-friend-invite-'.repeat(3);
    const origin = 'http://localhost:3300';
    const host = 'localhost:3300';
    web = await createApp(readConfiguration({ NODE_ENV: 'test', RUNTIME_DIRECTORY: appRoot, FRIEND_ACCESS_TOKEN: secret,
      CONTROLLER_URL: `http://127.0.0.1:${address.port}`, CONTROLLER_TOKEN: token, IP_GRANTS: 'false', PUBLIC_ORIGIN: origin,
    }));
    assert.equal((await web.inject({ method: 'POST', url: '/api/server/installation', headers: { host, origin }, payload: target })).statusCode, 401);
    const redemption = await web.inject({ method: 'POST', url: '/api/access/redeem', headers: { host, origin, authorization: `Bearer ${secret}` }, payload: {} });
    assert.equal(redemption.statusCode, 200);
    const cookie = String(redemption.headers['set-cookie']).split(';')[0]!;
    const headers = { host, origin, cookie };
    assert.equal((await web.inject({ method: 'POST', url: '/api/server/installation', headers: { ...headers, origin: 'https://evil.test' }, payload: target })).statusCode, 403);
    assert.deepEqual(calls, []);
    const catalog = await web.inject({ url: '/api/server/versions?minecraftVersion=1.7.10', headers });
    assert.equal(catalog.statusCode, 200);
    assert.deepEqual(catalog.json().loaders, [{ loader: 'Forge', loaderVersion: '10.13.4.1614' }]);
    const accepted = await web.inject({ method: 'POST', url: '/api/server/installation', headers, payload: target });
    assert.equal(accepted.statusCode, 202);
    assert.deepEqual(accepted.json(), { accepted: true });
    const working = (await web.inject({ url: '/api/status', headers })).json();
    assert.equal(working.server.busy, true);
    assert.equal(working.pack.minecraftVersion, '26.3');
    release();
    let status = working;
    for (let attempt = 0; attempt < 40; attempt++) {
      const response = await web.inject({ url: '/api/status', headers });
      assert.equal(response.statusCode, 200);
      status = response.json();
      if (!status.server.busy && !status.jobRunning) break;
      await delay(25);
    }
    assert.equal(status.server.busy, false, 'Installation did not finish within the bounded polling window.');
    assert.equal(status.jobRunning, false);
    assert.equal(status.server.state, 'stopped');
    assert.equal(status.server.installationError, undefined);
    assert.equal(status.pack.minecraftVersion, target.minecraftVersion);
    assert.equal(status.pack.loader, target.loader);
    assert.equal(status.pack.loaderVersion, target.loaderVersion);
    assert.deepEqual(calls, [target]);
    const zip = await web.inject({ url: '/api/pack/download', headers });
    assert.equal(zip.statusCode, 200);
    const { manifest } = await inspectManifest(zip.rawPayload);
    assert.equal(manifest.minecraft.version, '1.7.10');
    assert.deepEqual(manifest.minecraft.modLoaders, [{ id: 'forge-10.13.4.1614', primary: true }]);
    assert.equal(manifest.name, 'Dictionary Minecraft Server');
    assert.equal(await readFile(path.join(runtime, 'minecraft', 'config', 'settings.json'), 'utf8'), '{"original":true}');
    const controllerStatus = (await setup.app.inject({ url: '/status', headers: authorization })).json();
    assert.equal(controllerStatus.server.state, 'stopped');
    assert.equal(controllerStatus.server.version, target.minecraftVersion);
    assert.equal(controllerStatus.server.loader, target.loader);
    assert.equal(controllerStatus.server.loaderVersion, target.loaderVersion);
    assert.deepEqual((await setup.app.inject({ url: '/logs', headers: authorization })).json().lines, []);
  } finally { release(); await web?.close(); await setup.dispose(); await rm(appRoot, { recursive: true, force: true }); }
});

test('version installation is authenticated, exclusive, stopped and reports failures without changing the running target', async () => {
  let release!: () => void;
  let calls = 0;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const target = { minecraftVersion: '1.7.10', loader: 'Forge' as const, loaderVersion: '10.13.4.1614' };
  const setup = await fixture(true, {
    catalog: async () => ({ versions: ['26.3', '1.7.10', '1.6.4'], minecraftVersion: '1.7.10', loaders: [{ loader: 'Forge', loaderVersion: target.loaderVersion }] }),
    install: async () => { calls++; await pending; throw new Error('Simulated installer failure; original retained.'); },
  });
  try {
    assert.equal((await setup.app.inject({ url: '/versions' })).statusCode, 401);
    assert.deepEqual((await setup.app.inject({ url: '/versions?minecraftVersion=1.7.10', headers: authorization })).json().versions, ['26.3', '1.7.10', '1.6.4']);
    assert.equal((await setup.app.inject({ method: 'POST', url: '/installation', headers: authorization, payload: { ...target, command: 'sh' } })).statusCode, 400);
    assert.equal((await setup.app.inject({ method: 'POST', url: '/installation', headers: authorization, payload: target })).statusCode, 202);
    assert.equal((await setup.app.inject({ url: '/status', headers: authorization })).json().server.busy, true);
    assert.equal((await setup.app.inject({ method: 'POST', url: '/installation', headers: authorization, payload: target })).statusCode, 409);
    assert.equal((await setup.app.inject({ method: 'POST', url: '/action', headers: authorization, payload: { action: 'start' } })).statusCode, 409);
    assert.equal((await setup.app.inject({ method: 'POST', url: '/workspace/entries/remove', headers: authorization, payload: { path: 'config/settings.json' } })).statusCode, 409);
    release();
    await new Promise(resolve => setImmediate(resolve));
    const status = (await setup.app.inject({ url: '/status', headers: authorization })).json().server;
    assert.equal(status.busy, false);
    assert.equal(status.version, '26.3');
    assert.match(status.installationError, /original retained/);
    assert.equal(calls, 1);
    assert.equal((await setup.app.inject({ method: 'POST', url: '/action', headers: authorization, payload: { action: 'start' } })).statusCode, 200);
    assert.equal((await setup.app.inject({ method: 'POST', url: '/installation', headers: authorization, payload: target })).statusCode, 409);
  } finally { release(); await setup.dispose(); }
});
