import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { link, mkdtemp, mkdir, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MinecraftServer } from './minecraft.js';
import { BackupObjects } from './backup-objects.js';

const runningServer = `
  process.stdout.write('Done (0.01s)!\\n');
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', data => { if (data.includes('stop')) process.exit(0); });
`;
type Dependencies = NonNullable<ConstructorParameters<typeof MinecraftServer>[1]>;

async function fixture(dependencies: Dependencies = {}, backupObjectsDirectory?: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'aron-minecraft-'));
  const directory = path.join(root, 'minecraft');
  await mkdir(path.join(directory, 'mods'), { recursive: true });
  await writeFile(path.join(directory, 'mods', 'old.jar'), 'old');
  await writeFile(path.join(directory, 'fabric-server-launch.jar'), 'fixture');
  await writeFile(path.join(directory, 'eula.txt'), 'eula=true\n');
  let launches = 0;
  const server = new MinecraftServer({ directory, java: process.execPath, memoryMb: 512, version: '26.3', address: 'mc.aron.best', activity: () => undefined, ...(backupObjectsDirectory ? { backupObjectsDirectory } : {}) }, {
    launch: (_command, _arguments, options) => {
      launches += 1;
      return spawn(process.execPath, ['-e', runningServer], { ...options, stdio: 'pipe' });
    },
    availableBytes: async () => 8n * 1024n ** 3n,
    ...dependencies,
  });
  await server.initialize();
  return { root, directory, server, launches: () => launches, dispose: async () => { await server.shutdown(); await rm(root, { recursive: true, force: true }); } };
}

async function snapshotFile(root: string, snapshot: string, file: string) {
  const manifest = JSON.parse(await readFile(path.join(snapshot, 'backup.json'), 'utf8'));
  const reference = manifest.files.find((entry: { path: string }) => entry.path === file);
  assert.ok(reference);
  const handle = await new BackupObjects(path.join(root, 'backup-objects')).openObject(reference.sha256, reference.size);
  try { return await handle.readFile('utf8'); } finally { await handle.close(); }
}

test('backup free-space preflight preserves the recovery reserve and never leaves a partial successful snapshot', async () => {
  const setup = await fixture({ availableBytes: async () => 256n * 1024n ** 2n + 13n });
  try {
    await mkdir(path.join(setup.directory, 'world', 'region'), { recursive: true });
    await writeFile(path.join(setup.directory, 'world', 'region', 'r.0.0.mca'), 'data');
    await assert.rejects(setup.server.action('backup'), /Not enough free disk space/);
    assert.deepEqual(await readdir(path.join(setup.root, 'backups')), []);
    assert.equal(setup.server.status().lastBackup, null);
    assert.equal(await readFile(path.join(setup.directory, 'world', 'region', 'r.0.0.mca'), 'utf8'), 'data');
  } finally { await setup.dispose(); }
});

test('retention preserves unrecognized backup directories rather than deleting unknown data', async () => {
  const setup = await fixture();
  try {
    const backups = path.join(setup.root, 'backups');
    await mkdir(backups);
    for (let index = 0; index < 20; index += 1) await mkdir(path.join(backups, `retained-${index}`));
    await writeFile(path.join(backups, 'retained-0', 'world-save'), 'irreplaceable');
    assert.ok(await setup.server.action('backup'));
    assert.equal((await readdir(backups)).length, 21);
    assert.equal(await readFile(path.join(backups, 'retained-0', 'world-save'), 'utf8'), 'irreplaceable');
  } finally { await setup.dispose(); }
});

test('snapshot traversal refuses symlinks instead of reading outside the server', async () => {
  const setup = await fixture();
  try {
    const outside = path.join(setup.root, 'private');
    await mkdir(outside);
    await writeFile(path.join(outside, 'unrelated-file'), 'private');
    await symlink(outside, path.join(setup.directory, 'world'));
    await assert.rejects(setup.server.action('backup'), /symbolic links/);
    assert.deepEqual(await readdir(path.join(setup.root, 'backups')), []);
  } finally { await setup.dispose(); }
});

test('backup and pre-swap update failures restart the previously running server', async () => {
  const setup = await fixture({ availableBytes: async directory => path.basename(directory) === 'backups' ? 0n : 8n * 1024n ** 3n });
  try {
    await setup.server.action('start');
    await assert.rejects(setup.server.action('backup'), /Not enough free disk space/);
    assert.equal(setup.server.status().state, 'running');
    assert.equal(setup.launches(), 2);
    await assert.rejects(setup.server.action('update', async () => []), /Not enough free disk space/);
    assert.equal(setup.server.status().state, 'running');
    assert.equal(setup.launches(), 3);
    assert.equal(await readFile(path.join(setup.directory, 'mods', 'old.jar'), 'utf8'), 'old');
    assert.equal((await readdir(setup.directory)).some(name => name.startsWith('mods-staging-')), false);
  } finally { await setup.dispose(); }
});

test('failed new-mod startup restores prior world bytes and previously absent directories', async () => {
  for (const existingWorld of [false, true]) {
    let launches = 0;
    const failedStartup = `
      const fs = require('node:fs');
      fs.mkdirSync('world', { recursive: true });
      fs.mkdirSync('config', { recursive: true });
      fs.writeFileSync('world/level.dat', 'changed-by-broken-mod');
      fs.writeFileSync('config/new-mod.json', '{}');
      fs.writeFileSync('server.properties', 'changed');
      process.exit(1);
    `;
    const setup = await fixture({
      launch: (_command, _arguments, options) => spawn(process.execPath, ['-e', ++launches === 2 ? failedStartup : runningServer], { ...options, stdio: 'pipe' }),
      download: async (_url, destination) => { await writeFile(destination, 'new'); },
    });
    try {
      if (existingWorld) {
        await mkdir(path.join(setup.directory, 'world'));
        await writeFile(path.join(setup.directory, 'world', 'level.dat'), 'original-world');
      }
      await writeFile(path.join(setup.directory, 'installed-mods.json'), '[{"fileId":1}]');
      await setup.server.action('start');
      await assert.rejects(setup.server.action('update', async () => [{ modId: 1, fileId: 2, fileName: 'new.jar', url: 'https://edge.forgecdn.net/new.jar', hashes: [], fileLength: 3 }]), /Minecraft could not start/);
      assert.equal(setup.server.status().state, 'running');
      assert.equal(launches, 3);
      assert.deepEqual(await readdir(path.join(setup.directory, 'mods')), ['old.jar']);
      assert.equal(await readFile(path.join(setup.directory, 'installed-mods.json'), 'utf8'), '[{"fileId":1}]');
      const files = await readdir(setup.directory);
      assert.equal(files.includes('config'), false);
      assert.equal(files.includes('server.properties'), false);
      assert.equal(files.includes('world'), existingWorld);
      if (existingWorld) assert.equal(await readFile(path.join(setup.directory, 'world', 'level.dat'), 'utf8'), 'original-world');
      assert.ok(files.some(name => name.startsWith('world-failed-')));
      assert.ok(files.some(name => name.startsWith('config-failed-')));
    } finally { await setup.dispose(); }
  }
});

test('partially failed cleanup after commit retains the new installation and intact backup', async () => {
  const setup = await fixture({
    removeDirectory: async directory => {
      if (path.basename(directory).startsWith('mods-previous-')) {
        await rm(path.join(directory, 'old.jar'));
        throw new Error('simulated directory cleanup failure');
      }
      await rm(directory, { recursive: true, force: true });
    },
  });
  try {
    await setup.server.action('update', async () => []);
    assert.equal(setup.server.status().state, 'stopped');
    assert.deepEqual(await readdir(path.join(setup.directory, 'mods')), []);
    assert.equal(await readFile(path.join(setup.directory, 'installed-mods.json'), 'utf8'), '[]');
    const backup = (await readdir(path.join(setup.root, 'backups')))[0];
    assert.ok(backup);
    assert.ok(Number.isFinite(Date.parse(setup.server.status().lastBackup ?? '')));
    const timestamp = setup.server.status().lastBackup;
    await setup.server.initialize();
    assert.equal(setup.server.status().lastBackup, timestamp);
    assert.equal(await snapshotFile(setup.root, path.join(setup.root, 'backups', backup), 'mods/old.jar'), 'old');
    assert.ok(setup.server.logs().some(line => line.includes('cleanup failure')));
    assert.equal((await readdir(setup.directory)).some(name => name.startsWith('mods-failed-')), false);
  } finally { await setup.dispose(); }
});

test('a closed Minecraft input pipe cannot crash the controller during stop', async () => {
  const setup = await fixture({
    launch: (_command, _arguments, options) => spawn(process.execPath, ['-e', `require('node:fs').closeSync(0); process.stdout.write('Done (0.01s)!\\n'); setInterval(() => {}, 1000);`], { ...options, stdio: 'pipe' }),
  });
  try {
    await setup.server.action('start');
    await setup.server.action('stop');
    assert.equal(setup.server.status().state, 'stopped');
    assert.ok(setup.server.logs().some(line => line.includes('input closed')));
  } finally { await setup.dispose(); }
});

test('backups retain the newest six manual and automatic snapshots only after committing their replacement', async () => {
  let now = Date.parse('2026-09-21T12:00:00.000Z');
  let removals = 0;
  const setup = await fixture({
    now: () => now,
    removeDirectory: async directory => {
      const snapshots = await readdir(path.dirname(directory));
      assert.equal(snapshots.length, 8);
      assert.equal(snapshots.some(name => name.startsWith('.incomplete-')), false);
      removals++;
      await rm(directory, { recursive: true, force: true });
    },
  });
  try {
    const backups = path.join(setup.root, 'backups');
    await mkdir(backups);
    await mkdir(path.join(backups, 'legacy-snapshot'));
    await writeFile(path.join(backups, 'legacy-snapshot', 'world-save'), 'irreplaceable');
    for (let index = 0; index < 10; index++) {
      now += 60_000;
      await writeFile(path.join(setup.directory, 'mods', 'old.jar'), `${index}`);
      const saved = index % 2 ? await setup.server.action('backup') : await setup.server.automaticBackup();
      assert.ok(saved);
      assert.equal(JSON.parse(await readFile(path.join(saved, 'backup.json'), 'utf8')).kind, index % 2 ? 'manual' : 'automatic');
      assert.deepEqual(await readdir(saved), ['backup.json']);
    }
    const snapshots = await readdir(backups);
    assert.equal(removals, 4);
    assert.equal(snapshots.length, 7);
    assert.equal(await readFile(path.join(backups, 'legacy-snapshot', 'world-save'), 'utf8'), 'irreplaceable');
    const saved = snapshots.filter(name => name !== 'legacy-snapshot');
    assert.deepEqual(await Promise.all(saved.sort().map(name => snapshotFile(setup.root, path.join(backups, name), 'mods/old.jar'))), ['4', '5', '6', '7', '8', '9']);
  } finally { await setup.dispose(); }
});

test('manual and automatic backups share the same six-snapshot retention policy', async () => {
  let now = Date.parse('2026-09-21T12:00:00.000Z');
  const setup = await fixture({ now: () => now++ });
  try {
    for (let index = 0; index < 6; index++) await setup.server.action('backup');
    for (let index = 0; index < 3; index++) assert.ok(await setup.server.automaticBackup());
    const backups = path.join(setup.root, 'backups');
    const snapshots = await readdir(backups);
    assert.equal(snapshots.length, 6);
    const manifests = await Promise.all(snapshots.map(name => readFile(path.join(backups, name, 'backup.json'), 'utf8').then(text => JSON.parse(text))));
    assert.equal(manifests.filter(manifest => manifest.kind === 'manual').length, 3);
    assert.equal(manifests.filter(manifest => manifest.kind === 'automatic').length, 3);
  } finally { await setup.dispose(); }
});

test('server slots share identical checksum objects without exposing shared writable Minecraft files', async () => {
  const shared = await mkdtemp(path.join(tmpdir(), 'aron-shared-backups-'));
  const objects = path.join(shared, 'objects');
  const first = await fixture({}, objects);
  const second = await fixture({}, objects);
  try {
    const left = await first.server.action('backup');
    const right = await second.server.automaticBackup();
    const leftManifest = JSON.parse(await readFile(path.join(left!, 'backup.json'), 'utf8'));
    const rightManifest = JSON.parse(await readFile(path.join(right!, 'backup.json'), 'utf8'));
    assert.deepEqual(leftManifest.files, rightManifest.files);
    assert.equal(leftManifest.format, 2);
    assert.deepEqual(await readdir(left!), ['backup.json']);
    const reference = leftManifest.files.find((file: { path: string }) => file.path === 'mods/old.jar');
    await writeFile(path.join(first.directory, 'mods', 'old.jar'), 'changed');
    const object = await new BackupObjects(objects).openObject(reference.sha256, reference.size);
    try {
      assert.equal(await object.readFile('utf8'), 'old');
      assert.equal((await object.stat()).nlink, 1);
    } finally { await object.close(); }
    assert.equal(await readFile(path.join(second.directory, 'mods', 'old.jar'), 'utf8'), 'old');
    assert.equal((await readdir(path.join(objects, reference.sha256.slice(0, 2)))).filter(name => name === reference.sha256).length, 1);
  } finally { await first.dispose(); await second.dispose(); await rm(shared, { recursive: true, force: true }); }
});

test('update rollback snapshots join automatic retention even when six snapshots already exist', async () => {
  const setup = await fixture();
  try {
    for (let index = 0; index < 6; index++) await setup.server.action('backup');
    await setup.server.action('update', async () => []);
    assert.equal(setup.server.status().state, 'stopped');
    const snapshots = await readdir(path.join(setup.root, 'backups'));
    const manifests = await Promise.all(snapshots.map(name => readFile(path.join(setup.root, 'backups', name, 'backup.json'), 'utf8').then(text => JSON.parse(text))));
    assert.equal(manifests.filter(manifest => manifest.kind === 'manual').length, 5);
    assert.equal(manifests.filter(manifest => manifest.kind === 'automatic').length, 1);
  } finally { await setup.dispose(); }
});

test('a failed automatic snapshot never rotates prior successful backups or changes the success timestamp', async () => {
  let now = Date.parse('2026-09-21T12:00:00.000Z');
  let available = 8n * 1024n ** 3n;
  const setup = await fixture({ now: () => now++, availableBytes: async () => available });
  try {
    for (let index = 0; index < 6; index++) await setup.server.automaticBackup();
    const retained = await readdir(path.join(setup.root, 'backups'));
    const lastBackup = setup.server.status().lastBackup;
    available = 0n;
    await assert.rejects(setup.server.automaticBackup(), /Not enough free disk space/);
    assert.deepEqual(await readdir(path.join(setup.root, 'backups')), retained);
    assert.equal(setup.server.status().lastBackup, lastBackup);
    assert.equal(setup.server.status().busy, false);
  } finally { await setup.dispose(); }
});

test('a failed metadata-space check preserves the previous six snapshots and success timestamp', async () => {
  let now = Date.parse('2026-09-21T12:00:00.000Z');
  let failCommit = false;
  let calls = 0;
  const setup = await fixture({ now: () => now++, availableBytes: async () => failCommit && ++calls > 1 ? 256n * 1024n ** 2n : 8n * 1024n ** 3n });
  try {
    for (let index = 0; index < 6; index++) await setup.server.automaticBackup();
    const backups = path.join(setup.root, 'backups');
    const retained = await readdir(backups);
    const lastBackup = setup.server.status().lastBackup;
    failCommit = true;
    await assert.rejects(setup.server.automaticBackup(), /commit the backup metadata/);
    assert.deepEqual(await readdir(backups), retained);
    assert.equal(setup.server.status().lastBackup, lastBackup);
  } finally { await setup.dispose(); }
});

test('retention removes an old prepared download without interrupting an already opened download', async () => {
  let now = Date.parse('2026-09-21T12:00:00.000Z');
  const setup = await fixture({ now: () => now++ });
  try {
    const oldest = await setup.server.action('backup');
    const archive = `${oldest}.tar.gz`;
    await writeFile(archive, 'already prepared download');
    const download = await open(archive, 'r');
    try {
      for (let index = 0; index < 6; index++) await setup.server.automaticBackup();
      await assert.rejects(readFile(archive), { code: 'ENOENT' });
      assert.equal(await download.readFile('utf8'), 'already prepared download');
      assert.equal((await readdir(path.join(setup.root, 'backups'))).length, 6);
    } finally { await download.close(); }
  } finally { await setup.dispose(); }
});

test('retention preserves unsafe download links and their associated snapshot', async () => {
  let now = Date.parse('2026-09-21T12:00:00.000Z');
  const setup = await fixture({ now: () => now++ });
  try {
    const oldest = await setup.server.action('backup');
    const outside = path.join(setup.root, 'private-download');
    await writeFile(outside, 'private');
    await symlink(outside, `${oldest}.tar.gz`);
    for (let index = 0; index < 6; index++) await setup.server.automaticBackup();
    assert.equal(await snapshotFile(setup.root, oldest!, 'mods/old.jar'), 'old');
    assert.equal(await readFile(outside, 'utf8'), 'private');
    assert.ok(setup.server.logs().some(line => line.includes('retention kept')));
  } finally { await setup.dispose(); }
});

test('valid legacy snapshots rotate only after a new checksum-backed snapshot is committed', async () => {
  let now = Date.parse('2026-09-21T12:00:00.000Z');
  const setup = await fixture({ now: () => now++ });
  try {
    const backups = path.join(setup.root, 'backups');
    const legacy = path.join(backups, '2026-09-20T12-00-00.000Z-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    await mkdir(path.join(legacy, 'mods'), { recursive: true });
    await writeFile(path.join(legacy, 'mods', 'old.jar'), 'legacy');
    await writeFile(path.join(legacy, 'backup.json'), JSON.stringify({ createdAt: '2026-09-20T12:00:00.000Z', items: ['mods'], snapshotBytes: '6' }));
    for (let index = 0; index < 5; index++) await setup.server.action('backup');
    assert.equal(await readFile(path.join(legacy, 'mods', 'old.jar'), 'utf8'), 'legacy');
    const latest = await setup.server.automaticBackup();
    await assert.rejects(readFile(path.join(legacy, 'backup.json')), { code: 'ENOENT' });
    assert.equal(await snapshotFile(setup.root, latest!, 'mods/old.jar'), 'old');
  } finally { await setup.dispose(); }
});

test('validated timestamp-only legacy snapshots count toward six-backup retention', async () => {
  let now = Date.parse('2026-09-21T12:00:00.000Z');
  const setup = await fixture({ now: () => now++ });
  try {
    const backups = path.join(setup.root, 'backups');
    const legacy = path.join(backups, '2026-09-20T12-00-00.000Z');
    await mkdir(path.join(legacy, 'mods'), { recursive: true });
    await writeFile(path.join(legacy, 'mods', 'old.jar'), 'legacy');
    await writeFile(path.join(legacy, 'backup.json'), JSON.stringify({ createdAt: '2026-09-20T12:00:00.000Z', items: ['mods'], snapshotBytes: '6' }));
    for (let index = 0; index < 5; index++) await setup.server.automaticBackup();
    assert.equal((await readdir(backups)).length, 6);
    assert.equal(await readFile(path.join(legacy, 'mods', 'old.jar'), 'utf8'), 'legacy');
    const latest = await setup.server.action('backup');
    assert.equal((await readdir(backups)).length, 6);
    await assert.rejects(readFile(path.join(legacy, 'backup.json')), { code: 'ENOENT' });
    assert.equal(await snapshotFile(setup.root, latest!, 'mods/old.jar'), 'old');
  } finally { await setup.dispose(); }
});

test('stopped-server checkpoints are throttled from persisted successful snapshots', async () => {
  let now = Date.parse('2026-09-21T12:00:00.000Z');
  const setup = await fixture({ now: () => now });
  try {
    assert.equal(setup.server.automaticBackupDue(), true);
    assert.ok(await setup.server.checkpoint());
    assert.equal(setup.launches(), 0);
    assert.equal(setup.server.automaticBackupDue(), false);
    now += 15 * 60_000 - 1;
    assert.equal(await setup.server.checkpoint(), undefined);
    await setup.server.initialize();
    assert.equal(await setup.server.checkpoint(), undefined);
    now++;
    assert.ok(await setup.server.checkpoint());
    assert.equal((await readdir(path.join(setup.root, 'backups'))).length, 2);
    now += 6 * 60 * 60_000;
    assert.equal(setup.server.automaticBackupDue(), true);
  } finally { await setup.dispose(); }
});

test('manual backups also defer checkpoints and periodic automatic backups', async () => {
  const setup = await fixture();
  try {
    await setup.server.action('backup');
    assert.equal(await setup.server.checkpoint(), undefined);
    await setup.server.initialize();
    assert.equal(setup.server.automaticBackupDue(), false);
    assert.equal(await setup.server.checkpoint(), undefined);
  } finally { await setup.dispose(); }
});

test('automatic backups skip active or unknown players and stop and resume a confirmed idle server', async () => {
  let online: number | null = 1;
  let queryFails = false;
  const setup = await fixture({ queryPlayers: async () => {
    if (queryFails) throw new Error('Status unavailable');
    return { online, max: 12, names: online === 0 ? [] : null };
  } });
  try {
    await setup.server.action('start');
    assert.equal(await setup.server.checkpoint(), undefined);
    assert.equal(await setup.server.automaticBackup(), undefined);
    online = null;
    assert.equal(await setup.server.automaticBackup(), undefined);
    online = 0;
    queryFails = true;
    assert.equal(await setup.server.automaticBackup(), undefined);
    assert.equal(setup.launches(), 1);
    queryFails = false;
    assert.ok(await setup.server.automaticBackup());
    assert.equal(setup.launches(), 2);
    assert.equal(setup.server.status().state, 'running');
    assert.equal(setup.server.status().busy, false);
  } finally { await setup.dispose(); }
});

test('automatic backup failure resumes the idle server and preserves its prior snapshot', async () => {
  let available = 8n * 1024n ** 3n;
  const setup = await fixture({ availableBytes: async () => available, queryPlayers: async () => ({ online: 0, max: 12, names: [] }) });
  try {
    const prior = await setup.server.automaticBackup();
    const lastBackup = setup.server.status().lastBackup;
    await setup.server.action('start');
    available = 0n;
    await assert.rejects(setup.server.automaticBackup(), /Not enough free disk space/);
    assert.equal(setup.server.status().state, 'running');
    assert.equal(setup.launches(), 2);
    assert.equal(setup.server.status().lastBackup, lastBackup);
    assert.equal(await snapshotFile(setup.root, prior!, 'mods/old.jar'), 'old');
  } finally { await setup.dispose(); }
});

test('automatic backups do not overlap an existing operation or act on a missing installation', async () => {
  let release: (() => void) | undefined;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const setup = await fixture({ availableBytes: async () => { await wait; return 8n * 1024n ** 3n; } });
  try {
    const backup = setup.server.action('backup');
    assert.equal(await setup.server.automaticBackup(), undefined);
    assert.equal(await setup.server.checkpoint(), undefined);
    release!();
    await backup;
    await rm(path.join(setup.directory, 'fabric-server-launch.jar'));
    await setup.server.initialize();
    assert.equal(setup.server.status().state, 'not-installed');
    assert.equal(await setup.server.automaticBackup(), undefined);
    assert.equal(await setup.server.checkpoint(), undefined);
  } finally { release!(); await setup.dispose(); }
});

test('checkpoints protect failed installations without attempting a restart', async () => {
  let launches = 0;
  const setup = await fixture({ launch: (_command, _arguments, options) => {
    launches++;
    return spawn(process.execPath, ['-e', 'process.exit(1)'], { ...options, stdio: 'pipe' });
  } });
  try {
    await assert.rejects(setup.server.action('start'), /could not start/);
    assert.equal(setup.server.status().state, 'failed');
    assert.ok(await setup.server.checkpoint());
    assert.equal(launches, 1);
    assert.equal(setup.server.status().state, 'failed');
  } finally { await setup.dispose(); }
});

test('automatic snapshots skip startup and shutdown', async () => {
  const setup = await fixture();
  try {
    const startup = setup.server.action('start');
    assert.equal(await setup.server.automaticBackup(), undefined);
    assert.equal(await setup.server.checkpoint(), undefined);
    await startup;
    await setup.server.shutdown();
    assert.equal(await setup.server.automaticBackup(), undefined);
    assert.equal(await setup.server.checkpoint(), undefined);
    assert.equal(setup.server.status().lastBackup, null);
  } finally { await setup.dispose(); }
});

test('retention preserves malformed, symlinked, and hard-linked snapshots', async () => {
  let now = Date.parse('2026-09-21T12:00:00.000Z');
  const setup = await fixture({ now: () => now++ });
  try {
    const original = await setup.server.automaticBackup();
    const outside = path.join(setup.root, 'private');
    await mkdir(outside);
    await writeFile(path.join(outside, 'valuable'), 'preserve');
    await symlink(outside, path.join(original!, 'escaped'));
    const hardlinked = await setup.server.automaticBackup();
    await link(path.join(outside, 'valuable'), path.join(hardlinked!, 'linked-file'));
    for (let index = 0; index < 6; index++) await setup.server.automaticBackup();
    assert.equal(await readFile(path.join(outside, 'valuable'), 'utf8'), 'preserve');
    assert.equal(await snapshotFile(setup.root, original!, 'mods/old.jar'), 'old');
    assert.equal(await snapshotFile(setup.root, hardlinked!, 'mods/old.jar'), 'old');
    assert.ok(setup.server.logs().some(line => line.includes('retention kept') && line.includes('symbolic links')));
    assert.ok(setup.server.logs().some(line => line.includes('retention kept') && line.includes('hard links')));
    const malformed = await setup.server.automaticBackup();
    await writeFile(path.join(malformed!, 'backup.json'), JSON.stringify({ kind: 'automatic', createdAt: '2020-01-01T00:00:00.000Z', items: ['../private'], snapshotBytes: '1' }));
    await writeFile(path.join(malformed!, 'retained'), 'preserve');
    for (let index = 0; index < 6; index++) await setup.server.automaticBackup();
    assert.equal(await readFile(path.join(malformed!, 'retained'), 'utf8'), 'preserve');
  } finally { await setup.dispose(); }
});

test('backup storage rejects a symlinked parent and does not expose linked manifests on reload', async () => {
  const setup = await fixture();
  try {
    const outside = path.join(setup.root, 'private');
    await mkdir(outside);
    await writeFile(path.join(outside, 'manifest'), JSON.stringify({ createdAt: '2099-01-01T00:00:00.000Z' }));
    const backups = path.join(setup.root, 'backups');
    await symlink(outside, backups);
    await assert.rejects(setup.server.automaticBackup(), /backup directory/);
    assert.deepEqual(await readdir(outside), ['manifest']);
    await rm(backups);
    await mkdir(path.join(backups, 'untrusted'), { recursive: true });
    await symlink(path.join(outside, 'manifest'), path.join(backups, 'untrusted', 'backup.json'));
    await setup.server.initialize();
    assert.equal(setup.server.status().lastBackup, null);
  } finally { await setup.dispose(); }
});
