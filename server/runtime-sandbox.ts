import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { InstalledServer, InstallationHardening } from './loader-installation.js';
import { RuntimeIntegrity } from './runtime-integrity.js';
import { javaProxyArguments } from './java-network.js';
import { assertSandboxServerProperties, readServerProperties } from './server-properties.js';
export { javaProxyArguments } from './java-network.js';

const launcher = '/usr/local/bin/minecraft-sandbox';
const javaExecutables = ['/opt/java/openjdk/bin/java', '/opt/java/8/bin/java', '/opt/java/17/bin/java', '/opt/java/21/bin/java'];
const writableDirectories = ['world', 'mods', 'config', 'defaultconfigs', 'kubejs', 'scripts', 'datapacks', 'resourcepacks', 'shaderpacks', 'logs', 'crash-reports', '.mixin.out'];
const writableFiles = ['banned-ips.json', 'banned-players.json', 'ops.json', 'whitelist.json', 'usercache.json', 'server.properties'];

export interface RuntimeSandboxOptions {
  directory: string;
  dataDirectory: string;
  trustDirectory: string;
  proxyAddress: string;
  javaPaths: Record<number, string>;
  log: (line: string) => void;
}

async function regular(file: string): Promise<void> {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.nlink !== 1) throw new Error(`Sandbox file must be a regular unlinked file: ${path.basename(file)}.`);
}

async function directory(candidate: string): Promise<void> {
  await mkdir(candidate, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
  if (!(await lstat(candidate)).isDirectory()) throw new Error('A sandbox directory is not a regular directory.');
}

async function digest(file: string, algorithm: string): Promise<string> {
  await regular(file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash(algorithm);
    for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes);
    return hash.digest('hex');
  } finally { await handle.close(); }
}

export class RuntimeSandbox {
  private readonly integrity: RuntimeIntegrity;
  constructor(private readonly options: RuntimeSandboxOptions) {
    const relative = path.relative(path.resolve(options.dataDirectory), path.resolve(options.directory));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Minecraft must be inside its dedicated data volume.');
    this.integrity = new RuntimeIntegrity({ directory: options.directory, writableDirectory: options.dataDirectory, trustDirectory: options.trustDirectory, identity: createHash('sha256').update(relative).digest('hex') });
    javaProxyArguments(options.proxyAddress, 3129);
  }

  hardening(): InstallationHardening {
    return { prepare: (root, installed, vanilla) => this.prepare(root, installed, vanilla), seal: () => this.integrity.seal() };
  }

  async verify(): Promise<InstalledServer> { return this.integrity.verify(); }

  async launch(java: string, installed: InstalledServer): Promise<{ command: string; prefix: string[]; javaArguments: string[] }> {
    if (!javaExecutables.includes(java)) throw new Error('Only the Java runtimes included in the pinned container image may launch Minecraft.');
    const checksums = JSON.parse(await readFile('/usr/local/share/minecraft-java.json', 'utf8')) as Record<string, string>;
    if (!checksums[java] || await digest(java, 'sha256') !== checksums[java]) throw new Error('The Java executable failed checksum verification.');
    const root = this.options.directory;
    const temporary = path.join(root, '.sandbox-tmp');
    const old = await lstat(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
    if (old && !old.isDirectory()) throw new Error('The private JVM temporary directory is not a regular directory.');
    if (old) await rm(temporary, { recursive: true });
    await directory(temporary);
    const writable: string[] = [temporary];
    for (const name of writableDirectories) {
      const candidate = path.join(root, name);
      await directory(candidate);
      writable.push(candidate);
    }
    for (const name of writableFiles) {
      const candidate = path.join(root, name);
      if (name !== 'server.properties') await writeFile(candidate, '[]\n', { flag: 'wx', mode: 0o600 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
      await regular(candidate);
      writable.push(candidate);
    }
    if (installed.loader === 'Fabric') {
      const cacheRoot = path.join(root, '.fabric');
      await directory(cacheRoot);
      const cache = path.join(cacheRoot, 'processedMods');
      const current = await lstat(cache).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
      if (current && !current.isDirectory()) throw new Error('Fabric mod cache is not a regular directory.');
      if (current) await rm(cache, { recursive: true });
      await directory(cache);
      writable.push(cache);
    }
    // Class data sharing: the JVM writes an archive of loaded classes on the first
    // start and maps it on later starts, which removes most of the class-loading
    // time before mods initialize. The archive is validated by the JVM against the
    // classpath and silently ignored when it no longer matches.
    const jvmCache = path.join(root, '.jvm-cache');
    await directory(jvmCache);
    writable.push(jvmCache);
    assertSandboxServerProperties(await readServerProperties(path.join(root, 'server.properties')));
    return {
      command: launcher,
      prefix: ['--read', root, ...writable.flatMap(value => ['--write', value]), '--connect', '3129', '--connect', '443', '--bind', '25566', '--', java],
      javaArguments: [...javaProxyArguments(this.options.proxyAddress, 3129), `-Djava.io.tmpdir=${temporary}`, '-XX:-UsePerfData',
        '-XX:+AutoCreateSharedArchive', `-XX:SharedArchiveFile=${path.join(jvmCache, 'server.jsa')}`,
        // Aikar's G1 settings: shorter pauses and steadier tick times on a large heap.
        '-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200', '-XX:+UnlockExperimentalVMOptions', '-XX:+DisableExplicitGC',
        '-XX:G1NewSizePercent=30', '-XX:G1MaxNewSizePercent=40', '-XX:G1HeapRegionSize=8M', '-XX:G1ReservePercent=20', '-XX:InitiatingHeapOccupancyPercent=15',
        '-XX:G1MixedGCLiveThresholdPercent=90', '-XX:G1RSetUpdatingPauseTimePercent=5', '-XX:SurvivorRatio=32', '-XX:+PerfDisableSharedMem', '-XX:MaxTenuringThreshold=1'],
    };
  }

  private async prepare(root: string, installed: InstalledServer, vanilla: { sha1: string; size: number }): Promise<void> {
    if ((await readdir(root)).some(name => ['mods', 'config', 'world', 'kubejs', 'scripts'].includes(name))) throw new Error('Trusted runtime preparation requires a fresh installer directory without modpack data.');
    const java = this.options.javaPaths[installed.javaMajor];
    if (!java || !javaExecutables.includes(java)) throw new Error('The requested pinned Java runtime is unavailable.');
    await writeFile(path.join(root, 'eula.txt'), 'eula=false\n', { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(root, 'server.properties'), 'server-ip=127.0.0.1\nserver-port=25567\nonline-mode=true\nlevel-name=world\nview-distance=2\n', { flag: 'wx', mode: 0o600 });
    this.options.log('Preparing official runtime dependencies without mods.');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(java, [...javaProxyArguments(this.options.proxyAddress, 3128), '-Xms128M', '-Xmx1024M', ...installed.launchArgs, 'nogui'], {
        cwd: root, shell: false, detached: true, stdio: 'pipe', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', JAVA_HOME: path.resolve(java, '..', '..') },
      });
      let pending = '';
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
      }, 180_000).unref();
      const receive = (bytes: Buffer) => {
        pending += bytes.toString();
        const lines = pending.split('\n');
        pending = lines.pop()!.slice(-2000);
        for (const line of lines) {
          this.options.log(line.slice(0, 2000));
          if (/Done \([\d.,]+s\)!/.test(line)) child.stdin.end('stop\n');
        }
      };
      child.stdout.on('data', receive);
      child.stderr.on('data', receive);
      child.stdin.on('error', () => undefined);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); if (expired || code !== 0) reject(new Error(`Trusted runtime preparation failed (${expired ? 'timeout' : code}).`)); else resolve(); });
    });
    if (installed.loader === 'Fabric') {
      const downloaded = path.join(root, '.fabric', 'server', `${installed.minecraftVersion}-server.jar`);
      if ((await lstat(downloaded)).size !== vanilla.size || await digest(downloaded, 'sha1') !== vanilla.sha1) throw new Error('The launcher-provisioned Minecraft server failed the official Mojang checksum.');
    }
    for (const name of ['eula.txt', 'server.properties', 'world', 'logs', 'mods', 'config', 'usercache.json', 'ops.json', 'whitelist.json', 'banned-players.json', 'banned-ips.json']) {
      await rm(path.join(root, name), { recursive: true, force: true });
    }
  }
}
