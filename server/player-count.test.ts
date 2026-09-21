import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { PlayerCountMonitor, queryPlayerCount, type PlayerCount } from './player-count.js';

function variable(value: number): Buffer {
  const bytes: number[] = [];
  do { const part = value & 127; value >>>= 7; bytes.push(part | (value ? 128 : 0)); } while (value);
  return Buffer.from(bytes);
}

function statusReply(players: unknown): Buffer {
  const json = Buffer.from(JSON.stringify({ players }));
  const packet = Buffer.concat([Buffer.from([0]), variable(json.length), json]);
  return Buffer.concat([variable(packet.length), packet]);
}

async function endpoint(reply: (socket: Socket, request: Buffer) => void) {
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.once('data', bytes => reply(socket, bytes));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address.');
  return { port: address.port, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}

test('player status handles fragmented modern packets and one name per real sample entry', async () => {
  const reply = statusReply({ online: 3, max: 12, sample: [{ name: 'Aron' }, { name: 'Friend_2' }, { name: 'Aron' }, { name: '<unsafe>' }] });
  const fixture = await endpoint((socket, request) => {
    assert.deepEqual([...request.subarray(-2)], [1, 0]);
    socket.write(reply.subarray(0, 3));
    setImmediate(() => socket.end(reply.subarray(3)));
  });
  try {
    assert.deepEqual(await queryPlayerCount('26.3', new AbortController().signal, fixture.port), { online: 3, max: 12, names: ['Aron', 'Friend_2'] });
  } finally { await fixture.close(); }
});

test('player status supports legacy 1.6.4 counts without inventing player names', async () => {
  const text = Buffer.from('§1\0' + '78\0' + '1.6.4\0' + 'Server\0' + '2\0' + '20', 'utf16le').swap16();
  const header = Buffer.alloc(3);
  header[0] = 255;
  header.writeUInt16BE(text.length / 2, 1);
  const fixture = await endpoint((socket, request) => { assert.deepEqual([...request], [254, 1]); socket.end(Buffer.concat([header, text])); });
  try { assert.deepEqual(await queryPlayerCount('1.6.4', new AbortController().signal, fixture.port), { online: 2, max: 20, names: null }); }
  finally { await fixture.close(); }
});

test('hidden player samples are unavailable, not falsely empty while players are online', async () => {
  const fixture = await endpoint(socket => socket.end(statusReply({ online: 4, max: 20 })));
  try { assert.deepEqual(await queryPlayerCount('1.7.10', new AbortController().signal, fixture.port), { online: 4, max: 20, names: null }); }
  finally { await fixture.close(); }
});

test('status rejects invalid counts, malformed packet lengths and oversized replies', async () => {
  for (const bytes of [statusReply({ online: -1, max: 20 }), statusReply({ online: '2', max: 20 }), Buffer.from([255, 255, 255, 255, 255]), variable(256 * 1024), Buffer.from([2, 0, 0])]) {
    const fixture = await endpoint(socket => socket.end(bytes));
    try { await assert.rejects(queryPlayerCount('26.3', new AbortController().signal, fixture.port)); }
    finally { await fixture.close(); }
  }
});

test('status timeout and cancellation close the local query', async () => {
  const fixture = await endpoint(() => undefined);
  try {
    await assert.rejects(queryPlayerCount('26.3', new AbortController().signal, fixture.port, 30), /timed out/);
    const abort = new AbortController();
    const request = queryPlayerCount('26.3', abort.signal, fixture.port);
    abort.abort();
    await assert.rejects(request, /cancelled/);
  } finally { await fixture.close(); }
});

test('player count polling is cached and reports unavailable after a failed refresh', async () => {
  let now = 0;
  let calls = 0;
  const monitor = new PlayerCountMonitor(async () => {
    if (++calls > 1) throw new Error('Unavailable');
    return { online: 2, max: 12, names: ['Aron', 'Friend'] };
  }, () => now);
  assert.deepEqual(monitor.read(false, '26.3'), { online: 0, max: null, names: [] });
  assert.equal(calls, 0);
  assert.deepEqual(monitor.read(true, '26.3'), { online: null, max: null, names: null });
  await nextTurn();
  assert.equal(monitor.read(true, '26.3').online, 2);
  assert.equal(calls, 1);
  now = 5000;
  monitor.read(true, '26.3');
  await nextTurn();
  assert.deepEqual(monitor.read(true, '26.3'), { online: null, max: null, names: null });
  assert.equal(calls, 2);
});

test('stopping or changing installations discards an in-flight player response', async () => {
  const pending: Array<(value: PlayerCount) => void> = [];
  const monitor = new PlayerCountMonitor(() => new Promise(resolve => pending.push(resolve)));
  monitor.read(true, '26.3');
  assert.equal(monitor.read(false, '26.3').online, 0);
  pending[0]!({ online: 8, max: 12, names: ['Stale'] });
  await nextTurn();
  assert.equal(monitor.read(false, '26.3').online, 0);
  monitor.read(true, '26.3');
  monitor.read(true, '1.7.10');
  pending[1]!({ online: 8, max: 12, names: ['OldSlot'] });
  await nextTurn();
  assert.equal(monitor.read(true, '1.7.10').online, null);
  pending[2]!({ online: 1, max: 20, names: ['NewSlot'] });
  await nextTurn();
  assert.deepEqual(monitor.read(true, '1.7.10'), { online: 1, max: 20, names: ['NewSlot'] });
});
