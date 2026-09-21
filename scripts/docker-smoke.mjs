import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:3300');
if (!['localhost', '127.0.0.1'].includes(base.hostname) || base.protocol !== 'http:') throw new Error('Smoke tests only operate on a local preview.');
const token = (await readFile(new URL('../.runtime/docker/secrets/friend_access_token', import.meta.url), 'utf8')).trim();
let cookie = '';
let profileId;
async function request(route, method = 'GET', body, headers = {}) {
  return fetch(new URL(route, base), { method, headers: { origin: base.origin, ...(cookie ? { cookie } : {}), ...(profileId ? { 'X-Server-Profile': profileId } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
}
assert.equal((await request('/api/status')).status, 401);
const redemption = await request('/api/access/redeem', 'POST', {}, { authorization: `Bearer ${token}` });
assert.equal(redemption.status, 200);
cookie = redemption.headers.get('set-cookie')?.split(';')[0] ?? '';
assert.ok(cookie);
const status = await (await request('/api/status')).json();
profileId = status.profiles?.activeId;
assert.equal(status.capabilities.workspaceWrite, true);
assert.equal(status.capabilities.ipWhitelisted, false);
assert.equal(status.server.state, 'stopped', 'Stop the preview Minecraft process before testing writes.');
const suffix = randomUUID();
const textPath = `config/smoke-${suffix}.json`;
const text = await request('/api/workspace/files/text', 'PUT', { path: textPath, contents: '{"smoke":true}', revision: 'new' });
assert.equal(text.status, 200, await text.clone().text());
const saved = await text.json();
assert.equal((await request(`/api/workspace/files/text?${new URLSearchParams({ path: textPath })}`)).status, 200);
assert.equal((await request('/api/workspace/files/text', 'PUT', { path: textPath, contents: '{}', revision: 'outdated' })).status, 409);
assert.equal((await request('/api/workspace/files/text?path=../secrets/friend_access_token')).status, 400);
const folderPath = `config/folder-${suffix}`;
assert.equal((await request('/api/workspace/directories', 'POST', { path: folderPath })).status, 200);
assert.equal((await request('/api/workspace/files/text', 'PUT', { path: `${folderPath}/notes.whatever`, contents: 'Created through the file manager.', revision: 'new' })).status, 200);
assert.equal((await request('/api/workspace/entries/move', 'POST', { path: `${folderPath}/notes.whatever`, destination: `${folderPath}/renamed.md` })).status, 200);
assert.equal((await request('/api/workspace/entries/move', 'POST', { path: folderPath, destination: `${folderPath}-moved` })).status, 200);
const listing = await (await request('/api/workspace/files')).json();
assert(listing.directories.some(folder => folder.path === `${folderPath}-moved`));
assert.equal((await request('/api/workspace/entries/remove', 'POST', { path: `${folderPath}-moved` })).status, 200);
assert.equal((await request('/api/workspace/entries/remove', 'POST', { path: 'config' })).status, 400);
const modPath = `mods/smoke-${suffix}.jar`;
const payload = Buffer.from('Smoke fixture, removed before starting Minecraft.');
const created = await request('/api/workspace/uploads', 'POST', { path: modPath, size: payload.length, replace: false });
assert.equal(created.status, 200, await created.clone().text());
const upload = await created.json();
assert.equal((await request(`/api/workspace/uploads/${upload.id}/chunks`, 'POST', { index: 0, data: payload.toString('base64') })).status, 200);
assert.equal((await request(`/api/workspace/uploads/${upload.id}/complete`, 'POST', {})).status, 200);
const downloaded = await request(`/api/workspace/files/download?${new URLSearchParams({ path: modPath })}`);
assert.equal(downloaded.status, 200);
assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), payload);
assert.equal((await request('/api/workspace/mods/action', 'POST', { path: modPath, action: 'disable' })).status, 200);
const mods = await (await request('/api/workspace/mods')).json();
assert.equal(mods.mods.find(mod => mod.path === `${modPath}.disabled`)?.enabled, false);
assert.equal((await request('/api/workspace/mods/action', 'POST', { path: `${modPath}.disabled`, action: 'enable' })).status, 200);
assert.equal((await request('/api/workspace/mods/action', 'POST', { path: modPath, action: 'uninstall' })).status, 200);
assert.equal((await request('/api/workspace/files/text', 'PUT', { path: textPath, contents: '{}', revision: saved.revision }, { origin: 'https://example.invalid' })).status, 403);
const zip = await request('/api/pack/download');
assert.equal(zip.status, 200);
assert.equal(zip.headers.get('content-type'), 'application/zip');
assert.equal(Buffer.from(await zip.arrayBuffer()).readUInt32LE(0), 0x04034b50);
console.log('Container smoke checks passed: invite, isolation, file editor, folder creation, rename/move/recoverable deletion, conflict detection, upload/download, mod controls, origin checks and ZIP.');
console.log(`Preview fixture retained at ${textPath}; the test mod was uninstalled into recovery storage.`);

if (process.argv.includes('--lifecycle')) {
  async function settle(expected) {
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      const current = await (await request('/api/status')).json();
      if (!current.jobRunning) {
        assert.equal(current.server.state, expected, JSON.stringify(current.server.failure));
        return current;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error(`Minecraft did not reach ${expected}.`);
  }
  assert.equal((await request('/api/server/action', 'POST', { action: 'start' })).status, 202);
  await settle('running');
  assert.equal((await request('/api/workspace/files/text', 'PUT', { path: textPath, contents: '{}', revision: saved.revision })).status, 409);
  console.log('Minecraft started successfully inside the isolated container; live file writes are locked.');
  assert.equal((await request('/api/server/action', 'POST', { action: 'stop' })).status, 202);
  await settle('stopped');
  assert.equal((await request('/api/server/action', 'POST', { action: 'backup' })).status, 202);
  const backedUp = await settle('stopped');
  assert.ok(backedUp.server.lastBackup);
  console.log('Minecraft stopped cleanly and backed up its preview world.');
}
