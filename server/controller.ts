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
import { createBackupArchive, downloadBackup, type BackupArtifact, type BackupJob } from './backup-archive.js';
import { WorkspaceActivity } from './workspace-activity.js';

const configurationSchema = z.object({
  HOST: z.enum(['0.0.0.0', '127.0.0.1']).default('0.0.0.0'),
  CONTROLLER_PORT: z.coerce.number().int().min(1024).max(65535).default(3001),
  CONTROLLER_TOKEN: z.string().min(32).max(256),
  RUNTIME_DIRECTORY: z.string().default('/data'),
  CONTAINER_SANDBOX: z.enum(['true', 'false']).default('false'),
  JAVA_PATH: z.string().default('/opt/java/openjdk/bin/java'),
  JAVA8_PATH: z.string().default('/opt/java/8/bin/java'),
  JAVA17_PATH: z.string().default('/opt/java/17/bin/java'),
  JAVA21_PATH: z.string().default('/opt/java/21/bin/java'),
  MINECRAFT_VERSION: z.string().regex(/^[A-Za-z0-9.-]{1,40}$/).default('26.3'),
  FABRIC_LOADER_VERSION: z.string().regex(/^[0-9.]{1,40}$/).default('0.19.5'),
  MINECRAFT_MEMORY_MB: z.coerce.number().int().min(1024).max(8192).default(4096),
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
    port: 25565, upstreamPort: 25566,
    joined: async ip => { joins.push({ id: randomUUID(), ip }); if (joins.length > 100) joins.shift(); },
    failure: () => record('The Minecraft gateway reported a connection error.'),
  }) : undefined;
  const javaPaths = { 8: configuration.JAVA8_PATH, 17: configuration.JAVA17_PATH, 21: configuration.JAVA21_PATH, 25: configuration.JAVA_PATH };
  const installerFor = (directory: string, log: (line: string) => void) => dependencies.installationFactory?.(directory, log) ?? dependencies.installations ?? new LoaderInstallation({ directory, javaPaths, log });
  async function runtimeFor(root: string) {
    await assertInstallationPresent(root);
    const directory = path.join(root, 'minecraft');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const server = new MinecraftServer({ directory, java: configuration.JAVA_PATH, javaPaths, loaderVersion: configuration.FABRIC_LOADER_VERSION, memoryMb: configuration.MINECRAFT_MEMORY_MB,
      version: configuration.MINECRAFT_VERSION, address: configuration.MINECRAFT_ADDRESS, activity: record,
      requireOnlineMode: Boolean(gateway), onLog: line => gateway?.observeLog(line),
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
  let mutationRevision = 0;
  const backupJobs = new Map<string, { job: BackupJob; artifact?: BackupArtifact }>();
  const backupTasks = new Set<Promise<void>>();
  let backupDownloads = 0;
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
  async function exclusive<T>(operation: () => Promise<T>, fileWrite = false, runtime = activeRuntime): Promise<T> {
    assertProfile();
    if (working) throw Object.assign(new Error('Another server or file operation is in progress.'), { statusCode: 409 });
    if (fileWrite && !isolated) throw Object.assign(new Error('File changes require the isolated Minecraft container.'), { statusCode: 409 });
    if (fileWrite && !['stopped', 'not-installed', 'failed'].includes(runtime.server.status().state)) {
      throw Object.assign(new Error('Stop the Minecraft server before changing modpack files.'), { statusCode: 409 });
    }
    working = true;
    mutationRevision++;
    try { return await operation(); } finally { working = false; }
  }
  async function workspaceRuntime(fallback = false) {
    let id = profileContext.getStore()?.workspaceId ?? profiles.activeId();
    if (fallback && !(await listProfiles()).profiles.some(profile => profile.id === id)) id = profiles.activeId();
    return { id, runtime: await runtimeForProfile(id) };
  }
  async function workspaceOperation<T>(operation: (runtime: Runtime) => Promise<T>, fileWrite = true): Promise<T> {
    const { id, runtime } = await workspaceRuntime();
    return exclusive(async () => {
      profiles.directoryFor(id);
      const result = await operation(runtime);
      if (fileWrite) await runtime.changes.changed();
      return result;
    }, fileWrite, runtime);
  }
  async function workspaceUpload<T>(operation: (runtime: Runtime, newModOnly: boolean) => Promise<T>, completed = false): Promise<T> {
    const { id, runtime } = await workspaceRuntime();
    return exclusive(async () => {
      assertIsolated();
      profiles.directoryFor(id);
      const state = runtime.server.status().state;
      if (!['stopped', 'not-installed', 'failed', 'running'].includes(state) || runtime.server.status().busy) throw Object.assign(new Error('Wait for the selected server operation to finish before uploading files.'), { statusCode: 409 });
      const result = await operation(runtime, state === 'running');
      if (completed) await runtime.changes.changed();
      return result;
    }, false, runtime);
  }
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
  function scheduleProfile(operation: () => Promise<void>) {
    assertProfile();
    assertIsolated();
    if (working || server.status().busy) throw Object.assign(new Error('Wait for the current operation to finish before changing saved servers.'), { statusCode: 409 });
    profileError = undefined;
    profileTask = exclusive(operation).catch(error => {
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
    if (!['/status', '/versions', '/backups/:id', '/backups/:id/download'].includes(request.routeOptions.url ?? '')) assertProfile();
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid controller request.' });
    const failure = error as Error & { statusCode?: number };
    const status = failure.statusCode && failure.statusCode >= 400 && failure.statusCode < 600 ? failure.statusCode : 500;
    reply.code(status).send({ error: status === 500 ? 'Controller operation failed. Check the server logs.' : failure.message });
  });
  app.get('/health', async () => ({ ok: true }));
  function runtimeStatus(runtime: Runtime) {
    return { ...runtime.server.status(), busy: working || runtime.server.status().busy, ...(runtime.installationError ? { installationError: runtime.installationError } : {}) };
  }
  app.get('/status', async () => {
    const { id, runtime } = await workspaceRuntime(true);
    const saved = await listProfiles();
    return { server: { ...runtimeStatus(activeRuntime), ...(profileError ? { profileError } : {}) }, workspace: { profileId: id, server: runtimeStatus(runtime), updatedAt: runtime.changes.updatedAt }, profiles: saved, profileBindingRequired: profiles.requiresProfileBinding(), isolated, activity, joins };
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
    });
    return reply.code(202).send({ accepted: true });
  });
  app.post('/profiles/select', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).strict().parse(request.body);
    profiles.directoryFor(id);
    scheduleProfile(() => activate(id));
    return reply.code(202).send({ accepted: true });
  });
  app.post('/profiles/rename', async request => {
    const { id, name } = z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(64) }).strict().parse(request.body);
    assertIsolated();
    await exclusive(() => profiles.rename(id, name));
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
    });
    record('Removed an inactive saved server. Its files remain in recovery storage.');
    return listProfiles();
  });
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
      await runtime.installations.install(target);
      await runtime.server.initialize();
      await runtime.changes.changed();
      record(`Installed Minecraft ${target.minecraftVersion} with ${target.loader} ${target.loaderVersion}. Server remains stopped.`);
    }, true, runtime).catch(error => {
      runtime.installationError = error instanceof Error ? error.message : 'Server installation failed.';
      runtime.server.appendLog(`[Installation] ${runtime.installationError}`);
      record(`Server installation failed: ${runtime.installationError}`);
    });
    return reply.code(202).send({ accepted: true });
  });
  app.post('/action', { bodyLimit: 256 * 1024 }, async request => {
    const body = z.object({ action: z.enum(['start', 'stop', 'restart', 'backup', 'update', 'sync-profile']), downloads: z.array(downloadSchema).max(150).optional() }).strict().parse(request.body);
    await exclusive(async () => {
      await server.action(body.action, async () => {
        if (!body.downloads) throw new Error('No verified mod download list was provided.');
        return body.downloads;
      });
      if (body.action === 'update' || body.action === 'sync-profile') await activeRuntime.changes.changed();
    });
    return { completed: true };
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
    const entry: { job: BackupJob; artifact?: BackupArtifact } = { job };
    const runtime = activeRuntime;
    backupJobs.set(job.id, entry);
    const task = exclusive(async () => {
      await runtime.files.close();
      const snapshot = await runtime.server.action('backup');
      if (!snapshot) throw new Error('The backup did not produce a saved snapshot.');
      entry.artifact = await createBackupArchive(snapshot);
      job.filename = `dictionary-minecraft-backup-${path.basename(snapshot)}.tar.gz`;
      job.state = 'ready';
      record('A server backup is saved and ready to download.');
    }).catch(error => {
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
    if (entry.job.state !== 'ready' || !entry.artifact) throw Object.assign(new Error(entry.job.error ?? 'This backup is still being prepared.'), { statusCode: 409 });
    if (backupDownloads >= 2) throw Object.assign(new Error('Two backup downloads are already in progress. Try again shortly.'), { statusCode: 429 });
    backupDownloads++;
    let released = false;
    const release = () => { if (!released) { released = true; backupDownloads--; } };
    try {
      const archive = await downloadBackup(entry.artifact);
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
    const result = await workspaceOperation(runtime => runtime.files.createDirectory(path));
    record(`Created folder ${path}`);
    return result;
  });
  app.post('/workspace/entries/move', async request => {
    const { path, destination } = z.object({ path: filePathSchema, destination: filePathSchema }).strict().parse(request.body);
    const result = await workspaceOperation(runtime => runtime.files.move(path, destination));
    record(`Moved ${path} to ${destination}`);
    return result;
  });
  app.post('/workspace/entries/remove', async request => {
    const { path } = z.object({ path: filePathSchema }).strict().parse(request.body);
    const result = await workspaceOperation(runtime => runtime.files.remove(path));
    record(`Moved ${path} to recovery storage`);
    return result;
  });
  app.post('/workspace/mods/action', async request => {
    const body = z.object({ path: filePathSchema, action: z.enum(['enable', 'disable', 'uninstall']) }).strict().parse(request.body);
    const result = await workspaceOperation(runtime => runtime.files.modAction(body.path, body.action));
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
      files: z.array(z.never()).length(0), overrides: z.literal('overrides'),
    }).strict() }).strict().parse(request.body);
    const archive = await workspaceOperation(async runtime => {
      const target = runtime.server.status();
      if (!['stopped', 'not-installed', 'failed', 'running'].includes(target.state)) throw Object.assign(new Error('Wait for the selected Minecraft server operation before downloading the modpack.'), { statusCode: 409 });
      if (manifest.minecraft.version !== target.version || manifest.minecraft.modLoaders[0]?.id !== `${target.loader.toLowerCase()}-${target.loaderVersion}`) {
        throw Object.assign(new Error('The pack target does not match the installed server.'), { statusCode: 409 });
      }
      return runtime.files.exportArchive(manifest);
    }, false);
    return reply.type('application/zip').header('Content-Length', archive.length).send(archive);
  });
  app.addHook('onReady', async () => {
    await gateway?.listen();
    if (configuration.MINECRAFT_AUTOSTART === 'true') void exclusive(() => server.action('start')).catch(() => record('Automatic Minecraft startup failed.'));
  });
  app.addHook('onClose', async () => {
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
