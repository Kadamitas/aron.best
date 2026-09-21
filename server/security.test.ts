import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createApp, readConfiguration } from './app.js';
import { validateArtifactUrl } from './download.js';

test('host separation, invitation, origin and command allowlist hold at the API boundary', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'aron-security-'));
  const secret = 'a'.repeat(43);
  const app = await createApp(readConfiguration({ NODE_ENV: 'test', RUNTIME_DIRECTORY: directory, FRIEND_ACCESS_TOKEN: secret }));
  try {
    assert.equal((await app.inject({ url: '/api/status', headers: { host: 'aron.best' } })).statusCode, 404);
    assert.equal((await app.inject({ url: '/api/status', headers: { host: 'attacker.test' } })).statusCode, 421);
    assert.equal((await app.inject({ url: '/api/status', headers: { host: 'mc.modpack.aron.best' } })).statusCode, 401);
    const gate = await app.inject({ url: '/', headers: { host: 'mc.modpack.aron.best' } });
    assert.equal(gate.statusCode, 200);
    assert.match(gate.body, /Friends only/);
    assert.doesNotMatch(gate.body, /<app-root>/);
    assert.match(gate.headers['content-security-policy'] as string, /script-src 'nonce-/);
    assert.equal(gate.headers['x-robots-tag'], 'noindex, nofollow');
    const opened = await app.inject({ url: '/', headers: { host: 'mc.modpack.aron.best', authorization: `Bearer ${secret}` } });
    assert.doesNotMatch(opened.body, /Friends only/);
    const portfolio = await app.inject({ url: '/', headers: { host: 'aron.best' } });
    assert.doesNotMatch(portfolio.body, /Friends only/);
    const status = await app.inject({ url: '/api/status', headers: { host: 'mc.modpack.aron.best', authorization: `Bearer ${secret}` } });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().capabilities.authorized, true);
    const action = { method: 'POST' as const, url: '/api/server/action', payload: { action: 'restart' } };
    assert.equal((await app.inject(action)).statusCode, 401);
    assert.equal((await app.inject({ ...action, headers: { authorization: `Bearer ${secret}`, origin: 'https://evil.test' } })).statusCode, 403);
    assert.equal((await app.inject({ ...action, headers: { authorization: `Bearer ${secret}`, origin: 'https://mc.modpack.aron.best' }, payload: { action: 'rm -rf /' } })).statusCode, 400);
    const logs = await app.inject({ url: '/api/server/logs' });
    assert.equal(logs.statusCode, 401);
    for (const url of ['/%61pi/server/logs', '/api/server/%6cogs', '/api/server/logs?example=1']) {
      assert.equal((await app.inject({ url })).statusCode, 401, url);
      assert.equal((await app.inject({ url, headers: { host: 'aron.best' } })).statusCode, 404, url);
    }
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('artifact downloads reject local, insecure and disguised hosts', () => {
  for (const url of ['http://edge.forgecdn.net/mod.jar', 'https://127.0.0.1/mod.jar', 'https://edge.forgecdn.net.attacker.test/mod.jar', 'https://edge.forgecdn.net:444/mod.jar', 'https://user:pass@edge.forgecdn.net/mod.jar']) assert.throws(() => validateArtifactUrl(url));
  assert.equal(validateArtifactUrl('https://edge.forgecdn.net/files/mod.jar').hostname, 'edge.forgecdn.net');
});
