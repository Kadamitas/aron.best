import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, createServer, type Socket, type AddressInfo } from 'node:net';
import { once } from 'node:events';
import { IpAccess, normalizeIp } from './ip-access.js';
import { MinecraftGateway } from './minecraft-gateway.js';
import { createApp, readConfiguration } from './app.js';

test('IP grants persist, normalize mapped IPv4, and do not approve adjacent addresses', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aron-ip-'));
  try {
    const file = join(directory, 'access.json');
    const store = new IpAccess(file);
    await store.initialize();
    await Promise.all([store.grant('::ffff:198.51.100.4', 'invite'), store.grant('198.51.100.5', 'minecraft')]);
    const restored = new IpAccess(file);
    await restored.initialize();
    assert.equal(restored.allows('198.51.100.4'), true);
    assert.equal(restored.allows('198.51.100.5'), true);
    assert.equal(restored.allows('198.51.100.6'), false);
    assert.equal(normalizeIp('2001:db8:0:0:0:0:0:1'), '2001:db8::1');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('invite redemption approves only the real request IP and survives restart without a bearer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aron-ip-http-'));
  const secret = 't'.repeat(43);
  const configuration = readConfiguration({ NODE_ENV: 'test', RUNTIME_DIRECTORY: directory, FRIEND_ACCESS_TOKEN: secret });
  let app = await createApp(configuration);
  const headers = { host: 'mc.modpack.aron.best', origin: 'https://mc.modpack.aron.best' };
  try {
    const redeem = { method: 'POST' as const, url: '/api/access/redeem', payload: {}, remoteAddress: '198.51.100.4' };
    assert.equal((await app.inject({ ...redeem, headers })).statusCode, 401);
    assert.equal((await app.inject({ ...redeem, headers: { ...headers, authorization: `Bearer ${secret}`, origin: 'https://evil.test' } })).statusCode, 403);
    assert.equal((await app.inject({ ...redeem, headers: { ...headers, authorization: `Bearer ${secret}` } })).statusCode, 200);
    await app.close();
    app = await createApp(configuration);
    for (let i = 0; i < 12; i++) {
      assert.equal((await app.inject({ method: 'POST', url: '/api/pack/export', payload: {}, headers, remoteAddress: '198.51.100.4' })).statusCode, 200);
    }
    const status = await app.inject({ url: '/api/status', headers, remoteAddress: '198.51.100.4' });
    assert.equal(status.json().capabilities.ipWhitelisted, true);
    assert.equal((await app.inject({ url: '/api/server/logs', headers: { ...headers, 'x-forwarded-for': '198.51.100.4' }, remoteAddress: '198.51.100.9' })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/server/logs', headers: { host: 'aron.best' }, remoteAddress: '198.51.100.4' })).statusCode, 404);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('game gateway grants only after correlated server login and join messages', async () => {
  const upstream = createServer();
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const granted: string[] = [];
  const gateway = new MinecraftGateway({ port: 0, host: '127.0.0.1', upstreamPort: (upstream.address() as AddressInfo).port,
    joined: async ip => { granted.push(ip); }, failure: error => { throw error; } });
  await gateway.listen();
  const incoming = once(upstream, 'connection');
  const client = createConnection({ host: '127.0.0.1', port: (gateway.address() as AddressInfo).port });
  const [connection] = await incoming as [Socket];
  try {
    // Receiving forwarded data establishes that the upstream peer mapping is live.
    const received = once(connection, 'data');
    client.write('status ping');
    await received;
    const prefix = '[12:34:56] [Server thread/INFO]: ';
    const login = `Friend[/127.0.0.1:${connection.remotePort}] logged in with entity id 1 at (0, 0, 0)`;
    gateway.observeLog(`${prefix}Friend joined the game`);
    gateway.observeLog(`${prefix}<Stranger> ${login}`);
    gateway.observeLog(`${prefix}Friend joined the game`);
    assert.deepEqual(granted, []);
    gateway.observeLog(`${prefix}${login}`);
    assert.deepEqual(granted, []);
    gateway.observeLog(`${prefix}Friend joined the game`);
    assert.deepEqual(granted, ['127.0.0.1']);
    gateway.observeLog(`${prefix}Friend joined the game`);
    assert.equal(granted.length, 1);
  } finally {
    client.destroy(); connection.destroy();
    await gateway.close();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
