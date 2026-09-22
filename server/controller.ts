import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { access, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import Fastify from 'fastify';
import { z } from 'zod';
import { MinecraftServer, type MinecraftDependencies } from './minecraft.js';
import { MinecraftGateway } from './minecraft-gateway.js';
import { ModpackFiles } from './modpack-files.js';
import { validateArtifactUrl } from './download.js';
import { withSecrets } from './secrets.js';
import { LoaderInstallation, type ServerTarget } from './loader-installation.js';
import { assertInstallationPresent, writeServerDefaults } from './container-bootstrap.js';
import { ServerProfiles } from './server-profiles.js';
import { createBackupArchive, downloadBackup, discardBackupArchive, type BackupJob } from './backup-archive.js';
import { WorkspaceActivity } from './workspace-activity.js';
import { RuntimeSandbox } from './runtime-sandbox.js';
import { AutomaticBackups } from './automatic-backups.js';
import { backupIdSchema, savedBackups, savedBackupPath } from './backup-history.js';
import { collectBackupObjects } from './backup-maintenance.js';

const configurationSchema = z.object({
  HOST: z.enum(['0.0.0.0', '127.0.0.1']).default('0.0.0.0'),
  CONTROLLER_PORT: z.coerce.number().int().min(1024).max(65535).default(3001),
  CONTROLLER_TOKEN: z.string().min(32).max(256),
  RUNTIME_DIRECTORY: z.string().default('/data'),
  CONTAINER_SANDBOX: z.enum(['true', 'false']).default('false'),
  RUNTIME_TRUST_DIRECTORY: z.string().default('/runtime-trust'),
  RUNTIME_PROXY_ADDRESS: z.string().ipv4().default('172.30.3.2'),
  JAVA_PATH: z.string().default('/opt/java/openjdk/bin/java'),
  JAVA8_PATH: z.string().default('/opt/java/8/bin/java'),
  JAVA17_PATH: z.string().default('/opt/java/17/bin/java'),
  JAVA21_PATH: z.string().default('/opt/java/21/bin/java'),
  MINECRAFT_VERSION: z.string().regex(/^[A-Za-z0-9.-]{1,40}$/).default('26.3'),
  FABRIC_LOADER_VERSION: z.string().regex(/^[0-9.]{1,40}$/).default('0.19.5'),
  MINECRAFT_MEMORY_MB: z.coerce.number().int().min(1024).max(65536).default(4096),
  MINECRAFT_START_TIMEOUT_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
  MINECRAFT_ADDRESS: z.string().default('mc.aron.best'),
  MINECRAFT_AUTOSTART: z.enum(['true', 'false']).default('false'),
  MINECRAFT_GATEWAY: z.enum(['true', 'false']).default('true'),
});

export const readControllerConfiguration = (environment: NodeJS.ProcessEnv = process.env) => configurationSchema.parse(withSecrets(environment));
export type ControllerConfiguration = z.infer<typeof configurationSchema>;
const addressSchema = z.string().min(1).max(100);
const filePathSchema = z.string().min(1).max(320);
const downloadSchema = z.object({
  modId: z.number().int().positive(), fileId: z.number().int().positive(),
  fileName: z.string().max(255), fileLength: z.number().int().nonnegative().max(128 * 1024 ** 2),
  hashes: z.array(z.object({ algo: z.union([z.literal(1), z.literal(2)]), value: z.string().regex(/^[a-fA-F0-9]{32,40}$/) })).min(1).max(2),
  url: z.string().url().refine(value => { try { validateArtifactUrl(value); return true; } catch { return false; } }),
}).strict();

export async function createController(configuration = readControllerConfiguration(), dependencies: { minecraft?: Partial<MinecraftDependencies>; isolated?: boolean; installations?: Pick<LoaderInstallation, 'catalog' | 'install'>; installationFactory?: (directory: string, log: (line: string) => void) => Pick<LoaderInstallation, 'catalog' | 'install'> } = {}) {
  const fallbackTarget: ServerTarget = { minecraftVersion: configuration.MINECRAFT_VERSION, loader: 'Fabric', loaderVersion: configuration.FABRIC_LOADER_VERSION };
  const profiles = new ServerProfiles({ directory: configuration.RUNTIME_DIRECTORY, fallbackTarget });
  await profiles.initialize();
  const detected = configuration.CONTAINER_SANDBOX === 'true' && process.platform === 'linux' && process.getuid?.() !== 0
    && await access('/.dockerenv').then(() => true, () => false);
  const isolated = dependencies.isolated ?? detected;
  const activity: { id: string; message: string; timestamp: string }[] = [];
  const joins: { id: string; ip: string }[] = [];
  const record = (message: string) => { activity.unshift({ id: randomUUID(), message, timestamp: new Date().toISOString() }); activity.splice(60); };
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024, requestTimeout: 30_000, connectionTimeout: 10_000 });
  const gateway = configuration.MINECRAFT_GATEWAY === 'true' ? new MinecraftGateway({
    port: 25565, upstreamPort: 25566, perAddressLimit: configuration.CONTAINER_SANDBOX === 'true' ? 64 : 6,
    joined: async ip => { joins.push({ id: randomUUID(), ip }); if (joins.length > 100) joins.shift(); },
    failure: () => record('The Minecraft gateway reported a connection error.'),
  }) : undefined;
  const javaPaths = { 8: configuration.JAVA8_PATH, 17: configuration.JAVA17_PATH, 21: configuration.JAVA21_PATH, 25: configuration.JAVA_PATH };
  const sandboxFor = (directory: string, log: (line: string) => void) => configuration.CONTAINER_SANDBOX === 'true' ? new RuntimeSandbox({ directory, dataDirectory: configuration.RUNTIME_DIRECTORY, trustDirectory: configuration.RUNTIME_TRUST_DIRECTORY, proxyAddress: configuration.RUNTIME_PROXY_ADDRESS, javaPaths, log }) : undefined;
  const installerFor = (directory: string, log: (line: string) => void) => dependencies.installationFactory?.(directory, log) ?? dependencies.installations ?? new LoaderInstallation({ directory, javaPaths, log, hardening: sandboxFor(directory, log)?.hardening(), installerProxyAddress: configuration.CONTAINER_SANDBOX === 'true' ? configuration.RUNTIME_PROXY_ADDRESS : undefined });
  async function runtimeFor(root: string) {
    await assertInstallationPresent(root);
    const directory = path.join(root, 'minecraft');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const server = new MinecraftServer({ directory, java: configuration.JAVA_PATH, javaPaths, loaderVersion: configuration.FABRIC_LOADER_VERSION, memoryMb: configuration.MINECRAFT_MEMORY_MB, startTimeoutMs: configuration.MINECRAFT_START_TIMEOUT_SECONDS * 1000,
      version: configuration.MINECRAFT_VERSION, address: configuration.MINECRAFT_ADDRESS, activity: record,
      requireOnlineMode: Boolean(gateway), onLog: line => gateway?.observeLog(line),
      sandbox: sandboxFor(directory, line => record(line)),
      backupObjectsDirectory: path.join(configuration.RUNTIME_DIRECTORY, 'backup-objects'),
    }, dependencies.minecraft);
    await server.initialize();
    const changes = new WorkspaceActivity(root);
    await changes.initialize();
    return { directory, server, changes, files: new ModpackFiles(directory), installations: installerFor(directory, line => server.appendLog(`[Installation] ${line}`)), installationError: undefined as string | undefined };
  }
  type Runtime = Awaited<ReturnType<typeof runtimeFor>>;
  const runtimes = new Map<string, Promise<Runtime>>();
  const removing = new Set<string>();
  async function runtimeForProfile(id: string) {
    const root = profiles.directoryFor(id);
    if (removing.has(id)) throw Object.assign(new Error('This saved server is being removed.'), { statusCode: 409 });
    let runtime = runtimes.get(id);
    if (!runtime) {
      runtime = runtimeFor(root);
      runtimes.set(id, runtime);
      void runtime.catch(() => { if (runtimes.get(id) === runtime) runtimes.delete(id); });
    }
    const result = await runtime;
    profiles.directoryFor(id);
    if (removing.has(id)) throw Object.assign(new Error('This saved server is being removed.'), { statusCode: 409 });
    return result;
  }
  let activeRuntime = await runtimeForProfile(profiles.activeId());
  let { directory, server, files } = activeRuntime;
  let installationTask: Promise<void> | undefined;
  let profileError: string | undefined;
  let profileTask: Promise<void> | undefined;
  let working = false;
  let currentOperation: string | undefined;
  let mutationRevision = 0;
  const backupJobs = new Map<string, { job: BackupJob; snapshotId?: string }>();
  const backupTasks = new Set<Promise<void>>();
  let backupDownloads = 0;
  let backupError: string | undefined;
  const profileContext = new AsyncLocalStorage<{ id?: string; workspaceId?: string }>();
  async function listProfiles() {
    const revision = mutationRevision;
    try { return await profiles.list(!working); }
    catch (error) { if (working || revision !== mutationRevision) return profiles.list(false); throw error; }
  }
  function assertProfile() {
    const context = profileContext.getStore();
    if (context && (context.id !== undefined && context.id !== profiles.activeId() || context.id === undefined && profiles.requiresProfileBinding())) {
      throw Object.assign(new Error('The selected server changed. Refresh the workspace before continuing.'), { statusCode: 409 });
    }
  }
  function assertIsolated() {
    if (!isolated) throw Object.assign(new Error('Saved servers require the isolated Minecraft container.'), { statusCode: 409 });
  }
  async function exclusive<T>(operation: () => Promise<T>, fileWrite = false, runtime = activeRuntime, bound = true, label = 'Saving file changes'): Promise<T> {
    if (bound) assertProfile();
    if (working) throw Object.assign(new Error('Another server or file operation is in progress.'), { statusCode: 409 });
    if (fileWrite && !isolated) throw Object.assign(new Error('File changes require the isolated Minecraft container.'), { statusCode: 409 });
    if (fileWrite && !['stopped', 'not-installed', 'failed'].includes(runtime.server.status().state)) {
      throw Object.assign(new Error('Stop the Minecraft server before changing modpack files.'), { statusCode: 409 });
    }
    working = true;
    currentOperation = label;
    mutationRevision++;
    try { return await operation(); } finally { working = false; currentOperation = undefined; }
  }
  async function workspaceRuntime(fallback = false) {
    let id = profileContext.getStore()?.workspaceId ?? profiles.activeId();
    if (fallback && !(await listProfiles()).profiles.some(profile => profile.id === id)) id = profiles.activeId();
    return { id, runtime: await runtimeForProfile(id) };
  }
  async function workspaceOperation<T>(operation: (runtime: Runtime) => Promise<T>, fileWrite = true, label = 'Saving file changes'): Promise<T> {
    const { id, runtime } = await workspaceRuntime();
    return exclusive(async () => {
      profiles.directoryFor(id);
      if (fileWrite) await checkpoint(runtime);
      const result = await operation(runtime);
      if (fileWrite) await runtime.changes.changed();
      return result;
    }, fileWrite, runtime, true, label);
  }
  async function workspaceUpload<T>(operation: (runtime: Runtime, newModOnly: boolean) => Promise<T>, completed = false): Promise<T> {
    const { id, runtime } = await workspaceRuntime();
    return exclusive(async () => {
      assertIsolated();
      profiles.directoryFor(id);
      const state = runtime.server.status().state;
      if (!['stopped', 'not-installed', 'failed', 'running'].includes(state) || runtime.server.status().busy) throw Object.assign(new Error('Wait for the selected server operation to finish before uploading files.'), { statusCode: 409 });
      if (completed && state !== 'running') await checkpoint(runtime);
      const result = await operation(runtime, state === 'running');
      if (completed) await runtime.changes.changed();
      return result;
    }, false, runtime, true, 'Uploading files');
  }
  async function checkpoint(runtime: Runtime): Promise<void> {
    const previous = currentOperation;
    currentOperation = 'Saving safety backup';
    try { const saved = await runtime.server.checkpoint(); backupError = undefined; if (saved) await collectRecovery(); }
    catch (error) {
      backupError = `A safety backup could not be saved. ${error instanceof Error ? error.message : 'Check Server Log for details.'}`;
      runtime.server.appendLog(`[Backup] ${backupError}`);
      record(backupError);
      throw Object.assign(new Error(backupError), { statusCode: 409 });
    } finally { currentOperation = previous; }
  }
  async function collectRecovery(): Promise<void> {
    try { await collectBackupObjects(configuration.RUNTIME_DIRECTORY); backupError = undefined; }
    catch (error) {
      backupError = `Backup saved, but storage cleanup needs attention. ${error instanceof Error ? error.message : 'Check Server Log for details.'}`;
      server.appendLog(`[Backup] ${backupError}`);
      record(backupError);
    }
  }
  const automatic = new AutomaticBackups({
    candidates: async () => {
      if (!isolated || working) return undefined;
      const saved = await listProfiles();
      const candidates = [];
      for (const profile of saved.profiles) {
        const runtime = await runtimeForProfile(profile.id);
        candidates.push({ id: profile.id, due: runtime.server.automaticBackupDue() });
      }
      return candidates;
    },
    backup: async id => {
      if (working) return false;
      const runtime = await runtimeForProfile(id);
      if (working || !runtime.server.automaticBackupDue()) return false;
      return exclusive(async () => {
        const snapshot = await runtime.server.automaticBackup();
        if (snapshot) { await collectRecovery(); record('Automatic backup saved in protected recovery storage.'); }
        return Boolean(snapshot);
      }, false, runtime, false, 'Saving automatic backup');
    },
    report: message => { server.appendLog(`[Backup] ${message}`); record(message); },
  });
  async function activate(id: string) {
    const next = await runtimeForProfile(id);
    if (next.server.status().state === 'not-installed') throw Object.assign(new Error('The selected server installation is incomplete.'), { statusCode: 409 });
    await server.action('stop');
    await files.close();
    if (next !== activeRuntime) await next.files.close();
    await profiles.select(id);
    activeRuntime = next;
    ({ directory, server, files } = next);
    record('Selected a saved server. It remains stopped.');
  }
  function scheduleProfile(operation: () => Promise<void>, label: string) {
    assertProfile();
    assertIsolated();
    if (working || server.status().busy) throw Object.assign(new Error('Wait for the current operation to finish before changing saved servers.'), { statusCode: 409 });
    profileError = undefined;
    profileTask = exclusive(operation, false, activeRuntime, true, label).catch(error => {
      profileError = error instanceof Error ? error.message : 'The saved server operation failed.';
      server.appendLog(`[Saved servers] ${profileError}`);
      record(`Saved server operation failed: ${profileError}`);
    });
  }
  app.addHook('onRequest', (request, _reply, done) => {
    const id = z.string().uuid().optional().parse(request.headers['x-server-profile']);
    const workspaceId = z.string().uuid().optional().parse(request.headers['x-workspace-profile']);
    profileContext.run({ id, workspaceId }, done);
  });
  app.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions.url === '/health') return;
    const candidate = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const digest = (value: string) => createHash('sha256').update(value).digest();
    if (candidate.length > 256 || !timingSafeEqual(digest(candidate), digest(configuration.CONTROLLER_TOKEN))) return reply.code(401).send({ error: 'Controller authentication required.' });
    reply.header('Cache-Control', 'no-store');
    if (!['/status', '/versions', '/backups/:id', '/backups/:id/download', '/recovery', '/recovery/backups/:profileId/:id/download'].includes(request.routeOptions.url ?? '')) assertProfile();
    if (!['GET', 'HEAD'].includes(request.method) && (request.routeOptions.url?.startsWith('/workspace/') || request.routeOptions.url === '/profiles/restore')) request.raw.setTimeout?.(15 * 60_000);
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid controller request.' });
    const failure = error as Error & { statusCode?: number };
    const status = failure.statusCode && failure.statusCode >= 400 && failure.statusCode < 600 ? failure.statusCode : 500;
    reply.code(status).send({ error: status === 500 ? 'Controller operation failed. Check the server logs.' : failure.message });
  });
  app.get('/health', async () => ({ ok: true }));
  function runtimeStatus(runtime: Runtime) {
    return { ...runtime.server.status(), busy: working || runtime.server.status().busy, ...(currentOperation ? { operation: currentOperation } : {}), ...(runtime.installationError ? { installationError: runtime.installationError } : {}) };
  }
  app.get('/status', async () => {
    const { id, runtime } = await workspaceRuntime(true);
    const saved = await listProfiles();
    const failure = backupError ?? automatic.error;
    return { server: { ...runtimeStatus(activeRuntime), ...(profileError ? { profileError } : {}), ...(failure ? { backupError: failure } : {}) }, workspace: { profileId: id, server: runtimeStatus(runtime), updatedAt: runtime.changes.updatedAt }, profiles: saved, profileBindingRequired: profiles.requiresProfileBinding(), isolated, activity, joins };
  });
  app.get('/logs', async () => ({ lines: server.logs() }));
  app.get('/crash', async () => server.latestCrashReport());
  app.get('/versions', async request => {
    const { minecraftVersion } = z.object({ minecraftVersion: z.string().regex(/^[0-9.]{1,40}$/).optional() }).strict().parse(request.query);
    const { runtime } = await workspaceRuntime();
    return runtime.installations.catalog(minecraftVersion ?? runtime.server.status().version);
  });
  app.post('/profiles', async (request, reply) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(64) }).strict().parse(request.body);
    if ((await listProfiles()).profiles.length >= 5) throw Object.assign(new Error('Five servers are already saved. Delete an inactive server before adding another.'), { statusCode: 409 });
    scheduleProfile(async () => {
      const current = server.status();
      const target: ServerTarget = { minecraftVersion: current.version, loader: current.loader, loaderVersion: current.loaderVersion };
      const accepted = /^eula=true\s*$/m.test(await readFile(path.join(directory, 'eula.txt'), 'utf8').catch(() => ''));
      await server.action('stop');
      await files.close();
      const created = await profiles.create(name, async root => {
        const destination = path.join(root, 'minecraft');
        await writeServerDefaults(destination, accepted);
        const installer = installerFor(destination, line => server.appendLog(`[New server] ${line}`));
        const compatible = (await installer.catalog(target.minecraftVersion)).loaders.find(choice => choice.loader === target.loader);
        if (!compatible) throw Object.assign(new Error('The current Minecraft and loader combination is not available for a new installation.'), { statusCode: 409 });
        await installer.install({ ...target, loaderVersion: compatible.loaderVersion });
      });
      await activate(created.id);
      await activeRuntime.changes.changed();
      record(`Created saved server ${name} with a blank world, mods, and configuration.`);
    }, `Creating ${name}`);
    return reply.code(202).send({ accepted: true });
  });
  app.post('/profiles/select', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).strict().parse(request.body);
    profiles.directoryFor(id);
    const selected = (await listProfiles()).profiles.find(profile => profile.id === id)!;
    scheduleProfile(() => activate(id), `Switching to ${selected.name}`);
    return reply.code(202).send({ accepted: true });
  });
  app.post('/profiles/rename', async request => {
    const { id, name } = z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(64) }).strict().parse(request.body);
    assertIsolated();
    await exclusive(() => profiles.rename(id, name), false, activeRuntime, true, 'Renaming saved server');
    record(`Renamed a saved server to ${name}.`);
    return listProfiles();
  });
  app.post('/profiles/remove', async request => {
    const { id } = z.object({ id: z.string().uuid() }).strict().parse(request.body);
    assertIsolated();
    await exclusive(async () => {
      profiles.directoryFor(id);
      if (id === profiles.activeId()) throw Object.assign(new Error('Set another server active before deleting this one.'), { statusCode: 409 });
      removing.add(id);
      try {
        const runtime = await runtimes.get(id);
        await runtime?.files.close();
        await runtime?.server.shutdown();
        runtimes.delete(id);
        await profiles.remove(id);
      } finally { removing.delete(id); }
    }, false, activeRuntime, true, 'Moving server to recovery');
    record('Removed an inactive saved server. Its files remain in recovery storage.');
    return listProfiles();
  });
  app.post('/profiles/restore', async request => {
    const { id } = z.object({ id: z.string().uuid() }).strict().parse(request.body);
    assertIsolated();
    await exclusive(() => profiles.restore(id), false, activeRuntime, true, 'Restoring deleted server');
    record('Restored a deleted server with its files and backups. The active server did not change.');
    return { restored: true };
  });
  app.get('/recovery', async () => {
    assertIsolated();
    if (working) throw Object.assign(new Error('Wait for the current operation, then refresh recovery.'), { statusCode: 409 });
    const revision = mutationRevision;
    const current = (await listProfiles()).profiles.map(profile => ({ ...profile, deleted: false }));
    const removed = (await profiles.listRemoved()).map(profile => ({ ...profile, deleted: true }));
    const servers = [...current, ...removed];
    const backups = [];
    for (const profile of servers) backups.push(...await savedBackups(await profiles.recoveryDirectoryFor(profile.id), profile.id));
    if (working || revision !== mutationRevision) throw Object.assign(new Error('Recovery storage changed. Refresh to see the latest backups.'), { statusCode: 409 });
    return { servers, backups, automatic: { enabled: true, intervalHours: 6, retained: 6, error: backupError ?? automatic.error } };
  });
  app.get('/recovery/backups/:profileId/:id/download', async (request, reply) => {
    const { profileId, id } = z.object({ profileId: z.string().uuid(), id: backupIdSchema }).parse(request.params);
    assertIsolated();
    request.raw.setTimeout?.(30 * 60_000);
    if (backupDownloads >= 2) throw Object.assign(new Error('Two backup downloads are already in progress. Try again shortly.'), { statusCode: 429 });
    backupDownloads++;
    let released = false;
    const release = () => { if (!released) { released = true; backupDownloads--; } };
    try {
      const archive = await recoveryDownload(profileId, id);
      const timeout = setTimeout(() => archive.stream.destroy(new Error('The backup download timed out.')), 30 * 60_000);
      timeout.unref();
      archive.stream.once('close', () => { clearTimeout(timeout); release(); });
      reply.raw.once('close', () => archive.stream.destroy());
      return reply.type('application/gzip').header('Content-Disposition', `attachment; filename="dictionary-minecraft-backup-${id}.tar.gz"`).header('Content-Length', archive.size).send(archive.stream);
    } catch (error) { release(); throw error; }
  });
  async function recoveryDownload(profileId: string, id: string) {
    return exclusive(async () => {
      const root = await profiles.recoveryDirectoryFor(profileId);
      const snapshot = await savedBackupPath(root, profileId, id);
      const artifact = await createBackupArchive(snapshot, path.join(configuration.RUNTIME_DIRECTORY, 'backup-objects'));
      const archive = await downloadBackup(artifact);
      try { await discardBackupArchive(artifact); return archive; }
      catch (error) { archive.stream.destroy(); throw error; }
    }, false, activeRuntime, false, 'Preparing backup download');
  }
  app.post('/installation', async (request, reply) => {
    const target = z.object({ minecraftVersion: z.string().regex(/^[0-9.]{1,40}$/), loader: z.enum(['Fabric', 'Forge', 'NeoForge', 'Quilt']), loaderVersion: z.string().regex(/^[A-Za-z0-9.+_-]{1,100}$/) }).strict().parse(request.body);
    if (!isolated) throw Object.assign(new Error('Server installation changes require the isolated Minecraft container.'), { statusCode: 409 });
    const { id, runtime } = await workspaceRuntime();
    assertProfile();
    if (working || !['stopped', 'not-installed', 'failed'].includes(runtime.server.status().state)) throw Object.assign(new Error('Stop the selected server and wait for existing operations before changing versions.'), { statusCode: 409 });
    runtime.installationError = undefined;
    installationTask = exclusive(async () => {
      profiles.directoryFor(id);
      await runtime.files.close();
      await checkpoint(runtime);
      await runtime.installations.install(target);
      await runtime.server.initialize();
      await runtime.changes.changed();
      record(`Installed Minecraft ${target.minecraftVersion} with ${target.loader} ${target.loaderVersion}. Server remains stopped.`);
    }, true, runtime, true, `Installing Minecraft ${target.minecraftVersion} with ${target.loader}`).catch(error => {
      runtime.installationError = error instanceof Error ? error.message : 'Server installation failed.';
      runtime.server.appendLog(`[Installation] ${runtime.installationError}`);
      record(`Server installation failed: ${runtime.installationError}`);
    });
    return reply.code(202).send({ accepted: true });
  });
  app.post('/action', { bodyLimit: 256 * 1024 }, async request => {
    const body = z.object({ action: z.enum(['start', 'stop', 'restart', 'backup', 'update', 'sync-profile']), downloads: z.array(downloadSchema).max(150).optional() }).strict().parse(request.body);
    request.raw.setTimeout?.(15 * 60_000);
    const labels = { start: 'Starting server', stop: 'Shutting down server', restart: 'Restarting server', backup: 'Saving backup', update: 'Updating modpack', 'sync-profile': 'Syncing modpack' };
    await exclusive(async () => {
      await server.action(body.action, async () => {
        if (!body.downloads) throw new Error('No verified mod download list was provided.');
        return body.downloads;
      });
      if (['backup', 'update', 'sync-profile'].includes(body.action)) await collectRecovery();
      if (body.action === 'update' || body.action === 'sync-profile') await activeRuntime.changes.changed();
    }, false, activeRuntime, true, labels[body.action]);
    return { completed: true };
  });
  app.post('/command', async request => {
    const { command } = z.object({ command: z.string().min(1).max(300) }).strict().parse(request.body);
    activeRuntime.server.command(command);
    return { accepted: true };
  });
  app.post('/backups', async (request, reply) => {
    z.object({}).strict().parse(request.body);
    assertIsolated();
    assertProfile();
    if (working || server.status().busy) throw Object.assign(new Error('Wait for the current server operation before creating a backup.'), { statusCode: 409 });
    if (backupJobs.size >= 100) {
      const oldest = [...backupJobs].find(([, entry]) => entry.job.state !== 'running');
      if (oldest) backupJobs.delete(oldest[0]);
    }
    const job: BackupJob = { id: randomUUID(), profileId: profiles.activeId(), state: 'running' };
    const entry: { job: BackupJob; snapshotId?: string } = { job };
    const runtime = activeRuntime;
    backupJobs.set(job.id, entry);
    const task = exclusive(async () => {
      await runtime.files.close();
      const snapshot = await runtime.server.action('backup');
      if (!snapshot) throw new Error('The backup did not produce a saved snapshot.');
      await collectRecovery();
      entry.snapshotId = path.basename(snapshot);
      job.filename = `dictionary-minecraft-backup-${path.basename(snapshot)}.tar.gz`;
      job.state = 'ready';
      record('A server backup is saved and ready to download.');
    }, false, runtime, true, 'Saving backup').catch(error => {
      job.state = 'failed';
      job.error = typeof error?.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500 ? error.message : 'The backup could not be prepared. Check Server Log for details.';
      runtime.server.appendLog(`[Backup] ${error instanceof Error ? error.message : 'Backup failed.'}`);
      record('The server backup could not be prepared.');
    }).finally(() => backupTasks.delete(task));
    backupTasks.add(task);
    return reply.code(202).send({ id: job.id, profileId: job.profileId });
  });
  function backupJob(params: unknown) {
    const { id } = z.object({ id: z.string().uuid() }).parse(params);
    const entry = backupJobs.get(id);
    if (!entry) throw Object.assign(new Error('That backup session is no longer available. Saved snapshots remain on the server.'), { statusCode: 404 });
    return entry;
  }
  app.get('/backups/:id', async request => backupJob(request.params).job);
  app.get('/backups/:id/download', async (request, reply) => {
    const entry = backupJob(request.params);
    if (entry.job.state !== 'ready' || !entry.snapshotId) throw Object.assign(new Error(entry.job.error ?? 'This backup is still being prepared.'), { statusCode: 409 });
    request.raw.setTimeout?.(30 * 60_000);
    if (backupDownloads >= 2) throw Object.assign(new Error('Two backup downloads are already in progress. Try again shortly.'), { statusCode: 429 });
    backupDownloads++;
    let released = false;
    const release = () => { if (!released) { released = true; backupDownloads--; } };
    try {
      const archive = await recoveryDownload(entry.job.profileId, entry.snapshotId);
      const timeout = setTimeout(() => archive.stream.destroy(new Error('The backup download timed out.')), 30 * 60_000);
      timeout.unref();
      archive.stream.once('close', () => { clearTimeout(timeout); release(); });
      reply.raw.once('close', () => archive.stream.destroy());
      return reply.type('application/gzip').header('Content-Disposition', `attachment; filename="${entry.job.filename}"`).header('Content-Length', archive.size).send(archive.stream);
    } catch (error) { release(); throw error; }
  });
  app.get('/workspace/files', async () => (await workspaceRuntime()).runtime.files.list());
  app.get('/workspace/mods', async () => (await workspaceRuntime()).runtime.files.listMods());
  app.post('/workspace/directories', async request => {
    const { path } = z.object({ path: filePathSchema }).strict().parse(request.body);
    const result = await workspaceOperation(runtime => runtime.files.createDirectory(path), true, 'Creating folder');
    record(`Created folder ${path}`);
    return result;
  });
  app.post('/workspace/entries/move', async request => {
    const { path, destination } = z.object({ path: filePathSchema, destination: filePathSchema }).strict().parse(request.body);
    const result = await workspaceOperation(runtime => runtime.files.move(path, destination), true, 'Moving files');
    record(`Moved ${path} to ${destination}`);
    return result;
  });
  app.post('/workspace/entries/remove', async request => {
    const { path } = z.object({ path: filePathSchema }).strict().parse(request.body);
    const result = await workspaceOperation(runtime => runtime.files.remove(path), true, 'Moving files to recovery');
    record(`Moved ${path} to recovery storage`);
    return result;
  });
  app.post('/workspace/mods/action', async request => {
    const body = z.object({ path: filePathSchema, action: z.enum(['enable', 'disable', 'uninstall']) }).strict().parse(request.body);
    const result = await workspaceOperation(runtime => runtime.files.modAction(body.path, body.action), true, { enable: 'Enabling mod', disable: 'Disabling mod', uninstall: 'Uninstalling mod' }[body.action]);
    record(`Mod ${body.action}: ${body.path}`);
    return result;
  });
  app.get('/workspace/text', async request => {
    const { path } = z.object({ path: filePathSchema }).strict().parse(request.query);
    return (await workspaceRuntime()).runtime.files.text(path);
  });
  app.put('/workspace/text', { bodyLimit: 800_000 }, async request => {
    const body = z.object({ path: filePathSchema, contents: z.string().max(256 * 1024), revision: z.string().min(1).max(128) }).strict().parse(request.body);
    const result = await workspaceOperation(runtime => runtime.files.writeText(body.path, body.contents, body.revision));
    record(`Saved ${body.path}`);
    return result;
  });
  app.get('/workspace/download', async (request, reply) => {
    const { path } = z.object({ path: filePathSchema }).strict().parse(request.query);
    const result = await (await workspaceRuntime()).runtime.files.download(path);
    return reply.type('application/octet-stream').header('Content-Length', result.size).send(result.stream);
  });
  app.post('/workspace/uploads', async request => {
    const body = z.object({ path: filePathSchema, size: z.number().int().positive().max(128 * 1024 ** 2), replace: z.boolean(), address: addressSchema }).strict().parse(request.body);
    return workspaceUpload((runtime, newModOnly) => runtime.files.beginUpload(body.path, body.size, body.replace, body.address, newModOnly));
  });
  app.post('/workspace/uploads/:id/chunks', { bodyLimit: 800_000 }, async request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ index: z.number().int().nonnegative(), data: z.string().min(1).max(750_000), address: addressSchema }).strict().parse(request.body);
    return workspaceUpload((runtime, newModOnly) => runtime.files.appendUpload(id, body.index, body.data, body.address, newModOnly));
  });
  app.post('/workspace/uploads/:id/complete', async request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { address } = z.object({ address: addressSchema }).strict().parse(request.body);
    const result = await workspaceUpload((runtime, newModOnly) => runtime.files.finishUpload(id, address, newModOnly), true);
    record(`Uploaded ${result.path}`);
    return result;
  });
  app.delete('/workspace/uploads/:id', async request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { address } = z.object({ address: addressSchema }).strict().parse(request.body);
    await workspaceOperation(runtime => runtime.files.cancelUpload(id, address), false);
    return { cancelled: true };
  });
  app.post('/workspace/archive', async (request, reply) => {
    const { manifest } = z.object({ manifest: z.object({
      minecraft: z.object({ version: z.string().max(40), modLoaders: z.array(z.object({ id: z.string().max(80), primary: z.boolean() })).length(1) }),
      manifestType: z.literal('minecraftModpack'), manifestVersion: z.literal(1),
      name: z.string().min(1).max(100), version: z.string().min(1).max(100), author: z.string().max(100).optional(),
      files: z.array(z.object({ projectID: z.number().int().positive(), fileID: z.number().int().positive(), required: z.boolean(), fileName: z.string().min(1).max(255),
        name: z.string().max(200).optional(), websiteUrl: z.string().url().max(500).optional(), author: z.string().max(100).optional() }).strict()).max(500), overrides: z.literal('overrides'),
    }).strict() }).strict().parse(request.body);
    const archive = await workspaceOperation(async runtime => {
      const target = runtime.server.status();
      if (!['stopped', 'not-installed', 'failed', 'running'].includes(target.state)) throw Object.assign(new Error('Wait for the selected Minecraft server operation before downloading the modpack.'), { statusCode: 409 });
      if (manifest.minecraft.version !== target.version || manifest.minecraft.modLoaders[0]?.id !== `${target.loader.toLowerCase()}-${target.loaderVersion}`) {
        throw Object.assign(new Error('The pack target does not match the installed server.'), { statusCode: 409 });
      }
      return runtime.files.exportArchive(manifest);
    }, false, 'Preparing modpack download');
    return reply.type('application/zip').header('Content-Length', archive.length).send(archive);
  });
  app.addHook('onReady', async () => {
    await gateway?.listen();
    if (isolated) automatic.start();
    if (configuration.MINECRAFT_AUTOSTART === 'true') void exclusive(() => server.action('start'), false, activeRuntime, true, 'Starting server').catch(() => record('Automatic Minecraft startup failed.'));
  });
  app.addHook('onClose', async () => {
    await automatic.close();
    await installationTask;
    await profileTask;
    await Promise.all(backupTasks);
    for (const pending of runtimes.values()) {
      const runtime = await pending;
      await runtime.server.shutdown();
      await runtime.files.close();
    }
    await gateway?.close();
  });
  return app;
}
