import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { BackupObjects, type BackupObjectManifest } from './backup-objects.js';
import { collectBackupObjects, migrateBackups } from './backup-maintenance.js';

const timestamp = '2026-09-21T17:05:00.000Z';
const target = { minecraftVersion: '1.20.1', loader: 'Fabric', loaderVersion: '0.18.4' };
async function fixture(context: TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'aron-backup-maintenance-')));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function makeDirectory(directory: string): Promise<void> { await mkdir(directory, { recursive: true, mode: 0o700 }); }
async function json(file: string) { return JSON.parse(await readFile(file, 'utf8')); }
async function legacy(runtime: string, content = 'shared jar', kind?: 'automatic' | 'manual') {
  const name = `${timestamp.replaceAll(':', '-')}-${randomUUID()}`;
  const snapshot = path.join(runtime, 'backups', name);
  await makeDirectory(path.join(snapshot, 'mods'));
  await makeDirectory(path.join(snapshot, 'config', 'empty'));
  await writeFile(path.join(snapshot, 'mods', 'mod.jar'), content);
  await writeFile(path.join(snapshot, 'backup.json'), JSON.stringify({ createdAt: timestamp, items: ['mods', 'config'], snapshotBytes: String(Buffer.byteLength(content)), ...(kind ? { kind } : {}) }));
  return snapshot;
}
async function captured(root: string, content = 'shared jar'): Promise<BackupObjectManifest> {
  const source = path.join(root, 'fixture-sources', randomUUID());
  await makeDirectory(path.join(source, 'mods'));
  await writeFile(path.join(source, 'mods', 'mod.jar'), content);
  return new BackupObjects(path.join(root, 'backup-objects')).capture(source, ['mods']);
}
async function committed(root: string, runtime: string, content: string) {
  const objects = await captured(root, content);
  const snapshot = path.join(runtime, 'backups', `${timestamp.replaceAll(':', '-')}-${randomUUID()}`);
  await makeDirectory(snapshot);
  await writeFile(path.join(snapshot, 'backup.json'), JSON.stringify({ format: 2, createdAt: timestamp, kind: 'automatic', items: ['mods'], ...objects }));
  return { snapshot, objects };
}
function objectPath(root: string, hash: string): string { return path.join(root, 'backup-objects', hash.slice(0, 2), hash); }
async function assertMissing(file: string): Promise<void> { await assert.rejects(lstat(file), { code: 'ENOENT' }); }
async function deletedBundle(root: string, location: 'legacy' | 'managed' | 'incomplete'): Promise<string> {
  const id = randomUUID();
  const bundle = path.join(root, 'deleted-server-profiles', id);
  await makeDirectory(bundle);
  await writeFile(path.join(bundle, 'profile.json'), JSON.stringify({ id, name: 'Old world', removedAt: timestamp, ...(location === 'incomplete' ? { incomplete: true } : { location, ...target }) }));
  const runtime = location === 'legacy' ? bundle : path.join(bundle, 'runtime');
  await makeDirectory(runtime);
  return runtime;
}

test('legacy backups become shared checksummed snapshots while preserving timestamps, kinds and empty folders', async context => {
  const root = await fixture(context);
  const managed = path.join(root, 'server-profiles', randomUUID());
  const first = await legacy(root);
  const second = await legacy(managed, 'shared jar', 'automatic');
  await writeFile(`${first}.tar.gz`, 'old cached archive');
  await migrateBackups(root);
  const one = await json(path.join(first, 'backup.json'));
  const two = await json(path.join(second, 'backup.json'));
  assert.equal(one.format, 2);
  assert.equal(one.createdAt, timestamp);
  assert.equal(one.kind, 'manual');
  assert.equal(two.kind, 'automatic');
  assert.deepEqual(one.files, two.files);
  assert.deepEqual(one.directories, ['config', 'config/empty', 'mods']);
  assert.deepEqual(await readdir(first), ['backup.json']);
  assert.deepEqual(await readdir(second), ['backup.json']);
  await assertMissing(`${first}.tar.gz`);
  const object = objectPath(root, one.files[0].sha256);
  assert.equal(await readFile(object, 'utf8'), 'shared jar');
  assert.equal((await lstat(object)).nlink, 1);
  const restored = path.join(root, 'restored-copy');
  await new BackupObjects(path.join(root, 'backup-objects')).materialize({ files: one.files, directories: one.directories, snapshotBytes: one.snapshotBytes }, restored);
  assert.equal(await readFile(path.join(restored, 'mods', 'mod.jar'), 'utf8'), 'shared jar');
  assert.deepEqual(await readdir(path.join(restored, 'config', 'empty')), []);
  await migrateBackups(root);
  assert.deepEqual(await json(path.join(first, 'backup.json')), one);
});

test('migration handles deleted legacy, managed and incomplete recovery bundles', async context => {
  const root = await fixture(context);
  for (const type of ['legacy', 'managed', 'incomplete'] as const) {
    const runtime = await deletedBundle(root, type);
    const snapshot = await legacy(runtime, `saved ${type}`);
    await migrateBackups(root);
    assert.equal((await json(path.join(snapshot, 'backup.json'))).format, 2);
    assert.deepEqual(await readdir(snapshot), ['backup.json']);
  }
  await collectBackupObjects(root);
});

test('collection keeps references from every known active, deleted and incomplete layout', async context => {
  const root = await fixture(context);
  const managed = path.join(root, 'server-profiles', randomUUID());
  const runtimes = [root, managed];
  for (const type of ['legacy', 'managed', 'incomplete'] as const) runtimes.push(await deletedBundle(root, type));
  const retained = [];
  for (const [index, runtime] of runtimes.entries()) retained.push((await committed(root, runtime, `retained ${index}`)).objects.files[0]!.sha256);
  const orphan = (await captured(root, 'unreferenced content')).files[0]!.sha256;
  await collectBackupObjects(root);
  for (const hash of retained) assert((await lstat(objectPath(root, hash))).isFile());
  await assertMissing(objectPath(root, orphan));
});

test('collection respects valid incomplete snapshots and pending migration references', async context => {
  const root = await fixture(context);
  const { snapshot, objects } = await committed(root, root, 'old captured bytes');
  const pending = await captured(root, 'new captured bytes');
  await writeFile(path.join(snapshot, `.backup-migration-${randomUUID()}.json`), JSON.stringify({ format: 2, createdAt: timestamp, kind: 'automatic', items: ['mods'], ...pending }));
  const staged = path.join(root, 'backups', `.incomplete-${timestamp.replaceAll(':', '-')}-${randomUUID()}`);
  await makeDirectory(staged);
  await writeFile(path.join(staged, 'backup.json'), JSON.stringify({ format: 2, createdAt: timestamp, kind: 'automatic', items: ['mods'], ...pending }));
  const orphan = (await captured(root, 'orphan')).files[0]!.sha256;
  await collectBackupObjects(root);
  assert((await lstat(objectPath(root, objects.files[0]!.sha256))).isFile());
  assert((await lstat(objectPath(root, pending.files[0]!.sha256))).isFile());
  await assertMissing(objectPath(root, orphan));
});

test('committed migration cleanup resumes after some legacy files were already removed', async context => {
  const root = await fixture(context);
  const snapshot = await legacy(root);
  const objects = await new BackupObjects(path.join(root, 'backup-objects')).capture(snapshot, ['mods', 'config']);
  await writeFile(path.join(snapshot, 'backup.json'), JSON.stringify({ format: 2, createdAt: timestamp, kind: 'manual', items: ['mods', 'config'], ...objects }));
  await unlink(path.join(snapshot, 'mods', 'mod.jar'));
  await migrateBackups(root);
  assert.deepEqual(await readdir(snapshot), ['backup.json']);
  assert.equal(await readFile(objectPath(root, objects.files[0]!.sha256), 'utf8'), 'shared jar');
});

test('migration leaves legacy copies intact when recorded sizes do not match', async context => {
  const root = await fixture(context);
  const snapshot = await legacy(root);
  const metadata = await json(path.join(snapshot, 'backup.json'));
  await writeFile(path.join(snapshot, 'backup.json'), JSON.stringify({ ...metadata, snapshotBytes: '99' }));
  await assert.rejects(migrateBackups(root), /size does not match/);
  assert.equal(await readFile(path.join(snapshot, 'mods', 'mod.jar'), 'utf8'), 'shared jar');
  assert.equal((await json(path.join(snapshot, 'backup.json'))).format, undefined);
});

test('migration preserves unknown snapshot files without altering metadata', async context => {
  const root = await fixture(context);
  const snapshot = await legacy(root);
  await writeFile(path.join(snapshot, 'keep-my-notes.txt'), 'not migration data');
  await assert.rejects(migrateBackups(root), /unknown files/);
  assert.equal(await readFile(path.join(snapshot, 'keep-my-notes.txt'), 'utf8'), 'not migration data');
  assert.equal((await json(path.join(snapshot, 'backup.json'))).format, undefined);
});

test('migration rejects linked legacy files without deleting either link', async context => {
  const root = await fixture(context);
  const snapshot = await legacy(root);
  const second = path.join(root, 'keep.jar');
  await link(path.join(snapshot, 'mods', 'mod.jar'), second);
  await assert.rejects(migrateBackups(root), /linked|hard link/);
  assert.equal((await lstat(second)).nlink, 2);
  assert.equal((await json(path.join(snapshot, 'backup.json'))).format, undefined);
});

test('collection refuses linked backup folders and preserves unreferenced objects', async context => {
  const root = await fixture(context);
  const outside = await fixture(context);
  const orphan = (await captured(root, 'must survive')).files[0]!.sha256;
  await symlink(outside, path.join(root, 'backups'));
  await assert.rejects(collectBackupObjects(root), /linked|invalid/);
  assert.equal(await readFile(objectPath(root, orphan), 'utf8'), 'must survive');
});

test('collection refuses unknown profile layouts before removing objects', async context => {
  const root = await fixture(context);
  const orphan = (await captured(root, 'must survive')).files[0]!.sha256;
  await makeDirectory(path.join(root, 'server-profiles', 'unexpected-server'));
  await assert.rejects(collectBackupObjects(root), /unknown saved server/);
  assert.equal(await readFile(objectPath(root, orphan), 'utf8'), 'must survive');
});

test('collection refuses corrupt manifests and preserves every stored object', async context => {
  const root = await fixture(context);
  const { snapshot, objects } = await committed(root, root, 'retained');
  const orphan = (await captured(root, 'orphan')).files[0]!.sha256;
  await writeFile(path.join(snapshot, 'backup.json'), '{');
  await assert.rejects(collectBackupObjects(root), /valid JSON/);
  assert((await lstat(objectPath(root, orphan))).isFile());
  assert((await lstat(objectPath(root, objects.files[0]!.sha256))).isFile());
});

test('collection verifies referenced object sizes before deleting unreferenced data', async context => {
  const root = await fixture(context);
  const { snapshot, objects } = await committed(root, root, 'retained');
  const orphan = (await captured(root, 'orphan')).files[0]!.sha256;
  const metadata = await json(path.join(snapshot, 'backup.json'));
  metadata.files[0].size++;
  metadata.snapshotBytes = String(metadata.files[0].size);
  await writeFile(path.join(snapshot, 'backup.json'), JSON.stringify(metadata));
  await assert.rejects(collectBackupObjects(root), /invalid size/);
  assert((await lstat(objectPath(root, orphan))).isFile());
  assert((await lstat(objectPath(root, objects.files[0]!.sha256))).isFile());
});

test('cleanup will not remove changed legacy bytes after a format-2 commit', async context => {
  const root = await fixture(context);
  const snapshot = await legacy(root);
  const objects = await new BackupObjects(path.join(root, 'backup-objects')).capture(snapshot, ['mods', 'config']);
  await writeFile(path.join(snapshot, 'backup.json'), JSON.stringify({ format: 2, createdAt: timestamp, kind: 'manual', items: ['mods', 'config'], ...objects }));
  await writeFile(path.join(snapshot, 'mods', 'mod.jar'), 'other jar!');
  await assert.rejects(migrateBackups(root), /does not match|unexpected legacy file/);
  assert.equal(await readFile(path.join(snapshot, 'mods', 'mod.jar'), 'utf8'), 'other jar!');
  assert.equal(objects.files[0]!.sha256, createHash('sha256').update('shared jar').digest('hex'));
  assert.equal(await readFile(objectPath(root, objects.files[0]!.sha256), 'utf8'), 'shared jar');
});
