import { lookup } from 'node:dns/promises';
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import { BlockList, connect, createServer as createTcpServer, isIP, type Server as TcpServer, type Socket } from 'node:net';

export const installationHosts: ReadonlySet<string> = new Set([
  'piston-meta.mojang.com', 'piston-data.mojang.com', 'launchermeta.mojang.com', 'launcher.mojang.com',
  'libraries.minecraft.net', 'resources.download.minecraft.net', 'meta.fabricmc.net', 'maven.fabricmc.net',
  'meta.quiltmc.org', 'maven.quiltmc.org', 'files.minecraftforge.net', 'maven.minecraftforge.net', 'maven.neoforged.net',
  'edge.forgecdn.net', 'media.forgecdn.net', 'mediafilez.forgecdn.net', 'mediafiles.forgecdn.net',
  'repo.maven.apache.org', 'repo1.maven.org',
]);
export const authenticationHosts: ReadonlySet<string> = new Set(['sessionserver.mojang.com', 'api.minecraftservices.com', 'api.mojang.com', 'discovery.minecraftservices.com']);

export interface NetworkAddress { address: string; family: 4 | 6 }
export interface EdgeDestination { host: string; port: number; family?: 4 | 6 }
export interface NetworkEdgeDependencies {
  resolve: (host: string) => Promise<NetworkAddress[]>;
  dial: (destination: EdgeDestination) => Socket;
}
export interface NetworkEdgeLimits {
  relayConnections: number;
  relayConnectionsPerAddress: number;
  proxyConnections: number;
  proxyConnectionsPerAddress: number;
  headerTimeoutMs: number;
  resolutionTimeoutMs: number;
  connectTimeoutMs: number;
  relayIdleTimeoutMs: number;
  proxyIdleTimeoutMs: number;
  relayLifetimeMs: number;
  installerLifetimeMs: number;
  authenticationLifetimeMs: number;
  installerBytes: number;
  authenticationBytes: number;
}
export interface NetworkEdgeOptions {
  host?: string;
  minecraftHost?: string;
  minecraftPort?: number;
  relayPort?: number;
  installerProxyPort?: number;
  authenticationProxyPort?: number;
  authenticationTlsPort?: number;
  healthPort?: number;
  limits?: Partial<NetworkEdgeLimits>;
}
export interface NetworkEdgePorts { relay: number; installerProxy: number; authenticationProxy: number; authenticationTls: number; health: number }

const defaultLimits: NetworkEdgeLimits = {
  relayConnections: 64, relayConnectionsPerAddress: 6, proxyConnections: 32, proxyConnectionsPerAddress: 16,
  headerTimeoutMs: 5_000, resolutionTimeoutMs: 5_000, connectTimeoutMs: 8_000,
  relayIdleTimeoutMs: 180_000, proxyIdleTimeoutMs: 60_000,
  relayLifetimeMs: 24 * 60 * 60_000, installerLifetimeMs: 20 * 60_000, authenticationLifetimeMs: 5 * 60_000,
  installerBytes: 512 * 1024 ** 2, authenticationBytes: 8 * 1024 ** 2,
};
const excludedAddresses = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.31.196.0', 24], ['192.52.193.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['192.175.48.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) excludedAddresses.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['2620:4f:8000::', 48], ['3ffe::', 16], ['3fff::', 20],
] as const) excludedAddresses.addSubnet(address, prefix, 'ipv6');
const globalIpv6 = new BlockList();
globalIpv6.addSubnet('2000::', 3, 'ipv6');

class NetworkPolicyError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export function publicNetworkAddress(address: string): boolean {
  if (address.includes('%')) return false;
  const family = isIP(address);
  if (family === 4) return !excludedAddresses.check(address, 'ipv4');
  return family === 6 && globalIpv6.check(address, 'ipv6') && !excludedAddresses.check(address, 'ipv6');
}

export function connectHostname(authority: string | undefined, hosts: ReadonlySet<string>): string {
  const match = authority?.match(/^([A-Za-z0-9.-]{1,253}):443$/);
  const host = match?.[1]?.toLowerCase();
  if (!host || isIP(host) || !hosts.has(host)) throw new NetworkPolicyError('Destination not allowed.', 403);
  return host;
}

export async function resolvePublicDestination(host: string, resolve: NetworkEdgeDependencies['resolve']): Promise<NetworkAddress> {
  const addresses = await resolve(host);
  if (!addresses.length || addresses.length > 32 || addresses.some(record => isIP(record.address) !== record.family || !publicNetworkAddress(record.address))) {
    throw new NetworkPolicyError('Destination did not resolve exclusively to public addresses.', 403);
  }
  return addresses.find(record => record.family === 4) ?? addresses[0]!;
}

function readPort(environment: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = environment[name];
  if (value === undefined) return fallback;
  if (!/^\d{1,5}$/.test(value) || Number(value) < 1024 || Number(value) > 65535) throw new Error(`${name} must be an unprivileged TCP port.`);
  return Number(value);
}

export function readNetworkEdgeConfiguration(environment: NodeJS.ProcessEnv = process.env): NetworkEdgeOptions {
  const host = environment['NETWORK_EDGE_HOST'] ?? '0.0.0.0';
  if (!['0.0.0.0', '127.0.0.1', '::', '::1'].includes(host)) throw new Error('NETWORK_EDGE_HOST must be a local listening address.');
  const minecraftHost = environment['NETWORK_EDGE_MINECRAFT_HOST'] ?? 'minecraft';
  if (!isIP(minecraftHost) && !/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(minecraftHost)) throw new Error('NETWORK_EDGE_MINECRAFT_HOST must be a hostname or IP address.');
  return {
    host, minecraftHost,
    minecraftPort: readPort(environment, 'NETWORK_EDGE_MINECRAFT_PORT', 25565),
    relayPort: readPort(environment, 'NETWORK_EDGE_RELAY_PORT', 25565),
    installerProxyPort: readPort(environment, 'NETWORK_EDGE_INSTALLER_PROXY_PORT', 3128),
    authenticationProxyPort: readPort(environment, 'NETWORK_EDGE_AUTH_PROXY_PORT', 3129),
    authenticationTlsPort: readPort(environment, 'NETWORK_EDGE_AUTH_TLS_PORT', 443),
    healthPort: readPort(environment, 'NETWORK_EDGE_HEALTH_PORT', 3130),
  };
}

class Connections {
  private readonly sockets = new Set<Socket>();
  private readonly counts = new Map<string, number>();

  constructor(private readonly maximum: number, private readonly maximumPerAddress: number) {}

  add(socket: Socket): boolean {
    socket.on('error', () => socket.destroy());
    const address = socket.remoteAddress?.replace(/^::ffff:/, '') ?? 'unknown';
    const count = this.counts.get(address) ?? 0;
    if (this.sockets.size >= this.maximum || count >= this.maximumPerAddress) { socket.destroy(); return false; }
    this.sockets.add(socket);
    this.counts.set(address, count + 1);
    socket.once('close', () => {
      this.sockets.delete(socket);
      const remaining = (this.counts.get(address) ?? 1) - 1;
      if (remaining) this.counts.set(address, remaining);
      else this.counts.delete(address);
    });
    return true;
  }

  close(): void { for (const socket of this.sockets) socket.destroy(); }
}

function reject(socket: Socket, status: number): void {
  if (socket.destroyed) return;
  const reason = ({ 400: 'Bad Request', 403: 'Forbidden', 405: 'Method Not Allowed', 431: 'Request Header Fields Too Large', 502: 'Bad Gateway', 504: 'Gateway Timeout' } as Record<number, string>)[status] ?? 'Bad Gateway';
  socket.setTimeout(1_000, () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

async function deadline<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new NetworkPolicyError('Destination resolution timed out.', 504)), milliseconds).unref();
    })]);
  } finally { clearTimeout(timer); }
}

interface TunnelOptions {
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  lifetimeMs: number;
  maximumBytes?: number;
  head?: Buffer;
  proxy?: boolean;
}

const clientHelloLimit = 16 * 1024;

function serverName(body: Buffer, hosts: ReadonlySet<string>): string {
  let cursor = 0;
  const bytes = (length: number) => {
    if (length < 0 || cursor + length > body.length) throw new NetworkPolicyError('Malformed TLS ClientHello.', 400);
    const result = body.subarray(cursor, cursor + length);
    cursor += length;
    return result;
  };
  const length8 = () => bytes(1)[0]!;
  const length16 = () => bytes(2).readUInt16BE();
  const version = bytes(2);
  if (version[0] !== 3 || ![1, 2, 3].includes(version[1]!)) throw new NetworkPolicyError('Unsupported TLS ClientHello.', 400);
  bytes(32);
  const session = length8();
  if (session > 32) throw new NetworkPolicyError('Invalid TLS session identifier.', 400);
  bytes(session);
  const ciphers = length16();
  if (ciphers < 2 || ciphers % 2) throw new NetworkPolicyError('Invalid TLS cipher list.', 400);
  bytes(ciphers);
  const compression = bytes(length8());
  if (compression.length !== 1 || compression[0] !== 0) throw new NetworkPolicyError('TLS compression is not allowed.', 400);
  const extensions = length16();
  if (extensions !== body.length - cursor) throw new NetworkPolicyError('Invalid TLS extensions.', 400);
  const types = new Set<number>();
  let hostname: string | undefined;
  while (cursor < body.length) {
    const type = length16();
    const extension = bytes(length16());
    if (types.has(type) || type === 0xfe0d) throw new NetworkPolicyError('Duplicate or concealed TLS destinations are not allowed.', 400);
    types.add(type);
    if (type !== 0) continue;
    if (extension.length < 5 || extension.readUInt16BE(0) !== extension.length - 2 || extension[2] !== 0 || extension.readUInt16BE(3) !== extension.length - 5) {
      throw new NetworkPolicyError('Exactly one TLS server name is required.', 400);
    }
    hostname = connectHostname(`${extension.subarray(5).toString('utf8')}:443`, hosts);
  }
  if (!hostname) throw new NetworkPolicyError('A permitted TLS server name is required.', 403);
  return hostname;
}

export class TlsClientHello {
  private readonly received: Buffer[] = [];
  private readonly handshake: Buffer[] = [];
  private pending: Buffer = Buffer.alloc(0);
  private total = 0;
  private handshakeBytes = 0;
  private expected?: number;
  private finished = false;

  constructor(private readonly hosts: ReadonlySet<string> = authenticationHosts) {}

  accept(chunk: Buffer): { hostname: string; bytes: Buffer } | undefined {
    if (this.finished) throw new NetworkPolicyError('The TLS destination was already selected.', 400);
    this.total += chunk.length;
    if (this.total > clientHelloLimit) throw new NetworkPolicyError('The TLS ClientHello is too large.', 400);
    this.received.push(chunk);
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    while (this.pending.length >= 5) {
      if (this.pending[0] !== 22 || this.pending[1] !== 3 || ![1, 2, 3].includes(this.pending[2]!)) throw new NetworkPolicyError('Only TLS ClientHello handshakes are accepted.', 400);
      const length = this.pending.readUInt16BE(3);
      if (!length || length > clientHelloLimit - 5) throw new NetworkPolicyError('Invalid TLS record length.', 400);
      if (this.pending.length < length + 5) return undefined;
      this.handshake.push(this.pending.subarray(5, length + 5));
      this.handshakeBytes += length;
      this.pending = this.pending.subarray(length + 5);
      if (this.expected === undefined && this.handshakeBytes >= 4) {
        const header = Buffer.concat(this.handshake, this.handshakeBytes).subarray(0, 4);
        if (header[0] !== 1) throw new NetworkPolicyError('The first TLS handshake must be ClientHello.', 400);
        this.expected = 4 + header.readUIntBE(1, 3);
        if (this.expected < 45 || this.expected > clientHelloLimit - 5) throw new NetworkPolicyError('Invalid TLS ClientHello length.', 400);
      }
      if (this.expected === undefined || this.handshakeBytes < this.expected) continue;
      if (this.handshakeBytes !== this.expected) throw new NetworkPolicyError('Unexpected data in the TLS ClientHello record.', 400);
      const hostname = serverName(Buffer.concat(this.handshake, this.handshakeBytes).subarray(4), this.hosts);
      this.finished = true;
      return { hostname, bytes: Buffer.concat(this.received, this.total) };
    }
    return undefined;
  }
}

function tunnel(client: Socket, destination: EdgeDestination, dependencies: NetworkEdgeDependencies, options: TunnelOptions): void {
  if (client.destroyed) return;
  client.pause();
  if (options.maximumBytes && (options.head?.byteLength ?? 0) > options.maximumBytes) { reject(client, 403); return; }
  let upstream: Socket;
  try { upstream = dependencies.dial(destination); }
  catch { if (options.proxy) reject(client, 502); else client.destroy(); return; }
  let established = false;
  let finished = false;
  let bytes = options.head?.byteLength ?? 0;
  let lifetime: NodeJS.Timeout | undefined;
  const connection = setTimeout(() => finish(504), options.connectTimeoutMs).unref();
  const finish = (status?: number) => {
    if (finished) return;
    finished = true;
    clearTimeout(connection);
    clearTimeout(lifetime);
    upstream.destroy();
    if (options.proxy && !established && status) reject(client, status);
    else client.destroy();
  };
  const count = (chunk: Buffer) => {
    bytes += chunk.byteLength;
    if (options.maximumBytes && bytes > options.maximumBytes) finish();
  };
  client.once('close', () => finish());
  upstream.once('error', () => finish(502));
  upstream.once('close', () => {
    if (!established || !upstream.readableEnded) finish(502);
    else client.end();
  });
  const establishedConnection = () => {
    if (finished || client.destroyed) { finish(); return; }
    established = true;
    clearTimeout(connection);
    lifetime = setTimeout(() => finish(), options.lifetimeMs).unref();
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    client.setTimeout(options.idleTimeoutMs, () => finish());
    upstream.setTimeout(options.idleTimeoutMs, () => finish());
    client.on('data', count);
    upstream.on('data', count);
    if (options.proxy) client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    upstream.pipe(client);
    const forward = () => { if (!finished) { client.pipe(upstream); client.resume(); } };
    if (options.head?.length && !upstream.write(options.head)) upstream.once('drain', forward);
    else forward();
  };
  if (!upstream.connecting && upstream.remoteAddress) establishedConnection();
  else upstream.once('connect', establishedConnection);
}

function validConnect(request: IncomingMessage, hosts: ReadonlySet<string>, head: Buffer): string {
  const host = connectHostname(request.url, hosts);
  const hostHeaders = request.rawHeaders.filter((_value, index) => index % 2 === 0 && request.rawHeaders[index]?.toLowerCase() === 'host');
  const headerHost = request.headers.host?.toLowerCase();
  if (request.rawHeaders.length > 64 || hostHeaders.length !== 1 || headerHost !== host && headerHost !== `${host}:443` || request.headers['transfer-encoding'] || request.headers['content-length'] && request.headers['content-length'] !== '0' || head.byteLength > 16 * 1024) {
    throw new NetworkPolicyError('Invalid CONNECT request.', 400);
  }
  return host;
}

function createProxy(hosts: ReadonlySet<string>, dependencies: NetworkEdgeDependencies, limits: NetworkEdgeLimits, lifetimeMs: number, maximumBytes: number, requireMatchingTls = false): { server: HttpServer; connections: Connections } {
  const connections = new Connections(limits.proxyConnections, limits.proxyConnectionsPerAddress);
  const server = createHttpServer({ maxHeaderSize: 8 * 1024, headersTimeout: limits.headerTimeoutMs, requestTimeout: limits.headerTimeoutMs, connectionsCheckingInterval: 1_000, keepAliveTimeout: 1_000 }, (_request, response) => {
    response.writeHead(405, { Connection: 'close', 'Content-Length': '0' });
    response.end();
  });
  server.maxHeadersCount = 33;
  server.maxRequestsPerSocket = 1;
  server.on('connection', socket => {
    if (connections.add(socket)) socket.setTimeout(limits.headerTimeoutMs, () => socket.destroy());
  });
  server.on('clientError', (error, socket) => reject(socket as Socket, (error as NodeJS.ErrnoException).code === 'HPE_HEADER_OVERFLOW' ? 431 : 400));
  server.on('upgrade', (_request, socket) => reject(socket as Socket, 405));
  server.on('connect', (request, socket, head) => {
    const client = socket as Socket;
    client.pause();
    void (async () => {
      const hostname = validConnect(request, hosts, head);
      if (requireMatchingTls) {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        authenticateTls(client, dependencies, limits, hostname, head);
        return;
      }
      const address = await deadline(resolvePublicDestination(hostname, dependencies.resolve), limits.resolutionTimeoutMs);
      if (client.destroyed) return;
      tunnel(client, { host: address.address, family: address.family, port: 443 }, dependencies, {
        connectTimeoutMs: limits.connectTimeoutMs, idleTimeoutMs: limits.proxyIdleTimeoutMs, lifetimeMs, maximumBytes, head, proxy: true,
      });
    })().catch(error => reject(client, error instanceof NetworkPolicyError ? error.status : 502));
  });
  return { server, connections };
}

function authenticateTls(client: Socket, dependencies: NetworkEdgeDependencies, limits: NetworkEdgeLimits, hostname?: string, head?: Buffer): void {
  const parser = new TlsClientHello(hostname ? new Set([hostname]) : authenticationHosts);
  const timeout = setTimeout(() => client.destroy(), limits.headerTimeoutMs).unref();
  let selected = false;
  client.once('close', () => clearTimeout(timeout));
  const receive = (chunk: Buffer) => {
    try {
      const hello = parser.accept(chunk);
      if (!hello) return;
      selected = true;
      client.pause();
      client.removeListener('data', receive);
      clearTimeout(timeout);
      void (async () => {
        const address = await deadline(resolvePublicDestination(hello.hostname, dependencies.resolve), limits.resolutionTimeoutMs);
        if (client.destroyed) return;
        tunnel(client, { host: address.address, family: address.family, port: 443 }, dependencies, {
          connectTimeoutMs: limits.connectTimeoutMs, idleTimeoutMs: limits.proxyIdleTimeoutMs,
          lifetimeMs: limits.authenticationLifetimeMs, maximumBytes: limits.authenticationBytes, head: hello.bytes,
        });
      })().catch(() => client.destroy());
    } catch { clearTimeout(timeout); client.destroy(); }
  };
  client.on('data', receive);
  if (head?.length) receive(head);
  if (!selected && !client.destroyed) client.resume();
}

function createAuthenticationTls(dependencies: NetworkEdgeDependencies, limits: NetworkEdgeLimits): { server: TcpServer; connections: Connections } {
  const connections = new Connections(limits.proxyConnections, limits.proxyConnectionsPerAddress);
  const server = createTcpServer({ allowHalfOpen: true, pauseOnConnect: true }, client => {
    if (connections.add(client)) authenticateTls(client, dependencies, limits);
  });
  return { server, connections };
}

export function createNetworkEdge(options: NetworkEdgeOptions = {}, injected: Partial<NetworkEdgeDependencies> = {}) {
  const limits = { ...defaultLimits, ...options.limits };
  if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error('Network edge limits must be positive integers.');
  const dependencies: NetworkEdgeDependencies = {
    resolve: async host => (await lookup(host, { all: true, verbatim: true })).map(address => ({ address: address.address, family: address.family as 4 | 6 })),
    dial: destination => connect(destination),
    ...injected,
  };
  const relayConnections = new Connections(limits.relayConnections, limits.relayConnectionsPerAddress);
  const relay = createTcpServer({ pauseOnConnect: true, allowHalfOpen: true }, socket => {
    if (!relayConnections.add(socket)) return;
    tunnel(socket, { host: options.minecraftHost ?? 'minecraft', port: options.minecraftPort ?? 25565 }, dependencies, {
      connectTimeoutMs: limits.connectTimeoutMs, idleTimeoutMs: limits.relayIdleTimeoutMs, lifetimeMs: limits.relayLifetimeMs,
    });
  });
  const installer = createProxy(installationHosts, dependencies, limits, limits.installerLifetimeMs, limits.installerBytes);
  const authentication = createProxy(authenticationHosts, dependencies, limits, limits.authenticationLifetimeMs, limits.authenticationBytes, true);
  const authenticationTls = createAuthenticationTls(dependencies, limits);
  const healthConnections = new Connections(4, 4);
  const health = createHttpServer({ maxHeaderSize: 1024, headersTimeout: 2_000, requestTimeout: 2_000, connectionsCheckingInterval: 1_000, keepAliveTimeout: 1_000 }, (request, response) => {
    const healthy = request.method === 'GET' && request.url === '/health';
    const contents = healthy ? '{"status":"ok"}' : '';
    response.writeHead(healthy ? 200 : 404, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(contents), Connection: 'close', 'Cache-Control': 'no-store' });
    response.end(contents);
  });
  health.on('connection', socket => { if (healthConnections.add(socket)) socket.setTimeout(2_000, () => socket.destroy()); });
  health.on('connect', (_request, socket) => reject(socket as Socket, 405));
  health.on('upgrade', (_request, socket) => reject(socket as Socket, 405));
  health.on('clientError', (_error, socket) => reject(socket as Socket, 400));
  const servers: Array<TcpServer | HttpServer> = [relay, installer.server, authentication.server, authenticationTls.server, health];
  const pools = [relayConnections, installer.connections, authentication.connections, authenticationTls.connections, healthConnections];
  let started = false;

  async function close(): Promise<void> {
    for (const pool of pools) pool.close();
    await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => {
      if (!server.listening) { resolve(); return; }
      server.close(error => error ? reject(error) : resolve());
    })));
  }

  return {
    close,
    async listen(): Promise<NetworkEdgePorts> {
      if (started) throw new Error('The network edge can only be started once.');
      started = true;
      const ports = [options.relayPort ?? 25565, options.installerProxyPort ?? 3128, options.authenticationProxyPort ?? 3129, options.authenticationTlsPort ?? 443, options.healthPort ?? 3130];
      try {
        for (const [index, server] of servers.entries()) {
          await new Promise<void>((resolve, reject) => {
            const error = (cause: Error) => reject(cause);
            server.once('error', error);
            server.listen({ host: index === servers.length - 1 ? '127.0.0.1' : options.host ?? '0.0.0.0', port: ports[index]! }, () => { server.removeListener('error', error); resolve(); });
          });
        }
      } catch (error) { await close(); throw error; }
      const bound = servers.map(server => {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('The network edge did not bind a TCP port.');
        return address.port;
      });
      return { relay: bound[0]!, installerProxy: bound[1]!, authenticationProxy: bound[2]!, authenticationTls: bound[3]!, health: bound[4]! };
    },
  };
}
