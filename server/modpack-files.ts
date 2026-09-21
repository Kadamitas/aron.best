import { createHash, randomUUID } from 'node:crypto';
import { constants, type ReadStream, type Stats } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, rename, rmdir, statfs, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { maximumArchiveBytes, workspaceArchive } from './workspace-archive.js';

const roots = [['config'], ['defaultconfigs'], ['kubejs'], ['scripts'], ['mods'], ['datapacks'], ['resourcepacks'], ['shaderpacks'], ['world', 'serverconfig']] as const;
const binaryExtensions = new Set(['.7z', '.avi', '.bin', '.bmp', '.bz2', '.class', '.dat', '.db', '.dll', '.exe', '.flac', '.gif', '.gz', '.ico', '.jar', '.jpeg', '.jpg', '.m4a', '.mkv', '.mov', '.mp3', '.mp4', '.nbt', '.o', '.ogg', '.otf', '.pdf', '.png', '.pyc', '.rar', '.schem', '.so', '.sqlite', '.tar', '.tgz', '.ttf', '.wav', '.webm', '.webp', '.woff', '.woff2', '.xz', '.zip']);
const maximumTextBytes = 256 * 1024;
const maximumFileBytes = 128 * 1024 * 1024;
const maximumChunkBytes = 512 * 1024;
const maximumReservedBytes = 256 * 1024 * 1024;
const maximumWorkspaceBytes = 4 * 1024 * 1024 * 1024;
const minimumFreeBytes = 256 * 1024 * 1024;
const maximumEntries = 1200;
const maximumDepth = 8;
const uploadLifetime = 15 * 60_000;

export class ModpackFilesError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); }
}

export interface ModpackFile {
  path: string;
  name: string;
  size: number;
  modifiedAt: string;
  text: boolean;
}

export interface ModpackText extends ModpackFile {
  contents: string;
  revision: string;
}

export interface ModpackDirectory { path: string; name: string }

interface TreeEntry { parts: string[]; info: Stats; directory: boolean }

export interface WorkspaceManifest {
  minecraft: { version: string; modLoaders: Array<{ id: string; primary: boolean }> };
  manifestType: 'minecraftModpack';
  manifestVersion: 1;
  name: string;
  version: string;
  author?: string;
  files: unknown[];
  overrides: 'overrides';
}

interface Directory {
  handle: FileHandle;
  absolute: string;
  anchored: string;
  identity: Stats;
}

interface OpenFile { handle: FileHandle; info: Stats; relative: string }

interface UploadSession {
  id: string;
  address: string;
  destination: string;
  directory: Directory;
  handle: FileHandle;
  temporary: string;
  size: number;
  received: number;
  nextChunk: number;
  baseline: string | null;
  replace: boolean;
  expiresAt: number;
}

function extension(value: string): string { return path.extname(value).toLowerCase(); }
function editableFile(value: string): boolean { return !binaryExtensions.has(extension(value)) && !/\.jar\.disabled$/i.test(value); }
function revision(value: Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function sameFile(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }
function regular(info: Stats): void {
  if (!info.isFile() || info.nlink !== 1) throw new ModpackFilesError('That workspace path must be a regular file without additional hard links.', 409);
}
function pathParts(value: string): string[] {
  if (!value || value !== value.trim() || value.length > 320 || value.startsWith('/') || value.includes('\\') || value.includes('\0')) throw new ModpackFilesError('Use a valid workspace-relative file path.');
  const parts = value.split('/');
  if (parts.length > maximumDepth + 3 || parts.some(part => !part || Buffer.byteLength(part) > 240 || part === '.' || part === '..' || part.startsWith('.') || /[\x00-\x1f\x7f:]/.test(part))) throw new ModpackFilesError('Use a valid workspace-relative file path.');
  if (!roots.some(root => parts.length > root.length && root.every((part, index) => parts[index] === part))) throw new ModpackFilesError('That file is outside the modpack workspace.');
  return parts;
}
function assertNewMod(filePath: string, replace: boolean, baseline: string | null = null): void {
  const parts = pathParts(filePath);
  if (parts.length !== 2 || parts[0] !== 'mods' || !/\.jar$/i.test(parts[1]!) || replace || baseline !== null) {
    throw new ModpackFilesError('While the server is running, only new JAR files can be added to the mods folder. Stop it before replacing mods or changing other files.', 409);
  }
}
function fileMetadata(relative: string, info: Stats): ModpackFile {
  return { path: relative, name: path.basename(relative), size: info.size, modifiedAt: info.mtime.toISOString(), text: editableFile(relative) };
}
function validText(bytes: Buffer): string {
  const contents = bytes.toString('utf8');
  if (contents.includes('\0') || !Buffer.from(contents, 'utf8').equals(bytes)) throw new ModpackFilesError('This file is not valid UTF-8 text.');
  return contents;
}

export class ModpackFiles {
  private readonly sessions = new Map<string, UploadSession>();
  private pending: Promise<void> = Promise.resolve();
  private cleanupTimer?: NodeJS.Timeout;
  private readonly root: string;

  constructor(root: string) { this.root = path.resolve(root); }

  async list(): Promise<{ files: ModpackFile[]; directories: ModpackDirectory[]; truncated: boolean }> {
    return this.exclusive(async () => {
      await this.clearExpired();
      const files: ModpackFile[] = [];
      const directories: ModpackDirectory[] = [];
      let truncated = false;
      for (const base of roots) {
        const directory = await this.optionalDirectory(base);
        if (!directory) continue;
        directories.push({ path: base.join('/'), name: base.at(-1)! });
        try { truncated ||= await this.walk(base, directory, files, 0, false, directories); }
        finally { await directory.handle.close(); }
        if (truncated) break;
      }
      return { files: files.sort((left, right) => left.path.localeCompare(right.path)), directories: directories.sort((left, right) => left.path.localeCompare(right.path)), truncated };
    });
  }

  async createDirectory(directoryPath: string): Promise<ModpackDirectory> {
    return this.exclusive(async () => {
      await this.clearExpired();
      const parts = pathParts(directoryPath);
      this.assertNoUpload(directoryPath);
      await this.checkQuota(0, 0);
      const parent = await this.directory(parts.slice(0, -1), true);
      try {
        await this.createChild(parent, parts.at(-1)!);
        return { path: directoryPath, name: parts.at(-1)! };
      } finally { await parent.handle.close(); }
    });
  }

  async move(sourcePath: string, destinationPath: string): Promise<{ path: string; name: string; type: 'file' | 'directory' }> {
    return this.exclusive(async () => {
      await this.clearExpired();
      const source = pathParts(sourcePath);
      const destination = pathParts(destinationPath);
      if (destinationPath === sourcePath || destinationPath.startsWith(`${sourcePath}/`)) throw new ModpackFilesError('Choose a destination outside the selected folder.', 409);
      this.assertNoUpload(sourcePath, destinationPath);
      const parent = await this.directory(source.slice(0, -1), false);
      let target: Directory | undefined;
      try {
        target = await this.directory(destination.slice(0, -1), false);
        const type = await this.transfer(parent, source.at(-1)!, target, destination.at(-1)!, sourcePath, destinationPath);
        return { path: destinationPath, name: destination.at(-1)!, type };
      } finally { await target?.handle.close(); await parent.handle.close(); }
    });
  }

  async remove(filePath: string): Promise<{ path: string; removed: true; recoveryPath: string }> {
    return this.exclusive(async () => {
      await this.clearExpired();
      const parts = pathParts(filePath);
      this.assertNoUpload(filePath);
      const base = roots.find(root => root.every((part, index) => parts[index] === part))!;
      const parent = await this.directory(parts.slice(0, -1), false);
      let recovery: Directory | undefined;
      try {
        const rootDirectory = await this.directory(base, false);
        try { recovery = await this.childDirectory(rootDirectory, '.removed', true); }
        finally { await rootDirectory.handle.close(); }
        const name = `${Date.now()}-${randomUUID()}-${Buffer.from(parts.at(-1)!).subarray(0, 160).toString('utf8').replace(/\ufffd$/, '')}`;
        const recoveryPath = [...base, '.removed', name].join('/');
        await this.transfer(parent, parts.at(-1)!, recovery, name, filePath);
        return { path: filePath, removed: true, recoveryPath };
      } finally { await recovery?.handle.close(); await parent.handle.close(); }
    });
  }

  async listMods(): Promise<{ mods: Array<ModpackFile & { enabled: boolean }> }> {
    return this.exclusive(async () => {
      const directory = await this.optionalDirectory(['mods']);
      if (!directory) return { mods: [] };
      try {
        const mods: Array<ModpackFile & { enabled: boolean }> = [];
        for (const name of (await readdir(directory.anchored)).sort()) {
          if (name.startsWith('.') || !/\.jar(?:\.disabled)?$/i.test(name)) continue;
          const file = await this.openExisting(directory, name, `mods/${name}`).catch(error => {
            if (error instanceof ModpackFilesError || missing(error)) return undefined;
            throw error;
          });
          if (!file) continue;
          try { mods.push({ ...fileMetadata(file.relative, file.info), enabled: !name.toLowerCase().endsWith('.disabled') }); }
          finally { await file.handle.close(); }
          if (mods.length >= maximumEntries) break;
        }
        return { mods };
      } finally { await directory.handle.close(); }
    });
  }

  async modAction(filePath: string, action: 'enable' | 'disable' | 'uninstall'): Promise<ModpackFile | { path: string; removed: true }> {
    return this.exclusive(async () => {
      const parts = pathParts(filePath);
      if (parts.length !== 2 || parts[0] !== 'mods' || !/\.jar(?:\.disabled)?$/i.test(parts[1]!)) throw new ModpackFilesError('Choose a mod from the mods folder.');
      if (!['enable', 'disable', 'uninstall'].includes(action)) throw new ModpackFilesError('Choose a supported mod action.');
      const directory = await this.directory(['mods'], false);
      let destinationDirectory: Directory | undefined;
      try {
        const name = parts[1]!;
        const source = await this.openExisting(directory, name, filePath);
        try {
          const disabled = name.toLowerCase().endsWith('.disabled');
          if (action === 'enable' && !disabled || action === 'disable' && disabled) return fileMetadata(filePath, source.info);
          const removedName = Buffer.from(name).subarray(0, 180).toString('utf8').replace(/\ufffd$/, '');
          const destination = action === 'uninstall' ? `${Date.now()}-${randomUUID()}-${removedName}` : disabled ? name.slice(0, -9) : `${name}.disabled`;
          destinationDirectory = action === 'uninstall' ? await this.childDirectory(directory, '.removed', true) : undefined;
          const targetDirectory = destinationDirectory ?? directory;
          await this.assertDirectory(directory);
          await this.assertDirectory(targetDirectory);
          await this.assertFile(directory, name, source.info);
          const target = path.join(targetDirectory.anchored, destination);
          try { await link(path.join(directory.anchored, name), target); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ModpackFilesError('A mod already exists at the destination. No files were replaced.', 409);
            throw error;
          }
          try {
            const moved = await lstat(target);
            if (!sameFile(moved, source.info)) throw new ModpackFilesError('The mod changed during this operation. Try again.', 409);
            await this.assertFile(directory, name, source.info, 2);
            await unlink(path.join(directory.anchored, name));
          } catch (error) { await unlink(target).catch(() => undefined); throw error; }
          if (action === 'uninstall') return { path: `mods/.removed/${destination}`, removed: true };
          return fileMetadata(`mods/${destination}`, await lstat(target));
        } finally { await source.handle.close(); }
      } finally { await destinationDirectory?.handle.close(); await directory.handle.close(); }
    });
  }

  async text(filePath: string): Promise<ModpackText> { return this.exclusive(() => this.readText(filePath)); }

  async exportArchive(manifest: WorkspaceManifest): Promise<Buffer> {
    return this.exclusive(async () => {
      const metadata = Buffer.from(`${JSON.stringify({ minecraft: manifest.minecraft, manifestType: 'minecraftModpack', manifestVersion: 1, name: manifest.name, version: manifest.version, ...(manifest.author ? { author: manifest.author } : {}), files: [], overrides: 'overrides' }, null, 2)}\n`);
      if (metadata.length > 64 * 1024) throw new ModpackFilesError('The modpack archive metadata is too large.', 413);
      const inventory = await this.archiveInventory();
      const entries: Array<readonly [string, Buffer]> = [['manifest.json', metadata]];
      const versions = new Map<string, string>();
      let total = 22 + 76 + Buffer.byteLength('manifest.json') * 2 + metadata.length;
      for (const item of inventory) {
        const name = `overrides/${item.path}`;
        total += 76 + Buffer.byteLength(name) * 2 + item.size;
        if (total > maximumArchiveBytes) throw new ModpackFilesError('The modpack archive is limited to 128 MiB.', 413);
        const parts = pathParts(item.path);
        const directory = await this.directory(parts.slice(0, -1), false);
        try {
          const snapshot = await this.snapshot(directory, parts.at(-1)!, maximumFileBytes);
          if (!snapshot || snapshot.info.size !== item.size || snapshot.info.mtime.toISOString() !== item.modifiedAt) throw new ModpackFilesError('The modpack changed while the archive was being built. Try again.', 409);
          versions.set(item.path, snapshot.token);
          entries.push([name, snapshot.bytes]);
        } finally { await directory.handle.close(); }
      }
      if (JSON.stringify(await this.archiveInventory()) !== JSON.stringify(inventory)) throw new ModpackFilesError('The modpack changed while the archive was being built. Try again.', 409);
      for (const item of inventory) {
        const parts = pathParts(item.path);
        const directory = await this.directory(parts.slice(0, -1), false);
        try {
          const current = await this.snapshot(directory, parts.at(-1)!, maximumFileBytes, false);
          if (current?.token !== versions.get(item.path)) throw new ModpackFilesError('The modpack changed while the archive was being built. Try again.', 409);
        } finally { await directory.handle.close(); }
      }
      return workspaceArchive(entries);
    });
  }

  async writeText(filePath: string, contents: string, expectedRevision: string): Promise<ModpackText> {
    return this.exclusive(async () => {
      const parts = pathParts(filePath);
      if (!editableFile(filePath)) throw new ModpackFilesError('Binary files cannot be edited as text.');
      const bytes = Buffer.from(contents, 'utf8');
      if (bytes.length > maximumTextBytes) throw new ModpackFilesError('Text files are limited to 256 KiB.', 413);
      if (validText(bytes) !== contents) throw new ModpackFilesError('This file is not valid UTF-8 text.');
      const directory = await this.directory(parts.slice(0, -1), true);
      const name = parts.at(-1)!;
      const temporary = `.write-${randomUUID()}.tmp`;
      let created = false;
      try {
        const current = await this.snapshot(directory, name, maximumTextBytes);
        if (current) validText(current.bytes);
        if (current ? revision(current.bytes) !== expectedRevision : expectedRevision !== 'new') throw new ModpackFilesError('This file changed while you were editing it. Reload it before saving.', 409);
        await this.checkQuota(bytes.length, current?.bytes.length ?? 0);
        await this.assertDirectory(directory);
        const handle = await open(path.join(directory.anchored, temporary), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        created = true;
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        await this.assertDirectory(directory);
        const latest = await this.snapshot(directory, name, maximumTextBytes);
        if ((latest?.token ?? null) !== (current?.token ?? null)) throw new ModpackFilesError('This file changed while you were editing it. Reload it before saving.', 409);
        await this.publish(path.join(directory.anchored, temporary), directory, name, Boolean(current));
        created = false;
        return await this.readText(filePath);
      } finally {
        if (created) await this.removeTemporary(directory, temporary);
        await directory.handle.close();
      }
    });
  }

  async download(filePath: string): Promise<{ stream: ReadStream; name: string; size: number }> {
    return this.exclusive(async () => {
      const parts = pathParts(filePath);
      const directory = await this.directory(parts.slice(0, -1), false);
      try {
        const file = await this.openExisting(directory, parts.at(-1)!, filePath);
        if (file.info.size > maximumFileBytes) { await file.handle.close(); throw new ModpackFilesError('Downloads are limited to 128 MiB.', 413); }
        return { stream: file.handle.createReadStream({ autoClose: true, end: Math.max(0, file.info.size - 1) }), name: path.basename(filePath), size: file.info.size };
      } finally { await directory.handle.close(); }
    });
  }

  async beginUpload(filePath: string, size: number, replace: boolean, address: string, newModOnly = false): Promise<{ id: string; chunkBytes: number }> {
    return this.exclusive(async () => {
      await this.clearExpired();
      const parts = pathParts(filePath);
      if (newModOnly) assertNewMod(filePath, replace);
      if (!Number.isSafeInteger(size) || size < 1 || size > maximumFileBytes) throw new ModpackFilesError('Uploads must be between 1 byte and 128 MiB.', 413);
      if (this.sessions.size >= 8 || [...this.sessions.values()].filter(session => session.address === address).length >= 2) throw new ModpackFilesError('Too many uploads are in progress. Try again shortly.', 429);
      if ([...this.sessions.values()].some(session => session.destination === filePath)) throw new ModpackFilesError('An upload to that file is already in progress.', 409);
      const reserved = [...this.sessions.values()].reduce((total, session) => total + session.size, 0);
      if (reserved + size > maximumReservedBytes) throw new ModpackFilesError('The upload storage limit has been reached. Finish or cancel an upload first.', 429);
      const directory = await this.directory(parts.slice(0, -1), true);
      const name = parts.at(-1)!;
      const id = randomUUID();
      const temporary = `.upload-${id}.part`;
      let handle: FileHandle | undefined;
      try {
        await this.removeOrphans(directory);
        const current = await this.snapshot(directory, name, maximumFileBytes, false);
        if (current && !replace) throw new ModpackFilesError('A file already exists there. Enable replace to overwrite it.', 409);
        await this.checkQuota(size, current?.info.size ?? 0);
        await this.assertDirectory(directory);
        handle = await open(path.join(directory.anchored, temporary), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        this.sessions.set(id, { id, address, destination: filePath, directory, handle, temporary, size, received: 0, nextChunk: 0, baseline: current?.token ?? null, replace, expiresAt: Date.now() + uploadLifetime });
        this.scheduleCleanup();
        return { id, chunkBytes: maximumChunkBytes };
      } catch (error) {
        if (handle) { await handle.close(); await this.removeTemporary(directory, temporary); }
        await directory.handle.close();
        throw error;
      }
    });
  }

  async appendUpload(id: string, index: number, encoded: string, address: string, newModOnly = false): Promise<{ received: number; complete: boolean }> {
    return this.exclusive(async () => {
      await this.clearExpired();
      const session = this.session(id, address);
      if (newModOnly) assertNewMod(session.destination, session.replace, session.baseline);
      if (!Number.isSafeInteger(index) || index !== session.nextChunk) throw new ModpackFilesError('Upload chunks must arrive in order.', 409);
      if (encoded.length > Math.ceil(maximumChunkBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new ModpackFilesError('The upload chunk is not valid base64 data.');
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.toString('base64') !== encoded || !bytes.length || bytes.length > maximumChunkBytes || bytes.length > session.size - session.received) throw new ModpackFilesError('The upload chunk has an invalid size.');
      await this.assertDirectory(session.directory);
      const current = await session.handle.stat();
      if (current.size !== session.received) throw new ModpackFilesError('The uploaded file changed. Start the upload again.', 409);
      await this.assertFile(session.directory, session.temporary, current);
      try {
        let written = 0;
        while (written < bytes.length) {
          const result = await session.handle.write(bytes, written, bytes.length - written, session.received + written);
          if (!result.bytesWritten) throw new ModpackFilesError('The upload could not be written.', 507);
          written += result.bytesWritten;
        }
      } catch (error) { await session.handle.truncate(session.received); throw error; }
      session.received += bytes.length;
      session.nextChunk++;
      session.expiresAt = Date.now() + uploadLifetime;
      return { received: session.received, complete: session.received === session.size };
    });
  }

  async finishUpload(id: string, address: string, newModOnly = false): Promise<ModpackFile> {
    return this.exclusive(async () => {
      await this.clearExpired();
      const session = this.session(id, address);
      if (newModOnly) assertNewMod(session.destination, session.replace, session.baseline);
      if (session.received !== session.size) throw new ModpackFilesError('The upload is not complete yet.', 409);
      try {
        const parts = pathParts(session.destination);
        const currentDirectory = await this.directory(parts.slice(0, -1), false);
        try { if (!sameFile(currentDirectory.identity, session.directory.identity)) throw new ModpackFilesError('The destination folder changed. Start the upload again.', 409); }
        finally { await currentDirectory.handle.close(); }
        const name = parts.at(-1)!;
        await this.assertDirectory(session.directory);
        const current = await this.snapshot(session.directory, name, maximumFileBytes, false);
        if ((current?.token ?? null) !== session.baseline) throw new ModpackFilesError('The destination file changed. Start the upload again.', 409);
        const uploaded = await session.handle.stat();
        if (uploaded.size !== session.size) throw new ModpackFilesError('The uploaded file changed. Start the upload again.', 409);
        await this.assertFile(session.directory, session.temporary, uploaded);
        await session.handle.sync();
        await this.publish(path.join(session.directory.anchored, session.temporary), session.directory, name, session.baseline !== null);
        return fileMetadata(session.destination, await lstat(path.join(session.directory.anchored, name)));
      } finally { await this.discard(session); }
    });
  }

  async cancelUpload(id: string, address: string): Promise<void> {
    return this.exclusive(async () => { await this.clearExpired(); await this.discard(this.session(id, address)); });
  }

  async close(): Promise<void> {
    return this.exclusive(async () => { for (const session of [...this.sessions.values()]) await this.discard(session); });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.pending;
    let release!: () => void;
    this.pending = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await operation(); }
    catch (error) {
      if (missing(error)) throw new ModpackFilesError('That workspace path does not exist.', 404);
      if (['ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new ModpackFilesError('That workspace path is not available.');
      throw error;
    } finally { release(); }
  }

  private assertNoUpload(...paths: string[]): void {
    for (const session of this.sessions.values()) {
      if (paths.some(candidate => session.destination === candidate || session.destination.startsWith(`${candidate}/`))) throw new ModpackFilesError('Finish or cancel the upload in this location first.', 409);
    }
  }

  private async createChild(parent: Directory, name: string): Promise<Stats> {
    await this.assertDirectory(parent);
    const destination = path.join(parent.anchored, name);
    try { await mkdir(destination, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ModpackFilesError('A file or folder already exists there. Nothing was replaced.', 409);
      throw error;
    }
    const info = await lstat(destination);
    if (!info.isDirectory()) throw new ModpackFilesError('The destination folder changed. Try again.', 409);
    return info;
  }

  private async inDirectory<T>(base: Directory, parts: readonly string[], operation: (directory: Directory) => Promise<T>): Promise<T> {
    if (!parts.length) return operation(base);
    const child = await this.childDirectory(base, parts[0]!, false);
    try { return await this.inDirectory(child, parts.slice(1), operation); }
    finally { await child.handle.close(); }
  }

  private async tree(directory: Directory, relative: string, entries: TreeEntry[] = [], prefix: string[] = []): Promise<TreeEntry[]> {
    if (prefix.length > maximumDepth) throw new ModpackFilesError('This folder has too many nested folders to change safely.', 413);
    await this.assertDirectory(directory);
    for (const name of (await readdir(directory.anchored)).sort()) {
      const parts = [...prefix, name];
      const filePath = `${relative}/${parts.join('/')}`;
      pathParts(filePath);
      if (entries.length >= maximumEntries) throw new ModpackFilesError('This folder has too many entries to change safely.', 413);
      const info = await lstat(path.join(directory.anchored, name));
      if (info.isDirectory()) {
        const child = await this.childDirectory(directory, name, false);
        try {
          entries.push({ parts, info: child.identity, directory: true });
          await this.tree(child, relative, entries, parts);
        } finally { await child.handle.close(); }
      } else {
        regular(info);
        entries.push({ parts, info, directory: false });
      }
    }
    return entries;
  }

  private async assertEntry(parent: Directory, name: string, expected: Stats, links = 1): Promise<void> {
    await this.assertDirectory(parent);
    const current = await lstat(path.join(parent.anchored, name));
    if (expected.isDirectory()) {
      if (!current.isDirectory() || !sameFile(current, expected)) throw new ModpackFilesError('The folder changed during this operation. Try again.', 409);
    } else {
      if (!current.isFile() || current.nlink !== links || !sameFile(current, expected) || current.size !== expected.size || current.mtimeMs !== expected.mtimeMs) throw new ModpackFilesError('The file changed during this operation. Try again.', 409);
    }
  }

  private async linkEntry(source: Directory, name: string, target: Directory, destination: string, expected: Stats): Promise<void> {
    await this.assertEntry(source, name, expected);
    await this.assertDirectory(target);
    const linked = path.join(target.anchored, destination);
    try { await link(path.join(source.anchored, name), linked); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ModpackFilesError('A file or folder already exists there. Nothing was replaced.', 409);
      throw error;
    }
    const linkedInfo = await lstat(linked);
    try {
      await this.assertEntry(source, name, expected, 2);
      await this.assertEntry(target, destination, expected, 2);
    } catch (error) {
      const candidate = await lstat(linked).catch(() => undefined);
      if (candidate && sameFile(candidate, linkedInfo)) await unlink(linked);
      throw error;
    }
  }

  private async transfer(source: Directory, name: string, target: Directory, destination: string, relative: string, destinationRelative?: string): Promise<'file' | 'directory'> {
    await this.assertDirectory(source);
    const info = await lstat(path.join(source.anchored, name));
    if (!info.isDirectory()) {
      regular(info);
      await this.linkEntry(source, name, target, destination, info);
      try {
        await this.assertEntry(source, name, info, 2);
        await unlink(path.join(source.anchored, name));
      } catch (error) {
        await this.assertEntry(target, destination, info, 2);
        await unlink(path.join(target.anchored, destination));
        throw error;
      }
      return 'file';
    }
    const origin = await this.childDirectory(source, name, false);
    let destinationDirectory: Directory | undefined;
    let destinationIdentity: Stats | undefined;
    const created: TreeEntry[] = [];
    let committed = false;
    try {
      const entries = await this.tree(origin, relative);
      for (const entry of entries) if (destinationRelative) pathParts(`${destinationRelative}/${entry.parts.join('/')}`);
      destinationIdentity = await this.createChild(target, destination);
      destinationDirectory = await this.childDirectory(target, destination, false);
      if (!sameFile(destinationIdentity, destinationDirectory.identity)) throw new ModpackFilesError('The destination folder changed. Try again.', 409);
      for (const entry of entries) {
        await this.inDirectory(destinationDirectory, entry.parts.slice(0, -1), async destinationParent => {
          const entryName = entry.parts.at(-1)!;
          if (entry.directory) created.push({ ...entry, info: await this.createChild(destinationParent, entryName) });
          else await this.inDirectory(origin, entry.parts.slice(0, -1), async sourceParent => {
            await this.linkEntry(sourceParent, entryName, destinationParent, entryName, entry.info);
            created.push(entry);
          });
        });
      }
      for (const entry of [{ parts: [] as string[], info: origin.identity, directory: true }, ...entries.filter(item => item.directory)]) {
        await this.inDirectory(origin, entry.parts, async directory => {
          if (!sameFile(directory.identity, entry.info)) throw new ModpackFilesError('The source folder changed during this operation.', 409);
          const expected = entries.filter(item => item.parts.length === entry.parts.length + 1 && entry.parts.every((part, index) => item.parts[index] === part)).map(item => item.parts.at(-1)!).sort();
          if (JSON.stringify((await readdir(directory.anchored)).sort()) !== JSON.stringify(expected)) throw new ModpackFilesError('The source folder changed during this operation.', 409);
        });
      }
      for (const entry of entries.filter(item => !item.directory)) {
        await this.inDirectory(origin, entry.parts.slice(0, -1), parent => this.assertEntry(parent, entry.parts.at(-1)!, entry.info, 2));
        await this.inDirectory(destinationDirectory, entry.parts.slice(0, -1), parent => this.assertEntry(parent, entry.parts.at(-1)!, entry.info, 2));
      }
      await this.assertEntry(source, name, origin.identity);
      await this.assertEntry(target, destination, destinationIdentity);
      for (const entry of [...entries].reverse()) {
        await this.inDirectory(origin, entry.parts.slice(0, -1), async parent => {
          await this.assertEntry(parent, entry.parts.at(-1)!, entry.info, entry.directory ? 1 : 2);
          const candidate = path.join(parent.anchored, entry.parts.at(-1)!);
          if (entry.directory) { await rmdir(candidate); committed = true; }
          else { await unlink(candidate); committed = true; }
        });
      }
      await this.assertEntry(source, name, origin.identity);
      await rmdir(path.join(source.anchored, name));
      return 'directory';
    } catch (error) {
      if (!committed && destinationDirectory) {
        for (const entry of [...created].reverse()) {
          await this.inDirectory(destinationDirectory, entry.parts.slice(0, -1), async parent => {
            await this.assertEntry(parent, entry.parts.at(-1)!, entry.info, entry.directory ? 1 : 2);
            const candidate = path.join(parent.anchored, entry.parts.at(-1)!);
            if (entry.directory) await rmdir(candidate); else await unlink(candidate);
          }).catch(() => undefined);
        }
        if (destinationIdentity) {
          await this.assertEntry(target, destination, destinationIdentity).then(() => rmdir(path.join(target.anchored, destination))).catch(() => undefined);
        }
      }
      if (committed) throw new ModpackFilesError('The source changed during the move. Files were retained at the destination; inspect both folders before trying again.', 409);
      throw error;
    } finally { await destinationDirectory?.handle.close(); await origin.handle.close(); }
  }

  private async readText(filePath: string): Promise<ModpackText> {
    const parts = pathParts(filePath);
    if (!editableFile(filePath)) throw new ModpackFilesError('Binary files cannot be edited as text.');
    const directory = await this.directory(parts.slice(0, -1), false);
    try {
      const snapshot = await this.snapshot(directory, parts.at(-1)!, maximumTextBytes);
      if (!snapshot) throw new ModpackFilesError('That workspace file does not exist.', 404);
      return { ...fileMetadata(filePath, snapshot.info), contents: validText(snapshot.bytes), revision: revision(snapshot.bytes) };
    } finally { await directory.handle.close(); }
  }

  private async snapshot(directory: Directory, name: string, limit: number, retainContents = true): Promise<{ bytes: Buffer; info: Stats; token: string } | null> {
    const file = await this.openExisting(directory, name, name).catch(error => { if (missing(error)) return null; throw error; });
    if (!file) return null;
    try {
      if (file.info.size > limit) throw new ModpackFilesError(limit === maximumTextBytes ? 'Text files are limited to 256 KiB.' : 'Files are limited to 128 MiB.', 413);
      const bytes = Buffer.alloc(retainContents ? file.info.size : Math.min(file.info.size, 64 * 1024));
      const hash = createHash('sha256');
      let offset = 0;
      while (offset < file.info.size) {
        const bufferOffset = retainContents ? offset : 0;
        const length = Math.min(bytes.length - bufferOffset, file.info.size - offset);
        const result = await file.handle.read(bytes, bufferOffset, length, offset);
        if (!result.bytesRead) break;
        hash.update(bytes.subarray(bufferOffset, bufferOffset + result.bytesRead));
        offset += result.bytesRead;
      }
      const latest = await file.handle.stat();
      if (offset !== file.info.size || latest.size !== file.info.size || latest.ctimeMs !== file.info.ctimeMs) throw new ModpackFilesError('This file changed while it was being read. Try again.', 409);
      regular(latest);
      return { bytes, info: latest, token: `${latest.dev}:${latest.ino}:${latest.ctimeMs}:${hash.digest('hex')}` };
    } finally { await file.handle.close(); }
  }

  private async openExisting(directory: Directory, name: string, relative: string): Promise<OpenFile> {
    await this.assertDirectory(directory);
    const candidate = path.join(directory.anchored, name);
    const before = await lstat(candidate);
    regular(before);
    const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      regular(info);
      if (!sameFile(before, info)) throw new ModpackFilesError('This file changed while it was being opened. Try again.', 409);
      await this.assertDirectory(directory);
      return { handle, info, relative };
    } catch (error) { await handle.close(); throw error; }
  }

  private async archiveInventory(): Promise<ModpackFile[]> {
    const files: ModpackFile[] = [];
    for (const base of roots) {
      if (base[0] === 'world') continue;
      const directory = await this.optionalDirectory(base, true);
      if (!directory) continue;
      try {
        if (await this.walk(base, directory, files, 0, true)) throw new ModpackFilesError('The modpack contains too many files or nested folders to export completely.', 413);
      } finally { await directory.handle.close(); }
    }
    return files.filter(file => !file.path.toLowerCase().endsWith('.jar.disabled')).sort((left, right) => left.path.localeCompare(right.path));
  }

  private async walk(base: readonly string[], directory: Directory, files: ModpackFile[], depth: number, strict = false, directories?: ModpackDirectory[]): Promise<boolean> {
    if (depth > maximumDepth || files.length + (directories?.length ?? 0) >= maximumEntries) return true;
    await this.assertDirectory(directory);
    for (const name of (await readdir(directory.anchored)).sort()) {
      if (name.startsWith('.')) continue;
      if (/[\x00-\x1f\x7f\\:]/.test(name)) {
        if (strict) throw new ModpackFilesError('The modpack contains a file path that cannot be exported safely.', 409);
        continue;
      }
      const relative = [...base, name];
      const info = await lstat(path.join(directory.anchored, name)).catch(error => { if (missing(error)) return undefined; throw error; });
      if (!info) { if (strict) throw new ModpackFilesError('The modpack changed while the archive was being built. Try again.', 409); continue; }
      if (info.isSymbolicLink() || info.isFile() && info.nlink !== 1) {
        if (strict) throw new ModpackFilesError('The modpack contains linked files or folders that cannot be exported safely.', 409);
        continue;
      }
      if (info.isDirectory()) {
        const child = await this.childDirectory(directory, name, false);
        directories?.push({ path: relative.join('/'), name });
        try { if (await this.walk(relative, child, files, depth + 1, strict, directories)) return true; }
        finally { await child.handle.close(); }
      } else if (info.isFile() && info.nlink === 1) {
        files.push(fileMetadata(relative.join('/'), info));
        if (files.length + (directories?.length ?? 0) >= maximumEntries) return true;
      }
    }
    return false;
  }

  private async optionalDirectory(parts: readonly string[], strict = false): Promise<Directory | undefined> {
    try { return await this.directory(parts, false); }
    catch (error) { if (missing(error) || !strict && error instanceof ModpackFilesError) return undefined; throw error; }
  }

  private async directory(parts: readonly string[], create: boolean): Promise<Directory> {
    const handle = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let current: Directory;
    try {
      const absolute = await realpath(this.root);
      const identity = await handle.stat();
      const actual = await lstat(absolute);
      if (!identity.isDirectory() || !sameFile(identity, actual)) throw new ModpackFilesError('The modpack workspace is not available.', 503);
      current = { handle, absolute, identity, anchored: process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : absolute };
    } catch (error) { await handle.close(); throw error; }
    try {
      for (const segment of parts) {
        const next = await this.childDirectory(current, segment, create);
        await current.handle.close();
        current = next;
      }
      return current;
    } catch (error) { await current.handle.close(); throw error; }
  }

  private async childDirectory(parent: Directory, name: string, create: boolean): Promise<Directory> {
    await this.assertDirectory(parent);
    const candidate = path.join(parent.anchored, name);
    if (create) await mkdir(candidate, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    let handle: FileHandle;
    try { handle = await open(candidate, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
    catch (error) {
      if (['ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new ModpackFilesError('That workspace folder is not available.');
      throw error;
    }
    try {
      const identity = await handle.stat();
      await this.assertDirectory(parent);
      const info = await lstat(candidate);
      if (!info.isDirectory() || !sameFile(info, identity)) throw new ModpackFilesError('That workspace folder changed. Try again.', 409);
      const absolute = path.join(parent.absolute, name);
      return { handle, absolute, identity, anchored: process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : absolute };
    } catch (error) { await handle.close(); throw error; }
  }

  private async assertDirectory(directory: Directory): Promise<void> {
    if (process.platform === 'linux') return;
    const resolvedRoot = await realpath(this.root);
    const relative = path.relative(resolvedRoot, directory.absolute);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new ModpackFilesError('That workspace folder is not available.');
    let absolute = resolvedRoot;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      absolute = path.join(absolute, segment);
      const info = await lstat(absolute);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new ModpackFilesError('That workspace folder is not available.');
    }
    const current = await lstat(directory.absolute);
    if (!current.isDirectory() || !sameFile(current, directory.identity)) throw new ModpackFilesError('That workspace folder changed. Try again.', 409);
  }

  private async assertFile(directory: Directory, name: string, expected: Stats, links = 1): Promise<void> {
    await this.assertDirectory(directory);
    const current = await lstat(path.join(directory.anchored, name));
    if (!current.isFile() || current.nlink !== links || !sameFile(current, expected)) throw new ModpackFilesError('That workspace file changed. Try again.', 409);
  }

  private async publish(temporary: string, directory: Directory, name: string, replace: boolean): Promise<void> {
    const target = path.join(directory.anchored, name);
    if (replace) await rename(temporary, target);
    else {
      try { await link(temporary, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ModpackFilesError('A file appeared at that path. No files were replaced.', 409);
        throw error;
      }
      await unlink(temporary);
    }
    await directory.handle.sync();
  }

  private async checkQuota(additional: number, replacing: number): Promise<void> {
    const disk = await statfs(this.root);
    const outstanding = [...this.sessions.values()].reduce((sum, session) => sum + session.size - session.received, 0);
    if (disk.bavail * disk.bsize < minimumFreeBytes + outstanding + additional) throw new ModpackFilesError('There is not enough free storage for that file.', 507);
    let used = 0;
    let entries = 0;
    const measure = async (directory: Directory, depth: number): Promise<void> => {
      if (depth > 32) throw new ModpackFilesError('The workspace storage limit cannot be verified.', 507);
      await this.removeOrphans(directory);
      for (const name of await readdir(directory.anchored)) {
        if (++entries > 50_000) throw new ModpackFilesError('The workspace storage limit cannot be verified.', 507);
        const info = await lstat(path.join(directory.anchored, name));
        if (info.isDirectory()) {
          const child = await this.childDirectory(directory, name, false);
          try { await measure(child, depth + 1); } finally { await child.handle.close(); }
        } else if (info.isFile()) used += info.size;
        if (used + outstanding + additional - replacing > maximumWorkspaceBytes) throw new ModpackFilesError('The modpack workspace storage limit has been reached.', 507);
      }
    };
    for (const root of roots) {
      const directory = await this.optionalDirectory(root);
      if (!directory) continue;
      try { await measure(directory, 0); } finally { await directory.handle.close(); }
    }
  }

  private session(id: string, address: string): UploadSession {
    const session = this.sessions.get(id);
    if (!session || session.address !== address) throw new ModpackFilesError('That upload is no longer available.', 404);
    return session;
  }

  private scheduleCleanup(): void {
    this.cleanupTimer ??= setInterval(() => { void this.exclusive(() => this.clearExpired()).catch(() => undefined); }, 60_000).unref();
  }

  private async clearExpired(): Promise<void> {
    for (const session of [...this.sessions.values()]) if (session.expiresAt <= Date.now()) await this.discard(session);
  }

  private async discard(session: UploadSession): Promise<void> {
    this.sessions.delete(session.id);
    try { await session.handle.close(); await this.removeTemporary(session.directory, session.temporary); }
    finally {
      await session.directory.handle.close();
      if (!this.sessions.size && this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = undefined; }
    }
  }

  private async removeTemporary(directory: Directory, name: string): Promise<void> {
    try { await this.assertDirectory(directory); await unlink(path.join(directory.anchored, name)); }
    catch (error) { if (!missing(error) && !(error instanceof ModpackFilesError)) throw error; }
  }

  private async removeOrphans(directory: Directory): Promise<void> {
    const active = new Set([...this.sessions.values()].map(session => session.temporary));
    for (const name of await readdir(directory.anchored)) {
      if (!/^\.(?:upload-[0-9a-f-]{36}\.part|write-[0-9a-f-]{36}\.tmp)$/.test(name) || active.has(name)) continue;
      const info = await lstat(path.join(directory.anchored, name));
      if (info.isFile() && info.nlink === 1 && info.mtimeMs < Date.now() - uploadLifetime) await this.removeTemporary(directory, name);
    }
  }
}
