import { constants } from 'node:fs';
import { lstat, open, readdir, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { maximumBackupManifestBytes, validateBackupObjectManifest } from './backup-objects.js';

export const backupIdSchema = z.string().regex(/^[0-9][A-Za-z0-9._-]{0,159}$/);
const metadataSchema = z.object({
  createdAt: z.string().datetime(),
  snapshotBytes: z.string().regex(/^[0-9]{1,20}$/),
  kind: z.enum(['manual', 'automatic']).default('manual'),
});

export interface SavedBackup {
  id: string;
  profileId: string;
  createdAt: string;
  kind: 'manual' | 'automatic';
  sizeBytes: string;
}

function failure(message: string, statusCode = 409): Error { return Object.assign(new Error(message), { statusCode }); }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function anchored(handle: FileHandle, absolute: string): string { return process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : absolute; }

async function openDirectory(absolute: string): Promise<FileHandle> {
  const before = await lstat(absolute);
  if (!before.isDirectory()) throw failure('Recovery storage cannot contain linked folders.');
  const handle = await open(absolute, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const current = await handle.stat();
  if (!current.isDirectory() || before.ino !== current.ino || before.dev !== current.dev) {
    await handle.close();
    throw failure('Recovery storage changed while it was opened.');
  }
  return handle;
}

async function metadata(root: FileHandle, absolute: string) {
  const filename = path.join(anchored(root, absolute), 'backup.json');
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maximumBackupManifestBytes) throw failure('The saved backup metadata is invalid.');
    const contents = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < contents.length) {
      const { bytesRead } = await file.read(contents, offset, contents.length - offset, offset);
      if (!bytesRead) throw failure('The saved backup metadata changed while reading.');
      offset += bytesRead;
    }
    const after = await file.stat();
    const current = await lstat(filename);
    if (after.nlink !== 1 || before.size !== after.size || before.ctimeMs !== after.ctimeMs || before.dev !== current.dev || before.ino !== current.ino) throw failure('The saved backup metadata changed while reading.');
    try {
      const value = JSON.parse(contents.toString('utf8'));
      if (value.format === 2) validateBackupObjectManifest({ files: value.files, directories: value.directories, snapshotBytes: value.snapshotBytes });
      else if (value.format !== undefined) throw failure('Unsupported backup format.');
      return metadataSchema.parse(value);
    }
    catch { throw failure('The saved backup metadata is invalid.'); }
  } finally { await file.close(); }
}

export async function savedBackups(runtimeDirectory: string, profileId: string): Promise<SavedBackup[]> {
  const runtime = await openDirectory(runtimeDirectory);
  let backups: FileHandle | undefined;
  try {
    const absolute = path.join(runtimeDirectory, 'backups');
    try { backups = await openDirectory(path.join(anchored(runtime, runtimeDirectory), 'backups')); }
    catch (error) { if (missing(error)) return []; throw error; }
    const entries = await readdir(anchored(backups, absolute), { withFileTypes: true });
    if (entries.length > 1000) throw failure('Recovery storage contains too many entries to list safely.');
    const result: SavedBackup[] = [];
    for (const entry of entries) {
      if (!backupIdSchema.safeParse(entry.name).success || !entry.isDirectory()) continue;
      const child = await openDirectory(path.join(anchored(backups, absolute), entry.name));
      try {
        const information = await metadata(child, path.join(absolute, entry.name));
        result.push({ id: entry.name, profileId, createdAt: information.createdAt, kind: information.kind, sizeBytes: information.snapshotBytes });
      } finally { await child.close(); }
    }
    return result.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  } finally { await backups?.close(); await runtime.close(); }
}

export async function savedBackupPath(runtimeDirectory: string, profileId: string, id: string): Promise<string> {
  if (!backupIdSchema.safeParse(id).success) throw failure('Choose a saved backup.', 400);
  if (!(await savedBackups(runtimeDirectory, profileId)).some(backup => backup.id === id)) throw failure('That backup is no longer available.', 404);
  return path.join(runtimeDirectory, 'backups', id);
}
