import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { BackupObjects, validateBackupObjectManifest, type BackupObjectManifest } from './backup-objects.js';

const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const absent = async (filename: string) => assert.rejects(access(filename), { code: 'ENOENT' });

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'aron-backup-object-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'minecraft');
  const storage = path.join(root, 'backup-objects');
  await mkdir(source, { mode: 0o700 });
  const objects = new BackupObjects(storage);
  const objectPath = (hash: string) => path.join(storage, hash.slice(0, 2), hash);
  const write = async (relative: string, contents: string | Buffer) => { await mkdir(path.dirname(path.join(source, relative)), { recursive: true }); await writeFile(path.join(source, relative), contents); };
  return { root, source, storage, objects, objectPath, write };
}

test('capture stores SHA256 file references, empty folders, and logical size with private immutable objects', async t => {
  const setup = await fixture(t);
  await setup.write('mods/example.jar', 'identical bytes');
  await setup.write('world/level.dat', 'world data');
  await mkdir(path.join(setup.source, 'world', 'empty'));
  const manifest = await setup.objects.capture(setup.source, ['world', 'mods']);
  assert.deepEqual(manifest.directories, ['mods', 'world', 'world/empty']);
  assert.equal(manifest.snapshotBytes, '25');
  assert.deepEqual(manifest.files.find(file => file.path === 'mods/example.jar'), { path: 'mods/example.jar', sha256: sha256('identical bytes'), size: 15 });
  assert.equal((await lstat(setup.storage)).mode & 0o777, 0o700);
  for (const file of manifest.files) {
    assert.equal((await lstat(setup.objectPath(file.sha256))).mode & 0o777, 0o400);
    assert.equal((await lstat(setup.objectPath(file.sha256))).nlink, 1);
    assert.equal((await lstat(path.dirname(setup.objectPath(file.sha256)))).mode & 0o777, 0o700);
    const handle = await setup.objects.openObject(file.sha256, file.size);
    try { assert.equal(sha256(await handle.readFile()), file.sha256); }
    finally { await handle.close(); }
  }
});

test('identical files across names, slots, and snapshots share exactly one immutable object', async t => {
  const setup = await fixture(t);
  await setup.write('mods/first.jar', 'shared content');
  await setup.write('mods/second.jar', 'shared content');
  const first = await setup.objects.capture(setup.source, ['mods']);
  const secondSource = path.join(setup.root, 'another-slot');
  await mkdir(secondSource);
  await writeFile(path.join(secondSource, 'third.jar'), 'shared content');
  const second = await setup.objects.capture(secondSource, ['third.jar']);
  const before = await lstat(setup.objectPath(first.files[0]!.sha256));
  await setup.objects.capture(setup.source, ['mods']);
  const after = await lstat(setup.objectPath(first.files[0]!.sha256));
  assert.equal(first.files[0]!.sha256, first.files[1]!.sha256);
  assert.equal(second.files[0]!.sha256, first.files[0]!.sha256);
  assert.equal(before.ino, after.ino);
  assert.equal(after.nlink, 1);
  assert.deepEqual(await readdir(setup.storage), [first.files[0]!.sha256.slice(0, 2)]);
  assert.equal((await readdir(path.dirname(setup.objectPath(first.files[0]!.sha256)))).length, 1);
});

test('capturing existing identical objects needs no temporary writes or writable object capacity', async t => {
  const setup = await fixture(t);
  await setup.write('data', Buffer.alloc(2 * 1024 * 1024, 17));
  const initial = await setup.objects.capture(setup.source, ['data']);
  const object = setup.objectPath(initial.files[0]!.sha256);
  const shard = path.dirname(object);
  const before = await lstat(object);
  await chmod(shard, 0o500);
  await chmod(setup.storage, 0o500);
  try {
    assert.deepEqual(await setup.objects.capture(setup.source, ['data']), initial);
    assert.equal((await lstat(object)).ino, before.ino);
    assert.equal((await lstat(object)).ctimeMs, before.ctimeMs);
    assert(!(await readdir(setup.storage)).some(name => name.startsWith('.capture-')));
  } finally { await chmod(setup.storage, 0o700); await chmod(shard, 0o700); }
});

test('materialize copies bytes without sharing writable inodes and preserves empty directories', async t => {
  const setup = await fixture(t);
  await setup.write('config/example.json', '{"enabled":true}');
  await setup.write('world/level.dat', 'saved world');
  await setup.write('empty.txt', '');
  await mkdir(path.join(setup.source, 'empty-folder'));
  const manifest = await setup.objects.capture(setup.source, ['config', 'world', 'empty.txt', 'empty-folder']);
  const destination = path.join(setup.root, 'restored');
  await setup.objects.materialize(manifest, destination);
  assert.equal(await readFile(path.join(destination, 'world/level.dat'), 'utf8'), 'saved world');
  assert.equal(await readFile(path.join(destination, 'empty.txt'), 'utf8'), '');
  assert((await lstat(path.join(destination, 'empty-folder'))).isDirectory());
  const file = manifest.files.find(file => file.path === 'world/level.dat')!;
  assert.notEqual((await lstat(path.join(destination, file.path))).ino, (await lstat(setup.objectPath(file.sha256))).ino);
  assert.equal((await lstat(path.join(destination, file.path))).mode & 0o777, 0o600);
  await writeFile(path.join(destination, file.path), 'changed world');
  assert.equal(await readFile(setup.objectPath(file.sha256), 'utf8'), 'saved world');
});

test('selective restoration restores a folder or nested file without replacing unselected files', async t => {
  const setup = await fixture(t);
  await setup.write('world/region/r.0.0.mca', 'saved region');
  await setup.write('mods/example.jar', 'saved mod');
  const manifest = await setup.objects.capture(setup.source, ['world', 'mods']);
  const destination = path.join(setup.root, 'restored');
  await mkdir(path.join(destination, 'mods'), { recursive: true });
  await writeFile(path.join(destination, 'mods/example.jar'), 'current mod');
  await setup.objects.materialize(manifest, destination, ['world/region/r.0.0.mca']);
  assert.equal(await readFile(path.join(destination, 'world/region/r.0.0.mca'), 'utf8'), 'saved region');
  assert.equal(await readFile(path.join(destination, 'mods/example.jar'), 'utf8'), 'current mod');
  await setup.objects.materialize(manifest, destination, ['mods']);
  assert.equal(await readFile(path.join(destination, 'mods/example.jar'), 'utf8'), 'saved mod');
  await assert.rejects(setup.objects.materialize(manifest, destination, ['missing']), /absent/);
});

test('capture can select nested files and includes required parent folder records', async t => {
  const setup = await fixture(t);
  await setup.write('world/region/saved.mca', 'data');
  await setup.write('world/region/other.mca', 'not selected');
  const manifest = await setup.objects.capture(setup.source, ['world/region/saved.mca']);
  assert.deepEqual(manifest.directories, ['world', 'world/region']);
  assert.deepEqual(manifest.files.map(file => file.path), ['world/region/saved.mca']);
});

test('unsafe, overlapping, duplicate, and missing capture selections fail closed', async t => {
  const setup = await fixture(t);
  await setup.write('a/file', 'data');
  await setup.write('a-b', 'another');
  for (const items of [['../outside'], ['/etc/passwd'], ['a\\file'], ['a/../file'], ['a//file'], ['a', 'a'], ['a', 'a-b', 'a/file']]) await assert.rejects(setup.objects.capture(setup.source, items), /invalid|overlap/);
  await assert.rejects(setup.objects.capture(setup.source, ['missing']), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(setup.source, 'a/file'), 'utf8'), 'data');
});

test('capture rejects symlinks, hardlinks, and symlink parents without reading outside files', async t => {
  const setup = await fixture(t);
  const outside = path.join(setup.root, 'outside');
  await writeFile(outside, 'private');
  await symlink(outside, path.join(setup.source, 'linked'));
  await assert.rejects(setup.objects.capture(setup.source, ['linked']), /regular files/);
  await rm(path.join(setup.source, 'linked'));
  await link(outside, path.join(setup.source, 'linked'));
  await assert.rejects(setup.objects.capture(setup.source, ['linked']), /regular files/);
  await symlink(setup.root, path.join(setup.source, 'parent'));
  await assert.rejects(setup.objects.capture(setup.source, ['parent/outside']), /symbolic links/);
  const alias = path.join(setup.root, 'source-link');
  await symlink(setup.source, alias);
  await assert.rejects(setup.objects.capture(alias, []), /symbolic links/);
  assert.equal(await readFile(outside, 'utf8'), 'private');
});

test('corrupted existing checksum objects are never overwritten or reused', async t => {
  const setup = await fixture(t);
  await setup.write('data', 'original');
  const manifest = await setup.objects.capture(setup.source, ['data']);
  const file = manifest.files[0]!;
  const object = setup.objectPath(file.sha256);
  await chmod(object, 0o600);
  await writeFile(object, 'modified');
  await chmod(object, 0o400);
  await assert.rejects(setup.objects.openObject(file.sha256, file.size), /checksum/);
  await assert.rejects(setup.objects.capture(setup.source, ['data']), /checksum/);
  await assert.rejects(setup.objects.materialize(manifest, path.join(setup.root, 'restore')), /checksum/);
  await absent(path.join(setup.root, 'restore'));
  assert.equal(await readFile(object, 'utf8'), 'modified');
  assert(!(await readdir(setup.storage)).some(name => name.startsWith('.capture-')));
});

test('objects with writable permissions, wrong sizes, hardlinks, or symlinks are rejected', async t => {
  const setup = await fixture(t);
  await setup.write('data', 'original');
  const file = (await setup.objects.capture(setup.source, ['data'])).files[0]!;
  const object = setup.objectPath(file.sha256);
  await assert.rejects(setup.objects.openObject('../outside', file.size), /reference/);
  await assert.rejects(setup.objects.openObject(file.sha256, -1), /reference/);
  await assert.rejects(setup.objects.openObject(file.sha256, file.size + 1), /size or permissions/);
  await chmod(object, 0o600);
  await assert.rejects(setup.objects.openObject(file.sha256, file.size), /permissions/);
  await chmod(object, 0o400);
  await link(object, path.join(setup.root, 'linked-object'));
  await assert.rejects(setup.objects.openObject(file.sha256, file.size), /regular files/);
  await rm(object);
  await symlink(path.join(setup.root, 'linked-object'), object);
  await assert.rejects(setup.objects.openObject(file.sha256, file.size), /regular files/);
});

test('object storage must be private, independent, and free of symlink roots or shards', async t => {
  const setup = await fixture(t);
  await setup.write('data', 'original');
  await mkdir(setup.storage, { mode: 0o755 });
  await chmod(setup.storage, 0o755);
  await assert.rejects(setup.objects.capture(setup.source, ['data']), /private/);
  await chmod(setup.storage, 0o700);
  const hash = sha256('original');
  await symlink(setup.root, path.join(setup.storage, hash.slice(0, 2)));
  await assert.rejects(setup.objects.capture(setup.source, ['data']), /symbolic links/);
  await assert.rejects(new BackupObjects(path.join(setup.source, 'backup-objects')).capture(setup.source, ['data']), /outside/);
  assert.throws(() => new BackupObjects('/'), /dedicated/);
  assert.throws(() => new BackupObjects('relative'), /dedicated/);
});

test('restore rejects linked destination folders and files without touching the target', async t => {
  const setup = await fixture(t);
  await setup.write('config/example.txt', 'saved');
  const manifest = await setup.objects.capture(setup.source, ['config']);
  const destination = path.join(setup.root, 'restore');
  await mkdir(destination);
  await symlink(setup.source, path.join(destination, 'config'));
  await assert.rejects(setup.objects.materialize(manifest, destination), /symbolic links/);
  await rm(path.join(destination, 'config'));
  await mkdir(path.join(destination, 'config'));
  await symlink(path.join(setup.source, 'config/example.txt'), path.join(destination, 'config/example.txt'));
  await assert.rejects(setup.objects.materialize(manifest, destination), /regular files/);
  await assert.rejects(setup.objects.materialize(manifest, setup.storage), /outside/);
  assert.equal(await readFile(path.join(setup.source, 'config/example.txt'), 'utf8'), 'saved');
});

test('manifest validation rejects traversal, conflicts, invalid hashes, missing parents, and size mismatches', () => {
  const base: BackupObjectManifest = { directories: ['world'], files: [{ path: 'world/level.dat', sha256: sha256('world'), size: 5 }], snapshotBytes: '5' };
  assert.deepEqual(validateBackupObjectManifest(base), base);
  for (const invalid of [
    { ...base, extra: true },
    { ...base, directories: [] },
    { ...base, directories: ['world', 'world'] },
    { ...base, directories: ['../world'] },
    { ...base, files: [{ ...base.files[0], path: '../outside' }] },
    { ...base, files: [{ ...base.files[0], sha256: 'x'.repeat(64) }] },
    { ...base, files: [{ ...base.files[0], path: 'world' }] },
    { ...base, files: [...base.files, ...base.files], snapshotBytes: '10' },
    { ...base, files: [...base.files, { ...base.files[0], path: 'world/other', size: 6 }], snapshotBytes: '11' },
    { ...base, snapshotBytes: '4' },
    { ...base, snapshotBytes: '05' },
    { ...base, files: [{ ...base.files[0], size: -1 }] },
    { ...base, files: [{ ...base.files[0], size: 8 * 1024 ** 3 + 1 }] },
  ]) assert.throws(() => validateBackupObjectManifest(invalid));
});

test('capture and validation enforce depth and per-file size bounds before copying oversized data', async t => {
  const setup = await fixture(t);
  const filename = path.join(setup.source, 'oversized');
  const handle = await open(filename, 'wx');
  try { await handle.truncate(8 * 1024 ** 3 + 1); }
  finally { await handle.close(); }
  await assert.rejects(setup.objects.capture(setup.source, ['oversized']), /size limit/);
  const nested = Array.from({ length: 33 }, () => 'd').join('/');
  await setup.write(nested, 'deep');
  await assert.rejects(setup.objects.capture(setup.source, ['d']), /path is invalid/);
  assert.throws(() => validateBackupObjectManifest({ files: [], directories: [nested], snapshotBytes: '0' }), /path is invalid/);
  const largeFiles = [1, 2, 3].map(index => ({ path: `file${index}`, sha256: sha256(String(index)), size: 8 * 1024 ** 3 }));
  assert.throws(() => validateBackupObjectManifest({ files: largeFiles, directories: [], snapshotBytes: String(24 * 1024 ** 3) }), /total size/);
});

test('collection keeps referenced shared objects and removes only verified unreferenced objects', async t => {
  const setup = await fixture(t);
  await setup.write('keep', 'shared');
  await setup.write('discard', 'obsolete');
  const manifest = await setup.objects.capture(setup.source, ['keep', 'discard']);
  const kept = manifest.files.find(file => file.path === 'keep')!;
  const removed = manifest.files.find(file => file.path === 'discard')!;
  await setup.objects.collect(new Set([kept.sha256]));
  await access(setup.objectPath(kept.sha256));
  await absent(setup.objectPath(removed.sha256));
  const handle = await setup.objects.openObject(kept.sha256, kept.size);
  await handle.close();
  await setup.objects.collect(new Set());
  await absent(setup.objectPath(kept.sha256));
});

test('collection rejects incomplete reference sets, unknown layout, and corrupted objects before deleting anything', async t => {
  const setup = await fixture(t);
  await setup.write('one', 'first');
  await setup.write('two', 'second');
  const manifest = await setup.objects.capture(setup.source, ['one', 'two']);
  await assert.rejects(setup.objects.collect(new Set([sha256('missing')])), /missing/);
  for (const file of manifest.files) await access(setup.objectPath(file.sha256));
  await writeFile(path.join(setup.storage, 'unknown'), 'preserve');
  await assert.rejects(setup.objects.collect(new Set()), /unexpected/);
  for (const file of manifest.files) await access(setup.objectPath(file.sha256));
  await rm(path.join(setup.storage, 'unknown'));
  const file = manifest.files[0]!;
  await chmod(setup.objectPath(file.sha256), 0o600);
  await writeFile(setup.objectPath(file.sha256), 'x'.repeat(file.size));
  await chmod(setup.objectPath(file.sha256), 0o400);
  await assert.rejects(setup.objects.collect(new Set()), /checksum/);
  for (const file of manifest.files) await access(setup.objectPath(file.sha256));
});

test('collection rejects linked entries and can reclaim recognizable abandoned capture files', async t => {
  const setup = await fixture(t);
  await setup.write('one', 'first');
  const file = (await setup.objects.capture(setup.source, ['one'])).files[0]!;
  const temporary = path.join(setup.storage, '.capture-12345678-1234-1234-1234-123456789012.tmp');
  await link(setup.objectPath(file.sha256), temporary);
  await assert.rejects(setup.objects.collect(new Set()), /regular files/);
  await access(setup.objectPath(file.sha256));
  await rm(temporary);
  await writeFile(temporary, 'partial capture');
  await setup.objects.collect(new Set([file.sha256]));
  await absent(temporary);
  await access(setup.objectPath(file.sha256));
});

test('independent snapshot calls on one store serialize without corrupting shared objects', async t => {
  const setup = await fixture(t);
  await setup.write('data', 'shared snapshot');
  const snapshots = await Promise.all(Array.from({ length: 4 }, () => setup.objects.capture(setup.source, ['data'])));
  assert(snapshots.every(snapshot => snapshot.files[0]!.sha256 === snapshots[0]!.files[0]!.sha256));
  assert.equal((await lstat(setup.objectPath(snapshots[0]!.files[0]!.sha256))).nlink, 1);
});
