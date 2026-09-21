import { createConnection, createServer, type Socket } from 'node:net';
import { normalizeIp } from './ip-access.js';

/** Opaque TCP forwarding preserves Minecraft authentication and encryption. */
export class MinecraftGateway {
  private readonly sockets = new Set<Socket>();
  private readonly peers = new Map<number, string>();
  private readonly perIp = new Map<string, number>();
  private readonly logins = new Map<string, { port: number; at: number }>();
  private readonly server = createServer(socket => this.connect(socket));
  constructor(private readonly options: {
    port: number; upstreamPort: number; host?: string; perAddressLimit?: number;
    joined: (ip: string) => Promise<void>; failure: (error: unknown) => void;
  }) {}

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.options.port, this.options.host ?? '0.0.0.0', () => {
        this.server.removeListener('error', reject);
        this.server.on('error', this.options.failure);
        resolve();
      });
    });
  }
  address() { return this.server.address(); }

  private connect(client: Socket): void {
    const ip = normalizeIp(client.remoteAddress!);
    if (this.sockets.size >= 64 || (this.perIp.get(ip) ?? 0) >= (this.options.perAddressLimit ?? 6)) { client.destroy(); return; }
    this.sockets.add(client);
    this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);
    client.pause();
    const upstream = createConnection({ host: '127.0.0.1', port: this.options.upstreamPort });
    let port: number | undefined;
    const connectionDeadline = setTimeout(() => upstream.destroy(), 3000);
    connectionDeadline.unref();
    upstream.once('connect', () => {
      clearTimeout(connectionDeadline);
      port = upstream.localPort!;
      this.peers.set(port, ip);
      client.pipe(upstream).pipe(client);
      client.resume();
    });
    for (const socket of [client, upstream]) {
      socket.setTimeout(120000, () => socket.destroy());
      socket.on('error', () => socket.destroy());
    }
    upstream.once('close', () => client.destroy());
    client.once('close', () => {
      clearTimeout(connectionDeadline);
      upstream.destroy();
      this.sockets.delete(client);
      const count = (this.perIp.get(ip) ?? 1) - 1;
      if (count) this.perIp.set(ip, count); else this.perIp.delete(ip);
      if (port !== undefined) {
        this.peers.delete(port);
        for (const [name, login] of this.logins) if (login.port === port) this.logins.delete(name);
      }
    });
  }

  observeLog(line: string): void {
    // Only server-generated messages count, never chat, status pings, or TCP connections.
    const message = /^\[\d{2}:\d{2}:\d{2}\] \[Server thread\/INFO\]: (.*)$/.exec(line.trim())?.[1];
    if (!message) return;
    for (const [name, login] of this.logins) if (Date.now() - login.at > 30000) this.logins.delete(name);
    const login = /^([A-Za-z0-9_]{1,16})\[\/127\.0\.0\.1:(\d+)\] logged in with entity id \d+ at /.exec(message);
    if (login && this.peers.has(Number(login[2]))) {
      this.logins.set(login[1]!, { port: Number(login[2]), at: Date.now() });
      return;
    }
    const joined = /^([A-Za-z0-9_]{1,16}) joined the game$/.exec(message);
    if (!joined) return;
    const pending = this.logins.get(joined[1]!);
    this.logins.delete(joined[1]!);
    const ip = pending && this.peers.get(pending.port);
    if (ip) void this.options.joined(ip).catch(this.options.failure);
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    if (this.server.listening) await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
  }
}
