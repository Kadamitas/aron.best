import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fromBuffer, type Entry } from 'yauzl';
import { ModpackFiles, ModpackFilesError, type WorkspaceManifest } from './modpack-files.js';
import { workspaceArchive } from './workspace-archive.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'aron-workspace-'));
  const root = path.join(directory, 'game');
  await mkdir(root);
  const files = new ModpackFiles(root);
  t.after(async () => { await files.close(); await rm(directory, { recursive: true, force: true }); });
  const put = async (relative: string, contents: string | Buffer) => {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
    return absolute;
  };
  return { directory, root, files, put };
}

function status(code: number) { return (error: unknown) => error instanceof ModpackFilesError && error.statusCode === code; }
async function upload(files: ModpackFiles, destination: string, contents: string, replace = false, address = 'friend') {
  const session = await files.beginUpload(destination, Buffer.byteLength(contents), replace, address);
  await files.appendUpload(session.id, 0, Buffer.from(contents).toString('base64'), address);
  return session;
}

const manifest: WorkspaceManifest = {
  minecraft: { version: '26.3', modLoaders: [{ id: 'fabric-0.19.5', primary: true }] },
  manifestType: 'minecraftModpack', manifestVersion: 1, name: 'After Hours', version: 'local-snapshot',
  files: [{ projectID: 999, fileID: 123, required: true, fileName: 'managed.jar', name: 'Managed Mod', websiteUrl: 'https://www.curseforge.com/minecraft/mc-mods/managed' }], overrides: 'overrides',
};

async function unzip(bytes: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) { reject(error); return; }
      const contents = new Map<string, Buffer>();
      zip.on('error', reject);
      zip.on('end', () => resolve(contents));
      zip.on('entry', (entry: Entry) => {
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) { zip.close(); reject(streamError); return; }
          const chunks: Buffer[] = [];
          stream.on('error', reject);
          stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
          stream.on('end', () => { contents.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
        });
      });
      zip.readEntry();
    });
  });
}

test('workspace lists only allowed files, excluding control files and hidden temporary state', async t => {
  const { files, put } = await fixture(t);
  await put('config/example.toml', 'enabled=true');
  await put('world/serverconfig/example.json', '{}');
  await put('world/level.dat', 'private world state');
  await put('server.properties', 'secret');
  await put('.env', 'secret');
  await put('config/.upload-hidden.part', 'incomplete');
  await put('libraries/runtime.jar', 'installation');
  const listing = await files.list();
  assert.deepEqual(listing.files.map(file => file.path), ['config/example.toml', 'world/serverconfig/example.json']);
  assert.equal(listing.truncated, false);
});

test('all path operations reject traversal, hidden paths, root names, and control paths', async t => {
  const { files } = await fixture(t);
  const forbidden = ['../.env', '/etc/passwd', 'config/../server.properties', 'config/.env', 'config', 'world/serverconfig', 'world/level.dat', 'config\\other.txt', 'config//x.txt', ' config/x.txt', 'mods/./x.jar', 'server.properties', 'libraries/x.jar', 'config/x\0.txt'];
  for (const candidate of forbidden) {
    await assert.rejects(files.text(candidate), ModpackFilesError);
    await assert.rejects(files.download(candidate), ModpackFilesError);
    await assert.rejects(files.writeText(candidate, 'changed', 'new'), ModpackFilesError);
    await assert.rejects(files.beginUpload(candidate, 1, false, 'friend'), ModpackFilesError);
  }
});

test('world ancestor and nested symlinks cannot expose or modify outside files', async t => {
  const { directory, root, files, put } = await fixture(t);
  const outside = path.join(directory, 'outside');
  await mkdir(path.join(outside, 'serverconfig'), { recursive: true });
  await writeFile(path.join(outside, 'serverconfig', 'secret.txt'), 'private');
  await symlink(outside, path.join(root, 'world'));
  await put('config/safe.txt', 'safe');
  await symlink(path.join(outside, 'serverconfig'), path.join(root, 'config', 'linked'));
  assert.deepEqual((await files.list()).files.map(file => file.path), ['config/safe.txt']);
  for (const candidate of ['world/serverconfig/secret.txt', 'config/linked/secret.txt']) {
    await assert.rejects(files.text(candidate), ModpackFilesError);
    await assert.rejects(files.download(candidate), ModpackFilesError);
    await assert.rejects(files.writeText(candidate, 'changed', 'new'), ModpackFilesError);
    await assert.rejects(files.beginUpload(candidate, 7, true, 'friend'), ModpackFilesError);
  }
  assert.equal(await readFile(path.join(outside, 'serverconfig', 'secret.txt'), 'utf8'), 'private');
});

test('final symlinks and hardlinks are refused for reading, replacement and mod actions', async t => {
  const { directory, root, files, put } = await fixture(t);
  const secret = path.join(directory, 'secret.txt');
  await writeFile(secret, 'private');
  await put('mods/real.jar', 'mod');
  await mkdir(path.join(root, 'config'));
  await symlink(secret, path.join(root, 'config', 'symbolic.txt'));
  await link(secret, path.join(root, 'config', 'hard.txt'));
  await link(secret, path.join(root, 'mods', 'hard.jar'));
  await symlink(secret, path.join(root, 'mods', 'symbolic.jar'));
  assert.deepEqual((await files.listMods()).mods.map(mod => mod.name), ['real.jar']);
  assert.deepEqual((await files.list()).files.map(file => file.path), ['mods/real.jar']);
  for (const candidate of ['config/symbolic.txt', 'config/hard.txt']) {
    await assert.rejects(files.text(candidate), ModpackFilesError);
    await assert.rejects(files.download(candidate), ModpackFilesError);
    await assert.rejects(files.writeText(candidate, 'changed', 'new'), ModpackFilesError);
    await assert.rejects(files.beginUpload(candidate, 7, true, 'friend'), ModpackFilesError);
  }
  await assert.rejects(files.modAction('mods/hard.jar', 'uninstall'), ModpackFilesError);
  await assert.rejects(files.modAction('mods/symbolic.jar', 'disable'), ModpackFilesError);
  assert.equal(await readFile(secret, 'utf8'), 'private');
});

test('text writes preserve revisions and allow exactly one concurrent save', async t => {
  const { root, files, put } = await fixture(t);
  await put('config/example.toml', 'original');
  const original = await files.text('config/example.toml');
  const outcomes = await Promise.allSettled([
    files.writeText(original.path, 'first', original.revision),
    files.writeText(original.path, 'second', original.revision),
  ]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  const failure = outcomes.find(result => result.status === 'rejected');
  assert.ok(failure?.status === 'rejected' && status(409)(failure.reason));
  assert.equal((await files.text(original.path)).contents, 'first');
  assert.deepEqual(await readdir(path.join(root, 'config')), ['example.toml']);
  await assert.rejects(files.writeText(original.path, 'overwrite', 'new'), status(409));
  const created = await files.writeText('config/nested/new.json', '{}', 'new');
  assert.equal(created.contents, '{}');
  await assert.rejects(files.writeText('config/gone.txt', 'missing', original.revision), status(409));
});

test('text editing rejects oversized and invalid UTF-8 data before replacing a file', async t => {
  const { files, put } = await fixture(t);
  await put('config/invalid.txt', Buffer.from([0xff, 0xfe]));
  await put('config/binary.txt', 'abc\0def');
  await put('config/large.txt', 'a'.repeat(256 * 1024 + 1));
  await assert.rejects(files.text('config/invalid.txt'), /UTF-8/);
  await assert.rejects(files.text('config/binary.txt'), /UTF-8/);
  await assert.rejects(files.text('config/large.txt'), status(413));
  await assert.rejects(files.writeText('config/new.txt', '\ud800', 'new'), /UTF-8/);
  await assert.rejects(files.writeText('config/new.txt', 'a'.repeat(256 * 1024 + 1), 'new'), status(413));
  await assert.rejects(files.writeText('mods/new.jar', 'abc', 'new'), /Binary files/);
  assert.equal((await files.writeText('config/valid.txt', 'A\ufffdB', 'new')).contents, 'A\ufffdB');
});

test('downloads use the already opened descriptor after path replacement', async t => {
  const { directory, files, put } = await fixture(t);
  const original = await put('config/download.txt', 'original bytes');
  const secret = path.join(directory, 'secret.txt');
  await writeFile(secret, 'private bytes');
  const result = await files.download('config/download.txt');
  await unlink(original);
  await symlink(secret, original);
  const chunks: Buffer[] = [];
  for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), 'original bytes');
  assert.equal(result.size, 14);
});

test('uploads hide temporary files, bind sessions to addresses and reject replayed chunks', async t => {
  const { root, files } = await fixture(t);
  const session = await files.beginUpload('mods/example.jar', 6, false, 'friend');
  assert.equal(session.chunkBytes, 512 * 1024);
  assert.deepEqual((await files.list()).files, []);
  await assert.rejects(files.appendUpload(session.id, 0, 'YWJj', 'other'), status(404));
  await assert.rejects(files.cancelUpload(session.id, 'other'), status(404));
  await assert.rejects(files.appendUpload(session.id, 1, 'YWJj', 'friend'), status(409));
  await assert.rejects(files.appendUpload(session.id, 0, 'not base64', 'friend'), /base64/);
  await assert.rejects(files.appendUpload(session.id, 0, 'Zh==', 'friend'), /invalid size/);
  await assert.rejects(files.appendUpload(session.id, 0, Buffer.alloc(512 * 1024 + 1).toString('base64'), 'friend'), status(400));
  const results = await Promise.allSettled([
    files.appendUpload(session.id, 0, 'YWJj', 'friend'),
    files.appendUpload(session.id, 0, 'YWJj', 'friend'),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  await assert.rejects(files.finishUpload(session.id, 'friend'), status(409));
  await files.appendUpload(session.id, 1, 'ZGVm', 'friend');
  const completed = await files.finishUpload(session.id, 'friend');
  assert.equal(completed.path, 'mods/example.jar');
  assert.equal(await readFile(path.join(root, completed.path), 'utf8'), 'abcdef');
  assert.deepEqual(await readdir(path.join(root, 'mods')), ['example.jar']);
  await assert.rejects(files.finishUpload(session.id, 'friend'), status(404));
});

test('uploads never replace a destination created or edited after the upload began', async t => {
  const { root, files, put } = await fixture(t);
  const fresh = await upload(files, 'config/new.txt', 'uploaded');
  await put('config/new.txt', 'created elsewhere');
  await assert.rejects(files.finishUpload(fresh.id, 'friend'), status(409));
  assert.equal(await readFile(path.join(root, 'config/new.txt'), 'utf8'), 'created elsewhere');
  const replacement = await upload(files, 'config/new.txt', 'replacement', true);
  const current = await files.text('config/new.txt');
  await files.writeText(current.path, 'edited meanwhile', current.revision);
  await assert.rejects(files.finishUpload(replacement.id, 'friend'), status(409));
  assert.equal((await files.text(current.path)).contents, 'edited meanwhile');
  assert.deepEqual(await readdir(path.join(root, 'config')), ['new.txt']);
  const accepted = await upload(files, 'config/new.txt', 'accepted', true);
  await files.finishUpload(accepted.id, 'friend');
  assert.equal((await files.text(current.path)).contents, 'accepted');
});

test('an upload destination cannot be switched to an outside directory', async t => {
  const { directory, root, files } = await fixture(t);
  const session = await upload(files, 'config/example.txt', 'uploaded');
  const outside = path.join(directory, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'example.txt'), 'private');
  await rename(path.join(root, 'config'), path.join(root, 'old-config'));
  await symlink(outside, path.join(root, 'config'));
  await assert.rejects(files.finishUpload(session.id, 'friend'), ModpackFilesError);
  assert.equal(await readFile(path.join(outside, 'example.txt'), 'utf8'), 'private');
  assert.deepEqual(await readdir(outside), ['example.txt']);
});

test('a substituted upload temporary file cannot publish an outside file', async t => {
  const { directory, root, files } = await fixture(t);
  const session = await upload(files, 'mods/example.jar', 'uploaded');
  const temporary = (await readdir(path.join(root, 'mods')))[0]!;
  const secret = path.join(directory, 'secret.jar');
  await writeFile(secret, 'private');
  await unlink(path.join(root, 'mods', temporary));
  await symlink(secret, path.join(root, 'mods', temporary));
  await assert.rejects(files.finishUpload(session.id, 'friend'), status(409));
  assert.equal(await readFile(secret, 'utf8'), 'private');
  assert.deepEqual(await readdir(path.join(root, 'mods')), []);
});

test('upload reservations enforce per-address, global byte, destination and file size limits', async t => {
  const { files } = await fixture(t);
  await assert.rejects(files.beginUpload('mods/huge.jar', 128 * 1024 * 1024 + 1, false, 'a'), status(413));
  await assert.rejects(files.beginUpload('mods/zero.jar', 0, false, 'a'), status(413));
  const first = await files.beginUpload('mods/one.jar', 128 * 1024 * 1024, false, 'a');
  await assert.rejects(files.beginUpload('mods/one.jar', 1, true, 'b'), status(409));
  const second = await files.beginUpload('mods/two.jar', 128 * 1024 * 1024, false, 'a');
  await assert.rejects(files.beginUpload('mods/three.jar', 1, false, 'a'), status(429));
  await assert.rejects(files.beginUpload('mods/three.jar', 1, false, 'b'), status(429));
  await files.cancelUpload(first.id, 'a');
  await files.cancelUpload(second.id, 'a');
  const reservations = await Promise.all(Array.from({ length: 8 }, (_, index) => files.beginUpload(`mods/${index}.jar`, 1, false, `friend-${index}`)));
  await assert.rejects(files.beginUpload('mods/overflow.jar', 1, false, 'other'), status(429));
  await files.cancelUpload(reservations[0]!.id, 'friend-0');
  await files.beginUpload('mods/available.jar', 1, false, 'other');
});

test('workspace quota includes removed files and blocks further writes', async t => {
  const { root, files, put } = await fixture(t);
  await put('mods/.removed/large.jar', '');
  const handle = await open(path.join(root, 'mods/.removed/large.jar'), 'r+');
  try { await handle.truncate(4 * 1024 * 1024 * 1024); } finally { await handle.close(); }
  await assert.rejects(files.beginUpload('mods/extra.jar', 1, false, 'friend'), status(507));
  await assert.rejects(files.writeText('config/extra.txt', 'a', 'new'), status(507));
});

test('expired sessions and stale orphan uploads release their files and reservations', async t => {
  const { root, files, put } = await fixture(t);
  const session = await upload(files, 'mods/expired.jar', 'uploaded');
  const originalNow = Date.now;
  t.mock.method(Date, 'now', () => originalNow() + 16 * 60_000);
  await files.list();
  await assert.rejects(files.finishUpload(session.id, 'friend'), status(404));
  assert.deepEqual(await readdir(path.join(root, 'mods')), []);
  const orphan = await put(`mods/.upload-${randomUUID()}.part`, 'old incomplete upload');
  await utimes(orphan, new Date(0), new Date(0));
  await put('mods/.unrelated', 'leave this alone');
  const next = await files.beginUpload('mods/next.jar', 1, false, 'friend');
  await files.cancelUpload(next.id, 'friend');
  assert.deepEqual(await readdir(path.join(root, 'mods')), ['.unrelated']);
});

test('mod actions are collision-safe, idempotent, and recoverable on uninstall', async t => {
  const { root, files, put } = await fixture(t);
  await put('mods/example.jar', 'mod contents');
  assert.equal((await files.listMods()).mods[0]!.enabled, true);
  await files.modAction('mods/example.jar', 'enable');
  await files.modAction('mods/example.jar', 'disable');
  assert.equal((await files.listMods()).mods[0]!.enabled, false);
  await files.modAction('mods/example.jar.disabled', 'disable');
  await put('mods/example.jar', 'separate version');
  await assert.rejects(files.modAction('mods/example.jar.disabled', 'enable'), status(409));
  assert.equal(await readFile(path.join(root, 'mods/example.jar'), 'utf8'), 'separate version');
  assert.equal(await readFile(path.join(root, 'mods/example.jar.disabled'), 'utf8'), 'mod contents');
  const first = await files.modAction('mods/example.jar', 'uninstall');
  const second = await files.modAction('mods/example.jar.disabled', 'uninstall');
  assert.ok('removed' in first && first.removed);
  assert.ok('removed' in second && second.removed);
  assert.notEqual(first.path, second.path);
  assert.equal(await readFile(path.join(root, first.path), 'utf8'), 'separate version');
  assert.equal(await readFile(path.join(root, second.path), 'utf8'), 'mod contents');
  assert.deepEqual((await files.listMods()).mods, []);
  await assert.rejects(files.download(first.path), ModpackFilesError);
  await assert.rejects(files.modAction('config/example.jar', 'disable'), ModpackFilesError);
  await assert.rejects(files.modAction('mods/nested/example.jar', 'disable'), ModpackFilesError);
});

test('workspace archives include actual active mod bytes and configuration without tracked manifest files or private state', async t => {
  const { root, files, put } = await fixture(t);
  const jar = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0, 0xfe]);
  await put('mods/active.jar', jar);
  await put('mods/disabled.jar.disabled', 'disabled');
  await put('mods/.removed/uninstalled.jar', 'removed');
  await put('config/éxample.json', '{"enabled":true}');
  await put('scripts/server.js', 'settings = 1;');
  await put('resourcepacks/assets.zip', 'assets');
  await put('world/serverconfig/secret.toml', 'server-only');
  await put('server.properties', 'private');
  await put('fabric-server-launch.jar', 'runtime');
  const before = await files.list();
  const archive = await unzip(await files.exportArchive(manifest));
  assert.deepEqual([...archive.keys()], ['manifest.json', 'modlist.html', 'overrides/config/éxample.json', 'overrides/mods/active.jar', 'overrides/resourcepacks/assets.zip', 'overrides/scripts/server.js']);
  const metadata = JSON.parse(archive.get('manifest.json')!.toString());
  // The managed JAR is not installed, so CurseForge is not told to fetch it.
  assert.deepEqual(metadata.files, []);
  assert.equal(archive.get('modlist.html')!.toString(), '<ul>\n<li>active.jar (bundled in overrides)</li>\n</ul>\n');
  assert.deepEqual(metadata.minecraft, manifest.minecraft);
  assert.equal(metadata.overrides, 'overrides');
  assert.equal(metadata.name, 'After Hours');
  assert.deepEqual(archive.get('overrides/mods/active.jar'), jar);
  assert.equal(archive.get('overrides/config/éxample.json')!.toString(), '{"enabled":true}');
  assert.deepEqual(await files.list(), before);
  assert.deepEqual((await readdir(root)).sort(), ['config', 'fabric-server-launch.jar', 'mods', 'resourcepacks', 'scripts', 'server.properties', 'world']);
});

test('archives fail closed on linked sources and unsafe archive names', async t => {
  const { directory, root, files, put } = await fixture(t);
  await put('config/safe.txt', 'safe');
  const outside = path.join(directory, 'secret.txt');
  await writeFile(outside, 'private');
  const linked = path.join(root, 'config', 'linked.txt');
  await symlink(outside, linked);
  await assert.rejects(files.exportArchive(manifest), status(409));
  await unlink(linked);
  await link(outside, linked);
  await assert.rejects(files.exportArchive(manifest), status(409));
  await unlink(linked);
  await symlink(directory, path.join(root, 'mods'));
  await assert.rejects(files.exportArchive(manifest), ModpackFilesError);
  for (const candidate of ['../outside', '/absolute', 'overrides/../../outside', 'overrides\\outside', 'C:/outside', 'overrides//empty']) {
    assert.throws(() => workspaceArchive([[candidate, Buffer.from('payload')]]), /unsafe file path/);
  }
  assert.equal(await readFile(outside, 'utf8'), 'private');
});

test('archives reject oversized sources and inventories that would be truncated', async t => {
  const { root, files, put } = await fixture(t);
  const large = await put('mods/large.jar', '');
  const handle = await open(large, 'r+');
  try { await handle.truncate(128 * 1024 * 1024); } finally { await handle.close(); }
  await assert.rejects(files.exportArchive(manifest), status(413));
  await unlink(large);
  let nested = 'config';
  for (let depth = 0; depth < 10; depth++) nested += `/level-${depth}`;
  await put(`${nested}/deep.txt`, 'deep');
  await assert.rejects(files.exportArchive(manifest), status(413));
  assert.equal(await readFile(path.join(root, nested, 'deep.txt'), 'utf8'), 'deep');
});

test('archives reject files changed after capture instead of returning an inconsistent snapshot', async t => {
  const { files, put } = await fixture(t);
  const target = await put('config/example.txt', 'before');
  const originalSnapshot = (files as unknown as { snapshot: (...args: unknown[]) => Promise<unknown> }).snapshot.bind(files);
  let captured = false;
  t.mock.method(files as unknown as { snapshot: (...args: unknown[]) => Promise<unknown> }, 'snapshot', async (...args: unknown[]) => {
    const result = await originalSnapshot(...args);
    if (!captured) { captured = true; await writeFile(target, 'after!'); }
    return result;
  });
  await assert.rejects(files.exportArchive(manifest), status(409));
  assert.equal(await readFile(target, 'utf8'), 'after!');
});

test('directory inventory includes roots and nested empty folders without hidden or linked directories', async t => {
  const { directory, root, files, put } = await fixture(t);
  await put('config/settings/client.json', '{}');
  await mkdir(path.join(root, 'config', 'empty', 'nested'), { recursive: true });
  await mkdir(path.join(root, 'mods'));
  await mkdir(path.join(root, 'config', '.removed'));
  await mkdir(path.join(root, 'world', 'serverconfig'), { recursive: true });
  await symlink(directory, path.join(root, 'config', 'linked'));
  const inventory = await files.list();
  assert.deepEqual(inventory.directories.map(item => item.path), ['config', 'config/empty', 'config/empty/nested', 'config/settings', 'mods', 'world/serverconfig']);
  assert.deepEqual(inventory.files.map(item => item.path), ['config/settings/client.json']);
  assert.equal(inventory.truncated, false);
});

test('folder creation is exclusive and retains existing files and folders on collisions', async t => {
  const { root, files, put } = await fixture(t);
  const outcomes = await Promise.allSettled([files.createDirectory('config/new'), files.createDirectory('config/new')]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(outcomes.some(result => result.status === 'rejected' && status(409)(result.reason)));
  assert.deepEqual(await files.createDirectory('config/new/nested'), { path: 'config/new/nested', name: 'nested' });
  await put('config/existing.txt', 'preserve me');
  await assert.rejects(files.createDirectory('config/existing.txt'), status(409));
  assert.equal(await readFile(path.join(root, 'config/existing.txt'), 'utf8'), 'preserve me');
});

test('file moves and renames preserve bytes, allow supported roots, and never overwrite collisions', async t => {
  const { root, files, put } = await fixture(t);
  await put('config/original.json', '{"original":true}');
  await put('defaultconfigs/existing.json', '{"existing":true}');
  await files.createDirectory('defaultconfigs/empty');
  await assert.rejects(files.move('config/original.json', 'defaultconfigs/existing.json'), status(409));
  await assert.rejects(files.move('config/original.json', 'defaultconfigs/empty'), /already exists/);
  assert.deepEqual(await files.move('config/original.json', 'defaultconfigs/renamed.json'), { path: 'defaultconfigs/renamed.json', name: 'renamed.json', type: 'file' });
  assert.equal(await readFile(path.join(root, 'defaultconfigs/renamed.json'), 'utf8'), '{"original":true}');
  assert.equal(await readFile(path.join(root, 'defaultconfigs/existing.json'), 'utf8'), '{"existing":true}');
  await assert.rejects(lstat(path.join(root, 'config/original.json')), { code: 'ENOENT' });
  assert.equal((await lstat(path.join(root, 'defaultconfigs/renamed.json'))).nlink, 1);
  await put('mods/disabled.jar.disabled', 'disabled mod');
  await files.move('mods/disabled.jar.disabled', 'mods/renamed.jar.disabled');
  assert.equal((await files.listMods()).mods[0]?.enabled, false);
});

test('folder moves preserve nested files and empty folders and refuse existing empty destinations', async t => {
  const { root, files, put } = await fixture(t);
  await put('config/source/settings.json', '{}');
  await put('config/source/nested/options.toml', 'enabled=true');
  await mkdir(path.join(root, 'config/source/nested/empty'));
  await files.createDirectory('defaultconfigs/existing');
  await assert.rejects(files.move('config/source', 'defaultconfigs/existing'), status(409));
  assert.deepEqual(await files.move('config/source', 'defaultconfigs/renamed'), { path: 'defaultconfigs/renamed', name: 'renamed', type: 'directory' });
  await assert.rejects(lstat(path.join(root, 'config/source')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(root, 'defaultconfigs/renamed/nested/options.toml'), 'utf8'), 'enabled=true');
  assert.deepEqual(await readdir(path.join(root, 'defaultconfigs/renamed/nested/empty')), []);
  assert.equal((await lstat(path.join(root, 'defaultconfigs/renamed/settings.json'))).nlink, 1);
  await files.move('defaultconfigs/renamed/nested/empty', 'config/empty-moved');
  assert.deepEqual(await readdir(path.join(root, 'config/empty-moved')), []);
});

test('deleting files and folders retains recoverable content outside the public inventory', async t => {
  const { root, files, put } = await fixture(t);
  await put('config/delete.txt', 'recover file');
  await put('config/folder/nested/settings.json', '{"recover":true}');
  await mkdir(path.join(root, 'config/folder/empty'));
  const removedFile = await files.remove('config/delete.txt');
  assert.equal(removedFile.path, 'config/delete.txt');
  assert.equal(removedFile.removed, true);
  assert.match(removedFile.recoveryPath, /^config\/\.removed\//);
  assert.equal(await readFile(path.join(root, removedFile.recoveryPath), 'utf8'), 'recover file');
  const removedFolder = await files.remove('config/folder');
  assert.equal(await readFile(path.join(root, removedFolder.recoveryPath, 'nested/settings.json'), 'utf8'), '{"recover":true}');
  assert.deepEqual(await readdir(path.join(root, removedFolder.recoveryPath, 'empty')), []);
  assert.deepEqual((await files.list()).files, []);
  assert.deepEqual((await files.list()).directories, [{ path: 'config', name: 'config' }]);
  await assert.rejects(files.download(removedFile.recoveryPath), ModpackFilesError);
  await assert.rejects(files.move(removedFile.recoveryPath, 'config/visible.txt'), ModpackFilesError);
});

test('folder operations reject roots, escape paths and self-descendants', async t => {
  const { root, files, put } = await fixture(t);
  await put('config/source/settings.json', '{}');
  for (const candidate of ['config', 'mods', 'world/serverconfig', '../config', '/tmp/new', 'config/.removed', 'config/../world', 'config//new', 'config/bad\\name', 'config/\u0000bad']) {
    await assert.rejects(files.createDirectory(candidate), ModpackFilesError);
    await assert.rejects(files.move(candidate, 'config/destination'), ModpackFilesError);
    await assert.rejects(files.move('config/source', candidate), ModpackFilesError);
    await assert.rejects(files.remove(candidate), ModpackFilesError);
  }
  await assert.rejects(files.move('config/source', 'config/source'), status(409));
  await assert.rejects(files.move('config/source', 'config/source/child'), status(409));
  assert.equal(await readFile(path.join(root, 'config/source/settings.json'), 'utf8'), '{}');
});

test('file and folder changes reject symbolic links, hardlinks, hidden descendants and unsafe destinations', async t => {
  const { directory, root, files, put } = await fixture(t);
  const outside = path.join(directory, 'private.txt');
  await writeFile(outside, 'private');
  await put('config/source/safe.txt', 'safe');
  await symlink(outside, path.join(root, 'config/source/symbolic.txt'));
  await link(outside, path.join(root, 'config/hard.txt'));
  await symlink(directory, path.join(root, 'config/linked'));
  for (const candidate of ['config/source/symbolic.txt', 'config/source', 'config/hard.txt', 'config/linked']) {
    await assert.rejects(files.move(candidate, 'config/destination.txt'), ModpackFilesError);
    await assert.rejects(files.remove(candidate), ModpackFilesError);
  }
  await assert.rejects(files.move('config/source/safe.txt', 'config/linked/stolen.txt'), ModpackFilesError);
  await assert.rejects(files.createDirectory('config/linked/stolen'), ModpackFilesError);
  await unlink(path.join(root, 'config/source/symbolic.txt'));
  await put('config/source/.private.txt', 'hidden');
  await assert.rejects(files.move('config/source', 'config/destination'), ModpackFilesError);
  await assert.rejects(files.remove('config/source'), ModpackFilesError);
  assert.equal(await readFile(outside, 'utf8'), 'private');
  assert.equal(await readFile(path.join(root, 'config/source/safe.txt'), 'utf8'), 'safe');
  assert.equal(await readFile(path.join(root, 'config/source/.private.txt'), 'utf8'), 'hidden');
});

test('active uploads block intersecting file and folder mutations without cancelling the upload', async t => {
  const { files, put } = await fixture(t);
  await put('config/source/settings.json', '{}');
  const session = await upload(files, 'config/source/pending.txt', 'uploaded');
  await assert.rejects(files.move('config/source', 'config/moved'), status(409));
  await assert.rejects(files.remove('config/source'), status(409));
  await assert.rejects(files.move('config/source/settings.json', 'config/source/pending.txt'), status(409));
  await assert.rejects(files.createDirectory('config/source/pending.txt'), status(409));
  await files.finishUpload(session.id, 'friend');
  await files.move('config/source', 'config/moved');
  assert.equal((await files.text('config/moved/pending.txt')).contents, 'uploaded');
});

test('folder transfer rolls back its destination when the source changes before commit', async t => {
  const { root, files, put } = await fixture(t);
  await put('config/source/settings.json', '{}');
  await put('config/source/nested/options.txt', 'original');
  const internals = files as unknown as { linkEntry: (...args: unknown[]) => Promise<void> };
  const original = internals.linkEntry.bind(files);
  let changed = false;
  t.mock.method(internals, 'linkEntry', async (...args: unknown[]) => {
    await original(...args);
    if (!changed) { changed = true; await put('config/source/new.txt', 'concurrent addition'); }
  });
  await assert.rejects(files.move('config/source', 'config/destination'), status(409));
  await assert.rejects(lstat(path.join(root, 'config/destination')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(root, 'config/source/nested/options.txt'), 'utf8'), 'original');
  assert.equal(await readFile(path.join(root, 'config/source/new.txt'), 'utf8'), 'concurrent addition');
  assert.equal((await lstat(path.join(root, 'config/source/settings.json'))).nlink, 1);
});

test('folder destination races never overwrite a folder created by another operation', async t => {
  const { root, files, put } = await fixture(t);
  await put('config/source/settings.json', '{}');
  const internals = files as unknown as { createChild: (...args: unknown[]) => Promise<unknown> };
  const original = internals.createChild.bind(files);
  t.mock.method(internals, 'createChild', async (...args: unknown[]) => {
    await mkdir(path.join(root, 'config/destination'));
    return original(...args);
  });
  await assert.rejects(files.move('config/source', 'config/destination'), status(409));
  assert.equal(await readFile(path.join(root, 'config/source/settings.json'), 'utf8'), '{}');
  assert.deepEqual(await readdir(path.join(root, 'config/destination')), []);
});

test('arbitrary filename extensions and extensionless text files support creation, upload, editing, rename and recoverable deletion', async t => {
  const { root, files } = await fixture(t);
  const created = await files.writeText('config/settings.whatever', 'original', 'new');
  assert.equal(created.text, true);
  const edited = await files.writeText(created.path, 'updated', created.revision);
  assert.equal(edited.contents, 'updated');
  await files.move(created.path, 'config/renamed.another-extension');
  assert.equal((await files.text('config/renamed.another-extension')).contents, 'updated');
  assert.equal((await files.list()).files[0]?.text, true);
  const deleted = await files.remove('config/renamed.another-extension');
  assert.equal(await readFile(path.join(root, deleted.recoveryPath), 'utf8'), 'updated');
  await files.writeText('config/README', 'no extension required', 'new');
  assert.equal((await files.text('config/README')).contents, 'no extension required');
  const session = await upload(files, 'config/uploaded.custom', 'custom upload');
  const uploaded = await files.finishUpload(session.id, 'friend');
  assert.equal(uploaded.text, true);
  assert.equal((await files.text(uploaded.path)).contents, 'custom upload');
  await files.createDirectory('config/arbitrary');
  await files.move(uploaded.path, 'config/arbitrary/file.custom');
  await files.move('config/arbitrary', 'config/renamed-folder');
  assert.equal((await files.text('config/renamed-folder/file.custom')).contents, 'custom upload');
});

test('unknown extensions still require bounded valid UTF-8 while known binary formats are never text-editable', async t => {
  const { files, put } = await fixture(t);
  await put('config/unknown.weird', Buffer.from([0xff, 0xfe]));
  await put('config/large.custom', 'a'.repeat(256 * 1024 + 1));
  await assert.rejects(files.text('config/unknown.weird'), /UTF-8/);
  await assert.rejects(files.writeText('config/unknown.weird', 'replacement', createHash('sha256').update(Buffer.from([0xff, 0xfe])).digest('hex')), /UTF-8/);
  await assert.rejects(files.text('config/large.custom'), status(413));
  await assert.rejects(files.writeText('config/new.custom', '\ud800', 'new'), /UTF-8/);
  await assert.rejects(files.writeText('config/new.custom', 'a'.repeat(256 * 1024 + 1), 'new'), status(413));
  for (const filePath of ['mods/example.jar', 'mods/example.jar.disabled', 'config/image.png', 'config/archive.zip', 'config/world.nbt', 'config/data.dat']) {
    await put(filePath, 'these are text bytes');
    await assert.rejects(files.text(filePath), /Binary files/);
    await assert.rejects(files.writeText(filePath, 'changed', 'new'), /Binary files/);
    assert.equal((await files.list()).files.find(file => file.path === filePath)?.text, false);
  }
});

test('workspace archives hand installed CurseForge mods to the app by id and only bundle the rest', async t => {
  const { files, put } = await fixture(t);
  await put('mods/Managed.JAR', 'from curseforge');
  await put('mods/custom.jar', 'hand built');
  await put('mods/stale.jar.disabled', 'disabled');
  const archive = await unzip(await files.exportArchive({ ...manifest, files: [
    ...manifest.files,
    { projectID: 999, fileID: 124, required: true, fileName: 'managed.jar' },
    { projectID: 42, fileID: 7, required: true, fileName: 'missing.jar', name: 'Not installed' },
    { projectID: 43, fileID: 8, required: true, fileName: 'stale.jar', name: 'Disabled' },
  ] }));
  assert.deepEqual([...archive.keys()], ['manifest.json', 'modlist.html', 'overrides/mods/custom.jar']);
  const metadata = JSON.parse(archive.get('manifest.json')!.toString());
  assert.deepEqual(metadata.files, [{ projectID: 999, fileID: 123, required: true }]);
  assert.equal(metadata.version, 'local-snapshot');
  assert.equal(archive.get('modlist.html')!.toString(),
    '<ul>\n<li><a href="https://www.curseforge.com/minecraft/mc-mods/managed">Managed Mod</a></li>\n<li>custom.jar (bundled in overrides)</li>\n</ul>\n');
});
