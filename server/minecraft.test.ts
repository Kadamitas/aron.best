import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MinecraftServer } from './minecraft.js';

const runningServer = `
  process.stdout.write('Done (0.01s)!\\n');
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', data => { if (data.includes('stop')) process.exit(0); });
`;
type Dependencies = NonNullable<ConstructorParameters<typeof MinecraftServer>[1]>;

async function fixture(dependencies: Dependencies = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'aron-minecraft-'));
  const directory = path.join(root, 'minecraft');
  await mkdir(path.join(directory, 'mods'), { recursive: true });
  await writeFile(path.join(directory, 'mods', 'old.jar'), 'old');
  await writeFile(path.join(directory, 'fabric-server-launch.jar'), 'fixture');
  await writeFile(path.join(directory, 'eula.txt'), 'eula=true\n');
  let launches = 0;
  const server = new MinecraftServer({ directory, java: process.execPath, memoryMb: 512, version: '26.3', address: 'mc.aron.best', activity: () => undefined }, {
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

test('backup free-space preflight counts nested files and never leaves a partial successful snapshot', async () => {
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

test('the backup cap preserves all existing backups and refuses another copy', async () => {
  const setup = await fixture();
  try {
    const backups = path.join(setup.root, 'backups');
    await mkdir(backups);
    for (let index = 0; index < 20; index += 1) await mkdir(path.join(backups, `retained-${index}`));
    await writeFile(path.join(backups, 'retained-0', 'world-save'), 'irreplaceable');
    await assert.rejects(setup.server.action('backup'), /20-backup limit/);
    assert.equal((await readdir(backups)).length, 20);
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
    assert.equal(await readFile(path.join(setup.root, 'backups', backup, 'mods', 'old.jar'), 'utf8'), 'old');
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
