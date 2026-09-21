import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, test } from 'node:test';
import { createApp, readConfiguration } from './app.js';
import { CurseForgeClient } from './curseforge.js';
import { copyVerifiedFile } from './download.js';
import { LocalProfileService, validateProfilePath } from './local-profile.js';
import { PackService } from './modpack.js';

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
async function temporary(prefix: string) { const folder = await mkdtemp(path.join(tmpdir(), prefix)); folders.push(folder); return folder; }

function jar(name: string, content: string) {
  const bytes = Buffer.from(content);
  return { name, bytes, sha1: createHash('sha1').update(bytes).digest('hex'), md5: createHash('md5').update(bytes).digest('hex') };
}
type Jar = ReturnType<typeof jar>;

async function writeProfile(root: string, mods: Jar[], overrides: Record<string, unknown> = {}, files: Record<string, string> = {}, offset = 0) {
  const instance = path.join(root, 'Instances', "Friend's Modpack");
  await mkdir(path.join(instance, 'mods'), { recursive: true });
  for (const mod of mods) await writeFile(path.join(instance, 'mods', mod.name), mod.bytes);
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(instance, 'mods', name), content);
  const metadata = {
    name: "Friend's Modpack", gameVersion: '26.3', gameTypeID: 432,
    baseModLoader: { type: 4, forgeVersion: '0.19.5', minecraftVersion: '26.3' },
    installedAddons: mods.map((mod, index) => ({
      addonID: 1000 + index + offset, gameID: 432, categoryClassID: 6, name: `Mod ${index}`, isEnabled: true, isModified: false,
      webSiteURL: `https://www.curseforge.com/minecraft/mc-mods/mod-${index + offset}`,
      installedFile: { id: 5000 + index + offset, fileName: mod.name, fileLength: mod.bytes.length, fileStatus: 4, releaseType: 1, isAvailable: true,
        downloadUrl: `https://edge.forgecdn.net/files/${mod.name}`, gameVersion: ['26.3', 'Fabric'],
        hashes: [{ type: 1, value: mod.sha1 }, { type: 2, value: mod.md5 }], dependencies: [] },
    })),
    ...overrides,
  };
  const metadataPath = path.join(instance, 'minecraftinstance.json');
  await writeFile(metadataPath, JSON.stringify(metadata));
  return { instance, metadataPath };
}

test('the profile path is fixed host configuration and must name the App metadata file', () => {
  assert.equal(validateProfilePath(undefined), undefined);
  assert.equal(validateProfilePath(''), undefined);
  assert.throws(() => validateProfilePath('Instances/Pack/minecraftinstance.json'), /absolute path/);
  assert.throws(() => validateProfilePath('/Users/host/Instances/Pack/manifest.json'), /minecraftinstance\.json/);
  assert.equal(validateProfilePath('/Users/host/Instances/Pack/minecraftinstance.json'), '/Users/host/Instances/Pack/minecraftinstance.json');
});

test('inspect accepts a clean profile and rejects untracked, disabled, resized, or linked mod files', async () => {
  const root = await temporary('aron-profile-');
  const mods = [jar('alpha-1.0.jar', 'alpha bytes'), jar('beta-2.0.jar', 'beta bytes')];
  const { instance, metadataPath } = await writeProfile(root, mods);
  const service = new LocalProfileService(metadataPath);
  const snapshot = await service.inspect();
  assert.equal(snapshot.pack.name, "Friend's Modpack");
  assert.deepEqual(snapshot.files.map(file => file.fileName), ['alpha-1.0.jar', 'beta-2.0.jar']);
  const resolved = await realpath(instance);
  assert.equal(snapshot.files[0]!.localPath, path.join(resolved, 'mods', 'alpha-1.0.jar'));
  assert.equal(snapshot.modsDirectory, path.join(resolved, 'mods'));

  await writeFile(path.join(instance, 'mods', 'stray.jar'), 'not recorded');
  await assert.rejects(service.inspect(), /did not record/);
  await rm(path.join(instance, 'mods', 'stray.jar'));

  await writeFile(path.join(instance, 'mods', 'gamma.jar.disabled'), 'disabled');
  await assert.rejects(service.inspect(), /disabled mods/);
  await rm(path.join(instance, 'mods', 'gamma.jar.disabled'));

  await writeFile(path.join(instance, 'mods', 'alpha-1.0.jar'), 'alpha bytes changed');
  await assert.rejects(service.inspect(), /does not match the size/);
  await writeFile(path.join(instance, 'mods', 'alpha-1.0.jar'), mods[0]!.bytes);

  const elsewhere = path.join(root, 'elsewhere');
  await mkdir(elsewhere);
  await rm(path.join(instance, 'mods'), { recursive: true });
  await symlink(elsewhere, path.join(instance, 'mods'));
  await assert.rejects(service.inspect(), /symbolic link/);

  await assert.rejects(new LocalProfileService().inspect(), /not configured/);
  await assert.rejects(new LocalProfileService(path.join(root, 'missing', 'minecraftinstance.json')).inspect(), /missing/);
});

test('inspect refuses profiles with override files or locally modified mods', async () => {
  const root = await temporary('aron-profile-');
  const mods = [jar('alpha-1.0.jar', 'alpha bytes')];
  const overridden = await writeProfile(path.join(root, 'a'), mods, { modpackOverrides: ['config/thing.toml'] });
  await assert.rejects(new LocalProfileService(overridden.metadataPath).inspect(), /override/);
  const { metadataPath } = await writeProfile(path.join(root, 'b'), mods);
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  metadata.installedAddons[0].isModified = true;
  await writeFile(metadataPath, JSON.stringify(metadata));
  await assert.rejects(new LocalProfileService(metadataPath).inspect(), /locally modified/);
});

test('verified copies hash every byte and leave nothing behind on mismatch', async () => {
  const root = await temporary('aron-copy-');
  const mod = jar('alpha-1.0.jar', 'alpha bytes');
  const source = path.join(root, mod.name);
  await writeFile(source, mod.bytes);
  const destination = path.join(root, 'staged', mod.name);
  await mkdir(path.dirname(destination));
  await copyVerifiedFile(source, destination, { hashes: [{ algo: 1, value: mod.sha1.toUpperCase() }], expectedBytes: mod.bytes.length });
  assert.equal(await readFile(destination, 'utf8'), 'alpha bytes');

  await assert.rejects(copyVerifiedFile(source, path.join(root, 'staged', 'bad.jar'), { hashes: [{ algo: 1, value: 'f'.repeat(40) }] }), /checksum/);
  await assert.rejects(copyVerifiedFile(source, path.join(root, 'staged', 'bad.jar'), { hashes: [{ algo: 1, value: mod.sha1 }], expectedBytes: 3 }), /size/);
  await assert.rejects(copyVerifiedFile(source, path.join(root, 'staged', 'bad.jar'), { hashes: [{ algo: 9, value: 'x' }] }), /No supported checksum/);
  await symlink(source, path.join(root, 'link.jar'));
  await assert.rejects(copyVerifiedFile(path.join(root, 'link.jar'), path.join(root, 'staged', 'bad.jar'), {}), /regular file/);
  assert.deepEqual(await readdir(path.join(root, 'staged')), [mod.name]);
});

test('mod links are stored as requests without fetching and follow the installed pack', async () => {
  const root = await temporary('aron-requests-');
  const client = new CurseForgeClient({ fetch: (async () => { throw new Error('No network access is expected for link requests.'); }) as typeof fetch });
  const service = new PackService({ statePath: path.join(root, 'pack.json'), client, minecraftVersion: '26.3', loader: 'Fabric', loaderVersion: '0.19.5', name: "Friend's Modpack" });
  for (const bad of ['http://www.curseforge.com/minecraft/mc-mods/sodium', 'https://curseforge.example/minecraft/mc-mods/sodium', 'https://www.curseforge.com/minecraft/modpacks/sodium', 'https://www.curseforge.com/minecraft/mc-mods/../etc', 'not a url']) {
    await assert.rejects(service.requestMod(bad), /CurseForge Minecraft mod page/, bad);
  }
  const first = await service.requestMod('https://curseforge.com/minecraft/mc-mods/Sodium/');
  assert.equal(first.url, 'https://www.curseforge.com/minecraft/mc-mods/sodium');
  assert.equal(first.slug, 'sodium');
  assert.equal(first.status, 'pending');
  const duplicate = await service.requestMod('https://www.curseforge.com/minecraft/mc-mods/sodium');
  assert.equal(duplicate.id, first.id);
  const pinned = await service.requestMod('https://www.curseforge.com/minecraft/mc-mods/mod-0/files/5000');
  assert.equal(pinned.status, 'pending');
  assert.equal((await service.getPack()).requests.length, 2);

  const profile = await writeProfile(root, [jar('alpha-1.0.jar', 'alpha bytes')]);
  const snapshot = await new LocalProfileService(profile.metadataPath).inspect();
  const imported = await service.importLocalProfile(snapshot.pack);
  assert.equal(imported.version, '0.1.1');
  assert.deepEqual(imported.requests.map(request => request.status), ['installed', 'pending']);

  const replaced = await writeProfile(path.join(root, 'next'), [jar('beta-2.0.jar', 'beta bytes')], {}, {}, 10);
  const next = await service.importLocalProfile((await new LocalProfileService(replaced.metadataPath).inspect()).pack);
  assert.equal(next.version, '0.1.2');
  assert.deepEqual(next.mods.map(mod => mod.name), ['Mod 0']);
  assert.equal(next.history.length, 1);
  assert.equal(next.history[0]!.version, 'alpha-1.0.jar');
  assert.ok(Number.isFinite(Date.parse(next.history[0]!.removedAt)));
  assert.deepEqual(next.requests.map(request => request.status), ['pending', 'pending']);

  const unchanged = await service.importLocalProfile((await new LocalProfileService(replaced.metadataPath).inspect()).pack);
  assert.equal(unchanged.version, '0.1.2');
  const renamed = { ...snapshot.pack, name: 'Another Pack' };
  await assert.rejects(service.importLocalProfile(renamed), /must match this pack/);
});

const runningServer = `
  process.stdout.write('Done (0.01s)!\\n');
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', data => { if (data.includes('stop')) process.exit(0); });
`;
const crashingServer = `
  require('node:fs').mkdirSync('crash-reports', { recursive: true });
  require('node:fs').writeFileSync('crash-reports/crash-2026-09-21_01.02.03-server.txt', '---- Minecraft Crash Report ----\\nDescription: Broken mod\\n');
  process.stderr.write('Mixin apply failed\\n');
  process.exit(1);
`;

async function workshop(root: string, metadataPath: string, launches: string[]) {
  const runtime = path.join(root, 'runtime');
  const minecraft = path.join(runtime, 'minecraft');
  await mkdir(path.join(minecraft, 'mods'), { recursive: true });
  await writeFile(path.join(minecraft, 'mods', 'old.jar'), 'old');
  await writeFile(path.join(minecraft, 'fabric-server-launch.jar'), 'fixture');
  await writeFile(path.join(minecraft, 'eula.txt'), 'eula=true\n');
  await writeFile(path.join(runtime, 'pack.json'), JSON.stringify({ name: "Friend's Modpack", minecraftVersion: '26.3', loader: 'Fabric', loaderVersion: '0.19.5', version: '0.3.0', releases: [], history: [], requests: [],
    mods: [{ id: 42, name: 'Old Mod', summary: 'Previously installed', downloadCount: 0, fileId: 420, version: 'old.jar', explicit: true, dependencies: [], conflicts: [], requiredBy: [] }] }));
  const secret = 'p'.repeat(43);
  let count = 0;
  const app = await createApp(readConfiguration({ NODE_ENV: 'test', RUNTIME_DIRECTORY: runtime, FRIEND_ACCESS_TOKEN: secret, CURSEFORGE_PROFILE_PATH: metadataPath }), {
    minecraft: { launch: (_command, _arguments, options) => spawn(process.execPath, ['-e', launches[Math.min(count++, launches.length - 1)]!], { ...options, stdio: 'pipe' }), availableBytes: async () => 8n * 1024n ** 3n },
  });
  const headers = { host: 'mc.modpack.aron.best', origin: 'https://mc.modpack.aron.best', authorization: `Bearer ${secret}` };
  const status = async () => (await app.inject({ url: '/api/status', headers })).json();
  const settle = async () => { for (let i = 0; i < 300; i++) { if (!(await status()).jobRunning) return; await delay(100); } throw new Error('The server job did not finish.'); };
  return { app, headers, minecraft, runtime, status, settle };
}

test('friends request links, the host imports the App profile, and sync only commits after a healthy restart', async () => {
  const root = await temporary('aron-sync-');
  const mod = jar('alpha-1.0.jar', 'alpha bytes');
  const { metadataPath } = await writeProfile(root, [mod]);
  const site = await workshop(root, metadataPath, [runningServer]);
  try {
    assert.equal((await site.app.inject({ url: '/api/status', headers: { host: 'mc.modpack.aron.best' } })).statusCode, 401);
    const initial = await site.status();
    assert.equal(initial.capabilities.localProfile, true);
    assert.deepEqual(initial.history, []);
    const request = await site.app.inject({ method: 'POST', url: '/api/pack/requests', headers: site.headers, payload: { url: 'https://www.curseforge.com/minecraft/mc-mods/mod-0' } });
    assert.equal(request.statusCode, 200);
    assert.equal(request.json().status, 'pending');
    assert.equal((await site.app.inject({ method: 'POST', url: '/api/pack/requests', headers: site.headers, payload: { url: 'javascript:alert(1)' } })).statusCode, 400);
    assert.equal((await site.app.inject({ method: 'POST', url: '/api/pack/requests', headers: { host: 'mc.modpack.aron.best', origin: 'https://mc.modpack.aron.best' }, payload: { url: 'https://www.curseforge.com/minecraft/mc-mods/mod-0' } })).statusCode, 401);

    assert.equal((await site.app.inject({ method: 'POST', url: '/api/server/action', headers: site.headers, payload: { action: 'start' } })).statusCode, 202);
    await site.settle();
    assert.equal((await site.status()).server.state, 'running');

    assert.equal((await site.app.inject({ method: 'POST', url: '/api/server/action', headers: site.headers, payload: { action: 'sync-profile' } })).statusCode, 202);
    await site.settle();
    const synced = await site.status();
    assert.equal(synced.server.state, 'running');
    assert.deepEqual(await readdir(path.join(site.minecraft, 'mods')), ['alpha-1.0.jar']);
    assert.equal(await readFile(path.join(site.minecraft, 'mods', 'alpha-1.0.jar'), 'utf8'), 'alpha bytes');
    assert.deepEqual(synced.pack.mods.map((entry: { name: string }) => entry.name), ['Mod 0']);
    assert.equal(synced.pack.version, '0.3.1');
    assert.deepEqual(synced.history.map((entry: { name: string }) => entry.name), ['Old Mod']);
    assert.deepEqual(synced.requests.map((entry: { status: string }) => entry.status), ['installed']);
    assert.ok(synced.activity.some((entry: { message: string }) => entry.message.includes('App pack sync completed')));
    const backups = await readdir(path.join(site.runtime, 'backups'));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(path.join(site.runtime, 'backups', backups[0]!, 'mods', 'old.jar'), 'utf8'), 'old');
    const persisted = JSON.parse(await readFile(path.join(site.runtime, 'pack.json'), 'utf8'));
    assert.equal(persisted.version, '0.3.1');
  } finally { await site.app.close(); }
});

test('a sync that crashes the server rolls back the mods, keeps the draft, and shows friends the crash report', async () => {
  const root = await temporary('aron-sync-fail-');
  const mod = jar('alpha-1.0.jar', 'alpha bytes');
  const { metadataPath } = await writeProfile(root, [mod]);
  const site = await workshop(root, metadataPath, [runningServer, crashingServer, runningServer]);
  try {
    assert.equal((await site.app.inject({ method: 'POST', url: '/api/server/action', headers: site.headers, payload: { action: 'start' } })).statusCode, 202);
    await site.settle();
    assert.equal((await site.app.inject({ method: 'POST', url: '/api/server/action', headers: site.headers, payload: { action: 'sync-profile' } })).statusCode, 202);
    await site.settle();
    const after = await site.status();
    assert.equal(after.server.state, 'running');
    assert.deepEqual(await readdir(path.join(site.minecraft, 'mods')), ['old.jar']);
    assert.equal(after.pack.version, '0.3.0');
    assert.deepEqual(after.history, []);
    assert.ok(after.activity.some((entry: { message: string }) => entry.message.startsWith('App pack sync failed')));
    assert.ok(after.server.failure, 'the failed launch is recorded');
    assert.match(after.server.failure.message, /exit code 1/);
    assert.ok(Number.isFinite(Date.parse(after.server.failure.recoveredAt)), 'the rollback restart is marked as recovery');
    assert.ok(after.server.crashLog.some((line: string) => line.includes('Broken mod')));
    assert.match(after.server.crashLog[0], /crash-2026-09-21_01\.02\.03-server\.txt/);
    assert.equal((await site.app.inject({ url: '/api/status', headers: { host: 'mc.modpack.aron.best' } })).statusCode, 401);
  } finally { await site.app.close(); }
});
