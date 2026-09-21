import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect, createServer, Socket, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect as tlsConnect, createServer as createTlsServer } from 'node:tls';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { authenticationHosts, connectHostname, createNetworkEdge, installationHosts, publicNetworkAddress, readNetworkEdgeConfiguration, resolvePublicDestination, TlsClientHello, type EdgeDestination, type NetworkEdgeDependencies, type NetworkEdgeOptions } from './network-edge.js';

const publicAddress = { address: '93.184.216.34', family: 4 as const };

async function listener(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}

function stop(server: Server): Promise<void> { return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }

async function fixture(dependencies: Partial<NetworkEdgeDependencies> = {}, options: NetworkEdgeOptions = {}) {
  const edge = createNetworkEdge({ host: '127.0.0.1', relayPort: 0, installerProxyPort: 0, authenticationProxyPort: 0, authenticationTlsPort: 0, healthPort: 0, ...options }, dependencies);
  const ports = await edge.listen();
  return { edge, ports };
}

async function exchange(port: number, request: string | Buffer): Promise<Buffer> {
  const client = connect({ host: '127.0.0.1', port });
  const chunks: Buffer[] = [];
  client.on('data', bytes => chunks.push(bytes));
  client.on('error', () => undefined);
  client.setTimeout(3_000, () => client.destroy(new Error('Fixture request timed out.')));
  client.on('connect', () => client.write(request));
  await new Promise<void>(resolve => client.once('close', () => resolve()));
  return Buffer.concat(chunks);
}

function connectRequest(host: string, tail = ''): string { return `CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n${tail}`; }

test('edge rejects special IPv4 and IPv6 destinations, including mapped, translation and scoped addresses', () => {
  for (const address of [
    '0.0.0.0', '0.9.8.7', '10.2.3.4', '100.64.0.1', '100.127.255.255', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '172.31.255.254', '192.0.0.9', '192.0.2.1', '192.31.196.1', '192.52.193.1', '192.88.99.1',
    '192.168.0.1', '192.175.48.1', '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.1', '224.0.0.1', '239.255.255.255', '240.1.2.3', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:93.184.216.34', '::127.0.0.1', '64:ff9b::7f00:1', '64:ff9b:1::1',
    '100::1', '100:0:0:1::1', '2001::1', '2001:2::1', '2001:10::1', '2001:20::1', '2001:db8::1', '2002:7f00:1::1',
    '2620:4f:8000::1', '3ffe::1', '3fff::1', '5f00::1', 'fc00::1', 'fd12:1234::1', 'fe80::1', 'fe80::1%eth0', 'ff02::1', '2001:4860::1%eth0',
    '127.1', '2130706433', '0177.0.0.1', '127.000.000.001', 'localhost', 'garbage',
  ]) assert.equal(publicNetworkAddress(address), false, address);
  for (const address of ['1.1.1.1', '8.8.8.8', publicAddress.address, '100.63.255.255', '100.128.0.1', '172.15.255.255', '172.32.0.1', '2001:4860:4860::8888', '2606:4700:4700::1111']) {
    assert.equal(publicNetworkAddress(address), true, address);
  }
});

test('edge CONNECT allowlists are exact and reject IPs, ambiguous authorities and all ports except 443', () => {
  for (const host of installationHosts) assert.equal(connectHostname(`${host}:443`, installationHosts), host);
  for (const host of authenticationHosts) assert.equal(connectHostname(`${host.toUpperCase()}:443`, authenticationHosts), host);
  for (const authority of [
    undefined, '', 'meta.fabricmc.net', 'meta.fabricmc.net:80', 'meta.fabricmc.net:444', 'meta.fabricmc.net:0443',
    'meta.fabricmc.net.:443', 'meta.fabricmc.net.evil.test:443', 'evil.meta.fabricmc.net:443', 'META.FABRICMC.NET:443/path',
    'https://meta.fabricmc.net:443', 'user@meta.fabricmc.net:443', 'meta.fabricmc.net@127.0.0.1:443',
    'meta.fabricmc.net%00:443', 'meta.fabricmc.net%2e:443', 'meta.fabricmc.net\\@127.0.0.1:443',
    '127.0.0.1:443', '[::1]:443', '1.1.1.1:443', 'meta.fabricmc.net:443\r\nInjected: yes',
  ]) assert.throws(() => connectHostname(authority, installationHosts), /not allowed/, authority);
  for (const host of installationHosts) assert.throws(() => connectHostname(`${host}:443`, authenticationHosts));
});

test('edge DNS validates every answer and returns only the captured numeric address', async () => {
  assert.deepEqual(await resolvePublicDestination('meta.fabricmc.net', async () => [publicAddress]), publicAddress);
  const ipv6 = { address: '2606:4700:4700::1111', family: 6 as const };
  assert.deepEqual(await resolvePublicDestination('meta.fabricmc.net', async () => [ipv6]), ipv6);
  for (const result of [[], [{ address: '127.0.0.1', family: 4 as const }], [publicAddress, { address: '10.0.0.1', family: 4 as const }], [{ ...publicAddress, family: 6 as const }], Array.from({ length: 33 }, () => publicAddress)]) {
    await assert.rejects(resolvePublicDestination('meta.fabricmc.net', async () => result), /public addresses/);
  }
});

test('edge configuration has fixed defaults and refuses URLs or privileged ports', () => {
  assert.deepEqual(readNetworkEdgeConfiguration({}), {
    host: '0.0.0.0', minecraftHost: 'minecraft', minecraftPort: 25565, relayPort: 25565,
    installerProxyPort: 3128, authenticationProxyPort: 3129, authenticationTlsPort: 443, healthPort: 3130,
  });
  assert.equal(readNetworkEdgeConfiguration({ NETWORK_EDGE_MINECRAFT_HOST: 'minecraft-2', NETWORK_EDGE_MINECRAFT_PORT: '25566' }).minecraftPort, 25566);
  for (const environment of [
    { NETWORK_EDGE_HOST: 'evil.test' }, { NETWORK_EDGE_MINECRAFT_HOST: 'http://minecraft' }, { NETWORK_EDGE_MINECRAFT_HOST: 'minecraft:25565' },
    { NETWORK_EDGE_MINECRAFT_HOST: 'minecraft\n.example' }, { NETWORK_EDGE_RELAY_PORT: '80' }, { NETWORK_EDGE_AUTH_PROXY_PORT: '65536' }, { NETWORK_EDGE_HEALTH_PORT: '-1' },
  ]) assert.throws(() => readNetworkEdgeConfiguration(environment));
  assert.throws(() => createNetworkEdge({ limits: { proxyConnections: 0 } }), /positive integers/);
});

test('edge tunnels only approved destinations through a pinned address and blocks rebinding', async () => {
  const upstream = createServer(socket => socket.once('data', bytes => socket.end(Buffer.concat([Buffer.from('echo:'), bytes]))));
  const upstreamPort = await listener(upstream);
  const destinations: EdgeDestination[] = [];
  let resolutions = 0;
  const setup = await fixture({
    resolve: async host => { assert.equal(host, 'meta.fabricmc.net'); resolutions++; return resolutions === 1 ? [publicAddress] : [{ address: '127.0.0.1', family: 4 }]; },
    dial: destination => { destinations.push(destination); return connect({ host: '127.0.0.1', port: upstreamPort }); },
  });
  try {
    const response = await exchange(setup.ports.installerProxy, connectRequest('meta.fabricmc.net', 'client hello'));
    assert.match(response.toString(), /^HTTP\/1\.1 200 Connection Established\r\n\r\necho:client hello$/);
    assert.equal(resolutions, 1);
    assert.deepEqual(destinations, [{ host: publicAddress.address, family: 4, port: 443 }]);
    const rebound = await exchange(setup.ports.installerProxy, connectRequest('meta.fabricmc.net'));
    assert.match(rebound.toString(), /^HTTP\/1\.1 403/);
    assert.equal(destinations.length, 1);
  } finally { await setup.edge.close(); await stop(upstream); }
});

test('runtime proxy accepts only Mojang authentication hosts and rejects plain HTTP, upgrades and malformed CONNECT', async () => {
  const upstream = createServer(socket => socket.once('data', bytes => socket.end(bytes)));
  const upstreamPort = await listener(upstream);
  const resolutions: string[] = [];
  const setup = await fixture({ resolve: async host => { resolutions.push(host); return [publicAddress]; }, dial: () => connect({ host: '127.0.0.1', port: upstreamPort }) });
  try {
    for (const host of authenticationHosts) {
      const hello = tlsRecord(clientHello([tlsServerName(host)]));
      const response = await exchange(setup.ports.authenticationProxy, Buffer.concat([Buffer.from(connectRequest(host)), hello]));
      assert.deepEqual(response, Buffer.concat([Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n'), hello]));
    }
    assert.deepEqual(resolutions, [...authenticationHosts]);
    assert.match((await exchange(setup.ports.authenticationProxy, connectRequest('meta.fabricmc.net'))).toString(), /^HTTP\/1\.1 403/);
    assert.match((await exchange(setup.ports.authenticationProxy, 'GET http://sessionserver.mojang.com/ HTTP/1.1\r\nHost: sessionserver.mojang.com\r\n\r\n')).toString(), /^HTTP\/1\.1 405/);
    assert.match((await exchange(setup.ports.authenticationProxy, 'GET / HTTP/1.1\r\nHost: sessionserver.mojang.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')).toString(), /^HTTP\/1\.1 405/);
    for (const suffix of [
      'Host: evil.test:443\r\n\r\n', 'Host: sessionserver.mojang.com:443\r\nContent-Length: 1\r\n\r\nx',
      'Host: sessionserver.mojang.com:443\r\nTransfer-Encoding: chunked\r\n\r\n',
    ]) assert.match((await exchange(setup.ports.authenticationProxy, `CONNECT sessionserver.mojang.com:443 HTTP/1.1\r\n${suffix}`)).toString(), /^HTTP\/1\.1 400/);
    const excessiveHeaders = `CONNECT sessionserver.mojang.com:443 HTTP/1.1\r\nHost: sessionserver.mojang.com:443\r\n${Array.from({ length: 33 }, (_, index) => `X-${index}: 1\r\n`).join('')}\r\n`;
    assert.match((await exchange(setup.ports.authenticationProxy, excessiveHeaders)).toString(), /^HTTP\/1\.1 (400|431)/, 'Excess headers must be rejected by either the HTTP parser or the CONNECT header limit.');
    assert.equal(resolutions.length, authenticationHosts.size);
  } finally { await setup.edge.close(); await stop(upstream); }
});

test('authentication CONNECT binds TLS SNI to its exact authority before resolving or dialing', async () => {
  let resolved = false;
  let dialed = false;
  const setup = await fixture({ resolve: async () => { resolved = true; return [publicAddress]; }, dial: () => { dialed = true; throw new Error('Unexpected dial.'); } }, { limits: { headerTimeoutMs: 40 } });
  const established = Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n');
  try {
    for (const hello of [
      tlsRecord(clientHello([tlsServerName('api.minecraftservices.com')])),
      tlsRecord(clientHello([tlsServerName('evil.test')])),
      tlsRecord(clientHello([])),
      Buffer.from('not a TLS ClientHello'),
      Buffer.from([22, 3, 3, 1]),
    ]) {
      const response = await exchange(setup.ports.authenticationProxy, Buffer.concat([Buffer.from(connectRequest('sessionserver.mojang.com')), hello]));
      assert.deepEqual(response, established);
    }
    assert.equal(resolved, false);
    assert.equal(dialed, false);
  } finally { await setup.edge.close(); }
});

test('authentication CONNECT acknowledges before receiving a fragmented ClientHello and emits no second HTTP response', async () => {
  const upstream = createServer(socket => socket.once('data', bytes => socket.end(bytes)));
  const upstreamPort = await listener(upstream);
  let resolved = false;
  const setup = await fixture({ resolve: async host => { assert.equal(host, 'sessionserver.mojang.com'); resolved = true; return [publicAddress]; }, dial: () => connect({ host: '127.0.0.1', port: upstreamPort }) });
  const client = connect({ host: '127.0.0.1', port: setup.ports.authenticationProxy });
  client.setTimeout(3_000, () => client.destroy(new Error('CONNECT fixture timed out.')));
  try {
    await once(client, 'connect');
    client.write(connectRequest('sessionserver.mojang.com'));
    const [acknowledged] = await once(client, 'data');
    assert.equal(acknowledged.toString(), 'HTTP/1.1 200 Connection Established\r\n\r\n');
    assert.equal(resolved, false);
    const hello = clientHello([tlsServerName('sessionserver.mojang.com')]);
    const records = Buffer.concat([tlsRecord(hello.subarray(0, 3)), tlsRecord(hello.subarray(3))]);
    const received: Buffer[] = [];
    client.on('data', bytes => received.push(bytes));
    client.write(records.subarray(0, 6));
    await delay(10);
    assert.equal(resolved, false);
    client.write(records.subarray(6));
    await once(client, 'end');
    assert.deepEqual(Buffer.concat(received), records);
    assert.equal(resolved, true);
  } finally { client.destroy(); await setup.edge.close(); await stop(upstream); }
});

function tlsExtension(type: number, contents: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(contents.length, 2);
  return Buffer.concat([header, contents]);
}

function tlsServerName(hostname: string): Buffer {
  const name = Buffer.from(hostname);
  const header = Buffer.alloc(5);
  header.writeUInt16BE(name.length + 3, 0);
  header.writeUInt16BE(name.length, 3);
  return tlsExtension(0, Buffer.concat([header, name]));
}

function clientHello(extensions: Buffer[]): Buffer {
  const list = Buffer.concat(extensions);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(list.length);
  const body = Buffer.concat([Buffer.from([3, 3]), Buffer.alloc(32), Buffer.from([0, 0, 2, 0x13, 1, 1, 0]), length, list]);
  const header = Buffer.alloc(4);
  header[0] = 1;
  header.writeUIntBE(body.length, 1, 3);
  return Buffer.concat([header, body]);
}

function tlsRecord(handshake: Buffer, type = 22): Buffer {
  const header = Buffer.from([type, 3, 3, 0, 0]);
  header.writeUInt16BE(handshake.length, 3);
  return Buffer.concat([header, handshake]);
}

test('TLS ClientHello parser extracts exact approved SNI across fragmented records and network chunks', () => {
  for (const host of authenticationHosts) {
    const hello = clientHello([tlsServerName(host.toUpperCase()), tlsExtension(43, Buffer.from([2, 3, 4]))]);
    const records = Buffer.concat([tlsRecord(hello.subarray(0, 2)), tlsRecord(hello.subarray(2, 19)), tlsRecord(hello.subarray(19))]);
    const parser = new TlsClientHello();
    for (let index = 0; index < records.length - 1; index++) assert.equal(parser.accept(records.subarray(index, index + 1)), undefined);
    const parsed = parser.accept(records.subarray(-1));
    assert.equal(parsed?.hostname, host);
    assert.deepEqual(parsed?.bytes, records);
    assert.throws(() => parser.accept(Buffer.alloc(0)), /already selected/);
  }
  const coalesced = Buffer.concat([tlsRecord(clientHello([tlsServerName('sessionserver.mojang.com')])), tlsRecord(Buffer.from([1]), 20)]);
  assert.deepEqual(new TlsClientHello().accept(coalesced)?.bytes, coalesced);
});

test('TLS ClientHello parser rejects missing, duplicate, concealed, malformed and unapproved names', () => {
  const host = 'sessionserver.mojang.com';
  for (const extensions of [
    [], [tlsServerName('evil.test')], [tlsServerName('sessionserver.mojang.com.evil.test')], [tlsServerName('127.0.0.1')],
    [tlsServerName(host), tlsServerName(host)], [tlsServerName(host), tlsExtension(0xfe0d, Buffer.alloc(1))],
    [tlsServerName(host), tlsExtension(43, Buffer.alloc(0)), tlsExtension(43, Buffer.alloc(0))],
    [tlsServerName(`${host}.`)], [tlsServerName(`${host}\0`)],[tlsServerName(`é${host}`)],
  ]) assert.throws(() => new TlsClientHello().accept(tlsRecord(clientHello(extensions))));
  const multiple = tlsServerName(host);
  const second = tlsServerName('api.mojang.com').subarray(6);
  const names = Buffer.concat([multiple.subarray(4), second]);
  names.writeUInt16BE(names.length - 2);
  assert.throws(() => new TlsClientHello().accept(tlsRecord(clientHello([tlsExtension(0, names)]))), /one TLS server name/);
  const malformed = tlsServerName(host);
  malformed.writeUInt16BE(0xffff, 7);
  assert.throws(() => new TlsClientHello().accept(tlsRecord(clientHello([malformed]))));
  assert.throws(() => new TlsClientHello().accept(Buffer.from('GET / HTTP/1.1\r\nHost: sessionserver.mojang.com\r\n\r\n')), /Only TLS/);
  assert.throws(() => new TlsClientHello().accept(Buffer.alloc(16 * 1024 + 1)), /too large/);
  assert.throws(() => new TlsClientHello().accept(Buffer.from([22, 3, 3, 0xff, 0xff])), /record length/);
  assert.throws(() => new TlsClientHello().accept(tlsRecord(Buffer.from([2, 0, 0, 41, ...Buffer.alloc(41)]))), /first TLS handshake/);
  assert.throws(() => new TlsClientHello().accept(tlsRecord(Buffer.from([1, 0, 0xff, 0xff]))), /ClientHello length/);
  assert.throws(() => new TlsClientHello().accept(tlsRecord(Buffer.concat([clientHello([tlsServerName(host)]), Buffer.alloc(1)]))), /Unexpected data/);
});

test('transparent TLS relay replays every received byte unchanged to its pinned public destination', async () => {
  const hello = clientHello([tlsServerName('discovery.minecraftservices.com')]);
  const records = Buffer.concat([tlsRecord(hello.subarray(0, 5)), tlsRecord(hello.subarray(5)), tlsRecord(Buffer.from([1]), 20)]);
  const upstream = createServer(socket => socket.once('data', bytes => socket.end(bytes)));
  const upstreamPort = await listener(upstream);
  const destinations: EdgeDestination[] = [];
  const hosts: string[] = [];
  const setup = await fixture({ resolve: async host => { hosts.push(host); return [publicAddress]; }, dial: destination => { destinations.push(destination); return connect({ host: '127.0.0.1', port: upstreamPort }); } });
  try {
    assert.deepEqual(await exchange(setup.ports.authenticationTls, records), records);
    assert.deepEqual(hosts, ['discovery.minecraftservices.com']);
    assert.deepEqual(destinations, [{ host: publicAddress.address, family: 4, port: 443 }]);
    assert.equal((await exchange(setup.ports.authenticationTls, tlsRecord(clientHello([tlsServerName('meta.fabricmc.net')])))).length, 0);
    assert.equal((await exchange(setup.ports.authenticationTls, tlsRecord(clientHello([])))).length, 0);
    assert.equal(destinations.length, 1);
  } finally { await setup.edge.close(); await stop(upstream); }
});

test('transparent TLS rejects private DNS and expires incomplete ClientHello without opening an upstream socket', async () => {
  let dialed = false;
  const setup = await fixture({ resolve: async () => [{ address: '127.0.0.1', family: 4 }], dial: () => { dialed = true; throw new Error('Unexpected dial.'); } }, { limits: { headerTimeoutMs: 40 } });
  try {
    assert.equal((await exchange(setup.ports.authenticationTls, tlsRecord(clientHello([tlsServerName('api.mojang.com')])))).length, 0);
    const started = Date.now();
    assert.equal((await exchange(setup.ports.authenticationTls, Buffer.from([22, 3, 3, 1]))).length, 0);
    assert.ok(Date.now() - started < 1_000);
    assert.equal(dialed, false);
  } finally { await setup.edge.close(); }
});

test('transparent TLS preserves end-to-end certificate verification and large encrypted responses', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'aron-edge-tls-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configuration = path.join(root, 'certificate.conf');
  const key = path.join(root, 'key.pem');
  const certificate = path.join(root, 'certificate.pem');
  await writeFile(configuration, '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=v3\n[dn]\nCN=sessionserver.mojang.com\n[v3]\nsubjectAltName=DNS:sessionserver.mojang.com\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-keyout', key, '-out', certificate, '-days', '1', '-config', configuration], { stdio: 'pipe' });
  const cert = await readFile(certificate);
  const payload = Buffer.alloc(1024 * 1024, 0x7a);
  const upstream = createTlsServer({ key: await readFile(key), cert }, socket => socket.once('data', bytes => { assert.equal(bytes.toString(), 'authenticated request'); socket.end(payload); }));
  const upstreamPort = await listener(upstream);
  const destinations: EdgeDestination[] = [];
  const setup = await fixture({ resolve: async host => { assert.equal(host, 'sessionserver.mojang.com'); return [publicAddress]; }, dial: destination => { destinations.push(destination); return connect({ host: '127.0.0.1', port: upstreamPort }); } });
  const client = tlsConnect({ host: '127.0.0.1', port: setup.ports.authenticationTls, servername: 'sessionserver.mojang.com', ca: cert, rejectUnauthorized: true, minVersion: 'TLSv1.2' });
  try {
    await once(client, 'secureConnect');
    assert.equal(client.authorized, true);
    assert.equal(client.getPeerCertificate().subject.CN, 'sessionserver.mojang.com');
    const received: Buffer[] = [];
    client.on('data', bytes => received.push(bytes));
    client.setTimeout(3_000, () => client.destroy(new Error('TLS fixture timed out.')));
    client.write('authenticated request');
    await once(client, 'end');
    assert.deepEqual(Buffer.concat(received), payload);
    assert.deepEqual(destinations, [{ host: publicAddress.address, family: 4, port: 443 }]);
  } finally { client.destroy(); await setup.edge.close(); await stop(upstream); }
});

test('installer proxy supports Node default-port Host headers without allowing another authority or port', async () => {
  const upstream = createServer(socket => socket.once('data', bytes => socket.end(bytes)));
  const upstreamPort = await listener(upstream);
  let resolutions = 0;
  const setup = await fixture({ resolve: async () => { resolutions++; return [publicAddress]; }, dial: () => connect({ host: '127.0.0.1', port: upstreamPort }) });
  try {
    assert.match((await exchange(setup.ports.installerProxy, 'CONNECT meta.fabricmc.net:443 HTTP/1.1\r\nHost: meta.fabricmc.net\r\n\r\nhello')).toString(), /^HTTP\/1\.1 200 Connection Established\r\n\r\nhello$/);
    for (const header of ['meta.fabricmc.net:80', 'meta.fabricmc.net:0443', 'evil.test', 'meta.fabricmc.net.']) {
      assert.match((await exchange(setup.ports.installerProxy, `CONNECT meta.fabricmc.net:443 HTTP/1.1\r\nHost: ${header}\r\n\r\n`)).toString(), /^HTTP\/1\.1 400/);
    }
    assert.equal(resolutions, 1);
  } finally { await setup.edge.close(); await stop(upstream); }
});

test('edge bounds request headers, head bytes and DNS time without dialing', async () => {
  let dialed = false;
  const setup = await fixture({ resolve: () => new Promise(() => undefined), dial: () => { dialed = true; throw new Error('Unexpected dial.'); } }, { limits: { resolutionTimeoutMs: 30 } });
  try {
    assert.match((await exchange(setup.ports.installerProxy, connectRequest('meta.fabricmc.net'))).toString(), /^HTTP\/1\.1 504/);
    assert.match((await exchange(setup.ports.installerProxy, `CONNECT meta.fabricmc.net:443 HTTP/1.1\r\nHost: meta.fabricmc.net:443\r\nX-Huge: ${'x'.repeat(9_000)}\r\n\r\n`)).toString(), /^HTTP\/1\.1 431/);
    assert.match((await exchange(setup.ports.installerProxy, connectRequest('meta.fabricmc.net', 'x'.repeat(17 * 1024)))).toString(), /^HTTP\/1\.1 400/);
    assert.equal(dialed, false);
  } finally { await setup.edge.close(); }
});

test('opaque relay uses only configured upstream, preserves bytes and handles large backpressured responses', async () => {
  const bytes = Buffer.alloc(1024 * 1024, 0xa5);
  const upstream = createServer(socket => socket.once('data', request => { assert.equal(request.toString(), 'give data'); socket.end(bytes); }));
  const upstreamPort = await listener(upstream);
  const destinations: EdgeDestination[] = [];
  const setup = await fixture({ dial: destination => { destinations.push(destination); return connect({ host: '127.0.0.1', port: upstreamPort }); } }, { minecraftHost: 'fixed-minecraft', minecraftPort: 25566 });
  try {
    assert.deepEqual(await exchange(setup.ports.relay, 'give data'), bytes);
    assert.deepEqual(destinations, [{ host: 'fixed-minecraft', port: 25566 }]);
  } finally { await setup.edge.close(); await stop(upstream); }
});

test('relay per-address connection budget is released on disconnect and close terminates every tunnel', async () => {
  const upstreamSockets = new Set<Socket>();
  const upstream = createServer(socket => { upstreamSockets.add(socket); socket.on('close', () => upstreamSockets.delete(socket)); socket.write('ready'); });
  const upstreamPort = await listener(upstream);
  let dialed = 0;
  const setup = await fixture({ dial: () => { dialed++; return connect({ host: '127.0.0.1', port: upstreamPort }); } }, { limits: { relayConnectionsPerAddress: 1 } });
  const first = connect({ host: '127.0.0.1', port: setup.ports.relay });
  first.on('error', () => undefined);
  await once(first, 'data');
  try {
    assert.equal((await exchange(setup.ports.relay, 'denied')).length, 0);
    assert.equal(dialed, 1);
    first.destroy();
    await once(first, 'close');
    await delay(20);
    const second = connect({ host: '127.0.0.1', port: setup.ports.relay });
    second.on('error', () => undefined);
    await once(second, 'data');
    assert.equal(dialed, 2);
    const closed = once(second, 'close');
    await setup.edge.close();
    await closed;
  } finally { first.destroy(); await setup.edge.close(); for (const socket of upstreamSockets) socket.destroy(); await stop(upstream); }
});

test('edge bounds idle and lifetime, closes connection failures and serves local health only', async () => {
  const held = new Set<Socket>();
  const upstream = createServer(socket => { held.add(socket); socket.on('close', () => held.delete(socket)); socket.on('data', bytes => socket.write(bytes)); });
  const upstreamPort = await listener(upstream);
  const setup = await fixture({ resolve: async () => [publicAddress], dial: () => connect({ host: '127.0.0.1', port: upstreamPort }) }, { limits: { relayIdleTimeoutMs: 40, proxyIdleTimeoutMs: 40, installerLifetimeMs: 60, installerBytes: 3 } });
  try {
    assert.match((await exchange(setup.ports.health, 'GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n')).toString(), /^HTTP\/1\.1 200.*\{"status":"ok"\}$/s);
    assert.match((await exchange(setup.ports.health, 'GET /other HTTP/1.1\r\nHost: localhost\r\n\r\n')).toString(), /^HTTP\/1\.1 404/);
    assert.match((await exchange(setup.ports.health, connectRequest('meta.fabricmc.net'))).toString(), /^HTTP\/1\.1 405/);
    const idle = await exchange(setup.ports.installerProxy, connectRequest('meta.fabricmc.net'));
    assert.match(idle.toString(), /^HTTP\/1\.1 200/);
    assert.match((await exchange(setup.ports.installerProxy, connectRequest('meta.fabricmc.net', 'too many bytes'))).toString(), /^HTTP\/1\.1 403/);
  } finally { await setup.edge.close(); for (const socket of held) socket.destroy(); await stop(upstream); }
  const failing = await fixture({ resolve: async () => [publicAddress], dial: () => { throw new Error('No route.'); } });
  try { assert.match((await exchange(failing.ports.installerProxy, connectRequest('meta.fabricmc.net'))).toString(), /^HTTP\/1\.1 502/); }
  finally { await failing.edge.close(); }
});
