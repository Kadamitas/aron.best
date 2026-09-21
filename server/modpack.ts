import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fromBuffer, type Entry } from 'yauzl';
import { z } from 'zod';
import { CurseForgeClient, CurseForgeError, isCompatible, loaderSchema, type CurseMod, type Download, type Loader } from './curseforge.js';
import { workspaceArchive } from './workspace-archive.js';

const id = z.number().int().positive();
const modSchema = z.object({
  id, name: z.string(), summary: z.string(), logoUrl: z.string().optional(),
  downloadCount: z.number(), websiteUrl: z.string().optional(), fileId: id,
  version: z.string(), explicit: z.boolean(), dependencies: z.array(id),
  conflicts: z.array(id), requiredBy: z.array(id),
});
export type Mod = Omit<z.infer<typeof modSchema>, 'fileId' | 'version' | 'explicit' | 'dependencies' | 'conflicts' | 'requiredBy'> & {
  fileId?: number; version?: string; explicit?: boolean; dependencies?: number[]; conflicts?: number[]; requiredBy?: number[];
};
export type SelectedMod = z.infer<typeof modSchema>;
const historicalModSchema = modSchema.extend({ removedAt: z.string().datetime() });
const requestSchema = z.object({
  id: z.string().uuid(), url: z.string().url(), slug: z.string(),
  submittedAt: z.string().datetime(), status: z.enum(['pending', 'installed']),
});
export type ModRequest = z.infer<typeof requestSchema>;
const releaseSchema = z.object({
  id: z.string(), displayName: z.string(), version: z.string(), createdAt: z.string(),
  archiveSha256: z.string(), status: z.enum(['uploading', 'pending-review', 'uncertain']), fileId: id.optional(),
});
export type Release = z.infer<typeof releaseSchema>;
const packSchema = z.object({
  name: z.string().min(1).max(100), minecraftVersion: z.string().min(1).max(40), loader: loaderSchema,
  loaderVersion: z.string().min(1).max(40), version: z.string().regex(/^\d+\.\d+\.\d+$/),
  mods: z.array(modSchema).max(150), releases: z.array(releaseSchema).max(1000),
  history: z.array(historicalModSchema).max(500).default([]),
  requests: z.array(requestSchema).max(200).default([]),
});
export type Pack = z.infer<typeof packSchema>;

/** Store a link as a request, never fetch it or treat its contents as executable instructions. */
export function parseModLink(value: string): { url: string; slug: string } {
  const invalid = () => new CurseForgeError('INVALID_MOD_LINK', 'Use a CurseForge Minecraft mod page or a specific mod file link.', 400);
  if (value.length > 2048) throw invalid();
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw invalid(); }
  if (url.protocol !== 'https:' || !['curseforge.com', 'www.curseforge.com'].includes(url.hostname)
    || url.username || url.password || url.port) throw invalid();
  const match = /^\/minecraft\/mc-mods\/([a-z0-9][a-z0-9-]{0,149})(?:\/files\/([1-9]\d{0,14}))?\/?$/.exec(url.pathname.toLowerCase());
  const slug = match?.[1];
  if (!slug) throw invalid();
  return { url: `https://www.curseforge.com/minecraft/mc-mods/${slug}${match[2] ? `/files/${match[2]}` : ''}`, slug };
}

function requestIsInstalled(request: Pick<ModRequest, 'slug' | 'url'>, mods: SelectedMod[]): boolean {
  const fileId = request.url.match(/\/files\/(\d+)$/)?.[1];
  return mods.some(mod => {
    try { return Boolean(mod.websiteUrl && parseModLink(mod.websiteUrl).slug === request.slug && (!fileId || mod.fileId === Number(fileId))); }
    catch { return false; }
  });
}

function recordRemovedMods(pack: Pack, incoming: SelectedMod[]): void {
  const currentIds = new Set(incoming.map(mod => mod.id));
  const history = new Map(pack.history.map(mod => [mod.id, mod]));
  for (const mod of pack.mods) {
    if (!currentIds.has(mod.id)) history.set(mod.id, { ...mod, removedAt: new Date().toISOString() });
  }
  pack.history = [...history.values()].filter(mod => !currentIds.has(mod.id))
    .sort((a, b) => b.removedAt.localeCompare(a.removedAt)).slice(0, 500);
}

export function parseInstalledProfile(input: unknown): { pack: Pack; files: Download[] } {
  const installedFileSchema = z.object({
    id, fileName: z.string().min(1).max(255), fileLength: z.number().int().positive().max(128 * 1024 * 1024),
    fileStatus: z.number().int(), releaseType: z.number().int(), isAvailable: z.boolean(),
    downloadUrl: z.string(), gameVersion: z.array(z.string()),
    hashes: z.array(z.object({ type: z.number().int(), value: z.string() })),
    dependencies: z.array(z.object({ modId: id.optional(), addonId: id.optional(), relationType: z.number().int().optional(), type: z.number().int().optional() })),
  });
  const source = z.object({
    name: z.string().min(1).max(100), gameVersion: z.string().regex(/^[A-Za-z0-9.\-]+$/), gameTypeID: z.literal(432),
    baseModLoader: z.object({ type: z.literal(4), forgeVersion: z.string().regex(/^[0-9.]+$/), minecraftVersion: z.string() }),
    installedAddons: z.array(z.object({
      addonID: id, gameID: z.literal(432), categoryClassID: z.literal(6), name: z.string(),
      isEnabled: z.boolean(), isModified: z.boolean().optional(), isWorkingCopy: z.boolean().optional(),
      thumbnailUrl: z.string().nullable().optional(), webSiteURL: z.string().nullable().optional(), installedFile: installedFileSchema,
    })).max(150),
    modpackOverrides: z.array(z.unknown()).optional(),
  }).safeParse(input);
  if (!source.success) throw new CurseForgeError('INVALID_LOCAL_PROFILE', 'The local profile must be an installed Fabric Minecraft profile with complete file metadata.');
  const profile = source.data;
  if (profile.baseModLoader.minecraftVersion !== profile.gameVersion) throw new CurseForgeError('INVALID_LOCAL_PROFILE', 'The profile loader targets a different Minecraft version.');
  if (profile.modpackOverrides?.length) throw new CurseForgeError('PROFILE_OVERRIDES_UNSUPPORTED', 'This profile has override files. Review its server configuration before importing automatically.');
  const files: Download[] = [];
  const mods: SelectedMod[] = [];
  const filenames = new Set<string>();
  for (const addon of profile.installedAddons.filter((entry) => entry.isEnabled)) {
    const file = addon.installedFile;
    if (addon.isModified || addon.isWorkingCopy) throw new CurseForgeError('MODIFIED_LOCAL_MOD', `${addon.name} is marked locally modified. Restore the original file before importing.`);
    if (!file.gameVersion.includes(profile.gameVersion) || !file.gameVersion.includes('Fabric') || !file.isAvailable || ![4, 10].includes(file.fileStatus)) {
      throw new CurseForgeError('INCOMPATIBLE_LOCAL_MOD', `${addon.name} is not an available file for this profile's Minecraft and Fabric versions.`);
    }
    if (!file.fileName.endsWith('.jar') || /[\\/\x00-\x1f\x7f:]/.test(file.fileName) || file.fileName.startsWith('.') || filenames.has(file.fileName.toLowerCase())) {
      throw new CurseForgeError('UNSAFE_FILENAME', 'The local profile has an unsafe or duplicate mod filename.');
    }
    filenames.add(file.fileName.toLowerCase());
    const hashes = file.hashes.map((hash) => ({ algo: hash.type, value: hash.value }));
    if (!hashes.some((hash) => hash.algo === 1 && /^[a-f0-9]{40}$/i.test(hash.value))) throw new CurseForgeError('CHECKSUM_REQUIRED', `${addon.name} has no valid recorded SHA-1 checksum.`);
    const dependencies = file.dependencies.map((dependency) => {
      const modId = dependency.modId ?? dependency.addonId;
      const relationType = dependency.relationType ?? dependency.type;
      if (!modId || !relationType) throw new CurseForgeError('INVALID_LOCAL_DEPENDENCY', `${addon.name} has incomplete dependency metadata.`);
      return { modId, relationType };
    });
    files.push({ modId: addon.addonID, fileId: file.id, fileName: file.fileName, fileLength: file.fileLength, hashes, url: file.downloadUrl });
    mods.push({ id: addon.addonID, name: addon.name, summary: 'Imported from the local CurseForge profile.', downloadCount: 0,
      ...(addon.thumbnailUrl ? { logoUrl: addon.thumbnailUrl } : {}), ...(addon.webSiteURL ? { websiteUrl: addon.webSiteURL } : {}),
      fileId: file.id, version: file.fileName, explicit: true, requiredBy: [],
      dependencies: dependencies.filter((dependency) => dependency.relationType === 3).map((dependency) => dependency.modId),
      conflicts: dependencies.filter((dependency) => dependency.relationType === 5).map((dependency) => dependency.modId) });
  }
  const ids = new Set(mods.map((mod) => mod.id));
  if (ids.size !== mods.length) throw new CurseForgeError('DUPLICATE_LOCAL_MOD', 'The local profile contains duplicate mod projects.');
  for (const mod of mods) {
    if (mod.dependencies.some((dependency) => !ids.has(dependency))) throw new CurseForgeError('MISSING_DEPENDENCY', `${mod.name} has a required dependency that is absent or disabled.`);
    if (mod.conflicts.some((conflict) => ids.has(conflict))) throw new CurseForgeError('MOD_CONFLICT', `${mod.name} conflicts with another installed mod.`);
  }
  reconnectDependencies(mods);
  return { pack: packSchema.parse({ name: profile.name, minecraftVersion: profile.gameVersion, loader: 'Fabric', loaderVersion: profile.baseModLoader.forgeVersion,
    version: '0.1.0', mods, releases: [] }), files };
}

const manifestSchema = z.object({
  minecraft: z.object({ version: z.string(), modLoaders: z.array(z.object({ id: z.string(), primary: z.boolean() })).min(1).max(4) }),
  manifestType: z.literal('minecraftModpack'), manifestVersion: z.literal(1),
  name: z.string(), version: z.string(), author: z.string().optional(),
  files: z.array(z.object({ projectID: id, fileID: id, required: z.boolean() })).max(150),
  overrides: z.literal('overrides'),
});
export type Manifest = z.infer<typeof manifestSchema>;

/** Inspect the central directory and stream only manifest.json. Never extract ZIP paths. */
export async function inspectManifest(archive: Buffer): Promise<{ manifest: Manifest; hasOverrides: boolean }> {
  if (archive.length > 64 * 1024 * 1024) throw new CurseForgeError('ARCHIVE_TOO_LARGE', 'The modpack ZIP must be at most 64 MiB.');
  return new Promise((resolve, reject) => {
    fromBuffer(archive, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) { reject(new CurseForgeError('INVALID_ARCHIVE', 'The configured file is not a valid ZIP archive.')); return; }
      let manifestBytes: Buffer | undefined;
      let hasOverrides = false;
      let expandedSize = 0;
      const names = new Set<string>();
      const fail = (message: string) => { zip.close(); reject(new CurseForgeError('INVALID_ARCHIVE', message)); };
      if (zip.entryCount > 5000) { fail('The modpack ZIP contains too many files.'); return; }
      zip.on('error', () => fail('The modpack ZIP could not be read safely.'));
      zip.on('entry', (entry: Entry) => {
        const name = entry.fileName;
        expandedSize += entry.uncompressedSize;
        if (names.has(name) || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.includes('\\')
          || name.split('/').includes('..') || /[\x00-\x1f]/.test(name)
          || ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000
          || (entry.generalPurposeBitFlag & 1) !== 0 || expandedSize > 256 * 1024 * 1024) {
          fail('The modpack ZIP contains duplicate, unsafe, encrypted, or oversized entries.'); return;
        }
        names.add(name);
        if (name.startsWith('overrides/') && !name.endsWith('/')) hasOverrides = true;
        if (name !== 'manifest.json') { zip.readEntry(); return; }
        if (entry.uncompressedSize > 1024 * 1024) { fail('The modpack manifest exceeds 1 MiB.'); return; }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) { fail('The modpack manifest could not be read.'); return; }
          const chunks: Buffer[] = [];
          let length = 0;
          stream.on('data', (chunk: Buffer) => {
            length += chunk.length;
            if (length > 1024 * 1024) { stream.destroy(); fail('The modpack manifest exceeds 1 MiB.'); return; }
            chunks.push(chunk);
          });
          stream.on('error', () => fail('The modpack manifest failed decompression.'));
          stream.on('end', () => { manifestBytes = Buffer.concat(chunks); zip.readEntry(); });
        });
      });
      zip.on('end', () => {
        if (!manifestBytes) { fail('The ZIP must contain manifest.json at its root. Export the profile from the CurseForge App.'); return; }
        try {
          const manifest = manifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
          if (new Set(manifest.files.map((file) => file.projectID)).size !== manifest.files.length) {
            fail('The manifest contains multiple files for the same project.'); return;
          }
          resolve({ manifest, hasOverrides });
        } catch { fail('The ZIP does not contain a valid CurseForge Minecraft modpack manifest.'); }
      });
      zip.readEntry();
    });
  });
}

function describeMod(mod: CurseMod): Mod {
  return { id: mod.id, name: mod.name, summary: mod.summary, downloadCount: mod.downloadCount,
    ...(mod.logo ? { logoUrl: mod.logo.thumbnailUrl } : {}),
    ...(mod.links.websiteUrl ? { websiteUrl: mod.links.websiteUrl } : {}) };
}

function reconnectDependencies(mods: SelectedMod[]): void {
  for (const mod of mods) mod.requiredBy = mods.filter((other) => other.dependencies.includes(mod.id)).map((other) => other.id);
}

function nextVersion(version: string): string {
  const [major, minor, patch] = version.split('.').map(Number);
  return `${major}.${minor}.${(patch ?? 0) + 1}`;
}

function ensureCompatibility(manifest: Manifest, pack: Pack): void {
  const expectedLoader = `${pack.loader.toLowerCase()}-${pack.loaderVersion}`;
  if (manifest.minecraft.version !== pack.minecraftVersion || manifest.minecraft.modLoaders.length !== 1
    || manifest.minecraft.modLoaders[0]?.id.toLowerCase() !== expectedLoader || !manifest.minecraft.modLoaders[0]?.primary) {
    throw new CurseForgeError('PACK_VERSION_MISMATCH', `The archive must target Minecraft ${pack.minecraftVersion} with ${expectedLoader}.`);
  }
}

export interface PackServiceOptions {
  statePath: string;
  client: CurseForgeClient;
  name?: string;
  minecraftVersion: string;
  loader: Loader;
  loaderVersion?: string;
  publishProjectId?: number;
  publishArchivePath?: string;
}

export class PackService {
  private state?: Pack;
  private initialization?: Promise<Pack>;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: PackServiceOptions) {}

  private async initialize(): Promise<Pack> {
    if (!this.initialization) this.initialization = (async () => {
      try {
        const content = await readFile(this.options.statePath, 'utf8');
        if (content.length > 2 * 1024 * 1024) throw new Error('State file exceeds 2 MiB');
        this.state = packSchema.parse(JSON.parse(content));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new CurseForgeError('PACK_STATE_INVALID', 'The saved pack state could not be read. Preserve it and repair or restore the local backup.', 503);
        }
        this.state = packSchema.parse({ name: this.options.name ?? 'Dictionary Minecraft Server', minecraftVersion: this.options.minecraftVersion,
          loader: this.options.loader, loaderVersion: this.options.loaderVersion ?? (this.options.loader === 'Fabric' ? '0.19.5' : ''),
          version: '0.1.0', mods: [], releases: [] });
      }
      if (this.state.minecraftVersion !== this.options.minecraftVersion || this.state.loader !== this.options.loader
        || (this.options.loaderVersion && this.state.loaderVersion !== this.options.loaderVersion)) {
        throw new CurseForgeError('PACK_CONFIG_CHANGED', 'The saved pack targets a different Minecraft or loader version. Migrate it explicitly before changing the runtime configuration.', 503);
      }
      return this.state;
    })();
    return this.initialization;
  }

  private async persist(pack: Pack): Promise<void> {
    await mkdir(dirname(this.options.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.options.statePath}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(`${JSON.stringify(pack, null, 2)}\n`); await file.sync(); } finally { await file.close(); }
      await rename(temporary, this.options.statePath);
      this.state = pack;
    } finally { await rm(temporary, { force: true }); }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async getPack(): Promise<Pack> { await this.initialize(); return structuredClone(this.state!); }

  async requestMod(value: string): Promise<ModRequest> {
    const link = parseModLink(value);
    return this.serial(async () => {
      const pack = await this.getPack();
      const duplicate = pack.requests.find(request => request.url === link.url);
      if (duplicate) return structuredClone(duplicate);
      if (pack.requests.length >= 200) throw new CurseForgeError('REQUEST_LIMIT', 'The request list has reached 200 links. Ask the host to review it before adding more.', 409);
      const request: ModRequest = { ...link, id: randomUUID(), submittedAt: new Date().toISOString(),
        status: requestIsInstalled(link, pack.mods) ? 'installed' : 'pending' };
      pack.requests.unshift(request);
      await this.persist(pack);
      return structuredClone(request);
    });
  }

  async importLocalProfile(input: Pack): Promise<Pack> {
    const incoming = packSchema.parse(input);
    return this.serial(async () => {
      const pack = await this.getPack();
      if (incoming.name !== pack.name || incoming.minecraftVersion !== pack.minecraftVersion
        || incoming.loader !== pack.loader || incoming.loaderVersion !== pack.loaderVersion) {
        throw new CurseForgeError('PROFILE_TARGET_MISMATCH', 'The configured local profile must match this pack name, Minecraft version, and loader.');
      }
      const signature = (mods: SelectedMod[]) => mods.map(mod => `${mod.id}:${mod.fileId}`).sort().join(',');
      const changed = signature(pack.mods) !== signature(incoming.mods);
      recordRemovedMods(pack, incoming.mods);
      pack.mods = incoming.mods;
      pack.requests = pack.requests.map(request => ({ ...request, status: requestIsInstalled(request, pack.mods) ? 'installed' as const : 'pending' as const }));
      if (changed) pack.version = nextVersion(pack.version);
      await this.persist(pack);
      return structuredClone(pack);
    });
  }

  async search(query: string): Promise<Mod[]> {
    const pack = await this.getPack();
    return (await this.options.client.search(query, pack)).map(describeMod);
  }

  async add(modId: number): Promise<Pack> {
    id.parse(modId);
    return this.serial(async () => {
      const pack = await this.getPack();
      const selected = new Map(pack.mods.map((mod) => [mod.id, mod]));
      if (selected.get(modId)?.explicit) return pack;
      const resolving = new Set<number>();
      const resolve = async (projectId: number, explicit: boolean, depth = 0): Promise<void> => {
        const present = selected.get(projectId);
        if (present) { present.explicit ||= explicit; return; }
        if (resolving.has(projectId)) return;
        if (selected.size >= 150 || depth > 32) throw new CurseForgeError('DEPENDENCY_LIMIT', 'The dependency graph exceeds 150 mods or 32 levels.');
        resolving.add(projectId);
        const metadata = await this.options.client.getMod(projectId);
        if (metadata.gameId !== 432 || metadata.classId !== 6 || !metadata.isAvailable) {
          throw new CurseForgeError('INVALID_MOD', `Project ${projectId} is not an available Minecraft mod.`);
        }
        if (metadata.allowModDistribution === false) throw new CurseForgeError('DOWNLOAD_RESTRICTED', `${metadata.name} requires installation through the CurseForge App.`);
        const file = await this.options.client.latestFile(projectId, pack);
        const dependencies = [...new Set(file.dependencies.filter((dep) => dep.relationType === 3).map((dep) => dep.modId))];
        const mod: SelectedMod = { ...describeMod(metadata), fileId: file.id, version: file.displayName,
          explicit, dependencies, conflicts: file.dependencies.filter((dep) => dep.relationType === 5).map((dep) => dep.modId), requiredBy: [] };
        selected.set(projectId, mod);
        for (const dependency of dependencies) await resolve(dependency, false, depth + 1);
        resolving.delete(projectId);
      };
      await resolve(modId, true);
      for (const mod of selected.values()) {
        const conflict = mod.conflicts.find((conflictId) => selected.has(conflictId));
        if (conflict) throw new CurseForgeError('MOD_CONFLICT', `${mod.name} is marked incompatible with ${selected.get(conflict)!.name}. Remove one first.`);
      }
      pack.mods = [...selected.values()];
      reconnectDependencies(pack.mods);
      pack.version = nextVersion(pack.version);
      await this.persist(pack);
      return structuredClone(pack);
    });
  }

  async remove(modId: number): Promise<Pack> {
    id.parse(modId);
    return this.serial(async () => {
      const pack = await this.getPack();
      if (!pack.mods.some((mod) => mod.id === modId)) return pack;
      const dependents = pack.mods.filter((mod) => mod.dependencies.includes(modId));
      if (dependents.length) throw new CurseForgeError('MOD_REQUIRED', `Remove ${dependents.map((mod) => mod.name).join(', ')} before removing their required dependency.`);
      const candidates = new Map(pack.mods.filter((mod) => mod.id !== modId).map((mod) => [mod.id, mod]));
      const retained = new Set<number>();
      const visit = (projectId: number) => {
        if (retained.has(projectId)) return;
        retained.add(projectId);
        for (const dependency of candidates.get(projectId)?.dependencies ?? []) visit(dependency);
      };
      for (const mod of candidates.values()) if (mod.explicit) visit(mod.id);
      const remaining = [...candidates.values()].filter((mod) => retained.has(mod.id));
      recordRemovedMods(pack, remaining);
      pack.mods = remaining;
      pack.requests = pack.requests.map(request => ({ ...request, status: requestIsInstalled(request, pack.mods) ? 'installed' as const : 'pending' as const }));
      reconnectDependencies(pack.mods);
      pack.version = nextVersion(pack.version);
      await this.persist(pack);
      return structuredClone(pack);
    });
  }

  async exportManifest(): Promise<Manifest> {
    const pack = await this.getPack();
    return { minecraft: { version: pack.minecraftVersion, modLoaders: [{ id: `${pack.loader.toLowerCase()}-${pack.loaderVersion}`, primary: true }] },
      manifestType: 'minecraftModpack', manifestVersion: 1, name: pack.name, version: pack.version, author: 'Aron',
      files: pack.mods.map((mod) => ({ projectID: mod.id, fileID: mod.fileId, required: true })), overrides: 'overrides' };
  }

  async exportArchive(): Promise<Buffer> {
    const manifest = await this.exportManifest();
    const contents = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return workspaceArchive([['manifest.json', contents]]);
  }

  private async resolveFiles(files: { projectID: number; fileID: number }[], pack: Pack): Promise<Download[]> {
    const downloads: Download[] = [];
    const selected = new Set(files.map((file) => file.projectID));
    const filenames = new Set<string>();
    for (const entry of files) {
      const file = await this.options.client.getFile(entry.projectID, entry.fileID);
      if (!isCompatible(file, pack)) throw new CurseForgeError('PINNED_FILE_UNAVAILABLE', `Pinned file ${entry.fileID} is no longer an approved compatible release.`);
      if (!file.fileName.toLowerCase().endsWith('.jar')) throw new CurseForgeError('INVALID_MOD_FILE', 'Only mod JAR files can be applied to the server.');
      for (const dependency of file.dependencies) {
        if (dependency.relationType === 3 && !selected.has(dependency.modId)) throw new CurseForgeError('MISSING_DEPENDENCY', `Project ${entry.projectID} requires project ${dependency.modId}.`);
        if (dependency.relationType === 5 && selected.has(dependency.modId)) throw new CurseForgeError('MOD_CONFLICT', `Projects ${entry.projectID} and ${dependency.modId} are marked incompatible.`);
      }
      if (filenames.has(file.fileName.toLowerCase())) throw new CurseForgeError('DUPLICATE_FILENAME', 'Two mods resolve to the same filename.');
      filenames.add(file.fileName.toLowerCase());
      downloads.push(await this.options.client.download(file));
    }
    return downloads;
  }

  async resolveDownloads(): Promise<Download[]> {
    return (await this.resolveDraftRelease()).downloads;
  }

  async resolveDraftRelease(): Promise<{ version: string; minecraftVersion: string; loader: Loader; downloads: Download[] }> {
    const pack = await this.getPack();
    return { version: pack.version, minecraftVersion: pack.minecraftVersion, loader: pack.loader,
      downloads: await this.resolveFiles(pack.mods.map((mod) => ({ projectID: mod.id, fileID: mod.fileId })), pack) };
  }

  async resolveLatestRelease(): Promise<{ fileId: number; version: string; minecraftVersion: string; loader: Loader; downloads: Download[] }> {
    if (!this.options.publishProjectId) throw new CurseForgeError('PROJECT_ID_REQUIRED', 'Set CURSEFORGE_PROJECT_ID to update from a published pack.', 503);
    const pack = await this.getPack();
    const project = await this.options.client.getMod(this.options.publishProjectId);
    if (project.gameId !== 432 || project.classId !== 4471) throw new CurseForgeError('INVALID_PACK_PROJECT', 'CURSEFORGE_PROJECT_ID must identify a Minecraft modpack project.');
    const file = await this.options.client.latestFile(this.options.publishProjectId, pack);
    const { manifest, hasOverrides } = await inspectManifest(await this.options.client.downloadArchive(file));
    ensureCompatibility(manifest, pack);
    if (hasOverrides) throw new CurseForgeError('PUBLISHED_OVERRIDES_UNSUPPORTED', 'This release contains config or other override files. Import and review its server pack locally before applying; automatic updates currently handle pinned mod JARs only.');
    if (manifest.files.some((entry) => !entry.required)) throw new CurseForgeError('OPTIONAL_MODS_UNSUPPORTED', 'This published pack has optional files. Resolve its server mod selection locally before applying.');
    return { fileId: file.id, version: manifest.version, minecraftVersion: manifest.minecraft.version, loader: pack.loader,
      downloads: await this.resolveFiles(manifest.files, pack) };
  }

  async publish(displayName: string, changelog: string): Promise<{ fileId: number; release: Release }> {
    if (!displayName.trim() || displayName.length > 100 || !changelog.trim() || changelog.length > 10_000) {
      throw new CurseForgeError('INVALID_RELEASE_TEXT', 'Provide a release name up to 100 characters and a changelog up to 10,000 characters.', 400);
    }
    return this.serial(async () => {
      if (!this.options.publishProjectId) throw new CurseForgeError('PROJECT_ID_REQUIRED', 'Create your modpack project on CurseForge and set CURSEFORGE_PROJECT_ID locally.', 503);
      if (!this.options.client.publishingConfigured) throw new CurseForgeError('UPLOAD_TOKEN_REQUIRED', 'Set CURSEFORGE_UPLOAD_TOKEN locally. It is separate from the search API key.', 503);
      if (!this.options.publishArchivePath) throw new CurseForgeError('APP_EXPORT_REQUIRED', 'Export the matching profile from the CurseForge App and configure CURSEFORGE_EXPORT_PATH locally. Generated draft manifests cannot be published.', 503);
      const pack = await this.getPack();
      let bytes: Buffer;
      try {
        const info = await stat(this.options.publishArchivePath);
        if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error('Invalid file size');
        bytes = await readFile(this.options.publishArchivePath);
      } catch { throw new CurseForgeError('APP_EXPORT_UNREADABLE', 'The configured CurseForge App export must be an existing ZIP file no larger than 64 MiB.', 503); }
      const { manifest } = await inspectManifest(bytes);
      ensureCompatibility(manifest, pack);
      const desired = new Map(pack.mods.map((mod) => [mod.id, mod.fileId]));
      if (manifest.name !== pack.name || manifest.version !== pack.version || manifest.files.length !== desired.size
        || manifest.files.some((entry) => !entry.required || desired.get(entry.projectID) !== entry.fileID)) {
        throw new CurseForgeError('STALE_APP_EXPORT', `Export the current pack from the CurseForge App with name "${pack.name}", version ${pack.version}, and exactly the selected mod files.`);
      }
      const archiveSha256 = createHash('sha256').update(bytes).digest('hex');
      if (pack.releases.some((release) => release.archiveSha256 === archiveSha256)) {
        throw new CurseForgeError('RELEASE_ALREADY_ATTEMPTED', 'This exact archive was already submitted or its result is uncertain. Check the CurseForge author dashboard before publishing another version.', 409);
      }
      if (pack.releases.length >= 1000) throw new CurseForgeError('RELEASE_HISTORY_LIMIT', 'Archive the local publication history before submitting more releases.', 503);
      const release: Release = { id: randomUUID(), displayName: displayName.trim(), version: pack.version,
        createdAt: new Date().toISOString(), archiveSha256, status: 'uploading' };
      pack.releases.unshift(release);
      await this.persist(pack);
      try {
        const fileId = await this.options.client.upload(this.options.publishProjectId, bytes, {
          displayName: displayName.trim(), changelog: changelog.trim(), gameVersionNames: [pack.minecraftVersion, pack.loader],
        });
        release.fileId = fileId;
        release.status = 'pending-review';
        await this.persist(pack);
        return { fileId, release: structuredClone(release) };
      } catch (error) {
        release.status = 'uncertain';
        await this.persist(pack);
        if (error instanceof CurseForgeError) throw error;
        throw new CurseForgeError('UPLOAD_UNCERTAIN', 'The upload result is uncertain. Check the CurseForge author dashboard before attempting another release.', 502);
      }
    });
  }
}
