import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import Fastify, { LogController, type FastifyRequest } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { z } from 'zod';
import { CurseForgeClient } from './curseforge.js';
import { PackService } from './modpack.js';
import { MinecraftServer, type MinecraftDependencies, normalizeConsoleCommand } from './minecraft.js';
import { IpAccess } from './ip-access.js';
import { MinecraftGateway } from './minecraft-gateway.js';
import { LocalProfileService, validateProfilePath, type LocalProfileSnapshot } from './local-profile.js';
import { ModpackFiles } from './modpack-files.js';
import { ControllerClient } from './controller-client.js';
import { backupIdSchema } from './backup-history.js';
import { withSecrets } from './secrets.js';
import { inviteCookie, validInviteCookie } from './invite-session.js';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1024).max(65535).default(3000),
  PUBLIC_ORIGIN: z.string().url().default('https://mc.modpack.aron.best'),
  PORTFOLIO_HOSTS: z.string().default('aron.best,www.aron.best'),
  TRUST_PROXY: z.string().default('127.0.0.1,::1'),
  IP_GRANTS: z.enum(['true', 'false']).default('true'),
  CONTROLLER_URL: z.string().url().optional(),
  CONTROLLER_TOKEN: z.string().optional(),
  RUNTIME_DIRECTORY: z.string().default('.runtime'),
  FRIEND_ACCESS_TOKEN: z.string().default(''),
  MINECRAFT_VERSION: z.string().regex(/^[a-zA-Z0-9.\-]+$/).default('26.3'),
  FABRIC_LOADER_VERSION: z.string().regex(/^[0-9.]+$/).default('0.19.5'),
  JAVA_PATH: z.string().default('/opt/homebrew/opt/openjdk@25/bin/java'),
  MINECRAFT_MEMORY_MB: z.coerce.number().int().min(1024).max(65536).default(4096),
  MINECRAFT_START_TIMEOUT_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
  MINECRAFT_ADDRESS: z.string().default('mc.aron.best'),
  WORKSHOP_NAME: z.string().min(1).max(100).default('Dictionary Minecraft Server'),
  MINECRAFT_AUTOSTART: z.enum(['true', 'false']).default('false'),
  MINECRAFT_GATEWAY: z.enum(['true', 'false']).default('false'),
  CURSEFORGE_API_KEY: z.string().optional(),
  CURSEFORGE_UPLOAD_TOKEN: z.string().optional(),
  CURSEFORGE_PROJECT_ID: z.string().optional(),
  CURSEFORGE_EXPORT_PATH: z.string().optional(),
  CURSEFORGE_PROFILE_PATH: z.string().optional(),
});
export type Configuration = z.infer<typeof environmentSchema>;
export function readConfiguration(environment: NodeJS.ProcessEnv = process.env): Configuration { return environmentSchema.parse(withSecrets(environment)); }

/**
 * The page strangers see on the workshop host. It never includes the
 * application bundle. If the visitor arrived through an invitation link, the
 * fragment token is redeemed for this network and the page reloads into the app.
 */
function gatePage(nonce: string, configuration: Configuration): string {
  const address = configuration.MINECRAFT_ADDRESS.replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value]!);
  const access = configuration.IP_GRANTS === 'true' ? `Join <code>${address}</code> in Minecraft from this network, or open the invite link you were given, and it unlocks for you.` : 'Open the invite link you were given to unlock both Basic and Advanced.';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>The Workshop</title>
<style nonce="${nonce}">html{background:#15191a;color:#eef0ea;font:15px/1.7 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif}
main{max-width:520px;margin:18vh auto 0;padding:0 24px}.eyebrow{font:10px/1.5 "SFMono-Regular",Consolas,monospace;letter-spacing:.12em;color:#869282}
h1{font-size:40px;line-height:1.05;letter-spacing:-.04em;font-weight:500;margin:14px 0 18px}p{color:#a1ac9c;margin:0 0 14px}code{color:#d3e3c5}
#message{color:#c8f87a;min-height:1.5em}</style></head><body><main><p class="eyebrow">THE WORKSHOP</p><h1>Friends only.</h1>
<p id="message"></p><p>This page belongs to a private Minecraft server. ${access}</p></main>
<script nonce="${nonce}">(function(){var f=new URLSearchParams(location.hash.slice(1)),t=f.get('invite'),m=document.getElementById('message');if(!t)return;m.textContent='Checking your invitation...';
fetch('/api/access/redeem',{method:'POST',headers:{'Authorization':'Bearer '+t,'Content-Type':'application/json'},body:'{}'}).then(function(r){if(r.ok){history.replaceState(null,'',location.pathname);location.reload();}else{m.textContent='That invitation is not valid anymore. Ask for a new link.';}}).catch(function(){m.textContent='Could not reach the workshop. Try again in a moment.';});})();</script></body></html>`;
}

function authorized(request: FastifyRequest, secret: string) {
  if (secret.length < 32) return false;
  const candidate = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
  if (candidate.length > 256) return false;
  return timingSafeEqual(createHash('sha256').update(candidate).digest(), createHash('sha256').update(secret).digest());
}

export async function createApp(configuration = readConfiguration(), dependencies: { minecraft?: Partial<MinecraftDependencies> } = {}) {
  const runtimeDirectory = path.resolve(configuration.RUNTIME_DIRECTORY);
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const ipAccess = new IpAccess(path.join(runtimeDirectory, 'ip-access.json'));
  await ipAccess.initialize();
  const hasAccess = (request: FastifyRequest) => authorized(request, configuration.FRIEND_ACCESS_TOKEN)
    || validInviteCookie(request.headers.cookie, configuration.FRIEND_ACCESS_TOKEN)
    || (configuration.IP_GRANTS === 'true' && ipAccess.allows(request.ip));
  const app = Fastify({
    logger: configuration.NODE_ENV === 'test' ? false : { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'] },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 16 * 1024, requestTimeout: 30_000, connectionTimeout: 10_000,
    keepAliveTimeout: 5_000, maxRequestsPerSocket: 100,
    trustProxy: configuration.TRUST_PROXY.split(',').map(value => value.trim()).filter(Boolean),
  });
  await app.register(helmet, { contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    fontSrc: ["'self'", 'https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:', 'https://*.forgecdn.net'],
    connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'self'"],
    upgradeInsecureRequests: configuration.NODE_ENV === 'production' ? [] : null,
  } }, referrerPolicy: { policy: 'no-referrer' } });
  await app.register(rateLimit, { max: 90, timeWindow: '1 minute', cache: 5000, allowList: [], errorResponseBuilder: () => ({ statusCode: 429, code: 'RATE_LIMITED', message: 'Too many requests. Try again in a minute.' }) });
  const activity: { id: string; message: string; timestamp: string }[] = [];
  const record = (message: string) => {
    activity.unshift({ id: crypto.randomUUID(), message, timestamp: new Date().toISOString() });
    activity.splice(60);
  };
  const gateway = configuration.MINECRAFT_GATEWAY === 'true' && !configuration.CONTROLLER_URL ? new MinecraftGateway({
    port: 25565, upstreamPort: 25566,
    joined: async ip => { if (configuration.IP_GRANTS === 'true') { await ipAccess.grant(ip, 'minecraft'); record('A player joined Minecraft and their network received workshop access.'); } },
    failure: error => { app.log.error({ message: (error as Error).message }, 'Minecraft gateway access failed'); },
  }) : undefined;
  const client = new CurseForgeClient({ apiKey: configuration.CURSEFORGE_API_KEY, uploadToken: configuration.CURSEFORGE_UPLOAD_TOKEN });
  const projectId = configuration.CURSEFORGE_PROJECT_ID ? z.coerce.number().int().positive().parse(configuration.CURSEFORGE_PROJECT_ID) : undefined;
  const localProfile = new LocalProfileService(configuration.CONTROLLER_URL ? undefined : validateProfilePath(configuration.CURSEFORGE_PROFILE_PATH));
  const pack = new PackService({ statePath: path.join(runtimeDirectory, 'pack.json'), name: configuration.WORKSHOP_NAME, client,
    minecraftVersion: configuration.MINECRAFT_VERSION, loader: 'Fabric', loaderVersion: configuration.FABRIC_LOADER_VERSION,
    publishProjectId: projectId, publishArchivePath: configuration.CURSEFORGE_EXPORT_PATH || undefined });
  const remote = configuration.CONTROLLER_URL ? new ControllerClient(configuration.CONTROLLER_URL, configuration.CONTROLLER_TOKEN ?? '') : undefined;
  app.addHook('onRequest', (request, _reply, done) => {
    if (!remote) { done(); return; }
    const profile = z.string().uuid().optional().parse(request.headers['x-server-profile']);
    const workspaceProfile = z.string().uuid().optional().parse(request.headers['x-workspace-profile']);
    remote.forProfile(profile, done, workspaceProfile);
  });
  const minecraft = remote ?? new MinecraftServer({ directory: path.join(runtimeDirectory, 'minecraft'), java: configuration.JAVA_PATH,
    memoryMb: configuration.MINECRAFT_MEMORY_MB, version: configuration.MINECRAFT_VERSION, address: configuration.MINECRAFT_ADDRESS, activity: record,
    onLog: line => gateway?.observeLog(line), requireOnlineMode: Boolean(gateway), startTimeoutMs: configuration.MINECRAFT_START_TIMEOUT_SECONDS * 1000 }, dependencies.minecraft);
  await minecraft.initialize();
  const workspace = remote?.workspace ?? new ModpackFiles(path.join(runtimeDirectory, 'minecraft'));
  const observedJoins = new Set<string>();
  let joinPoll: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  async function collectJoins() {
    if (!remote || configuration.IP_GRANTS !== 'true' || polling) return;
    polling = true;
    try {
      const controller = await remote.refresh();
      for (const join of controller.joins) {
        if (observedJoins.has(join.id)) continue;
        await ipAccess.grant(join.ip, 'minecraft');
        observedJoins.add(join.id);
      }
      const retained = new Set(controller.joins.map(join => join.id));
      for (const id of observedJoins) if (!retained.has(id)) observedJoins.delete(id);
    } finally { polling = false; }
  }
  let globalWindow = Date.now(); let globalRequests = 0; let jobRunning = false; let packMutationRunning = false;
  let jobOperation: string | undefined;
  async function mutatePack<T>(operation: () => Promise<T>): Promise<T> {
    if (packMutationRunning) throw Object.assign(new Error('A pack change is already being processed. Try again when it finishes.'), { statusCode: 409 });
    packMutationRunning = true;
    try { return await operation(); } finally { packMutationRunning = false; }
  }
  async function assertWorkspaceWritable(allowNewMod = false) {
    const controller = await remote?.refresh();
    if (!controller?.isolated) throw Object.assign(new Error('File changes require the isolated Minecraft container.'), { statusCode: 409 });
    const selected = controller.workspace;
    const activeJob = jobRunning && selected.profileId === controller.profiles.activeId;
    if (activeJob || packMutationRunning || selected.server.busy || !['stopped', 'not-installed', 'failed', ...(allowNewMod ? ['running'] : [])].includes(selected.server.state)) {
      throw Object.assign(new Error('Stop the server being edited and wait for its current operation before changing workspace files.'), { statusCode: 409 });
    }
  }
  const publicHostname = new URL(configuration.PUBLIC_ORIGIN).hostname;
  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  app.addHook('onRequest', async (request, reply) => {
    const hostname = request.hostname.toLowerCase();
    const isLocal = localHosts.has(hostname);
    const allowed = [...configuration.PORTFOLIO_HOSTS.split(',').map(value => value.trim().toLowerCase()), publicHostname].includes(hostname) || isLocal;
    if (!allowed) return reply.code(421).send({ error: 'Unknown host.' });
    const route = request.routeOptions.url ?? '';
    if (!route.startsWith('/api/')) {
      // The workshop host is friends-only from the first byte: no bundle, no status, only the gate.
      if (hostname === publicHostname && !hasAccess(request)) {
        const nonce = randomBytes(16).toString('base64');
        return reply.code(200)
          .header('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`)
          .header('Cache-Control', 'no-store').header('X-Robots-Tag', 'noindex, nofollow')
          .type('text/html; charset=utf-8').send(gatePage(nonce, configuration));
      }
      return;
    }
    if (Date.now() - globalWindow > 60_000) { globalWindow = Date.now(); globalRequests = 0; }
    if (++globalRequests > 1200) return reply.code(503).send({ error: 'The server is busy. Try again shortly.' });
    if (hostname !== publicHostname && !isLocal) return reply.code(404).send({ error: 'Not found.' });
    reply.header('Cache-Control', 'no-store');
    if (route === '/api/health') return;
    if (!hasAccess(request)) return reply.code(401).send({ error: 'Redeem an invitation or join the Minecraft server from this network to unlock controls.' });
    if (!['GET', 'HEAD'].includes(request.method)) {
      const origin = request.headers.origin;
      const devOrigins = ['http://localhost:4200', 'http://127.0.0.1:4200', 'http://localhost:3000', 'http://127.0.0.1:3000'];
      const acceptable = origin === configuration.PUBLIC_ORIGIN || (isLocal && origin && devOrigins.includes(origin));
      if (!acceptable) return reply.code(403).send({ error: 'The request must come from the workshop page.' });
      if (route.startsWith('/api/workspace/') || route === '/api/server/profiles/restore') request.raw.setTimeout?.(15 * 60_000);
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'Some request fields are missing or invalid.' });
    const failure = error as Error & { statusCode?: number; code?: string };
    const status = failure.statusCode && failure.statusCode >= 400 && failure.statusCode < 600 ? failure.statusCode : 500;
    if (status >= 500) app.log.error({ message: failure.message, code: failure.code }, 'Operation failed');
    return reply.code(status).send({ error: status === 500 ? 'The operation could not be completed. Check the local service log.' : failure.message });
  });
  app.get('/api/health', async () => ({ ok: true }));
  app.post('/api/access/redeem', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    z.object({}).strict().parse(request.body);
    if (!authorized(request, configuration.FRIEND_ACCESS_TOKEN)) return reply.code(401).send({ error: 'This invitation is invalid or has been rotated.' });
    if (configuration.IP_GRANTS === 'true') await ipAccess.grant(request.ip, 'invite');
    reply.header('Set-Cookie', inviteCookie(configuration.FRIEND_ACCESS_TOKEN, new URL(configuration.PUBLIC_ORIGIN).protocol === 'https:'));
    return { authorized: true };
  });
  app.get('/api/status', async request => {
    const controller = await remote?.refresh();
    const permitted = hasAccess(request);
    const current = await pack.getPack();
    const server = controller?.server ?? minecraft.status();
    const target = controller?.workspace.server ?? server;
    // Crash reports list the host's paths and mods, so only friends with access see them.
    const crash = permitted && server.failure ? await (remote && controller ? remote.forProfile(controller.profiles.activeId, () => remote.latestCrashReport()).catch(() => null) : minecraft.latestCrashReport()) : null;
    const relevant = crash && server.failure && Date.parse(crash.createdAt) >= Date.parse(server.failure.at) - 5 * 60_000;
    const crashLog = relevant ? [`# ${crash.file} (${crash.createdAt})`, ...crash.lines] : permitted && server.failure ? (await (remote && controller ? remote.forProfile(controller.profiles.activeId, () => remote.logs()).catch(() => []) : minecraft.logs())).slice(-80) : undefined;
    const operation = controller?.server.operation ?? jobOperation;
    return { server: { ...server, ...(operation ? { operation } : {}), ...(crashLog ? { crashLog } : {}) }, ...(controller ? { profiles: controller.profiles, workspace: controller.workspace } : {}), pack: { ...current, name: configuration.WORKSHOP_NAME, ...(remote ? { minecraftVersion: target.version, loader: target.loader, loaderVersion: target.loaderVersion } : {}) }, history: current.history, requests: current.requests,
      capabilities: { authorized: permitted, workspaceWrite: Boolean(remote?.isolated), ipWhitelisted: configuration.IP_GRANTS === 'true' && ipAccess.allows(request.ip), joinAccess: configuration.IP_GRANTS === 'true' && Boolean(gateway || remote), curseforgeSearch: client.configured, localProfile: localProfile.configured, publish: Boolean(client.publishingConfigured && projectId && configuration.CURSEFORGE_EXPORT_PATH), update: Boolean(client.configured && projectId), server: minecraft.status().state !== 'not-installed' },
      activity: permitted ? [...activity, ...(controller?.activity ?? [])].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 60) : [], jobRunning: jobRunning || server.busy };
  });
  const searchCache = new Map<string, { expires: number; mods: Awaited<ReturnType<PackService['search']>> }>();
  app.get('/api/mods/search', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async request => {
    const { q } = z.object({ q: z.string().trim().max(100).default('') }).parse(request.query);
    const cached = searchCache.get(q);
    if (cached && cached.expires > Date.now()) return { mods: cached.mods };
    const mods = await pack.search(q);
    if (searchCache.size >= 100) searchCache.clear();
    searchCache.set(q, { expires: Date.now() + 60_000, mods });
    return { mods };
  });
  app.post('/api/pack/mods', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async request => {
    const { modId } = z.object({ modId: z.number().int().positive() }).strict().parse(request.body);
    const result = await mutatePack(() => pack.add(modId)); record(`Added a mod and its required dependencies.`); return result;
  });
  app.delete('/api/pack/mods/:id', async request => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const result = await mutatePack(() => pack.remove(id)); record('Removed a mod from the draft.'); return result;
  });
  app.post('/api/pack/export', async () => pack.exportManifest());
  app.get('/api/pack/download', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (_request, reply) => {
    const manifest = await pack.exportManifest();
    const controller = await remote?.refresh();
    const target = controller?.workspace.server ?? minecraft.status();
    // Every installed mod ships as a JAR under overrides so the pack imports without any CurseForge lookups; files stays empty.
    const archive = remote ? await remote.workspace.exportArchive({ ...manifest, minecraft: { version: target.version, modLoaders: [{ id: `${target.loader.toLowerCase()}-${target.loaderVersion}`, primary: true }] }, name: configuration.WORKSHOP_NAME, files: [], version: manifest.version }) : undefined;
    const localArchive = archive ? undefined : await pack.exportArchive();
    return reply
      .type('application/zip')
      .header('Content-Disposition', 'attachment; filename="dictionary-minecraft-server.zip"')
      .header('Content-Length', String(archive?.size ?? localArchive!.length))
      .send(archive?.stream ?? localArchive);
  });
  app.post('/api/pack/requests', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async request => {
    const { url } = z.object({ url: z.string().trim().min(1).max(2048) }).strict().parse(request.body);
    const result = await mutatePack(() => pack.requestMod(url));
    record(result.status === 'installed' ? 'A friend requested a mod that is already installed.' : 'A friend requested a mod link for the host to install through the CurseForge App.');
    return result;
  });
  app.get('/api/workspace/files', { config: { rateLimit: { max: 40, timeWindow: '1 minute' } } }, async () => workspace.list());
  app.get('/api/workspace/mods', async () => workspace.listMods());
  app.post('/api/workspace/directories', async request => {
    await assertWorkspaceWritable();
    const { path } = z.object({ path: z.string().min(1).max(320) }).strict().parse(request.body);
    return workspace.createDirectory(path);
  });
  app.post('/api/workspace/entries/move', async request => {
    await assertWorkspaceWritable();
    const { path, destination } = z.object({ path: z.string().min(1).max(320), destination: z.string().min(1).max(320) }).strict().parse(request.body);
    return workspace.move(path, destination);
  });
  app.post('/api/workspace/entries/remove', async request => {
    await assertWorkspaceWritable();
    const { path } = z.object({ path: z.string().min(1).max(320) }).strict().parse(request.body);
    return workspace.remove(path);
  });
  app.post('/api/workspace/mods/action', async request => {
    await assertWorkspaceWritable();
    const body = z.object({ path: z.string().min(1).max(320), action: z.enum(['enable', 'disable', 'uninstall']) }).strict().parse(request.body);
    return workspace.modAction(body.path, body.action);
  });
  app.get('/api/workspace/files/text', { config: { rateLimit: { max: 40, timeWindow: '1 minute' } } }, async request => {
    const { path: filePath } = z.object({ path: z.string().trim().min(1).max(320) }).parse(request.query);
    return workspace.text(filePath);
  });
  app.get('/api/workspace/files/download', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { path: filePath } = z.object({ path: z.string().trim().min(1).max(320) }).parse(request.query);
    const file = await workspace.download(filePath);
    return reply
      .type('application/octet-stream')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`)
      .header('Content-Length', String(file.size))
      .send(file.stream);
  });
  app.put('/api/workspace/files/text', { bodyLimit: 800_000, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async request => {
    await assertWorkspaceWritable();
    const body = z.object({ path: z.string().trim().min(1).max(320), contents: z.string().max(256 * 1024), revision: z.string().min(1).max(128) }).strict().parse(request.body);
    const file = await workspace.writeText(body.path, body.contents, body.revision);
    record(`Advanced workspace saved ${file.path}.`);
    return file;
  });
  app.post('/api/workspace/uploads', { config: { rateLimit: { max: 20, timeWindow: '5 minutes' } } }, async request => {
    await assertWorkspaceWritable(true);
    const body = z.object({ path: z.string().trim().min(1).max(320), size: z.number().int().positive().max(128 * 1024 * 1024), replace: z.boolean().default(false) }).strict().parse(request.body);
    return workspace.beginUpload(body.path, body.size, body.replace, request.ip);
  });
  app.post('/api/workspace/uploads/:id/chunks', { bodyLimit: 800_000, config: { rateLimit: { max: 400, timeWindow: '5 minutes' } } }, async request => {
    await assertWorkspaceWritable(true);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ index: z.number().int().nonnegative(), data: z.string().min(1).max(750_000) }).strict().parse(request.body);
    return workspace.appendUpload(id, body.index, body.data, request.ip);
  });
  app.post('/api/workspace/uploads/:id/complete', { config: { rateLimit: { max: 20, timeWindow: '5 minutes' } } }, async request => {
    await assertWorkspaceWritable(true);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    z.object({}).strict().parse(request.body);
    const file = await workspace.finishUpload(id, request.ip);
    record(`Advanced workspace uploaded ${file.path}.`);
    return file;
  });
  app.delete('/api/workspace/uploads/:id', { config: { rateLimit: { max: 30, timeWindow: '5 minutes' } } }, async request => {
    if (!remote) throw Object.assign(new Error('File changes require the isolated Minecraft container.'), { statusCode: 409 });
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await workspace.cancelUpload(id, request.ip);
    return { cancelled: true };
  });
  app.post('/api/pack/import-local', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async request => {
    z.object({}).strict().parse(request.body);
    const snapshot = await localProfile.inspect();
    const result = await mutatePack(() => pack.importLocalProfile(snapshot.pack));
    record(`Imported ${snapshot.files.length} mods from the host's CurseForge App profile into the draft.`);
    return result;
  });
  app.post('/api/pack/publish', { config: { rateLimit: { max: 3, timeWindow: '1 hour' } } }, async request => {
    const body = z.object({ displayName: z.string().trim().min(1).max(100), changelog: z.string().trim().min(1).max(8000) }).strict().parse(request.body);
    const result = await mutatePack(() => pack.publish(body.displayName, body.changelog)); record('Release submitted to CurseForge for review.'); return result;
  });
  for (const action of ['create', 'select', 'rename', 'remove', 'restore'] as const) {
    app.post(action === 'create' ? '/api/server/profiles' : `/api/server/profiles/${action}`, { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
      if (!remote || !(await remote.refresh()).isolated) throw Object.assign(new Error('Saved servers require the isolated Minecraft container.'), { statusCode: 409 });
      const name = z.string().trim().min(1).max(64);
      const id = z.string().uuid();
      const body = (action === 'create' ? z.object({ name }) : action === 'rename' ? z.object({ id, name }) : z.object({ id })).strict().parse(request.body);
      const result = await remote.profile(action, body);
      return reply.code(action === 'create' || action === 'select' ? 202 : 200).send(result);
    });
  }
  app.get('/api/server/versions', { config: { rateLimit: { max: 40, timeWindow: '1 minute' } } }, async request => {
    if (!remote) throw Object.assign(new Error('Version changes require the isolated Minecraft container.'), { statusCode: 409 });
    const { minecraftVersion } = z.object({ minecraftVersion: z.string().regex(/^[0-9.]{1,40}$/).optional() }).strict().parse(request.query);
    return remote.versions(minecraftVersion);
  });
  app.post('/api/server/installation', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (request, reply) => {
    await assertWorkspaceWritable();
    const target = z.object({ minecraftVersion: z.string().regex(/^[0-9.]{1,40}$/), loader: z.enum(['Fabric', 'Forge', 'NeoForge', 'Quilt']), loaderVersion: z.string().regex(/^[A-Za-z0-9.+_-]{1,100}$/) }).strict().parse(request.body);
    return reply.code(202).send(await remote!.install(target));
  });
  app.get('/api/server/logs', async () => ({ lines: await minecraft.logs() }));

  // Live updates: each browser keeps one open connection and the API pushes a
  // "status" event when the server's state changes and a "log" event with the
  // new log lines, checked once a second while anyone is connected.
  type LiveClient = { send: (event: string, data: unknown) => void; end: () => void; keepalive?: NodeJS.Timeout; lastLines: string[]; lastSnapshot: string };
  const liveClients = new Set<LiveClient>();
  let liveTicker: NodeJS.Timeout | undefined;
  const logDelta = (previous: string[], current: string[]): { reset: boolean; lines: string[] } => {
    if (!previous.length) return { reset: true, lines: current };
    const anchor = previous[previous.length - 1];
    const before = previous.length > 1 ? previous[previous.length - 2] : undefined;
    for (let index = current.length - 1; index >= 0; index--) {
      if (current[index] === anchor && (before === undefined || index === 0 || current[index - 1] === before)) return { reset: false, lines: current.slice(index + 1) };
    }
    return { reset: true, lines: current };
  };
  const liveTick = async () => {
    if (!liveClients.size) return;
    try {
      const controller = await remote?.refresh();
      const server = controller?.server ?? minecraft.status();
      const snapshot = JSON.stringify({ state: server.state, busy: server.busy, operation: controller?.server.operation ?? jobOperation ?? null, jobRunning: jobRunning || server.busy,
        failure: server.failure?.at ?? null, lastBackup: server.lastBackup, players: server.players?.online ?? null, active: controller?.profiles.activeId ?? null,
        installationError: controller?.server.installationError ?? null, activity: activity[0]?.id ?? null });
      const lines = await minecraft.logs();
      for (const client of liveClients) {
        if (client.lastSnapshot !== snapshot) { client.lastSnapshot = snapshot; client.send('status', JSON.parse(snapshot)); }
        const delta = logDelta(client.lastLines, lines);
        if (delta.reset || delta.lines.length) client.send('log', delta);
        client.lastLines = lines;
      }
    } catch (error) { app.log.warn({ message: (error as Error).message }, 'Live update check failed'); }
  };
  app.get('/api/events', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (liveClients.size >= 32) return reply.code(503).send({ error: 'Too many live connections. Try again in a moment.' });
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    raw.write(': connected\n\n');
    const client: LiveClient = { lastLines: [], lastSnapshot: '', send: (event, data) => { raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }, end: () => raw.end() };
    client.keepalive = setInterval(() => raw.write(': keepalive\n\n'), 15_000);
    liveClients.add(client);
    if (!liveTicker) liveTicker = setInterval(() => { void liveTick(); }, 1_000);
    void liveTick();
    const release = () => {
      clearInterval(client.keepalive);
      liveClients.delete(client);
      if (!liveClients.size && liveTicker) { clearInterval(liveTicker); liveTicker = undefined; }
    };
    request.raw.once('close', release);
    raw.once('close', release);
  });
  app.addHook('onClose', async () => {
    for (const client of liveClients) { clearInterval(client.keepalive); client.end(); }
    liveClients.clear();
    if (liveTicker) { clearInterval(liveTicker); liveTicker = undefined; }
  });
  app.get('/api/server/recovery', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async () => {
    if (!remote) throw Object.assign(new Error('Recovery requires the isolated Minecraft container.'), { statusCode: 409 });
    return remote.recovery();
  });
  app.get('/api/server/recovery/backups/:profileId/:id/download', { config: { rateLimit: { max: 6, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const { profileId, id } = z.object({ profileId: z.string().uuid(), id: backupIdSchema }).parse(request.params);
    if (!remote) throw Object.assign(new Error('Recovery requires the isolated Minecraft container.'), { statusCode: 409 });
    request.raw.setTimeout?.(30 * 60_000);
    const archive = await remote.downloadSavedBackup(profileId, id);
    reply.raw.once('close', () => archive.stream.destroy());
    return reply.type('application/gzip').header('Content-Disposition', `attachment; filename="dictionary-minecraft-backup-${id}.tar.gz"`).header('Content-Length', archive.size).send(archive.stream);
  });
  app.post('/api/server/command', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async request => {
    const { command } = z.object({ command: z.string().min(1).max(300) }).strict().parse(request.body);
    const line = normalizeConsoleCommand(command);
    await remote?.assertProfile();
    if (remote) await remote.command(line); else minecraft.command(line);
    record(`Console command: ${line.slice(0, 120)}`);
    return { accepted: true };
  });
  app.post('/api/server/backups', { config: { rateLimit: { max: 4, timeWindow: '10 minutes' } } }, async (request, reply) => {
    z.object({}).strict().parse(request.body);
    if (!remote) throw Object.assign(new Error('Backup downloads require the isolated Minecraft container.'), { statusCode: 409 });
    if (jobRunning || packMutationRunning) throw Object.assign(new Error('Wait for the current server operation before creating a backup.'), { statusCode: 409 });
    return reply.code(202).send(await remote.createBackup());
  });
  app.get('/api/server/backups/:id', { config: { rateLimit: { max: 40, timeWindow: '1 minute' } } }, async request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    if (!remote) throw Object.assign(new Error('Backup downloads require the isolated Minecraft container.'), { statusCode: 409 });
    return remote.backup(id);
  });
  app.get('/api/server/backups/:id/download', { config: { rateLimit: { max: 6, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    if (!remote) throw Object.assign(new Error('Backup downloads require the isolated Minecraft container.'), { statusCode: 409 });
    request.raw.setTimeout?.(30 * 60_000);
    const job = await remote.backup(id);
    if (job.state !== 'ready' || !job.filename) throw Object.assign(new Error(job.error ?? 'This backup is still being prepared.'), { statusCode: 409 });
    const archive = await remote.downloadBackup(id);
    reply.raw.once('close', () => archive.stream.destroy());
    return reply.type('application/gzip')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(job.filename)}`)
      .header('Content-Length', archive.size)
      .send(archive.stream);
  });
  app.post('/api/server/action', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { action } = z.object({ action: z.enum(['start', 'stop', 'restart', 'backup', 'update', 'sync-profile']) }).strict().parse(request.body);
    await remote?.assertProfile();
    if (remote && (action === 'update' || action === 'sync-profile')) {
      await remote.refresh();
      const current = await pack.getPack();
      const target = remote.status();
      if (current.minecraftVersion !== target.version || current.loader !== target.loader || current.loaderVersion !== target.loaderVersion) return reply.code(409).send({ error: 'The saved CurseForge profile targets a different Minecraft or loader version. Install compatible mods for the selected server instead.' });
    }
    if (action === 'update' && (!client.configured || !projectId)) return reply.code(409).send({ error: 'A CurseForge API key and published project are required before updating from a release.' });
    if (action === 'sync-profile' && !localProfile.configured) return reply.code(409).send({ error: 'The host must configure the CurseForge App profile path before syncing.' });
    if (jobRunning) return reply.code(409).send({ error: 'A server operation is already running.' });
    jobRunning = true;
    jobOperation = { start: 'Starting server', stop: 'Shutting down server', restart: 'Restarting server', backup: 'Saving backup', update: 'Updating modpack', 'sync-profile': 'Syncing modpack' }[action];
    const label = action === 'sync-profile' ? 'App pack sync' : `Server ${action}`;
    record(`${label} requested.`);
    let synced: LocalProfileSnapshot | undefined;
    const resolveDownloads = async () => {
      if (action === 'sync-profile') {
        // Every file is inspected before the server is touched and hashed again while it is copied.
        const snapshot = await localProfile.inspect();
        const target = await pack.getPack();
        if (snapshot.pack.name !== target.name || snapshot.pack.minecraftVersion !== target.minecraftVersion
          || snapshot.pack.loader !== target.loader || snapshot.pack.loaderVersion !== target.loaderVersion) {
          throw Object.assign(new Error('The CurseForge App profile must match this pack name, Minecraft version, and loader before syncing.'), { statusCode: 409 });
        }
        synced = snapshot;
        record(`Staging ${snapshot.files.length} verified mods from the CurseForge App profile.`);
        return snapshot.files;
      }
      if (!projectId) throw Object.assign(new Error('Publish a CurseForge project before using Update latest.'), { statusCode: 409 });
      const release = await pack.resolveLatestRelease();
      record(`Staging published release ${release.version}.`);
      return release.downloads;
    };
    void minecraft.action(action, resolveDownloads).then(async () => {
      // The draft only changes after the server accepted the new files and restarted.
      if (synced) { await mutatePack(() => pack.importLocalProfile(synced!.pack)); record('The draft now matches the synced App profile.'); }
    }).catch(error => { record(`${label} failed: ${(error as Error).message}`); app.log.error({ message: (error as Error).message }, 'Server operation failed'); }).finally(() => { jobRunning = false; jobOperation = undefined; });
    return reply.code(202).send({ accepted: true, action });
  });
  const browserRoot = path.resolve('dist/aron-best/browser');
  app.get('/site-config.json', async request => ({ workshop: request.hostname.toLowerCase() === publicHostname }));
  if (await access(path.join(browserRoot, 'index.html')).then(() => true, () => false)) {
    await app.register(staticFiles, { root: browserRoot, index: ['index.html'], maxAge: '1h', setHeaders: (response, file) => {
      if (file.endsWith('index.html')) response.header('Cache-Control', 'no-cache');
    } });
  }
  app.setNotFoundHandler((request, reply) => reply.code(404).send({ error: 'Not found.' }));
  app.addHook('onReady', async () => {
    await gateway?.listen();
    if (remote && configuration.IP_GRANTS === 'true') {
      joinPoll = setInterval(() => { void collectJoins().catch(() => app.log.warn('Minecraft join synchronization is unavailable.')); }, 3000);
      joinPoll.unref();
    }
    if (configuration.MINECRAFT_AUTOSTART === 'true') void minecraft.action('start').catch(error => record(`Automatic startup failed: ${(error as Error).message}`));
  });
  app.addHook('onClose', async () => { if (joinPoll) clearInterval(joinPoll); await minecraft.shutdown(); await gateway?.close(); if (workspace instanceof ModpackFiles) await workspace.close(); });
  return app;
}
