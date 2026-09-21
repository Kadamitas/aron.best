import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { CurseForgeError, type Download } from './curseforge.js';
import { parseInstalledProfile, type Pack } from './modpack.js';

export interface LocalMod extends Download { localPath: string }
export interface LocalProfileSnapshot {
  pack: Pack;
  files: LocalMod[];
  modsDirectory: string;
  metadataSha256: string;
  inspectedAt: string;
}

const maximumMetadataBytes = 16 * 1024 * 1024;

/** The profile location is fixed host configuration. It never comes from an HTTP request. */
export function validateProfilePath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!path.isAbsolute(value) || path.basename(value) !== 'minecraftinstance.json') {
    throw new Error('CURSEFORGE_PROFILE_PATH must be the absolute path to a CurseForge App profile minecraftinstance.json file.');
  }
  return value;
}

/**
 * Reads the CurseForge App profile the host configured and checks that its mods
 * folder matches what the App recorded. Files are hashed again while they are
 * copied to the server, so a JAR that changes after inspection is still rejected.
 */
export class LocalProfileService {
  constructor(private readonly metadataPath?: string) {}

  get configured(): boolean { return Boolean(this.metadataPath); }

  async inspect(): Promise<LocalProfileSnapshot> {
    if (!this.metadataPath) throw new CurseForgeError('LOCAL_PROFILE_UNCONFIGURED', 'The host has not configured the CurseForge App profile path yet.', 503);
    const metadata = await lstat(this.metadataPath).catch(() => undefined);
    if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size > maximumMetadataBytes) {
      throw new CurseForgeError('LOCAL_PROFILE_UNREADABLE', 'The configured CurseForge App profile file is missing, is not a regular file, or is too large.', 503);
    }
    const bytes = await readFile(this.metadataPath);
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString('utf8')); } catch {
      throw new CurseForgeError('LOCAL_PROFILE_UNREADABLE', 'The CurseForge App profile file is not valid JSON.', 503);
    }
    const { pack, files } = parseInstalledProfile(parsed);
    const instance = await realpath(path.dirname(this.metadataPath));
    const modsDirectory = path.join(instance, 'mods');
    const mods = await lstat(modsDirectory).catch(() => undefined);
    if (!mods?.isDirectory() || mods.isSymbolicLink()) throw new CurseForgeError('LOCAL_PROFILE_MODS_MISSING', 'The profile mods folder is missing or is a symbolic link.');
    const recorded = files.map(file => file.fileName).sort();
    const present = (await readdir(modsDirectory, { withFileTypes: true }))
      .filter(entry => /\.jar(\.disabled)?$/i.test(entry.name)).map(entry => entry.name).sort();
    if (JSON.stringify(present) !== JSON.stringify(recorded)) {
      throw new CurseForgeError('LOCAL_PROFILE_UNTRACKED_FILES', 'The profile mods folder has disabled mods or JAR files the CurseForge App did not record. Tidy the profile in the App, then try again.');
    }
    const localFiles: LocalMod[] = [];
    for (const file of files) {
      const localPath = path.join(modsDirectory, file.fileName);
      const info = await lstat(localPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== file.fileLength) {
        throw new CurseForgeError('LOCAL_MOD_MISMATCH', `${file.fileName} does not match the size the CurseForge App recorded.`);
      }
      localFiles.push({ ...file, localPath });
    }
    return { pack, files: localFiles, modsDirectory, metadataSha256: createHash('sha256').update(bytes).digest('hex'), inspectedAt: new Date().toISOString() };
  }
}
