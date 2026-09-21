import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { access, lstat, mkdir, open, readdir, realpath, rename, rm, statfs, utimes, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { classifyRuntimePath } from './runtime-integrity.js';
import { javaProxyArguments } from './java-network.js';

const curatedVersions = ['1.6.4', '1.7.10', '1.12.2', '1.16.5', '1.18.2', '1.19.2', '1.20.1', '1.21.1'];
const versionSchema = z.string().regex(/^[0-9][A-Za-z0-9.+-]{0,79}$/);
const targetSchema = z.object({ minecraftVersion: versionSchema, loader: z.enum(['Fabric', 'Forge', 'NeoForge', 'Quilt']), loaderVersion: versionSchema }).strict();
const installedSchema = targetSchema.extend({ javaMajor: z.union([z.literal(8), z.literal(17), z.literal(21), z.literal(25)]), launchArgs: z.array(z.string().max(240)).min(1).max(2), installedAt: z.string().datetime() }).strict();
const officialHosts = new Set(['piston-meta.mojang.com', 'piston-data.mojang.com', 'launchermeta.mojang.com', 'launcher.mojang.com', 'meta.fabricmc.net', 'maven.fabricmc.net', 'meta.quiltmc.org', 'maven.quiltmc.org', 'files.minecraftforge.net', 'maven.minecraftforge.net', 'maven.neoforged.net']);
const minecraftManifest = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const forgeMetadata = 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml';
const neoMetadata = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml';
const legacyNeoMetadata = 'https://maven.neoforged.net/releases/net/neoforged/forge/maven-metadata.xml';
const runtimeNames = new Set(['libraries', 'versions', '.fabric', '.quilt', 'installation.json', 'fabric-server-launch.jar', 'fabric-server-launcher.properties', 'quilt-server-launch.jar', 'quilt-server-launcher.properties', 'server.jar', 'run.sh', 'run.bat', 'user_jvm_args.txt', 'unix_args.txt', 'win_args.txt', 'installer.jar', 'installer.jar.log']);
const metadataLimit = 4 * 1024 ** 2;
const artifactLimit = 128 * 1024 ** 2;
const freeReserve = 2n * 1024n ** 3n;

export type ServerTarget = z.infer<typeof targetSchema>;
export type InstalledServer = z.infer<typeof installedSchema>;
export interface InstallationCatalog { versions: string[]; minecraftVersion: string; loaders: Array<Pick<ServerTarget, 'loader' | 'loaderVersion'>> }
export interface LoaderInstallationDependencies {
  fetch: typeof fetch;
  run: (java: string, args: string[], directory: string, log: (line: string) => void) => Promise<void>;
  availableBytes: (directory: string) => Promise<bigint>;
  rename: typeof rename;
}
export interface InstallationHardening {
  prepare(directory: string, installed: InstalledServer, vanilla: { sha1: string; size: number }): Promise<void>;
  seal(): Promise<unknown>;
}
interface MinecraftRelease { id: string; type: string; url: string; sha1: string }
interface TreeItem { relative: string; directory: boolean; info: Stats }
interface Directory { handle: FileHandle; anchored: string }

export class LoaderInstallationError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); }
}

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function sameFile(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }
function runtime(name: string): boolean { return classifyRuntimePath(name) === 'protected' || runtimeNames.has(name) || /^(?:minecraft_server[.-].*|forge-.*|neoforge-.*|fabric-installer.*|quilt-installer.*)\.jar(?:\.log)?$/.test(name); }
function newest(versions: string[]): string | undefined { return [...versions].sort((left, right) => right.localeCompare(left, 'en', { numeric: true })).at(0); }
function xmlVersions(contents: string): string[] { return [...contents.matchAll(/<version>([^<]+)<\/version>/g)].map(match => match[1]!).filter(value => versionSchema.safeParse(value).success); }
function officialUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !officialHosts.has(url.hostname) || url.username || url.password || url.port && url.port !== '443') throw new LoaderInstallationError('Installation downloads must use an approved official HTTPS host.');
  return url;
}
function regular(info: Stats): void {
  if (!info.isFile() || info.nlink !== 1) throw new LoaderInstallationError('Installation files must be regular files without symbolic or hard links.', 409);
}
function safeLaunch(installed: InstalledServer): boolean {
  const [first, second] = installed.launchArgs;
  if (installed.loader === 'Fabric') return first === '-jar' && second === 'fabric-server-launch.jar';
  if (installed.loader === 'Quilt') return first === '-jar' && second === 'quilt-server-launch.jar';
  const coordinate = `${installed.minecraftVersion}-${installed.loaderVersion}`;
  if (installed.loader === 'Forge') {
    const variants = [coordinate, `${coordinate}-${installed.minecraftVersion}`];
    return variants.some(version => installed.launchArgs.length === 1 && first === `@libraries/net/minecraftforge/forge/${version}/unix_args.txt`
      || first === '-jar' && (second === `forge-${version}.jar` || second === `forge-${version}-universal.jar` || second === `minecraftforge-universal-${version}.jar`));
  }
  return installed.launchArgs.length === 1 && (first === `@libraries/net/neoforged/neoforge/${installed.loaderVersion}/unix_args.txt`
    || installed.minecraftVersion === '1.20.1' && first === `@libraries/net/neoforged/forge/${coordinate}/unix_args.txt`);
}

export async function readInstalled(directory: string): Promise<InstalledServer | undefined> {
  const candidate = path.join(directory, 'installation.json');
  const info = await lstat(candidate).catch(error => { if (missing(error)) return undefined; throw error; });
  if (!info) return undefined;
  regular(info);
  if (info.size > 16 * 1024) throw new LoaderInstallationError('The installation descriptor is too large.', 409);
  const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    regular(current);
    if (!sameFile(info, current)) throw new LoaderInstallationError('The installation descriptor changed while it was opened.', 409);
    const bytes = Buffer.alloc(16 * 1024 + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (length > 16 * 1024 || length !== current.size || current.ctimeMs !== after.ctimeMs) throw new LoaderInstallationError('The installation descriptor changed while it was read.', 409);
    const value: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8'));
    if (value && typeof value === 'object' && !('loader' in value) && !('launchArgs' in value)) return undefined;
    const result = installedSchema.safeParse(value);
    if (!result.success || !safeLaunch(result.data)) throw new LoaderInstallationError('The installation descriptor contains an unsupported launch command.', 409);
    return result.data;
  } finally { await handle.close(); }
}

async function runInstaller(java: string, args: string[], directory: string, log: (line: string) => void): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(java, args, { cwd: directory, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', JAVA_HOME: path.resolve(java, '..', '..'), LANG: 'C.UTF-8' } });
    let pending = '';
    let timedOut = false;
    const receive = (bytes: Buffer) => {
      pending += bytes.toString('utf8');
      const lines = pending.split(/\r?\n/);
      pending = lines.pop()!.slice(-2000);
      for (const line of lines) log(line.slice(0, 2000));
    };
    child.stdout.on('data', receive);
    child.stderr.on('data', receive);
    const terminate = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } } };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, 15 * 60_000).unref();
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (pending) log(pending);
      if (timedOut) reject(new LoaderInstallationError('The official installer timed out. The original server was not changed.', 504));
      else if (code !== 0) reject(new LoaderInstallationError(`The official installer exited with code ${code}. The original server was not changed.`, 502));
      else resolve();
    });
  });
}

export class LoaderInstallation {
  private readonly dependencies: LoaderInstallationDependencies;
  private readonly directory: string;
  private readonly cache = new Map<string, { expires: number; bytes: Buffer }>();
  private installing = false;

  constructor(private readonly options: { directory: string; javaPaths: Record<number, string>; log: (line: string) => void; hardening?: InstallationHardening; installerProxyAddress?: string }, dependencies: Partial<LoaderInstallationDependencies> = {}) {
    this.directory = path.resolve(options.directory);
    if (this.directory === path.parse(this.directory).root) throw new LoaderInstallationError('Use a dedicated Minecraft server directory.');
    this.dependencies = { fetch, run: (java, args, directory, log) => runInstaller(java, [...(options.installerProxyAddress ? javaProxyArguments(options.installerProxyAddress, 3128) : []), ...args], directory, log), rename, availableBytes: async directory => { const info = await statfs(directory, { bigint: true }); return info.bavail * info.bsize; }, ...dependencies };
  }

  async catalog(minecraftVersion?: string): Promise<InstallationCatalog> {
    const releases = await this.releases();
    const versions = releases.filter(release => release.type === 'release' && (curatedVersions.includes(release.id) || /^\d+\.\d+(?:\.\d+)?$/.test(release.id) && Number(release.id.split('.')[0]) >= 26)).map(release => release.id);
    const selected = minecraftVersion ?? versions[0];
    if (!selected || !versionSchema.safeParse(selected).success) throw new LoaderInstallationError('Choose a valid Minecraft release.');
    if (!versions.includes(selected)) return { versions, minecraftVersion: selected, loaders: [] };
    const candidates = await Promise.all((['Fabric', 'Forge', 'NeoForge', 'Quilt'] as const).map(async loader => {
      try {
        const loaderVersion = await this.loaderVersion(selected, loader);
        return loaderVersion ? { loader, loaderVersion } : undefined;
      } catch (error) {
        this.options.log(`${loader} version lookup is temporarily unavailable: ${(error as Error).message}`);
        return undefined;
      }
    }));
    return { versions, minecraftVersion: selected, loaders: candidates.filter((value): value is Pick<ServerTarget, 'loader' | 'loaderVersion'> => value !== undefined) };
  }

  async install(value: ServerTarget): Promise<InstalledServer> {
    const parsed = targetSchema.safeParse(value);
    if (!parsed.success) throw new LoaderInstallationError('Choose a valid Minecraft version and loader.');
    if (this.installing) throw new LoaderInstallationError('Another installation is already in progress.', 409);
    this.installing = true;
    try { return await this.installTarget(parsed.data); }
    finally { this.installing = false; }
  }

  private async installTarget(target: ServerTarget): Promise<InstalledServer> {
    const catalog = await this.catalog(target.minecraftVersion);
    if (!catalog.loaders.some(loader => loader.loader === target.loader && loader.loaderVersion === target.loaderVersion)) throw new LoaderInstallationError('That loader build is not available for the selected Minecraft version.', 409);
    const release = (await this.releases()).find(release => release.id === target.minecraftVersion)!;
    const versionBytes = await this.metadata(release.url);
    if (createHash('sha1').update(versionBytes).digest('hex') !== release.sha1) throw new LoaderInstallationError('Minecraft version metadata failed checksum verification.', 502);
    const details = z.object({ javaVersion: z.object({ majorVersion: z.number().int() }).optional(), downloads: z.object({ server: z.object({ url: z.string().url(), sha1: z.string().regex(/^[a-f0-9]{40}$/), size: z.number().int().positive().max(artifactLimit) }) }) }).parse(JSON.parse(versionBytes.toString('utf8')));
    const javaMajor = details.javaVersion?.majorVersion ?? 8;
    if (![8, 17, 21, 25].includes(javaMajor) || !this.options.javaPaths[javaMajor]) throw new LoaderInstallationError(`Java ${javaMajor} must be configured before installing this release.`, 409);
    const parent = await realpath(path.dirname(this.directory));
    const original = path.join(parent, path.basename(this.directory));
    const originalInfo = await lstat(original);
    if (!originalInfo.isDirectory() || originalInfo.isSymbolicLink()) throw new LoaderInstallationError('The server directory cannot be a symbolic link.', 409);
    const retained = path.join(parent, 'installation-snapshots');
    await mkdir(retained, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    if (!(await lstat(retained)).isDirectory() || (await lstat(retained)).isSymbolicLink()) throw new LoaderInstallationError('Installation snapshot storage is not a regular directory.', 409);
    if ((await readdir(retained)).length >= 5) throw new LoaderInstallationError('Five installation snapshots are retained. Archive one safely before changing versions again.', 409);
    const inventory = await this.inventory(original);
    const preserved = inventory.filter(entry => !runtime(entry.relative.split('/')[0]!));
    const bytes = preserved.reduce((total, entry) => total + (entry.directory ? 0n : BigInt(entry.info.size)), 0n);
    if (await this.dependencies.availableBytes(parent) < bytes + freeReserve) throw new LoaderInstallationError('Not enough free storage to preserve the server and stage a new installation.', 507);
    const staging = path.join(parent, `.installation-${randomUUID()}`);
    const snapshot = path.join(retained, `${Date.now()}-${randomUUID()}`);
    await mkdir(staging, { mode: 0o700 });
    let archived = false;
    try {
      this.options.log(`Installing Minecraft ${target.minecraftVersion} with ${target.loader} ${target.loaderVersion}.`);
      const launchArgs = await this.prepare(staging, target, javaMajor, details.downloads.server);
      const installed = installedSchema.parse({ ...target, javaMajor, launchArgs, installedAt: new Date().toISOString() });
      if (!safeLaunch(installed)) throw new LoaderInstallationError('The installer did not produce a supported launch command.', 502);
      await this.options.hardening?.prepare(staging, installed, details.downloads.server);
      await this.inventory(staging);
      for (const entry of preserved) await this.copyEntry(original, staging, entry);
      await writeFile(path.join(staging, 'installation.json'), `${JSON.stringify(installed, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      if (!this.sameInventory(inventory, await this.inventory(original)) || !sameFile(originalInfo, await lstat(original))) throw new LoaderInstallationError('The existing server changed during installation. It was not replaced.', 409);
      await this.dependencies.rename(original, snapshot);
      archived = true;
      try { await this.dependencies.rename(staging, original); }
      catch (error) {
        await this.dependencies.rename(snapshot, original);
        archived = false;
        throw error;
      }
      await this.options.hardening?.seal();
      this.options.log(`Installation ready. The previous server is retained in installation-snapshots/${path.basename(snapshot)}.`);
      return installed;
    } finally {
      if (!archived) await rm(staging, { recursive: true, force: true });
    }
  }

  private async prepare(directory: string, target: ServerTarget, javaMajor: number, vanilla: { url: string; sha1: string; size: number }): Promise<string[]> {
    if (target.loader === 'Fabric') {
      const installers = z.array(z.object({ version: versionSchema, stable: z.boolean() })).parse(await this.json('https://meta.fabricmc.net/v2/versions/installer'));
      const installer = installers.find(value => value.stable)?.version;
      if (!installer) throw new LoaderInstallationError('No stable Fabric installer is available.', 502);
      await this.download(`https://meta.fabricmc.net/v2/versions/loader/${target.minecraftVersion}/${target.loaderVersion}/${installer}/server/jar`, path.join(directory, 'fabric-server-launch.jar'));
      await this.download(vanilla.url, path.join(directory, 'server.jar'), vanilla);
      return ['-jar', 'fabric-server-launch.jar'];
    }
    if (target.loader === 'Quilt') {
      const installers = z.array(z.object({ version: versionSchema, url: z.string().url(), file_size: z.number().int().positive().max(artifactLimit).optional() })).parse(await this.json('https://meta.quiltmc.org/v3/versions/installer'));
      const installer = installers.find(value => !/beta|alpha|rc/.test(value.version));
      if (!installer) throw new LoaderInstallationError('No stable Quilt installer is available.', 502);
      await this.download(installer.url, path.join(directory, 'installer.jar'), { sha1: await this.checksum(installer.url), size: installer.file_size });
      const installerJava = this.options.javaPaths[25] ?? this.options.javaPaths[21] ?? this.options.javaPaths[17];
      if (!installerJava) throw new LoaderInstallationError('Java 17 or later is required for the Quilt installer.', 409);
      await this.dependencies.run(installerJava, ['-jar', 'installer.jar', 'install', 'server', target.minecraftVersion, target.loaderVersion, '--install-dir=.'], directory, this.options.log);
      await this.download(vanilla.url, path.join(directory, 'server.jar'), vanilla);
      await this.assertLaunchFile(directory, 'quilt-server-launch.jar');
      await rm(path.join(directory, 'installer.jar'));
      return ['-jar', 'quilt-server-launch.jar'];
    }
    const coordinate = await this.mavenCoordinate(target);
    const legacyNeo = target.loader === 'NeoForge' && target.minecraftVersion === '1.20.1';
    const group = target.loader === 'Forge' ? 'net/minecraftforge/forge' : legacyNeo ? 'net/neoforged/forge' : 'net/neoforged/neoforge';
    const artifact = target.loader === 'Forge' || legacyNeo ? 'forge' : 'neoforge';
    const repository = target.loader === 'Forge' ? 'https://maven.minecraftforge.net' : 'https://maven.neoforged.net/releases';
    const url = `${repository}/${group}/${coordinate}/${artifact}-${coordinate}-installer.jar`;
    await this.download(url, path.join(directory, 'installer.jar'), { sha1: await this.checksum(url) });
    if (target.loader === 'Forge' && javaMajor === 8) await this.download(vanilla.url, path.join(directory, `minecraft_server.${target.minecraftVersion}.jar`), vanilla);
    await this.dependencies.run(this.options.javaPaths[javaMajor]!, ['-jar', 'installer.jar', '--installServer'], directory, this.options.log);
    const args = `libraries/${group}/${coordinate}/unix_args.txt`;
    if (await access(path.join(directory, args)).then(() => true, () => false)) {
      await this.assertLaunchFile(directory, args);
      await rm(path.join(directory, 'installer.jar'));
      return [`@${args}`];
    }
    if (target.loader === 'Forge') {
      for (const file of [`forge-${coordinate}.jar`, `forge-${coordinate}-universal.jar`, `minecraftforge-universal-${coordinate}.jar`]) {
        if (await access(path.join(directory, file)).then(() => true, () => false)) {
          await this.assertLaunchFile(directory, file);
          await rm(path.join(directory, 'installer.jar'));
          return ['-jar', file];
        }
      }
    }
    throw new LoaderInstallationError('The official installer did not produce a supported server launcher.', 502);
  }

  private async loaderVersion(minecraft: string, loader: ServerTarget['loader']): Promise<string | undefined> {
    if (loader === 'Fabric' || loader === 'Quilt') {
      const host = loader === 'Fabric' ? 'https://meta.fabricmc.net/v2' : 'https://meta.quiltmc.org/v3';
      const games = z.array(z.object({ version: z.string() })).parse(await this.json(`${host}/versions/game`));
      if (!games.some(game => game.version === minecraft)) return undefined;
      const entries = z.array(z.object({ loader: z.object({ version: versionSchema, stable: z.boolean().optional() }) })).parse(await this.json(`${host}/versions/loader/${minecraft}`));
      return newest(entries.filter(entry => entry.loader.stable !== false).map(entry => entry.loader.version));
    }
    if (loader === 'Forge') {
      const promos = z.object({ promos: z.record(z.string(), versionSchema) }).parse(await this.json('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json'));
      const version = promos.promos[`${minecraft}-latest`];
      if (!version) return undefined;
      const versions = xmlVersions((await this.metadata(forgeMetadata)).toString('utf8'));
      return versions.some(value => value === `${minecraft}-${version}` || value === `${minecraft}-${version}-${minecraft}`) ? version : undefined;
    }
    if (minecraft === '1.20.1') return newest(xmlVersions((await this.metadata(legacyNeoMetadata)).toString('utf8')).filter(version => version.startsWith('1.20.1-')).map(version => version.slice('1.20.1-'.length)));
    const prefix = minecraft.startsWith('1.') ? `${minecraft.slice(2)}.` : `${minecraft.split('.').map(Number).concat(minecraft.split('.').length === 2 ? [0] : []).join('.')}.`;
    return newest(xmlVersions((await this.metadata(neoMetadata)).toString('utf8')).filter(version => version.startsWith(prefix)));
  }

  private async mavenCoordinate(target: ServerTarget): Promise<string> {
    if (target.loader === 'NeoForge') return target.minecraftVersion === '1.20.1' ? `${target.minecraftVersion}-${target.loaderVersion}` : target.loaderVersion;
    const base = `${target.minecraftVersion}-${target.loaderVersion}`;
    const versions = xmlVersions((await this.metadata(forgeMetadata)).toString('utf8'));
    const coordinate = [base, `${base}-${target.minecraftVersion}`].find(value => versions.includes(value));
    if (!coordinate) throw new LoaderInstallationError('That Forge installer is not listed in the official Maven repository.', 409);
    return coordinate;
  }

  private async releases(): Promise<MinecraftRelease[]> {
    return z.object({ versions: z.array(z.object({ id: z.string(), type: z.string(), url: z.string().url(), sha1: z.string().regex(/^[a-f0-9]{40}$/) })) }).parse(await this.json(minecraftManifest)).versions;
  }

  private async json(url: string): Promise<unknown> { return JSON.parse((await this.metadata(url)).toString('utf8')); }

  private async checksum(url: string): Promise<string> {
    const sha1 = (await this.metadata(`${url}.sha1`)).toString('utf8').trim().split(/\s+/)[0];
    if (!sha1 || !/^[a-f0-9]{40}$/i.test(sha1)) throw new LoaderInstallationError('The official installer checksum is unavailable.', 502);
    return sha1;
  }

  private async metadata(url: string): Promise<Buffer> {
    const cached = this.cache.get(url);
    if (cached && cached.expires > Date.now()) return cached.bytes;
    const response = await this.request(url);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body!) {
      size += chunk.byteLength;
      if (size > metadataLimit) throw new LoaderInstallationError('Official metadata exceeds the size limit.', 502);
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    if (this.cache.size >= 80) this.cache.clear();
    this.cache.set(url, { bytes, expires: Date.now() + 5 * 60_000 });
    return bytes;
  }

  private async request(value: string, timeout = 8000): Promise<Response> {
    let url = officialUrl(value);
    const signal = AbortSignal.timeout(timeout);
    for (let hop = 0; hop < 4; hop++) {
      const response = await this.dependencies.fetch(url, { redirect: 'manual', signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new LoaderInstallationError('The official download redirect has no destination.', 502);
        url = officialUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok || !response.body) throw new LoaderInstallationError(`Official download failed (${response.status}).`, 502);
      return response;
    }
    throw new LoaderInstallationError('The official download redirected too many times.', 502);
  }

  private async download(url: string, destination: string, expected?: { sha1?: string; size?: number }): Promise<void> {
    const response = await this.request(url, 180_000);
    if (Number(response.headers.get('content-length')) > artifactLimit) { await response.body!.cancel(); throw new LoaderInstallationError('The official artifact exceeds the size limit.', 502); }
    const handle = await open(destination, 'wx', 0o600);
    const hash = createHash('sha1');
    let size = 0;
    try {
      for await (const chunk of response.body!) {
        size += chunk.byteLength;
        if (size > artifactLimit) throw new LoaderInstallationError('The official artifact exceeds the size limit.', 502);
        hash.update(chunk);
        await handle.writeFile(chunk);
      }
      if (!size || expected?.size !== undefined && expected.size !== size || expected?.sha1 && expected.sha1.toLowerCase() !== hash.digest('hex')) throw new LoaderInstallationError('Official artifact checksum or size verification failed.', 502);
      await handle.sync();
    } finally { await handle.close(); }
  }

  private async openDirectory(absolute: string): Promise<Directory> {
    const handle = await open(absolute, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    return { handle, anchored: process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : absolute };
  }

  private async inventory(root: string): Promise<TreeItem[]> {
    const entries: TreeItem[] = [];
    const walk = async (directory: Directory, prefix: string, depth: number) => {
      if (depth > 64) throw new LoaderInstallationError('The existing server has too many nested folders to snapshot safely.', 409);
      for (const name of (await readdir(directory.anchored)).sort()) {
        if (name.includes('\0') || name === '.' || name === '..') throw new LoaderInstallationError('An installation file has an invalid name.', 409);
        if (entries.length >= 100_000) throw new LoaderInstallationError('The server has too many files to snapshot safely.', 409);
        const absolute = path.join(directory.anchored, name);
        const relative = prefix ? `${prefix}/${name}` : name;
        const info = await lstat(absolute);
        if (info.isDirectory()) {
          const child = await this.openDirectory(absolute);
          try {
            if (!sameFile(info, await child.handle.stat())) throw new LoaderInstallationError('An installation folder changed during inspection.', 409);
            entries.push({ relative, directory: true, info });
            await walk(child, relative, depth + 1);
          } finally { await child.handle.close(); }
        } else { regular(info); entries.push({ relative, directory: false, info }); }
      }
    };
    const directory = await this.openDirectory(root);
    try { await walk(directory, '', 0); } finally { await directory.handle.close(); }
    return entries;
  }

  private sameInventory(left: TreeItem[], right: TreeItem[]): boolean {
    return left.length === right.length && left.every((entry, index) => {
      const other = right[index]!;
      return entry.relative === other.relative && sameFile(entry.info, other.info) && entry.info.size === other.info.size && entry.info.mtimeMs === other.info.mtimeMs && entry.info.ctimeMs === other.info.ctimeMs;
    });
  }

  private async copyEntry(source: string, destination: string, entry: TreeItem): Promise<void> {
    const segments = entry.relative.split('/');
    const target = path.join(destination, ...segments);
    if (entry.directory) {
      await mkdir(target, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
      if (!(await lstat(target)).isDirectory() || (await lstat(target)).isSymbolicLink()) throw new LoaderInstallationError('An installer-created path conflicts with a preserved folder.', 409);
      return;
    }
    let directory = await this.openDirectory(source);
    let input: FileHandle | undefined;
    let output: FileHandle | undefined;
    try {
      for (const segment of segments.slice(0, -1)) {
        const next = await this.openDirectory(path.join(directory.anchored, segment));
        await directory.handle.close();
        directory = next;
      }
      input = await open(path.join(directory.anchored, segments.at(-1)!), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = await input.stat();
      regular(before);
      if (!sameFile(before, entry.info) || before.size !== entry.info.size || before.ctimeMs !== entry.info.ctimeMs) throw new LoaderInstallationError('Server data changed while preparing its snapshot.', 409);
      output = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      regular(await output.stat());
      await output.truncate(0);
      const buffer = Buffer.alloc(64 * 1024);
      let copied = 0;
      while (copied < before.size) {
        const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, before.size - copied), copied);
        if (!bytesRead) throw new LoaderInstallationError('Server data changed while it was copied.', 409);
        await output.writeFile(buffer.subarray(0, bytesRead));
        copied += bytesRead;
      }
      const after = await input.stat();
      regular(after);
      if (after.size !== before.size || after.ctimeMs !== before.ctimeMs) throw new LoaderInstallationError('Server data changed while it was copied.', 409);
      await output.sync();
      await utimes(target, before.atime, before.mtime);
    } finally { await input?.close(); await output?.close(); await directory.handle.close(); }
  }

  private async assertLaunchFile(directory: string, relative: string): Promise<void> {
    const info = await lstat(path.join(directory, relative));
    regular(info);
    if (!info.size) throw new LoaderInstallationError('The official installer produced an empty launcher.', 502);
  }
}
