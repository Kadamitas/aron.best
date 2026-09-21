import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, rename, statfs, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

export interface BackupJob {
  id: string;
  profileId: string;
  state: 'running' | 'ready' | 'failed';
  filename?: string;
  error?: string;
}

export interface BackupArtifact { path: string; size: number; identity: Stats }

export const maximumBackupBytes = 16n * 1024n ** 3n;
export const maximumBackupEntries = 200_000;
const maximumEntryBytes = 8 * 1024 ** 3 - 1;
const archiveTimeout = 15 * 60_000;
const diskReserveBytes = 256n * 1024n ** 2n;

function failure(message: string, statusCode = 409): Error { return Object.assign(new Error(message), { statusCode }); }
function sameFile(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }
function regular(info: Stats): void {
  if (!info.isFile() || info.nlink !== 1) throw failure('A backup contains a linked or unsupported file. No download was created.');
}
function segment(name: string): void {
  if (!name || name === '.' || name === '..' || /[\\/\x00-\x1f\x7f:]/.test(name)) throw failure('A backup contains an unsafe file name. No download was created.');
}
function anchored(handle: FileHandle): string { return `/proc/self/fd/${handle.fd}`; }

async function childDirectory(parent: FileHandle, name: string): Promise<FileHandle> {
  segment(name);
  const candidate = path.join(anchored(parent), name);
  const handle = await open(candidate, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const identity = await handle.stat();
    const current = await lstat(candidate);
    if (!identity.isDirectory() || !current.isDirectory() || !sameFile(identity, current)) throw failure('A backup folder changed while it was opened.');
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

async function directory(absolute: string): Promise<FileHandle> {
  if (process.platform !== 'linux' || !path.isAbsolute(absolute)) throw failure('Backup downloads require the isolated Linux container.');
  let handle = await open('/', constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (const part of absolute.split('/').filter(Boolean)) {
      const next = await childDirectory(handle, part);
      await handle.close();
      handle = next;
    }
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

function header(name: string, size: number, type = '0', modifiedAt = 0): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8');
  block.write(type === '5' ? '0000700\0' : '0000600\0', 100, 8, 'ascii');
  block.write('0000000\0', 108, 8, 'ascii');
  block.write('0000000\0', 116, 8, 'ascii');
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  block.write(`${Math.max(0, Math.floor(modifiedAt / 1000)).toString(8).padStart(11, '0')}\0`, 136, 12, 'ascii');
  block.fill(32, 148, 156);
  block.write(type, 156, 1, 'ascii');
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  const checksum = block.reduce((sum, value) => sum + value, 0);
  block.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return block;
}

function paxPath(name: string): Buffer {
  const value = ` path=${name}\n`;
  let length = Buffer.byteLength(value) + 1;
  while (length !== Buffer.byteLength(value) + String(length).length) length = Buffer.byteLength(value) + String(length).length;
  return Buffer.from(`${length}${value}`);
}

async function* archiveEntries(root: FileHandle): AsyncGenerator<Buffer> {
  let entries = 0;
  let bytes = 0n;
  async function* walk(parent: FileHandle, prefix: string, depth: number): AsyncGenerator<Buffer> {
    if (depth > 32) throw failure('The backup contains too many nested folders.', 413);
    const before = await parent.stat();
    for (const name of (await readdir(anchored(parent))).sort()) {
      segment(name);
      if (++entries > maximumBackupEntries) throw failure('The backup contains too many files.', 413);
      const candidate = path.join(anchored(parent), name);
      const info = await lstat(candidate);
      const relative = `${prefix}${name}`;
      const tarName = info.isDirectory() ? `${relative}/` : relative;
      if (Buffer.byteLength(tarName) > 100 || !/^[\x20-\x7e]+$/.test(tarName)) {
        const attributes = paxPath(tarName);
        yield header(`PaxHeaders/${entries}`, attributes.length, 'x');
        yield attributes;
        if (attributes.length % 512) yield Buffer.alloc(512 - attributes.length % 512);
      }
      const storedName = Buffer.byteLength(tarName) <= 100 && /^[\x20-\x7e]+$/.test(tarName) ? tarName : `entry-${entries}`;
      if (info.isDirectory()) {
        const child = await childDirectory(parent, name);
        try {
          if (!sameFile(await child.stat(), info)) throw failure('The backup changed while its download was prepared.');
          yield header(storedName, 0, '5', info.mtimeMs);
          yield* walk(child, `${relative}/`, depth + 1);
        } finally { await child.close(); }
        continue;
      }
      regular(info);
      bytes += BigInt(info.size);
      if (info.size > maximumEntryBytes || bytes > maximumBackupBytes) throw failure('The backup is too large to download safely.', 413);
      const file = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const identity = await file.stat();
        regular(identity);
        if (!sameFile(info, identity) || info.size !== identity.size || info.ctimeMs !== identity.ctimeMs) throw failure('The backup changed while its download was prepared.');
        yield header(storedName, info.size, '0', info.mtimeMs);
        let offset = 0;
        while (offset < info.size) {
          const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, info.size - offset));
          const { bytesRead } = await file.read(chunk, 0, chunk.length, offset);
          if (!bytesRead) throw failure('A backup file changed while its download was prepared.');
          offset += bytesRead;
          yield chunk.subarray(0, bytesRead);
        }
        const latest = await file.stat();
        regular(latest);
        if (latest.size !== info.size || latest.ctimeMs !== info.ctimeMs || !sameFile(await lstat(candidate), info)) throw failure('The backup changed while its download was prepared.');
        if (info.size % 512) yield Buffer.alloc(512 - info.size % 512);
      } finally { await file.close(); }
    }
    if ((await parent.stat()).mtimeMs !== before.mtimeMs) throw failure('A backup folder changed while its download was prepared.');
  }
  yield* walk(root, '', 0);
  yield Buffer.alloc(1024);
}

export async function createBackupArchive(snapshot: string): Promise<BackupArtifact> {
  const parent = await directory(path.dirname(snapshot));
  const name = path.basename(snapshot);
  let root: FileHandle | undefined;
  let output: FileHandle | undefined;
  const temporary = path.join(anchored(parent), `.download-${randomUUID()}.tmp`);
  const destination = `${snapshot}.tar.gz`;
  try {
    root = await childDirectory(parent, name);
    const assertSpace = async () => {
      const space = await statfs(anchored(parent), { bigint: true });
      if (space.bavail * space.bsize < diskReserveBytes + 8n * 1024n ** 2n) throw failure('The backup snapshot was saved, but there is not enough free space to prepare its download.', 507);
    };
    await assertSpace();
    output = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const original = await output.stat();
    let sinceSpaceCheck = 0;
    const reserve = new Transform({ transform(chunk: Buffer, _encoding, complete) {
      sinceSpaceCheck += chunk.length;
      if (sinceSpaceCheck < 1024 * 1024) { complete(null, chunk); return; }
      sinceSpaceCheck = 0;
      void assertSpace().then(() => complete(null, chunk), error => complete(error));
    } });
    await pipeline(Readable.from(archiveEntries(root)), createGzip({ level: 1 }), reserve, output.createWriteStream({ autoClose: true, flush: true }), { signal: AbortSignal.timeout(archiveTimeout) });
    output = undefined;
    const identity = await lstat(temporary);
    regular(identity);
    if (!sameFile(original, identity)) throw failure('The saved backup archive changed during preparation.');
    await rename(temporary, path.join(anchored(parent), `${name}.tar.gz`));
    await parent.sync();
    return { path: destination, size: identity.size, identity };
  } finally {
    await output?.close();
    await unlink(temporary).catch(() => undefined);
    await root?.close();
    await parent.close();
  }
}

export async function downloadBackup(artifact: BackupArtifact) {
  const parent = await directory(path.dirname(artifact.path));
  try {
    const handle = await open(path.join(anchored(parent), path.basename(artifact.path)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      regular(info);
      if (!sameFile(info, artifact.identity) || info.size !== artifact.size || info.mtimeMs !== artifact.identity.mtimeMs) throw failure('This saved backup archive changed and is no longer available.');
      return { stream: handle.createReadStream({ autoClose: true, end: info.size - 1 }), size: info.size };
    } catch (error) { await handle.close(); throw error; }
  } finally { await parent.close(); }
}
