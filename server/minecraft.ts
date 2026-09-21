import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, cp, lstat, mkdir, open, readFile, readdir, rename, rm, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { copyVerifiedFile, downloadArtifact } from './download.js';
import { readInstalled, type InstalledServer } from './loader-installation.js';

/** A mod to stage: either a CurseForge CDN download or a verified copy from the host's CurseForge App profile. */
export interface ModDownload { modId: number; fileId: number; fileName: string; url?: string; localPath?: string; hashes: { algo: number; value: string }[]; fileLength: number }
export type MaintenanceAction = 'start' | 'stop' | 'restart' | 'backup' | 'update' | 'sync-profile';
const describeAction = (action: MaintenanceAction) => action === 'sync-profile' ? 'App pack sync' : `Server ${action}`;
type ServerState = 'not-installed' | 'stopped' | 'starting' | 'running' | 'stopping' | 'updating' | 'failed';
const backupItems = ['world', 'mods', 'config', 'server.properties', 'ops.json', 'whitelist.json', 'banned-players.json', 'banned-ips.json', 'installed-mods.json'];
const maximumBackups = 20;
const reservedDiskBytes = 256n * 1024n ** 2n;
export interface MinecraftDependencies {
  launch: (command: string, arguments_: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;
  download: typeof downloadArtifact;
  copy: typeof copyVerifiedFile;
  availableBytes: (directory: string) => Promise<bigint>;
  removeDirectory: (directory: string) => Promise<void>;
}
const defaultDependencies: MinecraftDependencies = {
  launch: (command, arguments_, options) => spawn(command, arguments_, { ...options, shell: false, stdio: 'pipe' }),
  download: downloadArtifact,
  copy: copyVerifiedFile,
  availableBytes: async directory => { const space = await statfs(directory, { bigint: true }); return space.bavail * space.bsize; },
  removeDirectory: directory => rm(directory, { recursive: true, force: true }),
};

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function inspectSnapshot(source: string): Promise<bigint> {
  const metadata = await lstat(source, { bigint: true });
  if (metadata.isSymbolicLink()) throw new Error(`Backups do not follow symbolic links: ${path.basename(source)}.`);
  if (metadata.isFile()) return metadata.size;
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
      if ((await lstat(current)).isSymbolicLink()) throw new Error('A symbolic link appeared while copying the backup.');
      return true;
    },
  });
}

export class MinecraftServer {
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
  constructor(private readonly options: { directory: string; java: string; javaPaths?: Record<number, string>; loaderVersion?: string; memoryMb: number; version: string; address: string; activity: (message: string) => void; onLog?: (line: string) => void; requireOnlineMode?: boolean }, dependencies: Partial<MinecraftDependencies> = {}) {
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  async initialize() {
    if (this.process) throw new Error('Stop Minecraft before reloading its installation.');
    this.installed = await readInstalled(this.options.directory);
    const launcher = this.installed ? this.installed.launchArgs[0] === '-jar' ? this.installed.launchArgs[1]! : this.installed.launchArgs[0]!.slice(1) : 'fabric-server-launch.jar';
    try { await access(path.join(this.options.directory, launcher)); this.state = 'stopped'; } catch { this.state = 'not-installed'; }
    const backupsDirectory = path.join(this.options.directory, '..', 'backups');
    const backups = await readdir(backupsDirectory, { withFileTypes: true }).catch(() => []);
    const latest = backups.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name).sort().at(-1);
    if (latest) {
      const manifest = await readFile(path.join(backupsDirectory, latest, 'backup.json'), 'utf8').then(text => JSON.parse(text) as { createdAt?: string }).catch(() => undefined);
      const legacyTimestamp = latest.replace(/^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2}\.\d{3}Z).*$/, '$1$2:$3:$4');
      const timestamp = manifest?.createdAt ?? legacyTimestamp;
      this.lastBackup = Number.isFinite(Date.parse(timestamp)) ? new Date(timestamp).toISOString() : null;
    }
  }
  status() { return { state: this.state, version: this.installed?.minecraftVersion ?? this.options.version, loader: this.installed?.loader ?? 'Fabric', loaderVersion: this.installed?.loaderVersion ?? this.options.loaderVersion ?? '0.19.5', address: this.options.address, uptimeSeconds: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0, lastBackup: this.lastBackup, busy: this.busy, failure: this.failure }; }
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
    try {
      if (action === 'start') await this.start();
      if (action === 'stop') await this.stop();
      if (action === 'restart') { this.lastRestartAt = Date.now(); await this.stop(); await this.start(); }
      if (action === 'backup') {
        const running = Boolean(this.process);
        await this.stop();
        try { await this.backup(); } catch (error) {
          await this.resumeAfterFailure(running, error);
          throw error;
        }
        if (running && !this.shuttingDown) await this.start();
      }
      if (action === 'update' || action === 'sync-profile') { if (!downloads) throw new Error('The update source is not configured.'); await this.update(await downloads()); }
      this.options.activity(`${describeAction(action)} completed.`);
    } catch (error) {
      this.options.activity(`${describeAction(action)} failed: ${error instanceof Error ? error.message : 'Unknown failure'}`);
      throw error;
    } finally { this.busy = false; }
  }

  private async start() {
    if (this.shuttingDown) throw new Error('The controller is shutting down.');
    if (this.process) throw Object.assign(new Error('The server is already running.'), { statusCode: 409 });
    if (this.state === 'not-installed') throw new Error('Run npm run bootstrap to install the Minecraft server.');
    this.installed = await readInstalled(this.options.directory);
    const eula = await readFile(path.join(this.options.directory, 'eula.txt'), 'utf8').catch(() => '');
    if (!/^eula=true\s*$/m.test(eula)) throw new Error('The owner must accept the Minecraft EULA locally before starting the server.');
    if (this.options.requireOnlineMode) {
      const properties = await readFile(path.join(this.options.directory, 'server.properties'), 'utf8');
      if (!/^online-mode=true\s*$/m.test(properties) || !/^server-ip=127\.0\.0\.1\s*$/m.test(properties)
        || !/^server-port=25566\s*$/m.test(properties)) throw new Error('Join-based access requires online-mode=true and the private game listener at 127.0.0.1:25566.');
    }
    const java = this.installed ? this.options.javaPaths?.[this.installed.javaMajor] : this.options.java;
    if (!java) throw new Error(`Java ${this.installed!.javaMajor} is not configured for this server installation.`);
    this.state = 'starting';
    const child = this.dependencies.launch(java, [`-Xms512M`, `-Xmx${this.options.memoryMb}M`, ...(this.installed?.launchArgs ?? ['-jar', 'fabric-server-launch.jar']), 'nogui'], {
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
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (this.status().state === 'running') return;
      if (!this.process) throw new Error('Minecraft could not start. Check the server log.');
      await delay(500);
    }
    await this.stop();
    this.state = 'failed';
    this.recordFailure('Minecraft did not become ready within three minutes and was stopped.');
    throw new Error('Minecraft did not become ready within three minutes.');
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

  private async backup() {
    if (this.process) throw new Error('Stop Minecraft before taking a consistent backup.');
    if ((await lstat(this.options.directory)).isSymbolicLink()) throw new Error('The Minecraft directory must not be a symbolic link.');
    const backupsDirectory = path.join(this.options.directory, '..', 'backups');
    await mkdir(backupsDirectory, { recursive: true, mode: 0o700 });
    if ((await lstat(backupsDirectory)).isSymbolicLink()) throw new Error('The backup directory must not be a symbolic link.');
    const retained = (await readdir(backupsDirectory, { withFileTypes: true })).filter(entry => entry.isDirectory());
    if (retained.length >= maximumBackups) throw new Error(`The ${maximumBackups}-backup limit is full. Archive verified backups elsewhere before creating another.`);
    const items: string[] = [];
    let snapshotBytes = 0n;
    for (const item of backupItems) {
      const source = path.join(this.options.directory, item);
      if (await exists(source)) { snapshotBytes += await inspectSnapshot(source); items.push(item); }
    }
    if (await this.dependencies.availableBytes(backupsDirectory) < snapshotBytes * 2n + reservedDiskBytes) {
      throw new Error('Not enough free disk space for a backup and recovery reserve. No backup was created.');
    }
    const createdAt = new Date().toISOString();
    const stamp = `${createdAt.replaceAll(':', '-')}-${randomUUID()}`;
    const backupDirectory = path.join(backupsDirectory, stamp);
    const staging = path.join(backupsDirectory, `.incomplete-${stamp}`);
    await mkdir(staging, { mode: 0o700 });
    try {
      for (const item of items) await copySnapshot(path.join(this.options.directory, item), path.join(staging, item));
      await writeFile(path.join(staging, 'backup.json'), JSON.stringify({ createdAt, items, snapshotBytes: snapshotBytes.toString() }), { mode: 0o600 });
      await rename(staging, backupDirectory);
    } catch (error) {
      await this.removeTemporary(staging);
      throw error;
    }
    this.lastBackup = createdAt;
    this.options.activity(`Backup saved: ${stamp}`);
    return backupDirectory;
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
      backupDirectory = await this.backup();
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
          if (backupDirectory) for (const item of backupItems.filter(item => item !== 'mods')) {
            const saved = path.join(backupDirectory, item);
            const live = path.join(this.options.directory, item);
            if (await exists(live)) await rename(live, `${live}-failed-${transaction}`);
            if (await exists(saved)) await copySnapshot(saved, live);
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
