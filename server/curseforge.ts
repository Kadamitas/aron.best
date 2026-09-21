import { createHash } from 'node:crypto';
import { z } from 'zod';

export class CurseForgeError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 422) {
    super(message);
    this.name = 'CurseForgeError';
  }
}

export const loaderSchema = z.enum(['Fabric', 'Forge', 'NeoForge', 'Quilt']);
export type Loader = z.infer<typeof loaderSchema>;
const loaders: Record<Loader, number> = { Forge: 1, Fabric: 4, Quilt: 5, NeoForge: 6 };
const positiveId = z.number().int().positive();

export const fileSchema = z.object({
  id: positiveId,
  modId: positiveId,
  gameId: z.number().int(),
  displayName: z.string().max(500),
  fileName: z.string().max(500),
  fileDate: z.string(),
  fileLength: z.number().int().nonnegative(),
  isAvailable: z.boolean(),
  fileStatus: z.number().int(),
  releaseType: z.number().int(),
  gameVersions: z.array(z.string()).max(200),
  dependencies: z.array(z.object({ modId: positiveId, relationType: z.number().int() })).max(500),
  hashes: z.array(z.object({ algo: z.number().int(), value: z.string().max(128) })).max(10),
  downloadUrl: z.string().nullable().optional(),
  isServerPack: z.boolean().nullable().optional(),
  serverPackFileId: z.number().int().nullable().optional(),
});
export type CurseFile = z.infer<typeof fileSchema>;

const modSchema = z.object({
  id: positiveId,
  gameId: z.number().int(),
  classId: z.number().int().nullable().optional(),
  name: z.string().max(500),
  summary: z.string().max(5000),
  downloadCount: z.number().nonnegative(),
  isAvailable: z.boolean(),
  allowModDistribution: z.boolean().nullable().optional(),
  logo: z.object({ thumbnailUrl: z.string(), url: z.string() }).nullable().optional(),
  links: z.object({ websiteUrl: z.string().nullable().optional() }),
});
export type CurseMod = z.infer<typeof modSchema>;

export interface Compatibility { minecraftVersion: string; loader: Loader }
export interface Download {
  modId: number;
  fileId: number;
  fileName: string;
  fileLength: number;
  url: string;
  hashes: { algo: number; value: string }[];
}

export function isCompatible(file: CurseFile, target: Compatibility): boolean {
  return file.gameId === 432 && file.isAvailable && [4, 10].includes(file.fileStatus)
    && file.releaseType === 1 && file.gameVersions.includes(target.minecraftVersion)
    && file.gameVersions.some((version) => version.toLowerCase() === target.loader.toLowerCase());
}

export function validateDownloadUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new CurseForgeError('UNSAFE_DOWNLOAD', 'CurseForge returned an invalid download address.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || !(url.hostname === 'forgecdn.net' || url.hostname.endsWith('.forgecdn.net'))) {
    throw new CurseForgeError('UNSAFE_DOWNLOAD', 'The download must use an HTTPS CurseForge CDN address.');
  }
  return url;
}

async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new CurseForgeError('RESPONSE_TOO_LARGE', 'The CurseForge response exceeds the permitted size.', 502);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > limit) throw new CurseForgeError('RESPONSE_TOO_LARGE', 'The CurseForge response exceeds the permitted size.', 502);
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, length);
}

export class CurseForgeClient {
  private readonly request: typeof fetch;
  constructor(private readonly options: { apiKey?: string; uploadToken?: string; fetch?: typeof fetch }) {
    this.request = options.fetch ?? fetch;
  }

  get configured(): boolean { return Boolean(this.options.apiKey); }
  get publishingConfigured(): boolean { return Boolean(this.options.uploadToken); }

  private async api<T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T>> {
    if (!this.options.apiKey) {
      throw new CurseForgeError('CURSEFORGE_KEY_REQUIRED', 'Add CURSEFORGE_API_KEY to the local .env file to search and resolve mods.', 503);
    }
    let response: Response;
    try {
      response = await this.request(`https://api.curseforge.com/v1/${path}`, {
        headers: { accept: 'application/json', 'x-api-key': this.options.apiKey },
        redirect: 'error', signal: AbortSignal.timeout(20_000),
      });
    } catch { throw new CurseForgeError('CURSEFORGE_UNAVAILABLE', 'CurseForge could not be reached before the request timed out. Try again later.', 502); }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) {
        throw new CurseForgeError('CURSEFORGE_KEY_REJECTED', 'CurseForge rejected CURSEFORGE_API_KEY. Check its approval and permissions.', 503);
      }
      throw new CurseForgeError('CURSEFORGE_UNAVAILABLE', `CurseForge returned HTTP ${response.status}. Try again later.`, response.status === 429 ? 429 : 502);
    }
    let json: unknown;
    try { json = JSON.parse((await boundedBody(response, 4 * 1024 * 1024)).toString('utf8')); }
    catch (error) {
      if (error instanceof CurseForgeError) throw error;
      throw new CurseForgeError('CURSEFORGE_INVALID_RESPONSE', 'CurseForge returned an invalid JSON response.', 502);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new CurseForgeError('CURSEFORGE_INVALID_RESPONSE', 'CurseForge returned incomplete mod metadata.', 502);
    return parsed.data;
  }

  async search(query: string, target: Compatibility): Promise<CurseMod[]> {
    if (query.length > 100) throw new CurseForgeError('INVALID_QUERY', 'Search text must be at most 100 characters.', 400);
    const params = new URLSearchParams({ gameId: '432', classId: '6', searchFilter: query.trim(),
      gameVersion: target.minecraftVersion, modLoaderType: String(loaders[target.loader]),
      sortField: '2', sortOrder: 'desc', pageSize: '24' });
    const result = await this.api(`mods/search?${params}`, z.object({ data: z.array(modSchema).max(50) }));
    return result.data.filter((mod) => mod.gameId === 432 && mod.classId === 6 && mod.isAvailable);
  }

  async getMod(id: number): Promise<CurseMod> {
    positiveId.parse(id);
    const mod = (await this.api(`mods/${id}`, z.object({ data: modSchema }))).data;
    if (mod.id !== id) throw new CurseForgeError('MOD_ID_MISMATCH', 'CurseForge returned a different project than requested.', 502);
    return mod;
  }

  async getFile(modId: number, fileId: number): Promise<CurseFile> {
    positiveId.parse(modId); positiveId.parse(fileId);
    const file = (await this.api(`mods/${modId}/files/${fileId}`, z.object({ data: fileSchema }))).data;
    if (file.modId !== modId || file.id !== fileId) throw new CurseForgeError('FILE_ID_MISMATCH', 'CurseForge returned a different file than requested.', 502);
    return file;
  }

  async latestFile(modId: number, target: Compatibility): Promise<CurseFile> {
    positiveId.parse(modId);
    const files: CurseFile[] = [];
    for (let page = 0; page < 10; page++) {
      const params = new URLSearchParams({ gameVersion: target.minecraftVersion, modLoaderType: String(loaders[target.loader]), pageSize: '50', index: String(page * 50) });
      const result = await this.api(`mods/${modId}/files?${params}`, z.object({
        data: z.array(fileSchema).max(50), pagination: z.object({ totalCount: z.number().int().nonnegative() }).optional(),
      }));
      files.push(...result.data.filter((file) => file.modId === modId && !file.isServerPack && isCompatible(file, target)));
      if (result.data.length < 50 || (result.pagination && (page + 1) * 50 >= result.pagination.totalCount)) break;
      if (page === 9) throw new CurseForgeError('TOO_MANY_FILES', 'This project has too many matching files to select a release safely. Pin a smaller compatibility range.');
    }
    files.sort((a, b) => b.fileDate.localeCompare(a.fileDate) || b.id - a.id);
    const selected = files[0];
    if (!selected) throw new CurseForgeError('NO_COMPATIBLE_RELEASE', `Project ${modId} has no approved stable release for Minecraft ${target.minecraftVersion} with ${target.loader}.`);
    return selected;
  }

  async download(file: CurseFile): Promise<Download> {
    const metadata = await this.getMod(file.modId);
    if (!metadata.isAvailable || metadata.allowModDistribution === false || !file.isAvailable) {
      throw new CurseForgeError('DOWNLOAD_RESTRICTED', `${metadata.name} does not currently permit this automated download. Install it through the CurseForge App.`);
    }
    const url = file.downloadUrl || (await this.api(`mods/${file.modId}/files/${file.id}/download-url`, z.object({ data: z.string().nullable() }))).data;
    if (!url) throw new CurseForgeError('DOWNLOAD_RESTRICTED', `${metadata.name} has no API download URL. Install it through the CurseForge App.`);
    validateDownloadUrl(url);
    if (!file.hashes.some((hash) => hash.algo === 1 && /^[a-f0-9]{40}$/i.test(hash.value))) {
      throw new CurseForgeError('CHECKSUM_REQUIRED', `${metadata.name} has no valid SHA-1 checksum to verify the download.`);
    }
    if (file.fileName.includes('/') || file.fileName.includes('\\') || /[\x00-\x1f\x7f:]/.test(file.fileName) || file.fileName.startsWith('.')) {
      throw new CurseForgeError('UNSAFE_FILENAME', 'CurseForge returned an unsafe filename.');
    }
    return { modId: file.modId, fileId: file.id, fileName: file.fileName, fileLength: file.fileLength, url, hashes: file.hashes };
  }

  async downloadArchive(file: CurseFile): Promise<Buffer> {
    const item = await this.download(file);
    const limit = 64 * 1024 * 1024;
    if (!file.fileName.toLowerCase().endsWith('.zip') || file.fileLength > limit) {
      throw new CurseForgeError('PACK_ARCHIVE_LIMIT', 'Published modpacks must be ZIP archives no larger than 64 MiB.');
    }
    let url = validateDownloadUrl(item.url);
    for (let redirects = 0; redirects < 4; redirects++) {
      const response = await this.request(url, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new CurseForgeError('DOWNLOAD_FAILED', 'CurseForge returned an invalid redirect.', 502);
        url = validateDownloadUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new CurseForgeError('DOWNLOAD_FAILED', `CurseForge download returned HTTP ${response.status}.`, 502); }
      const bytes = await boundedBody(response, limit);
      const expected = item.hashes.find((hash) => hash.algo === 1)!;
      if (bytes.length !== item.fileLength || createHash('sha1').update(bytes).digest('hex') !== expected.value.toLowerCase()) {
        throw new CurseForgeError('CHECKSUM_MISMATCH', 'The downloaded modpack did not match CurseForge metadata.');
      }
      return bytes;
    }
    throw new CurseForgeError('DOWNLOAD_REDIRECT_LIMIT', 'CurseForge returned too many redirects.', 502);
  }

  async upload(projectId: number, archive: Buffer, metadata: { displayName: string; changelog: string; gameVersionNames: string[] }): Promise<number> {
    positiveId.parse(projectId);
    if (!this.options.uploadToken) throw new CurseForgeError('UPLOAD_TOKEN_REQUIRED', 'Add CURSEFORGE_UPLOAD_TOKEN to the local .env file to publish.', 503);
    const form = new FormData();
    form.set('metadata', JSON.stringify({ ...metadata, changelogType: 'markdown', releaseType: 'release' }));
    form.set('file', new Blob([new Uint8Array(archive)], { type: 'application/zip' }), 'modpack.zip');
    const response = await this.request(`https://minecraft.curseforge.com/api/projects/${projectId}/upload-file`, {
      method: 'POST', headers: { 'X-Api-Token': this.options.uploadToken }, body: form,
      redirect: 'error', signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new CurseForgeError('UPLOAD_FAILED', `CurseForge upload returned HTTP ${response.status}. Check the author dashboard before trying again.`, 502); }
    const result = z.object({ id: positiveId }).safeParse(JSON.parse((await boundedBody(response, 1024 * 1024)).toString('utf8')));
    if (!result.success) throw new CurseForgeError('UPLOAD_UNCERTAIN', 'CurseForge did not return a file ID. Check the author dashboard before trying again.', 502);
    return result.data.id;
  }
}
