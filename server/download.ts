import { createHash, randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';

const artifactHosts = new Set(['edge.forgecdn.net', 'media.forgecdn.net', 'mediafilez.forgecdn.net', 'mediafiles.forgecdn.net', 'meta.fabricmc.net']);

export function validateArtifactUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !artifactHosts.has(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('The artifact must come from an approved HTTPS download host.');
  }
  return url;
}

export async function downloadArtifact(url: string, destination: string, options: { maximumBytes?: number; hashes?: { algo: number; value: string }[]; expectedBytes?: number } = {}): Promise<void> {
  let currentUrl = validateArtifactUrl(url);
  const maximumBytes = options.maximumBytes ?? 128 * 1024 * 1024;
  const timeout = AbortSignal.timeout(180_000);
  let response: Response | undefined;
  for (let hop = 0; hop < 4; hop++) {
    response = await fetch(currentUrl, { redirect: 'manual', signal: timeout });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error('Download redirect has no destination.');
    currentUrl = validateArtifactUrl(new URL(location, currentUrl).href);
  }
  if (!response?.ok || !response.body) throw new Error(`Download failed (${response?.status ?? 'no response'}).`);
  if (Number(response.headers.get('content-length')) > maximumBytes) { await response.body.cancel(); throw new Error('Download exceeds the size limit.'); }
  const temporary = `${destination}.${randomUUID()}.part`;
  const file = await open(temporary, 'wx', 0o600).catch(async error => { await response.body?.cancel(); throw error; });
  const sha1 = createHash('sha1');
  const md5 = createHash('md5');
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > maximumBytes) throw new Error('Download exceeds the size limit.');
      sha1.update(chunk); md5.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength) offset += (await file.write(chunk, offset)).bytesWritten;
    }
    const digests: Record<number, string> = { 1: sha1.digest('hex'), 2: md5.digest('hex') };
    if (options.expectedBytes !== undefined && bytes !== options.expectedBytes) throw new Error('Download size does not match CurseForge metadata.');
    for (const hash of options.hashes ?? []) {
      if (digests[hash.algo] && digests[hash.algo] !== hash.value.toLowerCase()) throw new Error('Download checksum verification failed.');
    }
    if (options.hashes && !options.hashes.some(hash => hash.algo === 1 || hash.algo === 2)) throw new Error('No supported checksum was supplied.');
    await file.sync();
    await file.close();
    await rename(temporary, destination);
  } catch (error) {
    await file.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
}
