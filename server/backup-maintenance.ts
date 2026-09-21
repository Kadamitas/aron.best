import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, realpath, rename, rmdir, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { BackupObjects, maximumBackupManifestBytes, validateBackupObjectManifest, type BackupObjectManifest } from './backup-objects.js';

const items = new Set(['world', 'mods', 'config', 'defaultconfigs', 'kubejs', 'scripts', 'datapacks', 'resourcepacks', 'shaderpacks', 'server.properties', 'ops.json', 'whitelist.json', 'banned-players.json', 'banned-ips.json', 'installed-mods.json', 'installation.json', 'eula.txt']);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const snapshotName = /^(?:\.incomplete-)?\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z(?:-[a-f0-9-]{36})?$/;
const pendingName = /^\.backup-migration-[a-f0-9-]{36}\.json$/;
const downloadName = /^\.download-[a-f0-9-]{36}\.tmp$/;
interface Directory { absolute: string; handle: FileHandle; identity: Stats }
interface Manifest { createdAt: string; kind: 'manual' | 'automatic'; items: string[]; snapshotBytes: string; objects?: BackupObjectManifest }
interface Snapshot { absolute: string; identity: Stats; manifest: Manifest; pending: string[] }
interface TreeFile { path: string; identity: Stats }
interface TreeDirectory { path: string; identity: Stats }

function failure(message: string): Error { return new Error(`Backup maintenance stopped: ${message} Existing backups were preserved.`); }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function same(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }
function stable(left: Stats, right: Stats): boolean { return same(left, right) && left.size === right.size && left.ctimeMs === right.ctimeMs && left.mtimeMs === right.mtimeMs; }
function regular(info: Stats): void { if (!info.isFile() || info.nlink !== 1) throw failure('A linked or unsupported file was found.'); }
function anchor(directory: Directory): string { return process.platform === 'linux' ? `/proc/self/fd/${directory.handle.fd}` : directory.absolute; }
function segment(name: string): void { if (!name || name === '.' || name === '..' || /[\\/\x00-\x1f\x7f:]/.test(name)) throw failure('A storage path is invalid.'); }
async function inspect(candidate: string): Promise<Stats | undefined> { return lstat(candidate).catch(error => { if (missing(error)) return undefined; throw error; }); }
async function assertDirectory(directory: Directory): Promise<void> {
  const current = await lstat(directory.absolute);
  if (!current.isDirectory() || !same(current, directory.identity)) throw failure('A storage folder changed.');
}
async function directory(requested: string): Promise<Directory> {
  if (!path.isAbsolute(requested) || requested !== path.normalize(requested) || requested === path.parse(requested).root) throw failure('Use a dedicated real runtime directory without symbolic links.');
  const before = await lstat(requested);
  // The storage folder itself must be a real directory. Its ancestors may be
  // symbolic links (macOS keeps /var under /private), so work on the resolved path.
  if (before.isSymbolicLink() || !before.isDirectory()) throw failure('A storage folder is linked or invalid.');
  const absolute = await realpath(requested);
  const handle = await open(absolute, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const identity = await handle.stat();
    if (!identity.isDirectory() || !same(before, identity)) throw failure('A storage folder changed.');
    return { absolute, identity, handle };
  } catch (error) { await handle.close(); throw error; }
}
async function child(parent: Directory, name: string): Promise<Directory> {
  segment(name);
  await assertDirectory(parent);
  const candidate = path.join(anchor(parent), name);
  const before = await lstat(candidate);
  if (!before.isDirectory()) throw failure('A storage folder is linked or invalid.');
  const handle = await open(candidate, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const identity = await handle.stat();
    if (!identity.isDirectory() || !same(before, identity)) throw failure('A storage folder changed.');
    const result = { absolute: path.join(parent.absolute, name), identity, handle };
    await assertDirectory(result);
    return result;
  } catch (error) { await handle.close(); throw error; }
}
async function json(parent: Directory, name: string): Promise<{ value: unknown; identity: Stats }> {
  segment(name);
  await assertDirectory(parent);
  const candidate = path.join(anchor(parent), name);
  const file = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    regular(before);
    if (before.size > maximumBackupManifestBytes) throw failure('Backup metadata is too large.');
    const contents = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < contents.length) {
      const result = await file.read(contents, offset, contents.length - offset, offset);
      if (!result.bytesRead) throw failure('Backup metadata changed during reading.');
      offset += result.bytesRead;
    }
    const after = await file.stat();
    regular(after);
    if (!stable(before, after) || !stable(after, await lstat(candidate))) throw failure('Backup metadata changed during reading.');
    try { return { value: JSON.parse(contents.toString('utf8')), identity: after }; }
    catch { throw failure('Backup metadata is not valid JSON.'); }
  } finally { await file.close(); }
}
function manifest(value: unknown): Manifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('Backup metadata is invalid.');
  const stored = value as Record<string, unknown>;
  const allowed = ['createdAt', 'kind', 'items', 'snapshotBytes', ...(stored.format === 2 ? ['format', 'files', 'directories'] : [])];
  if (Object.keys(stored).some(key => !allowed.includes(key)) || typeof stored.createdAt !== 'string' || !Number.isFinite(Date.parse(stored.createdAt)) || new Date(stored.createdAt).toISOString() !== stored.createdAt || stored.kind !== undefined && stored.kind !== 'manual' && stored.kind !== 'automatic' || !Array.isArray(stored.items) || !stored.items.every(item => typeof item === 'string' && items.has(item)) || new Set(stored.items).size !== stored.items.length || typeof stored.snapshotBytes !== 'string' || !/^(?:0|[1-9][0-9]{0,19})$/.test(stored.snapshotBytes)) throw failure('Backup metadata has an unknown or invalid layout.');
  const objects = stored.format === 2 ? validateBackupObjectManifest({ files: stored.files, directories: stored.directories, snapshotBytes: stored.snapshotBytes }) : undefined;
  if (objects) {
    const roots = new Set([...objects.directories, ...objects.files.map(file => file.path)].map(name => name.split('/')[0]!));
    if (roots.size !== stored.items.length || stored.items.some(item => !roots.has(item))) throw failure('Backup items do not match the object manifest.');
  }
  return { createdAt: stored.createdAt, kind: stored.kind ?? 'manual', items: stored.items, snapshotBytes: stored.snapshotBytes, objects };
}
function managedRecovery(value: unknown, id: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('A deleted server has invalid recovery metadata.');
  const stored = value as Record<string, unknown>;
  const common = ['id', 'name', 'removedAt'];
  const allowed = [...common, ...(stored.incomplete === true ? ['incomplete'] : ['location', 'minecraftVersion', 'loader', 'loaderVersion'])];
  if (Object.keys(stored).some(key => !allowed.includes(key)) || stored.id !== id || typeof stored.name !== 'string' || !stored.name.trim() || stored.name.length > 64 || /[\x00-\x1f\x7f]/.test(stored.name) || typeof stored.removedAt !== 'string' || !Number.isFinite(Date.parse(stored.removedAt))) throw failure('A deleted server has invalid recovery metadata.');
  if (stored.incomplete === true) return true;
  if (stored.location !== 'managed' && stored.location !== 'legacy' || typeof stored.minecraftVersion !== 'string' || !/^[0-9][A-Za-z0-9.+-]{0,79}$/.test(stored.minecraftVersion) || typeof stored.loaderVersion !== 'string' || !/^[0-9][A-Za-z0-9.+-]{0,79}$/.test(stored.loaderVersion) || !['Fabric', 'Forge', 'NeoForge', 'Quilt'].includes(String(stored.loader))) throw failure('A deleted server has invalid recovery metadata.');
  return stored.location === 'managed';
}
async function snapshot(parent: Directory, name: string): Promise<Snapshot> {
  const root = await child(parent, name);
  try {
    const metadata = manifest((await json(root, 'backup.json')).value);
    const expected = metadata.createdAt.replaceAll(':', '-');
    if (!name.replace(/^\.incomplete-/, '').startsWith(expected)) throw failure('A backup date does not match its folder.');
    const pending: string[] = [];
    for (const entry of await readdir(anchor(root))) {
      if (entry === 'backup.json' || metadata.items.includes(entry)) continue;
      if (!pendingName.test(entry)) throw failure('A backup folder contains unknown files.');
      const staged = manifest((await json(root, entry)).value);
      if (!staged.objects || staged.createdAt !== metadata.createdAt || staged.kind !== metadata.kind || staged.snapshotBytes !== metadata.snapshotBytes || [...staged.items].sort().join('\0') !== [...metadata.items].sort().join('\0')) throw failure('An interrupted backup migration does not match its snapshot.');
      pending.push(entry);
    }
    return { absolute: root.absolute, identity: root.identity, manifest: metadata, pending };
  } finally { await root.handle.close(); }
}
async function inventory(runtime: string): Promise<Snapshot[]> {
  const root = await directory(runtime);
  const snapshots: Snapshot[] = [];
  async function backups(parent: Directory) {
    if (!await inspect(path.join(anchor(parent), 'backups'))) return;
    const storage = await child(parent, 'backups');
    try {
      const entries = await readdir(anchor(storage));
      if (entries.length > 10_000) throw failure('Too many backup entries to inspect safely.');
      for (const name of entries) {
        const info = await lstat(path.join(anchor(storage), name));
        if (info.isDirectory() && snapshotName.test(name)) snapshots.push(await snapshot(storage, name));
        else if (name.endsWith('.tar.gz') && snapshotName.test(name.slice(0, -7)) || downloadName.test(name)) regular(info);
        else throw failure('Backup storage contains an unknown file or folder.');
      }
    } finally { await storage.handle.close(); }
  }
  async function inspectRuntime(parent: Directory, allowed: string[]) {
    for (const name of await readdir(anchor(parent))) {
      if (!allowed.includes(name)) throw failure('A saved server has an unknown recovery layout.');
      const info = await lstat(path.join(anchor(parent), name));
      if (name === 'workspace-state.json' || name === 'profile.json') regular(info);
      else if (!info.isDirectory()) throw failure('A saved server has a linked recovery folder.');
    }
    await backups(parent);
  }
  try {
    await backups(root);
    for (const name of ['server-profiles', 'deleted-server-profiles']) {
      if (!await inspect(path.join(anchor(root), name))) continue;
      const profiles = await child(root, name);
      try {
        const entries = await readdir(anchor(profiles));
        if (entries.length > 10_000) throw failure('Too many saved server folders to inspect safely.');
        for (const id of entries) {
          if (!uuid.test(id)) throw failure('An unknown saved server folder was found.');
          const profile = await child(profiles, id);
          try {
            if (name === 'server-profiles') await inspectRuntime(profile, ['minecraft', 'backups', 'installation-snapshots', 'workspace-state.json']);
            else {
              const managed = managedRecovery((await json(profile, 'profile.json')).value, id);
              await inspectRuntime(profile, managed ? ['profile.json', 'runtime'] : ['profile.json', 'minecraft', 'backups', 'installation-snapshots']);
              if (managed) {
                const runtime = await child(profile, 'runtime');
                try { await inspectRuntime(runtime, ['minecraft', 'backups', 'installation-snapshots', 'workspace-state.json']); }
                finally { await runtime.handle.close(); }
              }
            }
          } finally { await profile.handle.close(); }
        }
      } finally { await profiles.handle.close(); }
    }
    return snapshots;
  } finally { await root.handle.close(); }
}
async function verifyObjects(objects: BackupObjects, value: BackupObjectManifest): Promise<void> {
  for (const file of value.files) { const handle = await objects.openObject(file.sha256, file.size); await handle.close(); }
}
async function existingTree(root: Directory, metadata: Manifest): Promise<{ files: TreeFile[]; directories: TreeDirectory[] }> {
  const files: TreeFile[] = [];
  const directories: TreeDirectory[] = [];
  const expectedFiles = new Map(metadata.objects?.files.map(file => [file.path, file]));
  const expectedDirectories = new Set(metadata.objects?.directories);
  const walk = async (parent: Directory, name: string, relative: string) => {
    segment(name);
    if (relative.split('/').length > 32 || files.length + directories.length >= 200_000) throw failure('A backup tree is too large to inspect safely.');
    const candidate = path.join(anchor(parent), name);
    const info = await lstat(candidate);
    if (info.isDirectory()) {
      if (metadata.objects && !expectedDirectories.has(relative)) throw failure('A backup contains an unexpected legacy folder.');
      const nested = await child(parent, name);
      try {
        for (const childName of await readdir(anchor(nested))) await walk(nested, childName, `${relative}/${childName}`);
        directories.push({ path: relative, identity: nested.identity });
      } finally { await nested.handle.close(); }
    } else {
      regular(info);
      const expected = expectedFiles.get(relative);
      if (metadata.objects && (!expected || expected.size !== info.size)) throw failure('A backup contains an unexpected legacy file.');
      if (expected) {
        const file = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const before = await file.stat();
          regular(before);
          const hash = createHash('sha256');
          for await (const bytes of file.createReadStream({ autoClose: false })) hash.update(bytes);
          if (hash.digest('hex') !== expected.sha256 || !stable(info, before) || !stable(before, await file.stat()) || !stable(before, await lstat(candidate))) throw failure('A legacy backup copy does not match its stored object.');
        } finally { await file.close(); }
      }
      files.push({ path: relative, identity: info });
    }
  };
  for (const item of metadata.items) {
    if (await inspect(path.join(anchor(root), item))) await walk(root, item, item);
    else if (!metadata.objects) throw failure('A legacy backup is missing an item.');
  }
  return { files, directories };
}
async function removeFile(parent: Directory, name: string, identity: Stats): Promise<void> {
  await assertDirectory(parent);
  const current = await lstat(path.join(anchor(parent), name));
  regular(current);
  if (!stable(identity, current)) throw failure('A legacy backup copy changed during cleanup.');
  await unlink(path.join(anchor(parent), name));
  await parent.handle.sync();
}
async function cleanLegacy(root: Directory, metadata: Manifest): Promise<void> {
  const tree = await existingTree(root, metadata);
  for (const file of tree.files) {
    const parent = path.dirname(file.path) === '.' ? root : await directory(path.join(root.absolute, path.dirname(file.path)));
    try { await removeFile(parent, path.basename(file.path), file.identity); }
    finally { if (parent !== root) await parent.handle.close(); }
  }
  for (const entry of tree.directories) {
    const parent = path.dirname(entry.path) === '.' ? root : await directory(path.join(root.absolute, path.dirname(entry.path)));
    try {
      await assertDirectory(parent);
      const candidate = path.join(anchor(parent), path.basename(entry.path));
      const current = await lstat(candidate);
      if (!current.isDirectory() || !same(current, entry.identity)) throw failure('A legacy backup folder changed during cleanup.');
      await rmdir(candidate);
      await parent.handle.sync();
    } finally { if (parent !== root) await parent.handle.close(); }
  }
}
async function migrateSnapshot(saved: Snapshot, objects: BackupObjects): Promise<void> {
  const root = await directory(saved.absolute);
  try {
    if (!same(root.identity, saved.identity)) throw failure('A backup changed before migration.');
    let metadata = saved.manifest;
    const original = await json(root, 'backup.json');
    if (JSON.stringify(manifest(original.value)) !== JSON.stringify(metadata)) throw failure('Backup metadata changed before migration.');
    if (!metadata.objects) {
      await existingTree(root, metadata);
      const captured = await objects.capture(root.absolute, metadata.items);
      if (captured.snapshotBytes !== metadata.snapshotBytes) throw failure('A legacy backup size does not match its metadata.');
      await verifyObjects(objects, captured);
      const converted = JSON.stringify({ format: 2, createdAt: metadata.createdAt, kind: metadata.kind, items: metadata.items, ...captured });
      if (Buffer.byteLength(converted) > maximumBackupManifestBytes) throw failure('The migrated backup manifest is too large.');
      const temporary = path.join(anchor(root), `.backup-migration-${randomUUID()}.json`);
      try {
        const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await file.writeFile(converted); await file.sync(); } finally { await file.close(); }
        if (!stable(original.identity, (await json(root, 'backup.json')).identity)) throw failure('Backup metadata changed before commit.');
        await rename(temporary, path.join(anchor(root), 'backup.json'));
        await root.handle.sync();
      } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
      metadata = { ...metadata, objects: captured };
    }
    await verifyObjects(objects, metadata.objects!);
    await cleanLegacy(root, metadata);
    for (const name of saved.pending) {
      const pending = await json(root, name);
      const staged = manifest(pending.value);
      if (JSON.stringify(staged.objects) !== JSON.stringify(metadata.objects)) throw failure('An interrupted migration has different backup contents.');
      await removeFile(root, name, pending.identity);
    }
    const parent = await directory(path.dirname(root.absolute));
    try {
      const archive = `${path.basename(root.absolute)}.tar.gz`;
      const info = await inspect(path.join(anchor(parent), archive));
      if (info) await removeFile(parent, archive, info);
    } finally { await parent.handle.close(); }
  } finally { await root.handle.close(); }
}

export async function collectBackupObjects(runtimeDirectory: string): Promise<void> {
  const snapshots = await inventory(runtimeDirectory);
  const referenced = new Set<string>();
  const sizes = new Map<string, number>();
  const remember = (value?: BackupObjectManifest) => {
    for (const file of value?.files ?? []) {
      if (sizes.has(file.sha256) && sizes.get(file.sha256) !== file.size) throw failure('Backup objects have conflicting sizes.');
      referenced.add(file.sha256);
      sizes.set(file.sha256, file.size);
    }
  };
  for (const saved of snapshots) {
    remember(saved.manifest.objects);
    const root = await directory(saved.absolute);
    try {
      if (!same(root.identity, saved.identity)) throw failure('A backup changed before collection.');
      if (JSON.stringify(manifest((await json(root, 'backup.json')).value)) !== JSON.stringify(saved.manifest)) throw failure('Backup metadata changed before collection.');
      await existingTree(root, saved.manifest);
      for (const name of saved.pending) remember(manifest((await json(root, name)).value).objects);
    } finally { await root.handle.close(); }
  }
  const objects = new BackupObjects(path.join(runtimeDirectory, 'backup-objects'));
  for (const [hash, size] of sizes) { const file = await objects.openObject(hash, size); await file.close(); }
  await objects.collect(referenced);
}

export async function migrateBackups(runtimeDirectory: string): Promise<void> {
  const snapshots = await inventory(runtimeDirectory);
  const objects = new BackupObjects(path.join(runtimeDirectory, 'backup-objects'));
  for (const saved of snapshots) await migrateSnapshot(saved, objects);
  await collectBackupObjects(runtimeDirectory);
}
