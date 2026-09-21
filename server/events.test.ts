import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createApp, readConfiguration } from './app.js';

test('live events require access and push a status snapshot, then new log lines', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'aron-events-'));
  const secret = 'e'.repeat(43);
  const app = await createApp(readConfiguration({ NODE_ENV: 'test', RUNTIME_DIRECTORY: directory, FRIEND_ACCESS_TOKEN: secret }));
  try {
    assert.equal((await app.inject({ url: '/api/events', headers: { host: 'mc.modpack.aron.best' } })).statusCode, 401);
    const response = await app.inject({ url: '/api/events', headers: { host: 'mc.modpack.aron.best', authorization: `Bearer ${secret}` }, payloadAsStream: true });
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers['content-type']), /text\/event-stream/);
    const stream = response.stream();
    let received = '';
    const until = (marker: string) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Did not receive ${marker}. Got: ${received}`)), 5_000);
      const check = () => { if (received.includes(marker)) { clearTimeout(timer); stream.off('data', onData); resolve(); } };
      const onData = (chunk: Buffer) => { received += chunk.toString(); check(); };
      stream.on('data', onData);
      check();
    });
    await until('event: status');
    assert.match(received, /"state":"not-installed"/);
    stream.destroy();
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
