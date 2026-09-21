import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, statfs, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { copyVerifiedFile, downloadArtifact } from './download.js';
import { readInstalled, type InstalledServer } from './loader-installation.js';
import { PlayerCountMonitor, queryPlayerCount } from './player-count.js';
import type { RuntimeSandbox } from './runtime-sandbox.js';
import { assertSandboxServerProperties, readServerProperties } from './server-properties.js';
import { BackupObjects, maximumBackupManifestBytes, validateBackupObjectManifest } from './backup-objects.js';

/** A mod to stage: either a CurseForge CDN download or a verified copy from the host's CurseForge App profile. */
export interface ModDownload { modId: number; fileId: number; fileName: string; url?: string; localPath?: string; hashes: { algo: number; value: string }[]; fileLength: number }
export type MaintenanceAction = 'start' | 'stop' | 'restart' | 'backup' | 'update' | 'sync-profile';
const describeAction = (action: MaintenanceAction) => action === 'sync-profile' ? 'App pack sync' : `Server ${action}`;
type ServerState = 'not-installed' | 'stopped' | 'starting' | 'running' | 'stopping' | 'updating' | 'failed';
const backupItems = ['world', 'mods', 'config', 'defaultconfigs', 'kubejs', 'scripts', 'datapacks', 'resourcepacks', 'shaderpacks', 'server.properties', 'ops.json', 'whitelist.json', 'banned-players.json', 'banned-ips.json', 'installed-mods.json', 'installation.json', 'eula.txt'];
const maximumBackups = 6;
const checkpointInterval = 15 * 60_000;
const automaticBackupInterval = 6 * 60 * 60_000;
const reservedDiskBytes = 256n * 1024n ** 2n;
type BackupKind = 'manual' | 'automatic';
type RetainedSnapshot = { name: string; createdAt: string; device: bigint; inode: bigint };
export interface MinecraftDependencies {
  launch: (command: string, arguments_: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;
  download: typeof downloadArtifact;
  copy: typeof copyVerifiedFile;
  availableBytes: (directory: string) => Promise<bigint>;
  removeDirectory: (directory: string) => Promise<void>;
  now: () => number;
  queryPlayers: typeof queryPlayerCount;
}
const defaultDependencies: MinecraftDependencies = {
  launch: (command, arguments_, options) => spawn(command, arguments_, { ...options, shell: false, stdio: 'pipe' }),
  download: downloadArtifact,
  copy: copyVerifiedFile,
  availableBytes: async directory => { const space = await statfs(directory, { bigint: true }); return space.bavail * space.bsize; },
  removeDirectory: directory => rm(directory, { recursive: true, force: true }),
  now: Date.now,
  queryPlayers: queryPlayerCount,
};

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function inspectSnapshot(source: string): Promise<bigint> {
  const metadata = await lstat(source, { bigint: true });
  if (metadata.isSymbolicLink()) throw new Error(`Backups do not follow symbolic links: ${path.basename(source)}.`);
  if (metadata.isFile()) {
    if (metadata.nlink !== 1n) throw new Error('Backups do not include files with additional hard links.');
    return metadata.size;
  }
  if (!metadata.isDirectory()) throw new Error(`Backups require regular files or directories: ${path.basename(source)}.`);
  let bytes = 0n;
  for (const entry of await readdir(source)) bytes += await inspectSnapshot(path.join(source, entry));
  return bytes;
}

async function copySnapshot(source: string, destination: string) {
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
    filter: async current => {
      const info = await lstat(current);
      if (info.isSymbolicLink() || info.isFile() && info.nlink !== 1 || !info.isDirectory() && !info.isFile()) throw new Error('A linked or unsupported file appeared while copying the backup.');
      return true;
    },
  });
}

export class MinecraftServer {
  private readonly playerCounts: PlayerCountMonitor;
  private installed?: InstalledServer;
  private process?: ChildProcessWithoutNullStreams;
  private state: ServerState = 'not-installed';
  private startedAt?: number;
  private lastBackup: string | null = null;
  private busy = false;
  private lastRestartAt = 0;
  private lines: string[] = [];
  /** The most recent bad exit. It stays visible after a rollback restart so friends can read the crash log. */
  private failure: { at: string; message: string; exitCode: number | null; recoveredAt?: string } | null = null;
  private shuttingDown = false;
  private readonly dependencies: MinecraftDependencies;
  private readonly backupObjects: BackupObjects;
  constructor(private readonly options: { directory: string; java: string; javaPaths?: Record<number, string>; loaderVersion?: string; memoryMb: number; version: string; address: string; activity: (message: string) => void; onLog?: (line: string) => void; requireOnlineMode?: boolean; sandbox?: Pick<RuntimeSandbox, 'verify' | 'launch'>; backupObjectsDirectory?: string; startTimeoutMs?: number }, dependencies: Partial<MinecraftDependencies> = {}) {
    this.dependencies = { ...defaultDependencies, ...dependencies };
    this.playerCounts = new PlayerCountMonitor(this.dependencies.queryPlayers, this.dependencies.now);
    this.backupObjects = new BackupObjects(options.backupObjectsDirectory ?? path.join(options.directory, '..', 'backup-objects'));
  }

  async initialize() {
    if (this.process) throw new Error('Stop Minecraft before reloading its installation.');
    this.installed = await readInstalled(this.options.directory);
    const launcher = this.installed ? this.installed.launchArgs[0] === '-jar' ? this.installed.launchArgs[1]! : this.installed.launchArgs[0]!.slice(1) : 'fabric-server-launch.jar';
    try { await access(path.join(this.options.directory, launcher)); this.state = 'stopped'; } catch { this.state = 'not-installed'; }
    this.lastBackup = null;
    const backupsDirectory = await this.backupRoot(false);
    if (backupsDirectory) for (const entry of await readdir(backupsDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const manifest = await this.readBackupManifest(path.join(backupsDirectory, entry.name));
      const legacyTimestamp = entry.name.replace(/^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2}\.\d{3}Z).*$/, '$1$2:$3:$4');
      const timestamp = typeof manifest?.createdAt === 'string' ? manifest.createdAt : legacyTimestamp;
      if (Number.isFinite(Date.parse(timestamp)) && (!this.lastBackup || Date.parse(timestamp) > Date.parse(this.lastBackup))) this.lastBackup = new Date(timestamp).toISOString();
    }
  }
  status() { return { state: this.state, version: this.installed?.minecraftVersion ?? this.options.version, loader: this.installed?.loader ?? 'Fabric', loaderVersion: this.installed?.loaderVersion ?? this.options.loaderVersion ?? '0.19.5', address: this.options.address, uptimeSeconds: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0, lastBackup: this.lastBackup, busy: this.busy, failure: this.failure, players: this.playerCounts.read(this.state === 'running', this.installed?.minecraftVersion ?? this.options.version) }; }
  logs() { return [...this.lines]; }
  appendLog(line: string) { this.log(line); }
  private recordFailure(message: string, exitCode: number | null = null) { this.failure = { at: new Date().toISOString(), message, exitCode }; }

  /** The newest Minecraft crash report, read directly from the server folder and bounded in size. */
  async latestCrashReport(): Promise<{ file: string; createdAt: string; lines: string[] } | null> {
    const directory = path.join(this.options.directory, 'crash-reports');
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const name = entries.filter(entry => entry.isFile() && /^crash-[\w.-]+\.txt$/.test(entry.name)).map(entry => entry.name).sort().at(-1);
    if (!name) return null;
    const file = path.join(directory, name);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    const handle = await open(file, 'r');
    try {
      const { bytesRead, buffer } = await handle.read(Buffer.alloc(64 * 1024), 0, 64 * 1024, 0);
      return { file: name, createdAt: info.mtime.toISOString(), lines: buffer.subarray(0, bytesRead).toString('utf8').split('\n').slice(0, 400) };
    } finally { await handle.close(); }
  }
  private log(line: string) { this.lines.push(line.slice(0, 2000)); if (this.lines.length > 250) this.lines.shift(); }

  async action(action: MaintenanceAction, downloads?: () => Promise<ModDownload[]>) {
    if (this.shuttingDown) throw Object.assign(new Error('The controller is shutting down.'), { statusCode: 503 });
    if (this.busy) throw Object.assign(new Error('A server operation is already running.'), { statusCode: 409 });
    if (action === 'restart' && Date.now() - this.lastRestartAt < 120_000) throw Object.assign(new Error('Wait two minutes between restarts.'), { statusCode: 429 });
    this.busy = true;
    let snapshot: string | undefined;
    try {
      if (action === 'start') await this.start();
      if (action === 'stop') await this.stop();
      if (action === 'restart') { this.lastRestartAt = Date.now(); await this.stop(); await this.start(); }
      if (action === 'backup') {
        snapshot = await this.snapshotAndResume('manual');
      }
      if (action === 'update' || action === 'sync-profile') { if (!downloads) throw new Error('The update source is not configured.'); await this.update(await downloads()); }
      this.options.activity(`${describeAction(action)} completed.`);
      return snapshot;
    } catch (error) {
      this.options.activity(`${describeAction(action)} failed: ${error instanceof Error ? error.message : 'Unknown failure'}`);
      throw error;
    } finally { this.busy = false; }
  }

  automaticBackupDue(intervalMs = automaticBackupInterval) {
    return this.lastBackup === null || this.dependencies.now() - Date.parse(this.lastBackup) >= intervalMs;
  }

  async checkpoint(): Promise<string | undefined> {
    if (this.process || !['stopped', 'failed'].includes(this.state) || !this.automaticBackupDue(checkpointInterval)) return undefined;
    return this.automaticBackup();
  }

  async automaticBackup(): Promise<string | undefined> {
    if (this.busy || this.shuttingDown || !['stopped', 'failed', 'running'].includes(this.state)) return undefined;
    this.busy = true;
    try {
      if (this.process) {
        const players = await this.dependencies.queryPlayers(this.installed?.minecraftVersion ?? this.options.version, AbortSignal.timeout(2500)).catch(() => undefined);
        if (players?.online !== 0 || this.state !== 'running' || this.shuttingDown) return undefined;
      }
      return await this.snapshotAndResume('automatic');
    } catch (error) {
      this.options.activity(`Automatic backup failed: ${error instanceof Error ? error.message : 'Unknown failure'}`);
      throw error;
    } finally { this.busy = false; }
  }

  private async snapshotAndResume(kind: BackupKind) {
    const running = Boolean(this.process);
    await this.stop();
    let snapshot: string;
    try { snapshot = await this.backup(kind); } catch (error) {
      await this.resumeAfterFailure(running, error);
      throw error;
    }
    if (running && !this.shuttingDown) await this.start();
    return snapshot;
  }

  private async start() {
    if (this.shuttingDown) throw new Error('The controller is shutting down.');
    if (this.process) throw Object.assign(new Error('The server is already running.'), { statusCode: 409 });
    if (this.state === 'not-installed') throw new Error('Run npm run bootstrap to install the Minecraft server.');
    try { this.installed = this.options.sandbox ? await this.options.sandbox.verify() : await readInstalled(this.options.directory); }
    catch (error) {
      this.state = 'failed';
      this.recordFailure(`Runtime integrity verification failed: ${(error as Error).message}`);
      throw error;
    }
    const eula = await readFile(path.join(this.options.directory, 'eula.txt'), 'utf8').catch(() => '');
    if (!/^eula=true\s*$/m.test(eula)) throw new Error('The owner must accept the Minecraft EULA locally before starting the server.');
    if (this.options.requireOnlineMode) {
      assertSandboxServerProperties(await readServerProperties(path.join(this.options.directory, 'server.properties')));
    }
    const java = this.installed ? this.options.javaPaths?.[this.installed.javaMajor] : this.options.java;
    if (!java) throw new Error(`Java ${this.installed!.javaMajor} is not configured for this server installation.`);
    const sandbox = this.options.sandbox ? await this.options.sandbox.launch(java, this.installed!) : undefined;
    this.state = 'starting';
    const child = this.dependencies.launch(sandbox?.command ?? java, [...(sandbox?.prefix ?? []), ...(sandbox?.javaArguments ?? []), `-Xms512M`, `-Xmx${this.options.memoryMb}M`, ...(this.installed?.launchArgs ?? ['-jar', 'fabric-server-launch.jar']), 'nogui'], {
      cwd: this.options.directory,
      env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', JAVA_HOME: path.resolve(java, '..', '..') },
    });
    this.process = child;
    this.startedAt = undefined;
    let partial = '';
    const receive = (chunk: Buffer) => {
      partial += chunk.toString();
      const lines = partial.split('\n'); partial = lines.pop() ?? '';
      if (partial.length > 16_384) partial = partial.slice(-16_384);
      for (const line of lines) {
        this.log(line);
        this.options.onLog?.(line);
        if (this.process === child && this.state === 'starting' && /Done \([\d.,]+s\)!/.test(line)) {
          this.state = 'running'; this.startedAt = Date.now();
          if (this.failure && !this.failure.recoveredAt) this.failure = { ...this.failure, recoveredAt: new Date().toISOString() };
        }
      }
    };
    child.stdout.on('data', receive); child.stderr.on('data', receive);
    child.stdin.on('error', error => this.log(`Minecraft input closed: ${error.message}`));
    child.on('error', error => { this.log(error.message); if (this.process === child) { this.state = 'failed'; this.recordFailure(`Minecraft could not be launched: ${error.message}`); this.process = undefined; } });
    child.on('exit', code => {
      this.log(`Minecraft exited with code ${code}.`);
      if (this.process === child) {
        const clean = this.state === 'stopping' || code === 0;
        this.state = clean ? 'stopped' : 'failed';
        if (!clean) this.recordFailure(this.startedAt ? `Minecraft crashed while running (exit code ${code}).` : `Minecraft stopped during startup (exit code ${code}).`, code);
        this.process = undefined; this.startedAt = undefined;
      }
    });
    // A first boot in a container that shares its CPUs with a build can take
    // several minutes, so the readiness limit is generous and configurable.
    const startTimeoutMs = this.options.startTimeoutMs ?? 600_000;
    const minutes = Math.max(1, Math.round(startTimeoutMs / 60_000));
    const deadline = Date.now() + startTimeoutMs;
    while (Date.now() < deadline) {
      if (this.status().state === 'running') return;
      if (!this.process) throw new Error('Minecraft could not start. Check the server log.');
      await delay(500);
    }
    await this.stop();
    this.state = 'failed';
    this.recordFailure(`Minecraft did not become ready within ${minutes} minutes and was stopped.`);
    throw new Error(`Minecraft did not become ready within ${minutes} minutes.`);
  }

  async shutdown() { this.shuttingDown = true; await this.stop(); }
  private async stop() {
    const child = this.process;
    if (!child) return;
    this.state = 'stopping';
    if (child.stdin.writable && !child.stdin.destroyed) {
      child.stdin.write('stop\n', error => { if (error && this.process === child) child.kill('SIGTERM'); });
    } else child.kill('SIGTERM');
    const deadline = Date.now() + 60_000;
    while (this.process === child && Date.now() < deadline) await delay(250);
    if (this.process === child) {
      child.kill('SIGTERM');
      const termDeadline = Date.now() + 15_000;
      while (this.process === child && Date.now() < termDeadline) await delay(250);
      if (this.process === child) throw new Error('Minecraft did not stop cleanly. No files were changed.');
    }
  }

  private async backup(kind: BackupKind = 'manual') {
    if (this.process) throw new Error('Stop Minecraft before taking a consistent backup.');
    const backupsDirectory = (await this.backupRoot(true))!;
    const retained = (await readdir(backupsDirectory, { withFileTypes: true })).filter(entry => entry.isDirectory());
    const snapshots = (await Promise.all(retained.map(entry => this.retainedSnapshot(backupsDirectory, entry.name)))).filter((entry): entry is RetainedSnapshot => Boolean(entry));
    const items: string[] = [];
    for (const item of backupItems) {
      const source = path.join(this.options.directory, item);
      if (await exists(source)) { await inspectSnapshot(source); items.push(item); }
    }
    if (await this.dependencies.availableBytes(backupsDirectory) < reservedDiskBytes + BigInt(maximumBackupManifestBytes)) {
      throw new Error('Not enough free disk space for a backup and recovery reserve. No backup was created.');
    }
    const createdAt = new Date(this.dependencies.now()).toISOString();
    const stamp = `${createdAt.replaceAll(':', '-')}-${randomUUID()}`;
    const backupDirectory = path.join(backupsDirectory, stamp);
    const staging = path.join(backupsDirectory, `.incomplete-${stamp}`);
    await mkdir(staging, { mode: 0o700 });
    try {
      const objects = await this.backupObjects.capture(this.options.directory, items);
      const manifest = JSON.stringify({ format: 2, createdAt, kind, items, ...objects });
      if (Buffer.byteLength(manifest) > maximumBackupManifestBytes) throw new Error('The backup manifest is too large to save safely.');
      if (await this.dependencies.availableBytes(backupsDirectory) < reservedDiskBytes + BigInt(Buffer.byteLength(manifest))) throw new Error('Not enough free disk space to commit the backup metadata safely. Previous backups were preserved.');
      const handle = await open(path.join(staging, 'backup.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(manifest); await handle.sync(); } finally { await handle.close(); }
      await rename(staging, backupDirectory);
      const parent = await open(backupsDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await parent.sync(); } finally { await parent.close(); }
    } catch (error) {
      await this.removeTemporary(staging);
      throw error;
    }
    this.lastBackup = createdAt;
    this.options.activity(`Backup saved: ${stamp}`);
    await this.pruneSnapshots(backupsDirectory, snapshots, stamp);
    return backupDirectory;
  }

  private async backupRoot(create: boolean): Promise<string | undefined> {
    const server = path.resolve(this.options.directory);
    const serverInfo = await lstat(server).catch(error => { if (!create && error.code === 'ENOENT') return undefined; throw error; });
    if (!serverInfo) return undefined;
    const parent = await realpath(path.dirname(server));
    if (!serverInfo.isDirectory() || serverInfo.isSymbolicLink() || await realpath(server) !== path.join(parent, path.basename(server))) throw new Error('The Minecraft directory must be a real directory without symbolic links.');
    const directory = path.join(parent, 'backups');
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!info) return undefined;
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) throw new Error('The backup directory must be a real directory without symbolic links.');
    return directory;
  }

  private async readBackupManifest(directory: string): Promise<Record<string, unknown> | undefined> {
    let handle;
    try {
      if (!(await lstat(directory)).isDirectory()) return undefined;
      handle = await open(path.join(directory, 'backup.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > maximumBackupManifestBytes) return undefined;
      const bytes = Buffer.alloc(info.size);
      let position = 0;
      while (position < bytes.length) {
        const { bytesRead } = await handle.read(bytes, position, bytes.length - position, position);
        if (!bytesRead) return undefined;
        position += bytesRead;
      }
      const current = await handle.stat();
      if (current.size !== info.size || current.ctimeMs !== info.ctimeMs || current.nlink !== 1) return undefined;
      const manifest: unknown = JSON.parse(bytes.toString('utf8'));
      return manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest as Record<string, unknown> : undefined;
    } catch { return undefined; } finally { await handle?.close(); }
  }

  private async retainedSnapshot(directory: string, name: string): Promise<RetainedSnapshot | undefined> {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z(?:-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?$/.test(name)) return undefined;
    const snapshot = path.join(directory, name);
    const info = await lstat(snapshot, { bigint: true }).catch(() => undefined);
    if (!info?.isDirectory() || info.isSymbolicLink() || await realpath(snapshot) !== snapshot) return undefined;
    const manifest = await this.readBackupManifest(snapshot);
    if (!manifest || manifest.kind !== undefined && manifest.kind !== 'automatic' && manifest.kind !== 'manual' || typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt))) return undefined;
    const dated = new Date(manifest.createdAt).toISOString().replaceAll(':', '-');
    if (name !== dated && !name.startsWith(`${dated}-`)) return undefined;
    if (!Array.isArray(manifest.items) || !manifest.items.every(item => typeof item === 'string' && backupItems.includes(item)) || new Set(manifest.items).size !== manifest.items.length || typeof manifest.snapshotBytes !== 'string' || !/^\d+$/.test(manifest.snapshotBytes)) return undefined;
    if (manifest.format === 2) {
      try { validateBackupObjectManifest({ files: manifest.files, directories: manifest.directories, snapshotBytes: manifest.snapshotBytes }); } catch { return undefined; }
    } else if (manifest.format !== undefined) return undefined;
    return { name, createdAt: manifest.createdAt, device: info.dev, inode: info.ino };
  }

  private async pruneSnapshots(directory: string, snapshots: RetainedSnapshot[], committed: string) {
    const surplus = snapshots.length + 1 - maximumBackups;
    if (surplus <= 0) return;
    const oldest = [...snapshots].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.name.localeCompare(right.name)).slice(0, surplus);
    for (const snapshot of oldest) {
      let parent: FileHandle | undefined;
      let download: FileHandle | undefined;
      try {
        if (await this.backupRoot(false) !== directory || snapshot.name === committed) throw new Error('Backup storage changed during retention.');
        const current = await this.retainedSnapshot(directory, snapshot.name);
        if (!current || current.device !== snapshot.device || current.inode !== snapshot.inode) throw new Error('Snapshot identity changed during retention.');
        parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        const originalParent = await parent.stat();
        const currentParent = await lstat(directory);
        if (originalParent.dev !== currentParent.dev || originalParent.ino !== currentParent.ino || !currentParent.isDirectory()) throw new Error('Backup storage changed during retention.');
        const anchor = process.platform === 'linux' ? `/proc/self/fd/${parent.fd}` : directory;
        const target = path.join(anchor, snapshot.name);
        const archive = path.join(anchor, `${snapshot.name}.tar.gz`);
        download = await this.snapshotDownload(archive);
        await inspectSnapshot(target);
        const metadata = await lstat(target, { bigint: true });
        if (metadata.dev !== snapshot.device || metadata.ino !== snapshot.inode || !metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Snapshot identity changed during retention.');
        await this.dependencies.removeDirectory(target);
        if (download) {
          const opened = await download.stat();
          const current = await lstat(archive);
          if (!current.isFile() || current.nlink !== 1 || opened.dev !== current.dev || opened.ino !== current.ino) throw new Error('The old backup download changed and was retained.');
          await unlink(archive);
        }
      } catch (error) {
        const message = `Backup retention kept ${snapshot.name}: ${error instanceof Error ? error.message : 'Unknown failure'}`;
        this.log(message);
        this.options.activity(message);
      } finally { await download?.close(); await parent?.close(); }
    }
  }

  private async snapshotDownload(file: string): Promise<FileHandle | undefined> {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!handle) return;
    try {
      const info = await handle.stat();
      const current = await lstat(file);
      if (!info.isFile() || info.nlink !== 1 || !current.isFile() || current.nlink !== 1 || info.dev !== current.dev || info.ino !== current.ino) throw new Error('The old backup download is linked or changed and was retained.');
      return handle;
    } catch (error) { await handle.close(); throw error; }
  }

  private async update(downloads: ModDownload[]) {
    if (this.state === 'not-installed') throw new Error('Install the base Minecraft server before updating mods.');
    if (downloads.some(file => !Number.isSafeInteger(file.fileLength) || file.fileLength < 0)) throw new Error('The pack contains an invalid download size.');
    const downloadBytes = downloads.reduce((sum, file) => sum + file.fileLength, 0);
    if (downloads.length > 300 || downloadBytes > 2 * 1024 ** 3) throw new Error('The pack exceeds server download limits.');
    if (await this.dependencies.availableBytes(this.options.directory) < BigInt(downloadBytes) + reservedDiskBytes) throw new Error('Not enough free disk space to stage the new mods.');
    const transaction = randomUUID();
    const staging = path.join(this.options.directory, `mods-staging-${transaction}`);
    const current = path.join(this.options.directory, 'mods');
    const previous = path.join(this.options.directory, `mods-previous-${transaction}`);
    await mkdir(staging, { recursive: true, mode: 0o700 });
    const names = new Set<string>();
    let swapped = false;
    let oldExists = false;
    let oldMoved = false;
    let backupDirectory: string | undefined;
    const wasRunning = Boolean(this.process);
    try {
      for (const file of downloads) {
        if (!/^[A-Za-z0-9_+.() -]+\.jar$/.test(file.fileName) || names.has(file.fileName)) throw new Error('A mod has an unsafe or duplicated filename.');
        names.add(file.fileName);
        const destination = path.join(staging, file.fileName);
        if (file.localPath) await this.dependencies.copy(file.localPath, destination, { hashes: file.hashes, expectedBytes: file.fileLength });
        else if (file.url) await this.dependencies.download(file.url, destination, { hashes: file.hashes, expectedBytes: file.fileLength });
        else throw new Error('A mod has neither a download address nor a verified local file.');
      }
      await this.stop();
      backupDirectory = await this.backup('automatic');
      this.state = 'updating';
      oldExists = await exists(current);
      if (oldExists) { await rename(current, previous); oldMoved = true; }
      await rename(staging, current);
      swapped = true;
      this.state = 'stopped';
      if (wasRunning && !this.shuttingDown) await this.start();
      await writeFile(path.join(this.options.directory, 'installed-mods.json'), JSON.stringify(downloads.map(({ modId, fileId, fileName }) => ({ modId, fileId, fileName })), null, 2));
    } catch (error) {
      try {
        if (swapped) {
          await this.stop();
          await rename(current, path.join(this.options.directory, `mods-failed-${transaction}`));
          if (oldExists) await rename(previous, current);
          // Restoring absence matters too: a failed boot can create a new world.
          if (backupDirectory) {
            const manifest = await this.readBackupManifest(backupDirectory);
            if (!manifest) throw new Error('The rollback backup metadata could not be read safely.');
            const objects = manifest.format === 2 ? validateBackupObjectManifest({ files: manifest.files, directories: manifest.directories, snapshotBytes: manifest.snapshotBytes }) : undefined;
            const rollbackItems = backupItems.filter(item => item !== 'mods');
            for (const item of rollbackItems) {
              const saved = path.join(backupDirectory, item);
              const live = path.join(this.options.directory, item);
              if (await exists(live)) await rename(live, `${live}-failed-${transaction}`);
              if (!objects && await exists(saved)) await copySnapshot(saved, live);
            }
            if (objects) {
              const selected = rollbackItems.filter(item => (manifest.items as string[]).includes(item));
              if (selected.length) await this.backupObjects.materialize(objects, this.options.directory, selected);
            }
          }
          this.state = 'stopped';
          this.options.activity('Update failed. Restored the previous mods and backup state.');
        } else if (oldMoved) {
          await rename(previous, current);
          this.state = 'stopped';
        }
      } catch (recoveryError) {
        this.state = 'failed';
        throw new AggregateError([error, recoveryError], 'Update failed and automatic recovery could not finish. The backup and quarantined files were retained.');
      }
      await this.resumeAfterFailure(wasRunning, error);
      throw error;
    } finally { await this.removeTemporary(staging); }
    // A committed update must never roll back because disposable cleanup failed.
    if (oldExists) await this.removeTemporary(previous);
  }

  private async resumeAfterFailure(wasRunning: boolean, cause: unknown) {
    if (!wasRunning || this.process || this.shuttingDown) return;
    try { await this.start(); } catch (restartError) {
      throw new AggregateError([cause, restartError], 'The operation failed and the previous server could not restart. Check the server log.');
    }
  }

  private async removeTemporary(directory: string) {
    try { await this.dependencies.removeDirectory(directory); } catch (error) {
      this.log(`Temporary files retained at ${path.basename(directory)}: ${String(error)}`);
    }
  }
}
