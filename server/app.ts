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
import { MinecraftServer, type MinecraftDependencies } from './minecraft.js';
import { IpAccess } from './ip-access.js';
import { MinecraftGateway } from './minecraft-gateway.js';
import { LocalProfileService, validateProfilePath, type LocalProfileSnapshot } from './local-profile.js';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.literal('127.0.0.1').default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1024).max(65535).default(3000),
  PUBLIC_ORIGIN: z.string().url().default('https://mc.modpack.aron.best'),
  RUNTIME_DIRECTORY: z.string().default('.runtime'),
  FRIEND_ACCESS_TOKEN: z.string().default(''),
  MINECRAFT_VERSION: z.string().regex(/^[a-zA-Z0-9.\-]+$/).default('26.3'),
  FABRIC_LOADER_VERSION: z.string().regex(/^[0-9.]+$/).default('0.19.5'),
  JAVA_PATH: z.string().default('/opt/homebrew/opt/openjdk@25/bin/java'),
  MINECRAFT_MEMORY_MB: z.coerce.number().int().min(1024).max(8192).default(4096),
  MINECRAFT_ADDRESS: z.string().default('mc.aron.best'),
  MINECRAFT_AUTOSTART: z.enum(['true', 'false']).default('false'),
  MINECRAFT_GATEWAY: z.enum(['true', 'false']).default('false'),
  CURSEFORGE_API_KEY: z.string().optional(),
  CURSEFORGE_UPLOAD_TOKEN: z.string().optional(),
  CURSEFORGE_PROJECT_ID: z.string().optional(),
  CURSEFORGE_EXPORT_PATH: z.string().optional(),
  CURSEFORGE_PROFILE_PATH: z.string().optional(),
});
export type Configuration = z.infer<typeof environmentSchema>;
export function readConfiguration(environment: NodeJS.ProcessEnv = process.env): Configuration { return environmentSchema.parse(environment); }

/**
 * The page strangers see on the workshop host. It never includes the
 * application bundle. If the visitor arrived through an invitation link, the
 * fragment token is redeemed for this network and the page reloads into the app.
 */
function gatePage(nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>The Workshop</title>
<style nonce="${nonce}">html{background:#15191a;color:#eef0ea;font:15px/1.7 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif}
main{max-width:520px;margin:18vh auto 0;padding:0 24px}.eyebrow{font:10px/1.5 "SFMono-Regular",Consolas,monospace;letter-spacing:.12em;color:#869282}
h1{font-size:40px;line-height:1.05;letter-spacing:-.04em;font-weight:500;margin:14px 0 18px}p{color:#a1ac9c;margin:0 0 14px}code{color:#d3e3c5}
#message{color:#c8f87a;min-height:1.5em}</style></head><body><main><p class="eyebrow">THE WORKSHOP</p><h1>Friends only.</h1>
<p id="message"></p><p>This page belongs to a private Minecraft server. Join <code>mc.aron.best</code> in Minecraft from this network, or open the invite link you were given, and it unlocks for you.</p></main>
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
  const hasAccess = (request: FastifyRequest) => authorized(request, configuration.FRIEND_ACCESS_TOKEN) || ipAccess.allows(request.ip);
  const app = Fastify({
    logger: configuration.NODE_ENV === 'test' ? false : { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'] },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 16 * 1024, requestTimeout: 30_000, connectionTimeout: 10_000,
    keepAliveTimeout: 5_000, maxRequestsPerSocket: 100,
    trustProxy: ['127.0.0.1', '::1'],
  });
  await app.register(helmet, { contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    fontSrc: ["'self'", 'https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:', 'https://*.forgecdn.net'],
    connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'self'"],
    upgradeInsecureRequests: configuration.NODE_ENV === 'production' ? [] : null,
  } }, referrerPolicy: { policy: 'no-referrer' } });
  await app.register(rateLimit, { max: 90, timeWindow: '1 minute', cache: 5000, allowList: [], errorResponseBuilder: () => ({ error: 'Too many requests. Try again in a minute.' }) });
  const activity: { id: string; message: string; timestamp: string }[] = [];
  const record = (message: string) => {
    activity.unshift({ id: crypto.randomUUID(), message, timestamp: new Date().toISOString() });
    activity.splice(60);
  };
  const gateway = configuration.MINECRAFT_GATEWAY === 'true' ? new MinecraftGateway({
    port: 25565, upstreamPort: 25566,
    joined: async ip => { await ipAccess.grant(ip, 'minecraft'); record('A player joined Minecraft and their network received workshop access.'); },
    failure: error => { app.log.error({ message: (error as Error).message }, 'Minecraft gateway access failed'); },
  }) : undefined;
  const client = new CurseForgeClient({ apiKey: configuration.CURSEFORGE_API_KEY, uploadToken: configuration.CURSEFORGE_UPLOAD_TOKEN });
  const projectId = configuration.CURSEFORGE_PROJECT_ID ? z.coerce.number().int().positive().parse(configuration.CURSEFORGE_PROJECT_ID) : undefined;
  const localProfile = new LocalProfileService(validateProfilePath(configuration.CURSEFORGE_PROFILE_PATH));
  const pack = new PackService({ statePath: path.join(runtimeDirectory, 'pack.json'), name: 'After Hours', client,
    minecraftVersion: configuration.MINECRAFT_VERSION, loader: 'Fabric', loaderVersion: configuration.FABRIC_LOADER_VERSION,
    publishProjectId: projectId, publishArchivePath: configuration.CURSEFORGE_EXPORT_PATH || undefined });
  const minecraft = new MinecraftServer({ directory: path.join(runtimeDirectory, 'minecraft'), java: configuration.JAVA_PATH,
    memoryMb: configuration.MINECRAFT_MEMORY_MB, version: configuration.MINECRAFT_VERSION, address: configuration.MINECRAFT_ADDRESS, activity: record,
    onLog: line => gateway?.observeLog(line), requireOnlineMode: Boolean(gateway) }, dependencies.minecraft);
  await minecraft.initialize();
  let globalWindow = Date.now(); let globalRequests = 0; let jobRunning = false; let packMutationRunning = false;
  async function mutatePack<T>(operation: () => Promise<T>): Promise<T> {
    if (packMutationRunning) throw Object.assign(new Error('A pack change is already being processed. Try again when it finishes.'), { statusCode: 409 });
    packMutationRunning = true;
    try { return await operation(); } finally { packMutationRunning = false; }
  }
  const publicHostname = new URL(configuration.PUBLIC_ORIGIN).hostname;
  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  app.addHook('onRequest', async (request, reply) => {
    const hostname = request.hostname.toLowerCase();
    const isLocal = localHosts.has(hostname);
    const allowed = ['aron.best', 'www.aron.best', publicHostname].includes(hostname) || isLocal;
    if (!allowed) return reply.code(421).send({ error: 'Unknown host.' });
    const route = request.routeOptions.url ?? '';
    if (!route.startsWith('/api/')) {
      // The workshop host is friends-only from the first byte: no bundle, no status, only the gate.
      if (hostname === publicHostname && !hasAccess(request)) {
        const nonce = randomBytes(16).toString('base64');
        return reply.code(200)
          .header('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`)
          .header('Cache-Control', 'no-store').header('X-Robots-Tag', 'noindex, nofollow')
          .type('text/html; charset=utf-8').send(gatePage(nonce));
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
    await ipAccess.grant(request.ip, 'invite');
    return { authorized: true };
  });
  app.get('/api/status', async request => {
    const permitted = hasAccess(request);
    const current = await pack.getPack();
    const server = minecraft.status();
    // Crash reports list the host's paths and mods, so only friends with access see them.
    const crash = permitted && server.failure ? await minecraft.latestCrashReport() : null;
    const relevant = crash && server.failure && Date.parse(crash.createdAt) >= Date.parse(server.failure.at) - 5 * 60_000;
    const crashLog = relevant ? [`# ${crash.file} (${crash.createdAt})`, ...crash.lines] : permitted && server.failure ? minecraft.logs().slice(-80) : undefined;
    return { server: { ...server, ...(crashLog ? { crashLog } : {}) }, pack: current, history: current.history, requests: current.requests,
      capabilities: { authorized: permitted, ipWhitelisted: ipAccess.allows(request.ip), joinAccess: Boolean(gateway), curseforgeSearch: client.configured, localProfile: localProfile.configured, publish: Boolean(client.publishingConfigured && projectId && configuration.CURSEFORGE_EXPORT_PATH), update: Boolean(client.configured && projectId), server: minecraft.status().state !== 'not-installed' },
      activity: permitted ? activity : [], jobRunning };
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
  app.post('/api/pack/requests', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async request => {
    const { url } = z.object({ url: z.string().trim().min(1).max(2048) }).strict().parse(request.body);
    const result = await mutatePack(() => pack.requestMod(url));
    record(result.status === 'installed' ? 'A friend requested a mod that is already installed.' : 'A friend requested a mod link for the host to install through the CurseForge App.');
    return result;
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
  app.get('/api/server/logs', async () => ({ lines: minecraft.logs() }));
  app.post('/api/server/action', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { action } = z.object({ action: z.enum(['start', 'stop', 'restart', 'backup', 'update', 'sync-profile']) }).strict().parse(request.body);
    if (action === 'update' && (!client.configured || !projectId)) return reply.code(409).send({ error: 'A CurseForge API key and published project are required before updating from a release.' });
    if (action === 'sync-profile' && !localProfile.configured) return reply.code(409).send({ error: 'The host must configure the CurseForge App profile path before syncing.' });
    if (jobRunning) return reply.code(409).send({ error: 'A server operation is already running.' });
    jobRunning = true;
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
    }).catch(error => { record(`${label} failed: ${(error as Error).message}`); app.log.error({ message: (error as Error).message }, 'Server operation failed'); }).finally(() => { jobRunning = false; });
    return reply.code(202).send({ accepted: true, action });
  });
  const browserRoot = path.resolve('dist/aron-best/browser');
  if (await access(path.join(browserRoot, 'index.html')).then(() => true, () => false)) {
    await app.register(staticFiles, { root: browserRoot, index: ['index.html'], maxAge: '1h', setHeaders: (response, file) => {
      if (file.endsWith('index.html')) response.header('Cache-Control', 'no-cache');
    } });
  }
  app.setNotFoundHandler((request, reply) => reply.code(404).send({ error: 'Not found.' }));
  app.addHook('onReady', async () => {
    await gateway?.listen();
    if (configuration.MINECRAFT_AUTOSTART === 'true') void minecraft.action('start').catch(error => record(`Automatic startup failed: ${(error as Error).message}`));
  });
  app.addHook('onClose', async () => { await minecraft.shutdown(); await gateway?.close(); });
  return app;
}
