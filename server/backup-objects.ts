import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rename, statfs, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export interface BackupObjectReference { path: string; sha256: string; size: number }
export interface BackupObjectManifest { files: BackupObjectReference[]; directories: string[]; snapshotBytes: string }
export const maximumBackupManifestBytes = 32 * 1024 ** 2;
const maximumEntries = 200_000;
const maximumFileBytes = 8 * 1024 ** 3;
const maximumBytes = 16n * 1024n ** 3n;
const reserveBytes = 256n * 1024n ** 2n;
const hashPattern = /^[a-f0-9]{64}$/;
const temporaryPattern = /^\.capture-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/;
const referenceSchema = z.object({ path: z.string().min(1).max(1024), sha256: z.string().regex(hashPattern), size: z.number().int().nonnegative().max(maximumFileBytes) }).strict();
const manifestSchema = z.object({ files: z.array(referenceSchema).max(maximumEntries), directories: z.array(z.string().min(1).max(1024)).max(maximumEntries), snapshotBytes: z.string().regex(/^(?:0|[1-9][0-9]{0,19})$/) }).strict();
interface Directory { handle: FileHandle; absolute: string; identity: Stats }

function failure(message: string, statusCode = 409): Error { return Object.assign(new Error(message), { statusCode }); }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function sameFile(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }
function stable(left: Stats, right: Stats): boolean { return sameFile(left, right) && left.size === right.size && left.ctimeMs === right.ctimeMs && left.mtimeMs === right.mtimeMs; }
function regular(info: Stats): void { if (!info.isFile() || info.nlink !== 1) throw failure('Backup files must be regular files without symbolic or hard links.'); }
function relativeParts(value: string): string[] {
  if (typeof value !== 'string') throw failure('A backup path is invalid.');
  const parts = value.split('/');
  if (!value || Buffer.byteLength(value) > 1024 || parts.length > 32 || parts.some(part => !part || part === '.' || part === '..' || Buffer.byteLength(part) > 255 || /[\\\x00-\x1f\x7f:]/.test(part))) throw failure('A backup path is invalid.');
  return parts;
}
function absolutePath(value: string): string {
  if (!path.isAbsolute(value) || value.includes('\0') || path.normalize(value) !== value || value === path.parse(value).root) throw failure('Backup storage requires a dedicated absolute path.');
  if (process.platform === 'darwin' && ['/var/', '/tmp/', '/etc/'].some(prefix => value.startsWith(prefix))) return `/private${value}`;
  return value;
}
function contains(parent: string, child: string): boolean { const relative = path.relative(parent, child); return !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
function anchor(directory: Directory): string { return process.platform === 'linux' ? `/proc/self/fd/${directory.handle.fd}` : directory.absolute; }
async function assertDirectory(directory: Directory): Promise<void> {
  const latest = await lstat(directory.absolute);
  if (!latest.isDirectory() || !sameFile(directory.identity, latest)) throw failure('A backup directory changed while it was accessed.');
}
async function childDirectory(parent: Directory, name: string, create = false): Promise<Directory> {
  if (relativeParts(name).length !== 1) throw failure('A backup directory name is invalid.');
  await assertDirectory(parent);
  const candidate = path.join(anchor(parent), name);
  if (create) await mkdir(candidate, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
  const before = await lstat(candidate);
  if (!before.isDirectory()) throw failure('Backup directories cannot be symbolic links or special files.');
  const handle = await open(candidate, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const identity = await handle.stat();
    if (!identity.isDirectory() || !sameFile(before, identity)) throw failure('A backup directory changed while it was opened.');
    const directory = { handle, identity, absolute: path.join(parent.absolute, name) };
    await assertDirectory(parent);
    await assertDirectory(directory);
    if (create) await parent.handle.sync();
    return directory;
  } catch (error) { await handle.close(); throw error; }
}
async function directory(absolute: string, create = false): Promise<Directory> {
  absolute = absolutePath(absolute);
  const base = path.parse(absolute).root;
  const handle = await open(base, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let current: Directory = { handle, identity: await handle.stat(), absolute: base };
  const parts = absolute.slice(base.length).split(path.sep);
  try {
    for (const [index, part] of parts.entries()) {
      const next = await childDirectory(current, part, create && index === parts.length - 1);
      await current.handle.close();
      current = next;
    }
    return current;
  } catch (error) { await current.handle.close(); throw error; }
}
function selections(items: string[]): string[] {
  if (!Array.isArray(items) || items.length > maximumEntries) throw failure('The backup selection is invalid.');
  const ordered = items.map(item => { relativeParts(item); return item; }).sort();
  const previous = new Set<string>();
  for (const item of ordered) {
    const parts = relativeParts(item);
    for (let index = 1; index <= parts.length; index++) if (previous.has(parts.slice(0, index).join('/'))) throw failure('Backup selections cannot overlap.');
    previous.add(item);
  }
  return ordered;
}

export function validateBackupObjectManifest(value: unknown): BackupObjectManifest {
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) throw failure('The backup object manifest is invalid.');
  const manifest = parsed.data;
  if (manifest.files.length + manifest.directories.length > maximumEntries || Buffer.byteLength(JSON.stringify(manifest)) > maximumBackupManifestBytes) throw failure('The backup object manifest is too large.', 413);
  const entries = new Map<string, 'file' | 'directory'>();
  const sizes = new Map<string, number>();
  for (const name of manifest.directories) { relativeParts(name); if (entries.has(name)) throw failure('The backup object manifest contains duplicate paths.'); entries.set(name, 'directory'); }
  let total = 0n;
  for (const file of manifest.files) {
    relativeParts(file.path);
    if (entries.has(file.path)) throw failure('The backup object manifest contains duplicate paths.');
    if (sizes.has(file.sha256) && sizes.get(file.sha256) !== file.size) throw failure('The backup object manifest contains conflicting object sizes.');
    sizes.set(file.sha256, file.size);
    entries.set(file.path, 'file');
    total += BigInt(file.size);
  }
  for (const name of entries.keys()) {
    const parts = relativeParts(name);
    for (let index = 1; index < parts.length; index++) if (entries.get(parts.slice(0, index).join('/')) !== 'directory') throw failure('The backup object manifest contains missing or conflicting parent folders.');
  }
  if (total > maximumBytes || BigInt(manifest.snapshotBytes) !== total) throw failure('The backup object manifest has an invalid total size.', 413);
  return manifest;
}

export class BackupObjects {
  private readonly directory: string;
  private pending: Promise<void> = Promise.resolve();

  constructor(directory: string) { this.directory = absolutePath(directory); }

  async capture(sourceMinecraftRoot: string, items: string[]): Promise<BackupObjectManifest> {
    return this.exclusive(async () => {
      sourceMinecraftRoot = absolutePath(sourceMinecraftRoot);
      if (contains(sourceMinecraftRoot, this.directory) || contains(this.directory, sourceMinecraftRoot)) throw failure('Backup objects must be outside the Minecraft files.');
      const selected = selections(items);
      const root = await directory(sourceMinecraftRoot);
      const storage = await this.storage(true).catch(async error => { await root.handle.close(); throw error; });
      const files: BackupObjectReference[] = [];
      const directories = new Set<string>();
      let bytes = 0n;
      const recordDirectory = (relative: string) => { directories.add(relative); if (files.length + directories.size > maximumEntries) throw failure('The backup contains too many entries.', 413); };
      const walk = async (parent: Directory, name: string, relative: string): Promise<void> => {
        relativeParts(relative);
        if (files.length + directories.size >= maximumEntries) throw failure('The backup contains too many entries.', 413);
        await assertDirectory(parent);
        const candidate = path.join(anchor(parent), name);
        const before = await lstat(candidate);
        if (before.isDirectory()) {
          const child = await childDirectory(parent, name);
          try {
            recordDirectory(relative);
            const initial = await child.handle.stat();
            for (const entry of (await readdir(anchor(child))).sort()) await walk(child, entry, `${relative}/${entry}`);
            const final = await child.handle.stat();
            if (!stable(initial, final)) throw failure('A Minecraft folder changed while its backup was captured.');
            await assertDirectory(child);
          } finally { await child.handle.close(); }
        } else {
          regular(before);
          bytes += BigInt(before.size);
          if (before.size > maximumFileBytes || bytes > maximumBytes) throw failure('The backup exceeds its size limit.', 413);
          const file = await this.captureFile(storage, parent, name, before);
          files.push({ path: relative, ...file });
        }
      };
      try {
        const initial = await root.handle.stat();
        for (const item of selected) {
          const parts = relativeParts(item);
          let parent = root;
          try {
            for (let index = 0; index < parts.length - 1; index++) {
              const child = await childDirectory(parent, parts[index]!);
              if (parent !== root) await parent.handle.close();
              parent = child;
              recordDirectory(parts.slice(0, index + 1).join('/'));
            }
            await walk(parent, parts.at(-1)!, item);
          } finally { if (parent !== root) await parent.handle.close(); }
        }
        if (!stable(initial, await root.handle.stat())) throw failure('The Minecraft directory changed while its backup was captured.');
        await assertDirectory(root);
        return validateBackupObjectManifest({ files: files.sort((left, right) => left.path.localeCompare(right.path)), directories: [...directories].sort(), snapshotBytes: String(bytes) });
      } finally { await root.handle.close(); await storage.handle.close(); }
    });
  }

  async openObject(hash: string, size: number): Promise<FileHandle> {
    if (!hashPattern.test(hash) || !Number.isSafeInteger(size) || size < 0 || size > maximumFileBytes) throw failure('The backup object reference is invalid.');
    const storage = await this.storage(false);
    try { return await this.verifiedObject(storage, hash, size); }
    finally { await storage.handle.close(); }
  }

  async materialize(value: BackupObjectManifest, destination: string, items?: string[]): Promise<void> {
    return this.exclusive(async () => {
      const manifest = validateBackupObjectManifest(value);
      destination = absolutePath(destination);
      if (contains(destination, this.directory) || contains(this.directory, destination)) throw failure('Restored files must be outside backup object storage.');
      const selected = items === undefined ? undefined : selections(items);
      const available = new Set([...manifest.directories, ...manifest.files.map(file => file.path)]);
      if (selected?.some(item => !available.has(item))) throw failure('A selected restore path is absent from this backup.');
      const selectedSet = selected === undefined ? undefined : new Set(selected);
      const includes = (name: string) => {
        if (!selectedSet) return true;
        const parts = relativeParts(name);
        return parts.some((_, index) => selectedSet.has(parts.slice(0, index + 1).join('/')));
      };
      const files = manifest.files.filter(file => includes(file.path));
      const parents = new Set<string>();
      for (const name of [...files.map(file => file.path), ...selected ?? []]) {
        const parts = relativeParts(name);
        for (let index = 1; index < parts.length; index++) parents.add(parts.slice(0, index).join('/'));
      }
      const folders = manifest.directories.filter(name => includes(name) || parents.has(name));
      for (const file of files) { const handle = await this.openObject(file.sha256, file.size); await handle.close(); }
      const root = await directory(destination, true);
      const parentFor = async (parts: string[]): Promise<Directory> => {
        let parent = root;
        try {
          for (const part of parts) {
            const child = await childDirectory(parent, part, true);
            if (parent !== root) await parent.handle.close();
            parent = child;
          }
          return parent;
        } catch (error) { if (parent !== root) await parent.handle.close(); throw error; }
      };
      try {
        for (const folder of folders.sort((left, right) => relativeParts(left).length - relativeParts(right).length)) { const child = await parentFor(relativeParts(folder)); if (child !== root) await child.handle.close(); }
        for (const file of files) {
          const parts = relativeParts(file.path);
          const name = parts.pop()!;
          const parent = await parentFor(parts);
          const temporary = path.join(anchor(parent), `.capture-${randomUUID()}.tmp`);
          let input: FileHandle | undefined;
          let output: FileHandle | undefined;
          let temporaryCreated = false;
          try {
            const candidate = path.join(anchor(parent), name);
            const existing = await lstat(candidate).catch(error => { if (missing(error)) return undefined; throw error; });
            if (existing) regular(existing);
            input = await this.openObject(file.sha256, file.size);
            const before = await input.stat();
            output = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            temporaryCreated = true;
            const hash = await this.copy(input, output, file.size, parent);
            if (hash !== file.sha256 || !stable(before, await input.stat())) throw failure('A backup object changed while it was restored.');
            await output.sync();
            await output.close();
            output = undefined;
            await assertDirectory(parent);
            const latest = await lstat(candidate).catch(error => { if (missing(error)) return undefined; throw error; });
            if (latest) regular(latest);
            if (existing ? !latest || !stable(existing, latest) : latest !== undefined) throw failure('A restore destination changed while it was written.');
            await rename(temporary, candidate);
            temporaryCreated = false;
            await parent.handle.sync();
          } finally {
            await input?.close();
            await output?.close();
            if (temporaryCreated) await unlink(temporary).catch(error => { if (!missing(error)) throw error; });
            if (parent !== root) await parent.handle.close();
          }
        }
      } finally { await root.handle.close(); }
    });
  }

  async collect(referencedHashes: Set<string>): Promise<void> {
    return this.exclusive(async () => {
      if (!(referencedHashes instanceof Set) || [...referencedHashes].some(hash => !hashPattern.test(hash))) throw failure('The referenced backup objects are invalid.');
      const storage = await this.storage(false).catch(error => { if (missing(error) && !referencedHashes.size) return undefined; throw error; });
      if (!storage) return;
      const found = new Set<string>();
      const obsolete: Array<{ parent: string; name: string; identity: Stats }> = [];
      try {
        for (const name of await readdir(anchor(storage))) {
          const candidate = path.join(anchor(storage), name);
          const info = await lstat(candidate);
          if (temporaryPattern.test(name)) { regular(info); obsolete.push({ parent: this.directory, name, identity: info }); continue; }
          if (!/^[a-f0-9]{2}$/.test(name) || !info.isDirectory()) throw failure('Backup object storage contains an unexpected entry. Nothing was collected.');
          const shard = await childDirectory(storage, name);
          try {
            this.privateDirectory(shard);
            for (const hash of await readdir(anchor(shard))) {
              if (!hashPattern.test(hash) || !hash.startsWith(name)) throw failure('Backup object storage contains an unexpected entry. Nothing was collected.');
              const info = await lstat(path.join(anchor(shard), hash));
              const handle = await this.verifiedObject(storage, hash, info.size);
              await handle.close();
              found.add(hash);
              if (!referencedHashes.has(hash)) obsolete.push({ parent: shard.absolute, name: hash, identity: info });
            }
          } finally { await shard.handle.close(); }
        }
        if ([...referencedHashes].some(hash => !found.has(hash))) throw failure('A referenced backup object is missing. Nothing was collected.');
        for (const item of obsolete) {
          const parent = await directory(item.parent);
          try {
            const candidate = path.join(anchor(parent), item.name);
            const current = await lstat(candidate);
            regular(current);
            if (!stable(item.identity, current)) throw failure('Backup objects changed during collection. Remaining objects were preserved.');
            await unlink(candidate);
            await parent.handle.sync();
          } finally { await parent.handle.close(); }
        }
      } finally { await storage.handle.close(); }
    });
  }

  private async storage(create: boolean): Promise<Directory> {
    const storage = await directory(this.directory, create);
    try { this.privateDirectory(storage); return storage; }
    catch (error) { await storage.handle.close(); throw error; }
  }

  private privateDirectory(directory: Directory): void { if (directory.identity.mode & 0o077) throw failure('Backup object storage must be private to its controller.'); }

  private async verifiedObject(storage: Directory, hash: string, size: number): Promise<FileHandle> {
    const shard = await childDirectory(storage, hash.slice(0, 2));
    try {
      this.privateDirectory(shard);
      const candidate = path.join(anchor(shard), hash);
      const initial = await lstat(candidate);
      regular(initial);
      if (initial.size !== size || initial.size > maximumFileBytes || initial.mode & 0o222) throw failure('A backup object has invalid size or permissions.');
      const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await handle.stat();
        regular(before);
        if (!stable(initial, before) || await this.copy(handle, undefined, size) !== hash) throw failure('A backup object failed its checksum verification.');
        const after = await handle.stat();
        regular(after);
        if (!stable(before, after) || !stable(after, await lstat(candidate))) throw failure('A backup object changed during verification.');
        return handle;
      } catch (error) { await handle.close(); throw error; }
    } finally { await shard.handle.close(); }
  }

  private async captureFile(storage: Directory, parent: Directory, name: string, initial: Stats): Promise<{ sha256: string; size: number }> {
    const candidate = path.join(anchor(parent), name);
    const temporary = path.join(anchor(storage), `.capture-${randomUUID()}.tmp`);
    const input = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let output: FileHandle | undefined;
    let temporaryCreated = false;
    try {
      const before = await input.stat();
      regular(before);
      if (!stable(initial, before)) throw failure('A Minecraft file changed while its backup was opened.');
      const expectedHash = await this.copy(input, undefined, before.size);
      const hashed = await input.stat();
      regular(hashed);
      if (!stable(before, hashed) || !stable(hashed, await lstat(candidate))) throw failure('A Minecraft file changed while its checksum was captured.');
      const existing = await this.verifiedObject(storage, expectedHash, before.size).catch(error => { if (missing(error)) return undefined; throw error; });
      if (existing) {
        await existing.close();
        const latest = await input.stat();
        regular(latest);
        if (!stable(before, latest) || !stable(latest, await lstat(candidate))) throw failure('A Minecraft file changed while its backup was captured.');
        await assertDirectory(parent);
        return { sha256: expectedHash, size: before.size };
      }
      output = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      temporaryCreated = true;
      const sha256 = await this.copy(input, output, before.size, storage);
      const after = await input.stat();
      regular(after);
      if (sha256 !== expectedHash || !stable(before, after) || !stable(after, await lstat(candidate))) throw failure('A Minecraft file changed while its backup was captured.');
      await assertDirectory(parent);
      await output.chmod(0o400);
      await output.sync();
      await output.close();
      output = undefined;
      const shard = await childDirectory(storage, sha256.slice(0, 2), true);
      try {
        this.privateDirectory(shard);
        try { await link(temporary, path.join(anchor(shard), sha256)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        await unlink(temporary);
        temporaryCreated = false;
        await storage.handle.sync();
        await shard.handle.sync();
        const verified = await this.verifiedObject(storage, sha256, before.size);
        await verified.close();
      } finally { await shard.handle.close(); }
      return { sha256, size: before.size };
    } finally { await input.close(); await output?.close(); if (temporaryCreated) await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
  }

  private async copy(input: FileHandle, output: FileHandle | undefined, size: number, storage?: Directory): Promise<string> {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(1024 * 1024, size)));
    let offset = 0;
    while (offset < size) {
      if (output) {
        const space = await statfs(storage ? anchor(storage) : `/proc/self/fd/${output.fd}`, { bigint: true }).catch(error => { if (process.platform !== 'linux' && !storage) return undefined; throw error; });
        if (space && space.bavail * space.bsize < reserveBytes + BigInt(Math.min(buffer.length, size - offset))) throw failure('There is not enough free space to safely save or restore this backup.', 507);
      }
      const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (!bytesRead) throw failure('A backup file changed during its copy.');
      hash.update(buffer.subarray(0, bytesRead));
      if (output) {
        let written = 0;
        while (written < bytesRead) { const result = await output.write(buffer, written, bytesRead - written, offset + written); if (!result.bytesWritten) throw failure('A backup copy could not be completed.'); written += result.bytesWritten; }
      }
      offset += bytesRead;
    }
    return hash.digest('hex');
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.pending;
    let release!: () => void;
    this.pending = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
}
