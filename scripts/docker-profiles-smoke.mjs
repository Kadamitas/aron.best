import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:3300');
if (!['localhost', '127.0.0.1'].includes(origin.hostname) || origin.protocol !== 'http:') throw new Error('Saved-server smoke tests only operate on a local preview.');
const token = (await readFile(new URL('../.runtime/docker/secrets/friend_access_token', import.meta.url), 'utf8')).trim();
let cookie = '';
let profileId;
async function request(route, method = 'GET', body, selected = profileId, workspaceId) {
  const response = await fetch(new URL(route, origin), {
    method, signal: AbortSignal.timeout(30_000),
    headers: { origin: origin.origin, ...(cookie ? { cookie } : { authorization: `Bearer ${token}` }), ...(selected ? { 'X-Server-Profile': selected } : {}), ...(workspaceId ? { 'X-Workspace-Profile': workspaceId } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}
const redeemed = await request('/api/access/redeem', 'POST', {});
assert.equal(redeemed.status, 200);
cookie = redeemed.headers.get('set-cookie')?.split(';')[0] ?? '';
assert(cookie);
const initial = await request('/api/status');
assert.equal(initial.status, 200);
assert.equal(initial.body.server.state, 'stopped');
assert.equal(initial.body.jobRunning, false);
assert(initial.body.profiles && initial.body.profiles.profiles.length < 5, 'The preview needs one available server slot.');
const originalId = initial.body.profiles.activeId;
profileId = originalId;
const suffix = randomUUID();
const name = `Preview check ${suffix}`;
const renamed = `Verified ${suffix}`;
const file = `config/profile-check-${suffix}.md`;
let createdId;
let originalFileCreated = false;
let originalContents = 'Original server fixture.';

async function settle() {
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const response = await request('/api/status');
    if (response.status === 429) { await new Promise(resolve => setTimeout(resolve, 5000)); continue; }
    assert.equal(response.status, 200, JSON.stringify(response.body));
    if (!response.body.jobRunning) {
      assert(!response.body.server.profileError, response.body.server.profileError);
      profileId = response.body.profiles.activeId;
      return response.body;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error('Saved-server operation did not finish within fifteen minutes.');
}

try {
  assert.equal((await request('/api/workspace/files/text', 'PUT', { path: file, contents: 'Original server fixture.', revision: 'new' })).status, 200);
  originalFileCreated = true;
  const creation = await request('/api/server/profiles', 'POST', { name });
  assert.equal(creation.status, 202, JSON.stringify(creation.body));
  const created = await settle();
  createdId = created.profiles.activeId;
  assert.notEqual(createdId, originalId);
  assert.equal(created.profiles.profiles.length, initial.body.profiles.profiles.length + 1);
  assert.equal(created.profiles.profiles.find(profile => profile.id === createdId).name, name);
  assert.equal(created.server.state, 'stopped');
  assert.equal(created.pack.minecraftVersion, initial.body.pack.minecraftVersion);
  assert.equal((await request('/api/workspace/mods')).body.mods.length, 0);
  assert.equal((await request(`/api/workspace/files/text?${new URLSearchParams({ path: file })}`)).status, 404);
  assert.equal((await request('/api/workspace/files/text', 'PUT', { path: file, contents: 'Wrong slot.', revision: 'new' }, originalId)).status, 409);
  assert.equal((await request('/api/workspace/files/text', 'PUT', { path: file, contents: 'New server fixture.', revision: 'new' })).status, 200);
  assert.equal((await request('/api/server/profiles/rename', 'POST', { id: createdId, name: renamed })).status, 200);
  assert.equal((await request('/api/status')).body.profiles.profiles.find(profile => profile.id === createdId).name, renamed);
  assert.equal((await request('/api/server/profiles/remove', 'POST', { id: createdId })).status, 409);
  console.log('Blank saved server provisioned; rename, separate files, active-delete protection, and stale-context rejection passed.');
  if (process.argv.includes('--lifecycle')) {
    assert.equal((await request('/api/server/action', 'POST', { action: 'start' })).status, 202);
    assert.equal((await settle()).server.state, 'running');
    console.log('The new saved server reached running state inside Docker.');
    const editing = await request('/api/status', 'GET', undefined, profileId, originalId);
    assert.equal(editing.status, 200);
    assert.equal(editing.body.profiles.activeId, createdId);
    assert.equal(editing.body.server.state, 'running');
    assert.equal(editing.body.workspace.profileId, originalId);
    assert.equal(editing.body.workspace.server.state, 'stopped');
    const originalText = await request(`/api/workspace/files/text?${new URLSearchParams({ path: file })}`, 'GET', undefined, profileId, originalId);
    assert.equal(originalText.status, 200);
    originalContents = 'Edited while another saved server was running.';
    const saved = await request('/api/workspace/files/text', 'PUT', { path: file, contents: originalContents, revision: originalText.body.revision }, profileId, originalId);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const activeWrite = await request('/api/workspace/files/text', 'PUT', { path: `config/blocked-${suffix}.md`, contents: 'Must not write while running.', revision: 'new' }, profileId, createdId);
    assert.equal(activeWrite.status, 409);
    assert.equal((await request(`/api/workspace/files/text?${new URLSearchParams({ path: file })}`, 'GET', undefined, profileId, originalId)).body.contents, originalContents);
    assert.equal((await request('/api/status')).body.server.state, 'running');
    console.log('Inactive-slot file edits succeeded while the active game stayed running; active-slot writes remained blocked.');
  }
  assert.equal((await request('/api/server/profiles/select', 'POST', { id: originalId })).status, 202);
  const restored = await settle();
  assert.equal(restored.profiles.activeId, originalId);
  assert.equal(restored.server.state, 'stopped');
  assert.equal((await request(`/api/workspace/files/text?${new URLSearchParams({ path: file })}`)).body.contents, originalContents);
  assert.equal((await request('/api/server/action', 'POST', { action: 'start' }, createdId)).status, 409);
  assert.equal((await request('/api/server/profiles/remove', 'POST', { id: createdId })).status, 200);
  createdId = undefined;
  assert.equal((await request('/api/status')).body.profiles.profiles.length, initial.body.profiles.profiles.length);
  console.log('Switch-back preserved original files, stopped the prior game, and retained the deleted test server in recovery storage.');
} finally {
  const response = await request('/api/status').catch(() => undefined);
  if (response?.status === 200 && !response.body.jobRunning) {
    profileId = response.body.profiles.activeId;
    createdId ??= response.body.profiles.profiles.find(profile => profile.name === name || profile.name === renamed)?.id;
    if (profileId === createdId) {
      assert.equal((await request('/api/server/profiles/select', 'POST', { id: originalId })).status, 202);
      await settle();
    }
    if (profileId === originalId) {
      if (createdId) assert.equal((await request('/api/server/profiles/remove', 'POST', { id: createdId })).status, 200);
      if (originalFileCreated) assert.equal((await request('/api/workspace/entries/remove', 'POST', { path: file })).status, 200);
    }
  }
}
