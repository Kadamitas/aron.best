import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { CurseForgeClient, CurseForgeError, validateDownloadUrl, type CurseFile } from './curseforge.js';
import { inspectManifest, PackService, parseInstalledProfile, type Manifest } from './modpack.js';

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });

function file(id: number, dependencies: CurseFile['dependencies'] = []): CurseFile {
  return { id: id * 10, modId: id, gameId: 432, displayName: `Release ${id}`, fileName: `mod-${id}.jar`,
    fileDate: '2026-09-20T00:00:00Z', fileLength: 10, isAvailable: true, fileStatus: 4, releaseType: 1,
    gameVersions: ['26.3', 'Fabric'], dependencies, hashes: [{ algo: 1, value: 'a'.repeat(40) }],
    downloadUrl: `https://edge.forgecdn.net/files/${id}/mod-${id}.jar` };
}

function mod(id: number, classId = 6) {
  return { id, classId, gameId: 432, name: `Mod ${id}`, summary: 'A test mod', downloadCount: 10,
    isAvailable: true, allowModDistribution: true, links: { websiteUrl: `https://www.curseforge.com/minecraft/mc-mods/${id}` } };
}

function mockFetch(files: CurseFile[], extra?: (url: URL, init?: RequestInit) => Promise<Response | undefined>): typeof fetch {
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const custom = await extra?.(url, init);
    if (custom) return custom;
    const match = /^\/v1\/mods\/(\d+)(?:\/files(?:\/(\d+))?)?$/.exec(url.pathname);
    assert.ok(match, `Unexpected request ${url.href}`);
    const projectId = Number(match[1]);
    const payload = url.pathname.endsWith('/files') ? files.filter((entry) => entry.modId === projectId)
      : match[2] ? files.find((entry) => entry.modId === projectId && entry.id === Number(match[2])) : mod(projectId);
    return Response.json({ data: payload });
  }) as typeof fetch;
}

async function setup(files: CurseFile[], extra?: Parameters<typeof mockFetch>[1]) {
  const folder = await mkdtemp(join(tmpdir(), 'aron-curseforge-'));
  folders.push(folder);
  const statePath = join(folder, 'pack.json');
  const client = new CurseForgeClient({ apiKey: 'search-secret', uploadToken: 'upload-secret', fetch: mockFetch(files, extra) });
  const options = { statePath, client, minecraftVersion: '26.3', loader: 'Fabric' as const, loaderVersion: '0.19.5', name: 'Friends' };
  return { folder, statePath, client, options, service: new PackService(options) };
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Stored ZIP fixtures exercise the actual parser, including unsafe central directory names.
function zip(entries: [string, string][]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [path, content] of entries) {
    const name = Buffer.from(path); const data = Buffer.from(content); const checksum = crc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6);
    record.writeUInt32LE(checksum, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42);
    local.push(header, name, data); central.push(record, name); offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

test('missing API configuration is actionable and makes no network request', async () => {
  const client = new CurseForgeClient({ fetch: (() => { assert.fail('Network must not run'); }) as typeof fetch });
  await assert.rejects(client.search('fabric', { minecraftVersion: '26.3', loader: 'Fabric' }), { code: 'CURSEFORGE_KEY_REQUIRED', statusCode: 503 });
});

test('required dependencies are pinned, reverse-protected and removed when orphaned', async () => {
  const { service } = await setup([file(1, [{ modId: 2, relationType: 3 }]), file(2)]);
  const pack = await service.add(1);
  assert.deepEqual(pack.mods.map((entry) => [entry.id, entry.fileId, entry.explicit]), [[1, 10, true], [2, 20, false]]);
  await assert.rejects(service.remove(2), { code: 'MOD_REQUIRED' });
  assert.equal((await service.remove(1)).mods.length, 0);
});

test('concurrent mutations preserve both additions and persisted versions', async () => {
  const { service, statePath } = await setup([file(1), file(2)]);
  await Promise.all([service.add(1), service.add(2)]);
  const persisted = JSON.parse(await readFile(statePath, 'utf8'));
  assert.deepEqual(persisted.mods.map((entry: { id: number }) => entry.id), [1, 2]);
  assert.equal(persisted.version, '0.1.2');
});

test('a dependency conflict fails atomically without leaving partial selections', async () => {
  const { service } = await setup([file(1, [{ modId: 2, relationType: 5 }]), file(2)]);
  await service.add(1);
  await assert.rejects(service.add(2), { code: 'MOD_CONFLICT' });
  assert.deepEqual((await service.getPack()).mods.map((entry) => entry.id), [1]);
});

test('incompatible loader and unapproved files cannot be selected', async () => {
  const mismatched = file(1); mismatched.gameVersions = ['26.3', 'NeoForge'];
  const pending = file(1); pending.id = 11; pending.fileStatus = 3;
  const { service } = await setup([mismatched, pending]);
  await assert.rejects(service.add(1), { code: 'NO_COMPATIBLE_RELEASE' });
  assert.equal((await service.getPack()).mods.length, 0);
});

test('download addresses cannot target local networks, another host, or carry credentials', () => {
  for (const url of ['http://edge.forgecdn.net/mod.jar', 'https://127.0.0.1/mod.jar', 'https://forgecdn.net.attacker.test/mod.jar', 'https://secret@edge.forgecdn.net/mod.jar', 'https://edge.forgecdn.net:444/mod.jar']) {
    assert.throws(() => validateDownloadUrl(url), { code: 'UNSAFE_DOWNLOAD' });
  }
  assert.equal(validateDownloadUrl('https://mediafilez.forgecdn.net/files/a.jar').hostname, 'mediafilez.forgecdn.net');
});

test('archive inspection rejects traversal and duplicate manifests without extraction', async () => {
  const { service } = await setup([]);
  const manifest = JSON.stringify(await service.exportManifest());
  await assert.rejects(inspectManifest(zip([['../outside', 'bad'], ['manifest.json', manifest]])), CurseForgeError);
  await assert.rejects(inspectManifest(zip([['manifest.json', manifest], ['manifest.json', manifest]])), { code: 'INVALID_ARCHIVE' });
  const result = await inspectManifest(zip([['manifest.json', manifest], ['overrides/config/settings.json', '{}']]));
  assert.equal(result.hasOverrides, true);
});

test('publishing refuses a stale App export before making an upload', async () => {
  const { options, folder } = await setup([file(1)]);
  const exportPath = join(folder, 'app-export.zip');
  const service = new PackService({ ...options, publishProjectId: 123, publishArchivePath: exportPath });
  const oldManifest = await service.exportManifest();
  await service.add(1);
  await writeFile(exportPath, zip([['manifest.json', JSON.stringify(oldManifest)]]));
  await assert.rejects(service.publish('Friends', 'Add a mod'), { code: 'STALE_APP_EXPORT' });
  assert.equal((await service.getPack()).releases.length, 0);
});

test('publishing sends original bytes with a separate token and prevents duplicate uploads', async () => {
  let submitted: Buffer | undefined;
  let uploads = 0;
  const { options, folder } = await setup([file(1)], async (url, init) => {
    if (!url.pathname.endsWith('/upload-file')) return undefined;
    uploads++;
    assert.equal(url.origin, 'https://minecraft.curseforge.com');
    assert.deepEqual(init?.headers, { 'X-Api-Token': 'upload-secret' });
    const form = init?.body as FormData;
    submitted = Buffer.from(await (form.get('file') as Blob).arrayBuffer());
    assert.deepEqual(JSON.parse(String(form.get('metadata'))).gameVersionNames, ['26.3', 'Fabric']);
    return Response.json({ id: 789 });
  });
  const exportPath = join(folder, 'app-export.zip');
  const service = new PackService({ ...options, publishProjectId: 123, publishArchivePath: exportPath });
  await service.add(1);
  const original = zip([['manifest.json', JSON.stringify(await service.exportManifest())], ['overrides/', '']]);
  await writeFile(exportPath, original);
  const result = await service.publish('Friends 0.1.1', 'Add the first mod');
  assert.equal(result.fileId, 789);
  assert.equal(result.release.status, 'pending-review');
  assert.deepEqual(submitted, original);
  await assert.rejects(service.publish('Friends 0.1.1', 'Try again'), { code: 'RELEASE_ALREADY_ATTEMPTED' });
  assert.equal(uploads, 1);
});

test('an ambiguous upload remains recorded across process restarts', async () => {
  const { options, folder } = await setup([], async (url) => {
    if (url.pathname.endsWith('/upload-file')) throw new Error('Connection dropped after submission');
    return undefined;
  });
  const exportPath = join(folder, 'app-export.zip');
  const fullOptions = { ...options, publishProjectId: 123, publishArchivePath: exportPath };
  const service = new PackService(fullOptions);
  await writeFile(exportPath, zip([['manifest.json', JSON.stringify(await service.exportManifest())]]));
  await assert.rejects(service.publish('Friends', 'Initial release'), { code: 'UPLOAD_UNCERTAIN' });
  const restarted = new PackService(fullOptions);
  assert.equal((await restarted.getPack()).releases[0]?.status, 'uncertain');
  await assert.rejects(restarted.publish('Friends', 'Retry'), { code: 'RELEASE_ALREADY_ATTEMPTED' });
});

test('latest published release validates archive checksum and exact pinned files', async () => {
  let archive: Buffer;
  const packFile = file(123); packFile.fileName = 'friends.zip';
  const { options } = await setup([file(1), packFile], async (url) => {
    if (url.pathname === '/v1/mods/123') return Response.json({ data: mod(123, 4471) });
    if (url.hostname === 'edge.forgecdn.net') return new Response(new Uint8Array(archive));
    return undefined;
  });
  const service = new PackService({ ...options, publishProjectId: 123 });
  const manifest: Manifest = { ...await service.exportManifest(), files: [{ projectID: 1, fileID: 10, required: true }] };
  archive = zip([['manifest.json', JSON.stringify(manifest)]]);
  packFile.fileLength = archive.length;
  packFile.hashes = [{ algo: 1, value: createHash('sha1').update(archive).digest('hex') }];
  const release = await service.resolveLatestRelease();
  assert.equal(release.fileId, 1230);
  assert.equal(release.downloads[0]?.fileId, 10);
  archive = zip([['manifest.json', JSON.stringify(manifest)], ['overrides/config/important.json', '{}']]);
  packFile.fileLength = archive.length;
  packFile.hashes = [{ algo: 1, value: createHash('sha1').update(archive).digest('hex') }];
  await assert.rejects(service.resolveLatestRelease(), { code: 'PUBLISHED_OVERRIDES_UNSUPPORTED' });
});

test('local profile import derives the exact version and rejects incomplete required dependencies', () => {
  const profile = {
    name: 'Imported profile', gameVersion: '26.3', gameTypeID: 432,
    baseModLoader: { type: 4, forgeVersion: '0.19.5', minecraftVersion: '26.3' }, modpackOverrides: [],
    installedAddons: [{ addonID: 1, gameID: 432, categoryClassID: 6, name: 'Existing mod', isEnabled: true,
      installedFile: { id: 10, fileName: 'existing.jar', fileLength: 10, fileStatus: 4, releaseType: 1, isAvailable: true,
        downloadUrl: 'https://edge.forgecdn.net/files/existing.jar', gameVersion: ['26.3', 'Fabric'],
        hashes: [{ type: 1, value: 'a'.repeat(40) }], dependencies: [] as { addonId: number; type: number }[] } }],
  };
  const result = parseInstalledProfile(profile);
  assert.equal(result.pack.minecraftVersion, '26.3');
  assert.equal(result.pack.loaderVersion, '0.19.5');
  assert.equal(result.pack.mods[0]?.fileId, 10);
  profile.installedAddons[0]!.installedFile.dependencies = [{ addonId: 2, type: 3 }];
  assert.throws(() => parseInstalledProfile(profile), { code: 'MISSING_DEPENDENCY' });
});
