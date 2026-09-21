import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, opendir, rename, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { InstalledServer } from './loader-installation.js';

const runtimeRoots = new Set(['libraries', 'versions', '.fabric', '.quilt']);
const runtimeFiles = new Set(['installation.json', 'fabric-server-launcher.properties', 'quilt-server-launcher.properties', 'user_jvm_args.txt', 'unix_args.txt', 'win_args.txt', 'installer.jar.log']);
const runtimeExtension = /\.(?:jar|class|args|sh|bat|cmd|ps1|so|dll|dylib)$/i;
const maximumManifestBytes = 8 * 1024 ** 2;
const maximumDescriptorBytes = 16 * 1024;
const maximumScanMilliseconds = 120_000;
const maximumLimits = { files: 10_000, bytes: 8 * 1024 ** 3, fileBytes: 512 * 1024 ** 2, depth: 24, entries: 50_000 };
const versionSchema = z.string().regex(/^[0-9][A-Za-z0-9.+-]{0,79}$/);
const descriptorSchema = z.object({
  minecraftVersion: versionSchema,
  loader: z.enum(['Fabric', 'Forge', 'NeoForge', 'Quilt']),
  loaderVersion: versionSchema,
  javaMajor: z.union([z.literal(8), z.literal(17), z.literal(21), z.literal(25)]),
  launchArgs: z.array(z.string().min(1).max(240)).min(1).max(2),
  installedAt: z.string().datetime(),
}).strict();
const fileSchema = z.object({ path: z.string().min(1).max(1024), size: z.number().int().nonnegative().max(maximumLimits.fileBytes), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const manifestSchema = z.object({
  version: z.literal(1), identity: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  installation: descriptorSchema,
  files: z.array(fileSchema).min(2).max(maximumLimits.files),
  directories: z.array(z.string().min(1).max(1024)).max(maximumLimits.entries),
}).strict();
type RuntimeManifest = z.infer<typeof manifestSchema>;
type RuntimeFile = z.infer<typeof fileSchema>;
type Limits = typeof maximumLimits;
interface Directory { handle: FileHandle; absolute: string; identity: Stats }
interface Scan { installation: InstalledServer; files: RuntimeFile[]; directories: string[] }

export interface RuntimeIntegrityOptions {
  directory: string;
  writableDirectory: string;
  trustDirectory: string;
  identity: string;
  limits?: Partial<Limits>;
}

export type RuntimePathClass = 'protected' | 'mutable-cache' | 'unmanaged' | 'unsupported';

export class RuntimeIntegrityError extends Error {
  readonly statusCode = 409;
}

function reject(message: string): never { throw new RuntimeIntegrityError(message); }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function sameFile(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }
function sameContents(left: Stats, right: Stats): boolean { return sameFile(left, right) && left.size === right.size && left.ctimeMs === right.ctimeMs && left.mtimeMs === right.mtimeMs; }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function contained(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function safeRelative(relative: string): string[] {
  const parts = relative.split('/');
  if (!relative || Buffer.byteLength(relative) > 1024 || parts.some(part => !part || part === '.' || part === '..' || Buffer.byteLength(part) > 255 || /[\\\x00-\x1f\x7f:]/.test(part))) reject('A runtime file has an unsafe relative path.');
  return parts;
}
function protectedName(name: string): boolean { return runtimeRoots.has(name) || runtimeFiles.has(name) || runtimeExtension.test(name); }
export function classifyRuntimePath(relative: string): RuntimePathClass {
  const parts = safeRelative(relative);
  if (parts[0] === '.fabric' && parts.length > 1) {
    if (parts[1] === 'server') return 'protected';
    if (parts[1] === 'processedMods') return 'mutable-cache';
    return 'unsupported';
  }
  if (parts.length === 1 ? protectedName(parts[0]!) : runtimeRoots.has(parts[0]!)) return 'protected';
  return 'unmanaged';
}
function protectedPath(relative: string): boolean {
  return classifyRuntimePath(relative) === 'protected';
}
function regular(info: Stats): void {
  if (!info.isFile() || info.nlink !== 1) reject('Runtime files must be regular files without symbolic or hard links.');
}
function anchor(directory: Directory): string { return process.platform === 'linux' ? `/proc/self/fd/${directory.handle.fd}` : directory.absolute; }
async function assertDirectory(directory: Directory): Promise<void> {
  const current = await lstat(directory.absolute);
  if (!current.isDirectory() || !sameFile(current, directory.identity)) reject('A runtime directory changed during integrity verification.');
}
async function childDirectory(parent: Directory, name: string): Promise<Directory> {
  safeRelative(name);
  await assertDirectory(parent);
  const candidate = path.join(anchor(parent), name);
  const before = await lstat(candidate);
  if (!before.isDirectory()) reject('Runtime directories cannot be links or special files.');
  const handle = await open(candidate, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const identity = await handle.stat();
    if (!identity.isDirectory() || !sameFile(before, identity)) reject('A runtime directory changed while it was opened.');
    await assertDirectory(parent);
    const directory = { handle, absolute: path.join(parent.absolute, name), identity };
    await assertDirectory(directory);
    return directory;
  } catch (error) { await handle.close(); throw error; }
}
async function openDirectory(absolute: string): Promise<Directory> {
  let current: Directory;
  const handle = await open(path.parse(absolute).root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  current = { handle, absolute: path.parse(absolute).root, identity: await handle.stat() };
  try {
    for (const part of absolute.slice(current.absolute.length).split(path.sep).filter(Boolean)) {
      const next = await childDirectory(current, part);
      await current.handle.close();
      current = next;
    }
    return current;
  } catch (error) { await current.handle.close(); throw error; }
}
function launchFile(installed: InstalledServer): string {
  const [first, second] = installed.launchArgs;
  const coordinate = `${installed.minecraftVersion}-${installed.loaderVersion}`;
  let valid = false;
  if (installed.loader === 'Fabric') valid = installed.launchArgs.length === 2 && first === '-jar' && second === 'fabric-server-launch.jar';
  if (installed.loader === 'Quilt') valid = installed.launchArgs.length === 2 && first === '-jar' && second === 'quilt-server-launch.jar';
  if (installed.loader === 'Forge') {
    valid = [coordinate, `${coordinate}-${installed.minecraftVersion}`].some(version => installed.launchArgs.length === 1 && first === `@libraries/net/minecraftforge/forge/${version}/unix_args.txt`
      || installed.launchArgs.length === 2 && first === '-jar' && [`forge-${version}.jar`, `forge-${version}-universal.jar`, `minecraftforge-universal-${version}.jar`].includes(second!));
  }
  if (installed.loader === 'NeoForge') valid = installed.launchArgs.length === 1 && (first === `@libraries/net/neoforged/neoforge/${installed.loaderVersion}/unix_args.txt`
    || installed.minecraftVersion === '1.20.1' && first === `@libraries/net/neoforged/forge/${coordinate}/unix_args.txt`);
  if (!valid) reject('The runtime descriptor contains an unsupported launch command.');
  const relative = first === '-jar' ? second! : first!.slice(1);
  safeRelative(relative);
  if (!protectedPath(relative)) reject('The runtime launcher is outside the protected installation.');
  return relative;
}
function parseDescriptor(contents: Buffer): InstalledServer {
  if (contents.length > maximumDescriptorBytes) reject('The runtime installation descriptor is too large.');
  try {
    const installed = descriptorSchema.parse(JSON.parse(contents.toString('utf8')));
    launchFile(installed);
    return installed;
  } catch (error) { if (error instanceof RuntimeIntegrityError) throw error; reject('The runtime installation descriptor is invalid.'); }
}

export class RuntimeIntegrity {
  private readonly directory: string;
  private readonly writableDirectory: string;
  private readonly trustDirectory: string;
  private readonly identity: string;
  private readonly limits: Limits;
  private pending: Promise<void> = Promise.resolve();

  constructor(options: RuntimeIntegrityOptions) {
    for (const value of [options.directory, options.writableDirectory, options.trustDirectory]) if (!path.isAbsolute(value) || value.includes('\0')) reject('Integrity storage requires absolute dedicated paths.');
    this.directory = path.normalize(options.directory);
    this.writableDirectory = path.normalize(options.writableDirectory);
    this.trustDirectory = path.normalize(options.trustDirectory);
    if (![this.directory, this.writableDirectory, this.trustDirectory].every(value => value !== path.parse(value).root)) reject('Integrity storage cannot use a filesystem root.');
    if (!contained(this.writableDirectory, this.directory)) reject('The Minecraft installation must be inside its declared writable data directory.');
    if (contained(this.writableDirectory, this.trustDirectory) || contained(this.trustDirectory, this.writableDirectory)) reject('Runtime trust manifests must be outside Minecraft-writable data.');
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(options.identity)) reject('Use a controller-owned runtime identity.');
    this.identity = options.identity;
    this.limits = { ...maximumLimits, ...options.limits };
    for (const key of Object.keys(maximumLimits) as Array<keyof Limits>) {
      if (!Number.isSafeInteger(this.limits[key]) || this.limits[key] < 1 || this.limits[key] > maximumLimits[key]) reject('Runtime integrity limits are invalid.');
    }
  }

  async seal(): Promise<InstalledServer> {
    return this.exclusive(async () => {
      const storage = await this.storage(true);
      let directory: Directory | undefined;
      const temporary = `.seal-${randomUUID()}.json`;
      try {
        directory = await openDirectory(this.directory);
        const snapshot = await this.stableScan(directory);
        const manifest: RuntimeManifest = { version: 1, identity: this.identity, ...snapshot };
        const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
        if (bytes.length > maximumManifestBytes) reject('The runtime integrity manifest is too large.');
        const output = await open(path.join(anchor(storage), temporary), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await output.writeFile(bytes); await output.sync(); }
        finally { await output.close(); }
        await assertDirectory(storage);
        await rename(path.join(anchor(storage), temporary), path.join(anchor(storage), `${this.identity}.json`));
        await storage.handle.sync();
        return snapshot.installation;
      } finally {
        await unlink(path.join(anchor(storage), temporary)).catch(() => undefined);
        await directory?.handle.close();
        await storage.handle.close();
      }
    });
  }

  async verify(): Promise<InstalledServer> {
    return this.exclusive(async () => {
      const storage = await this.storage(false);
      let directory: Directory | undefined;
      try {
        const manifest = await this.readManifest(storage);
        directory = await openDirectory(this.directory);
        const actual = await this.stableScan(directory);
        if (JSON.stringify(actual) !== JSON.stringify({ installation: manifest.installation, files: manifest.files, directories: manifest.directories })) reject('Minecraft runtime integrity verification failed. Reinstall this server from a trusted source before starting it.');
        return manifest.installation;
      } finally { await directory?.handle.close(); await storage.handle.close(); }
    });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.pending;
    let release!: () => void;
    this.pending = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await operation(); }
    catch (error) {
      if (error instanceof RuntimeIntegrityError) throw error;
      if (missing(error)) reject('A trusted runtime manifest or installation file is missing. Reinstall this server before starting it.');
      if (['ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) reject('Integrity storage and runtime paths cannot contain symbolic links.');
      throw error;
    } finally { release(); }
  }

  private async storage(create: boolean): Promise<Directory> {
    const parent = await openDirectory(path.dirname(this.trustDirectory));
    try {
      if (create) await mkdir(path.join(anchor(parent), path.basename(this.trustDirectory)), { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
      const directory = await childDirectory(parent, path.basename(this.trustDirectory));
      const owner = process.getuid?.();
      if (owner === undefined || directory.identity.uid !== owner || (directory.identity.mode & 0o077) !== 0) { await directory.handle.close(); reject('Runtime trust storage must be private to the controller account.'); }
      return directory;
    } finally { await parent.handle.close(); }
  }

  private async readManifest(storage: Directory): Promise<RuntimeManifest> {
    const result = await this.readFile(storage, `${this.identity}.json`, maximumManifestBytes, true);
    if (result.info.uid !== process.getuid?.() || (result.info.mode & 0o077) !== 0) reject('The runtime trust manifest is not private to the controller account.');
    let manifest: RuntimeManifest;
    try { manifest = manifestSchema.parse(JSON.parse(result.contents!.toString('utf8'))); }
    catch { reject('The trusted runtime manifest is invalid.'); }
    if (manifest.identity !== this.identity) reject('The trusted runtime manifest belongs to a different server.');
    launchFile(manifest.installation);
    const files = manifest.files.map(file => file.path);
    const directories = manifest.directories;
    if (new Set(files).size !== files.length || new Set(directories).size !== directories.length
      || files.some(relative => !protectedPath(relative)) || directories.some(relative => !runtimeRoots.has(safeRelative(relative)[0]!) || classifyRuntimePath(relative) !== 'protected')
      || files.some(relative => directories.includes(relative))
      || JSON.stringify([...files].sort(compare)) !== JSON.stringify(files) || JSON.stringify([...directories].sort(compare)) !== JSON.stringify(directories)) reject('The trusted runtime manifest contains invalid paths.');
    return manifest;
  }

  private async stableScan(directory: Directory): Promise<Scan> {
    const deadline = Date.now() + maximumScanMilliseconds;
    const first = await this.scan(directory, deadline);
    const second = await this.scan(directory, deadline);
    if (JSON.stringify(first) !== JSON.stringify(second)) reject('The runtime changed during integrity verification.');
    return second;
  }

  private async scan(directory: Directory, deadline: number): Promise<Scan> {
    const files: RuntimeFile[] = [];
    const directories: string[] = [];
    let installation: InstalledServer | undefined;
    let bytes = 0;
    let entries = 0;
    const walk = async (current: Directory, prefix: string, depth: number) => {
      if (depth > this.limits.depth) reject('The runtime installation has too many nested directories.');
      await assertDirectory(current);
      const before = await current.handle.stat();
      const iterator = await opendir(anchor(current));
      for await (const entry of iterator) {
        if (++entries > this.limits.entries || Date.now() > deadline) reject('The runtime integrity scan exceeded its safety limits.');
        if (!prefix && !protectedName(entry.name)) continue;
        const relative = `${prefix}${entry.name}`;
        safeRelative(relative);
        const classification = classifyRuntimePath(relative);
        if (classification === 'unsupported') reject('The runtime contains an unsupported loader cache. Reinstall it before starting.');
        if (classification === 'mutable-cache') {
          const cache = await lstat(path.join(anchor(current), entry.name));
          if (!cache.isDirectory()) reject('Mutable loader caches cannot be links or files.');
          continue;
        }
        const info = await lstat(path.join(anchor(current), entry.name));
        if (info.isDirectory()) {
          if (!runtimeRoots.has(relative.split('/')[0]!)) reject('A runtime executable file was replaced with a directory.');
          const child = await childDirectory(current, entry.name);
          try { directories.push(relative); await walk(child, `${relative}/`, depth + 1); }
          finally { await child.handle.close(); }
        } else {
          regular(info);
          if (!prefix && runtimeRoots.has(entry.name)) reject('A runtime library directory was replaced with a file.');
          bytes += info.size;
          if (files.length >= this.limits.files || bytes > this.limits.bytes || info.size > this.limits.fileBytes) reject('The runtime installation exceeds its integrity size limits.');
          const result = await this.readFile(current, entry.name, relative === 'installation.json' ? maximumDescriptorBytes : this.limits.fileBytes, relative === 'installation.json', deadline);
          if (!sameContents(info, result.info)) reject('A runtime file changed during integrity verification.');
          files.push({ path: relative, size: result.info.size, sha256: result.sha256 });
          if (relative === 'installation.json') installation = parseDescriptor(result.contents!);
        }
      }
      const after = await current.handle.stat();
      await assertDirectory(current);
      if (before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) reject('A runtime directory changed during integrity verification.');
    };
    await walk(directory, '', 0);
    if (!installation) reject('A trusted installation descriptor is required before sealing or starting a runtime.');
    if (!files.some(file => file.path === launchFile(installation!))) reject('The runtime launcher is missing from the sealed installation.');
    return { installation, files: files.sort((left, right) => compare(left.path, right.path)), directories: directories.sort(compare) };
  }

  private async readFile(directory: Directory, name: string, limit: number, retain = false, deadline = Date.now() + maximumScanMilliseconds) {
    await assertDirectory(directory);
    const candidate = path.join(anchor(directory), name);
    const before = await lstat(candidate);
    regular(before);
    if (before.size > limit) reject('A runtime integrity file exceeds its size limit.');
    const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      regular(info);
      if (!sameContents(before, info)) reject('A runtime file changed while it was opened.');
      const hash = createHash('sha256');
      const contents = retain ? Buffer.alloc(info.size) : undefined;
      const chunk = Buffer.alloc(Math.min(64 * 1024, Math.max(1, info.size)));
      let offset = 0;
      while (offset < info.size) {
        if (Date.now() > deadline) reject('The runtime integrity scan timed out.');
        const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, info.size - offset), offset);
        if (!bytesRead) reject('A runtime file changed while it was read.');
        hash.update(chunk.subarray(0, bytesRead));
        contents?.set(chunk.subarray(0, bytesRead), offset);
        offset += bytesRead;
      }
      const after = await handle.stat();
      regular(after);
      const current = await lstat(candidate);
      regular(current);
      if (!sameContents(info, after) || !sameContents(info, current)) reject('A runtime file changed while it was read.');
      await assertDirectory(directory);
      return { info, sha256: hash.digest('hex'), contents };
    } finally { await handle.close(); }
  }
}
