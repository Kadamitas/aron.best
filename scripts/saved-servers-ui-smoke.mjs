import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const buildDirectory = path.resolve(process.argv[2] ?? '/tmp/aron-saved-servers-ui-build/browser');
const outputDirectory = fileURLToPath(new URL('../.runtime/ui-check/', import.meta.url));
await mkdir(outputDirectory, { recursive: true });
const requests = [];
const workspaceReads = [];
const profiles = [
  { id: 'infinity', name: 'FTB Infinity Evolved', minecraftVersion: '1.7.10', loader: 'Forge', loaderVersion: '10.13.4.1614' },
  { id: 'direwolf', name: 'Direwolf20', minecraftVersion: '1.12.2', loader: 'Forge', loaderVersion: '14.23.5.2860' },
];
const status = {
  history: [], requests: [], activity: [], jobRunning: false,
  profiles: { activeId: profiles[0].id, profiles, limit: 5 },
  pack: { name: 'Dictionary Minecraft Server', ...profiles[0], version: '', mods: [], releases: [] },
  server: { state: 'running', address: 'mc.example.test', profileError: '', uptimeSeconds: 120 },
  capabilities: { authorized: true, workspaceWrite: true, server: true, curseforgeSearch: false, publish: false, update: false, localProfile: false },
};
const activate = profile => { status.profiles.activeId = profile.id; status.server.state = 'stopped'; };
const fileContents = new Map();
const disabledMods = new Set();
const workspaceStatus = profile => ({ ...status.server, state: profile.id === status.profiles.activeId ? status.server.state : 'stopped', version: profile.minecraftVersion, loader: profile.loader, loaderVersion: profile.loaderVersion });
const workspaceFile = profile => {
  const contents = fileContents.get(profile.id) ?? `Original ${profile.id} settings`;
  return { path: 'config/example.txt', name: 'example.txt', size: contents.length, contents, revision: `fixture-${profile.id}`, modifiedAt: new Date().toISOString(), text: true };
};
const mimeTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
let releaseOldMods;
let holdFirstMods = true;
let completeProfileOperation;
const startProfileOperation = operation => {
  status.jobRunning = true;
  status.server.busy = true;
  status.server.profileError = '';
  completeProfileOperation = () => {
    status.jobRunning = false;
    status.server.busy = false;
    operation();
    completeProfileOperation = undefined;
  };
};
const fixture = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const json = (data, code = 200) => { response.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(data)); };
  try {
    if (url.pathname === '/site-config.json') return json({ workshop: true });
    const workspaceId = request.headers['x-workspace-profile'] ?? status.profiles.activeId;
    const workspace = profiles.find(profile => profile.id === workspaceId) ?? (url.pathname === '/api/status' ? profiles.find(profile => profile.id === status.profiles.activeId) : undefined);
    if (url.pathname.startsWith('/api/') && !workspace) return json({ error: 'This saved server no longer exists.' }, 404);
    if (url.pathname === '/api/status') return json({ ...status, pack: { ...status.pack, ...workspace }, workspace: { profileId: workspace.id, server: workspaceStatus(workspace) } });
    if (url.pathname === '/api/server/logs') return json({ lines: [`${status.profiles.activeId} server output`] });
    if (url.pathname === '/api/workspace/mods') {
      const profileId = workspace.id;
      workspaceReads.push({ path: url.pathname, profile: request.headers['x-server-profile'], workspace: profileId });
      if (holdFirstMods) { holdFirstMods = false; await new Promise(resolve => { releaseOldMods = resolve; }); }
      return json({ mods: [{ name: `${profileId}.jar`, path: `mods/${profileId}.jar`, size: 100, modifiedAt: new Date().toISOString(), text: false, enabled: !disabledMods.has(profileId) }] });
    }
    if (url.pathname === '/api/workspace/files') {
      workspaceReads.push({ path: url.pathname, profile: request.headers['x-server-profile'], workspace: workspace.id });
      return json({ files: [workspaceFile(workspace)], directories: [], truncated: false });
    }
    if (url.pathname === '/api/workspace/files/text' && request.method === 'GET') return json(workspaceFile(workspace));
    if (url.pathname.startsWith('/api/') && ['POST', 'PUT'].includes(request.method)) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push({ path: url.pathname, body, profile: request.headers['x-server-profile'], ...(url.pathname.startsWith('/api/workspace/') ? { workspace: request.headers['x-workspace-profile'] } : {}) });
      if (request.headers['x-server-profile'] !== status.profiles.activeId) return json({ error: 'The active server changed. Refresh before editing files.' }, 409);
      if (url.pathname.startsWith('/api/workspace/') && workspaceStatus(workspace).state === 'running') return json({ error: 'Stop this server before editing its files.' }, 409);
      if (url.pathname === '/api/workspace/files/text') { fileContents.set(workspace.id, body.contents); return json(workspaceFile(workspace)); }
      if (url.pathname === '/api/workspace/mods/action') { if (body.action === 'disable') disabledMods.add(workspace.id); else disabledMods.delete(workspace.id); return json({ accepted: true }); }
      if (url.pathname === '/api/server/profiles/select') { startProfileOperation(() => activate(profiles.find(profile => profile.id === body.id))); return json({ accepted: true }, 202); }
      if (url.pathname === '/api/server/profiles') {
        if (body.name === 'Rejected world') return json({ error: 'The fixture rejected this server creation.' }, 503);
        const profile = { ...profiles.find(profile => profile.id === status.profiles.activeId), id: `new-${profiles.length}`, name: body.name };
        startProfileOperation(() => { profiles.push(profile); activate(profile); });
        return json({ accepted: true }, 202);
      }
      if (url.pathname === '/api/server/profiles/rename') { profiles.find(profile => profile.id === body.id).name = body.name; return json({ accepted: true }); }
      if (url.pathname === '/api/server/profiles/remove') { profiles.splice(profiles.findIndex(profile => profile.id === body.id), 1); return json({ accepted: true }); }
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'Unexpected fixture request.' }, 500);
    const file = path.resolve(buildDirectory, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
    if (!file.startsWith(`${buildDirectory}${path.sep}`)) return json({ error: 'Invalid file path.' }, 400);
    response.writeHead(200, { 'content-type': mimeTypes[path.extname(file)] ?? 'application/octet-stream' });
    response.end(await readFile(file));
  } catch { if (!response.headersSent) response.writeHead(500); response.end(); }
});
await new Promise((resolve, reject) => { fixture.once('error', reject); fixture.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${fixture.address().port}`;
const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (existsSync(macChrome) ? macChrome : undefined);
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await expect(page.getByRole('heading', { name: 'Dictionary Minecraft Server', exact: true })).toBeVisible();
  const selector = page.getByRole('button', { name: 'Select saved server', exact: true, includeHidden: true });
  const select = async name => { await selector.click(); await page.getByRole('menuitem', { name: `Edit ${name}`, exact: true }).click(); };
  const manage = async name => { const trigger = page.getByRole('button', { name: 'Manage saved servers', exact: true }); if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click(); await page.getByRole('menuitem', { name, exact: true }).hover(); };
  await expect(selector).toContainText('FTB Infinity Evolved');
  await expect.poll(() => typeof releaseOldMods).toBe('function');
  await expect(page.getByRole('button', { name: 'Add mod', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Download pack ZIP', exact: true })).toBeEnabled();
  await page.getByRole('tab', { name: 'Advanced', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Choose files', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Edit config/example.txt', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'example.txt', exact: true });
  await expect(dialog.getByRole('textbox')).not.toBeEditable();
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Close editor', exact: true }).click();
  await select('Direwolf20');
  await expect(selector).toContainText('Direwolf20');
  releaseOldMods();
  await expect(page.getByRole('dialog')).toBeHidden();
  assert.equal(status.profiles.activeId, 'infinity');
  assert.equal(status.server.state, 'running');
  assert.equal(requests.length, 0);
  await expect(page.getByRole('region', { name: 'Server controls' })).toContainText('FTB Infinity Evolved');
  await expect(page.getByRole('button', { name: 'Restart', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Choose files', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Edit config/example.txt', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'example.txt', exact: true });
  await expect(dialog.getByRole('textbox')).toHaveValue('Original direwolf settings');
  await expect(dialog.getByRole('textbox')).toBeEditable();
  await dialog.getByRole('textbox').fill('Only the inactive Direwolf settings changed');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('Saved');
  assert.deepEqual(requests.at(-1), { path: '/api/workspace/files/text', body: { path: 'config/example.txt', contents: 'Only the inactive Direwolf settings changed', revision: 'fixture-direwolf' }, profile: 'infinity', workspace: 'direwolf' });
  assert.equal(fileContents.has('infinity'), false);
  assert.equal(status.server.state, 'running');
  await dialog.getByRole('button', { name: 'Close editor', exact: true }).click();
  await page.getByRole('tab', { name: 'Basic', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Change Minecraft version', exact: true })).toContainText('1.12.2');
  await expect(page.getByRole('heading', { name: 'direwolf.jar', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'infinity.jar', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Add mod', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Disable', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Enable', exact: true })).toBeEnabled();
  assert.deepEqual(requests.at(-1), { path: '/api/workspace/mods/action', body: { path: 'mods/direwolf.jar', action: 'disable' }, profile: 'infinity', workspace: 'direwolf' });
  assert.equal(disabledMods.has('infinity'), false);
  assert.equal(status.profiles.activeId, 'infinity');
  assert.equal(status.server.state, 'running');
  assert.equal(requests.some(request => request.path === '/api/server/action' || request.path === '/api/server/profiles/select'), false);
  assert(workspaceReads.some(request => request.path === '/api/workspace/files' && request.workspace === 'direwolf' && request.profile === 'infinity'));
  await page.screenshot({ path: path.join(outputDirectory, 'inactive-server-workspace.png'), fullPage: true });
  await page.getByRole('button', { name: 'Set active', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Set Direwolf20 active?', exact: true });
  await expect(dialog).toContainText('stop');
  await expect(dialog).toContainText('stopped');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(requests.length, 2);
  assert.equal(status.server.state, 'running');
  await page.getByRole('button', { name: 'Set active', exact: true }).click();
  await dialog.getByRole('button', { name: 'Stop and set active', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Switching to Direwolf20' })).toBeVisible();
  await expect(selector).toBeDisabled();
  assert.equal(status.profiles.activeId, 'infinity');
  await expect.poll(() => typeof completeProfileOperation).toBe('function');
  completeProfileOperation();
  await expect(page.getByRole('button', { name: 'Set active', exact: true })).toBeHidden({ timeout: 20_000 });
  assert.deepEqual(requests.at(-1), { path: '/api/server/profiles/select', body: { id: 'direwolf' }, profile: 'infinity' });
  assert.equal(status.profiles.activeId, 'direwolf');
  assert.equal(status.server.state, 'stopped');
  await page.getByRole('button', { name: 'New server', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Create a saved server', exact: true });
  await expect(dialog).toContainText('blank world, no mods and fresh settings');
  await expect(dialog.getByRole('button', { name: 'Create and switch', exact: true })).toBeDisabled();
  await dialog.getByLabel('Server name').fill('   ');
  await expect(dialog.getByRole('button', { name: 'Create and switch', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(requests.length, 3);
  await page.getByRole('button', { name: 'New server', exact: true }).click();
  await dialog.getByLabel('Server name').fill('  Fresh world  ');
  await page.screenshot({ path: path.join(outputDirectory, 'saved-server-create.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Create and switch', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Creating Fresh world...' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New server', exact: true })).toBeDisabled();
  assert.equal(status.profiles.activeId, 'direwolf');
  await expect.poll(() => typeof completeProfileOperation).toBe('function');
  completeProfileOperation();
  await expect(selector).toContainText('Fresh world', { timeout: 20_000 });
  assert.deepEqual(requests.at(-1), { path: '/api/server/profiles', body: { name: 'Fresh world' }, profile: 'direwolf' });
  await manage('Fresh world');
  await expect(page.getByRole('menuitem', { name: 'Delete', exact: true })).toBeDisabled();
  await page.screenshot({ path: path.join(outputDirectory, 'saved-server-menu.png'), fullPage: true });
  await manage('Direwolf20');
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Rename server', exact: true });
  await dialog.getByLabel('Server name').fill('Direwolf20 classic');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(requests.length, 4);
  await manage('Direwolf20');
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  await dialog.getByLabel('Server name').fill('Direwolf20 classic');
  await dialog.getByRole('button', { name: 'Rename server', exact: true }).click();
  await expect(dialog).toBeHidden();
  assert.deepEqual(requests.at(-1), { path: '/api/server/profiles/rename', body: { id: 'direwolf', name: 'Direwolf20 classic' }, profile: 'new-2' });
  await manage('Direwolf20 classic');
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Delete Direwolf20 classic?', exact: true });
  await expect(dialog).toContainText('Its world, mods, settings and backups are kept.');
  await expect(dialog).toContainText('Recovery at any time');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(requests.length, 5);
  await select('Direwolf20 classic');
  await expect(selector).toContainText('Direwolf20 classic');
  assert.equal(status.profiles.activeId, 'new-2');
  await manage('Direwolf20 classic');
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete saved server', exact: true }).click();
  await expect.poll(() => profiles.length).toBe(2);
  await expect(selector).toContainText('Fresh world');
  await page.getByRole('tab', { name: 'Advanced', exact: true }).click();
  await page.getByText('example.txt', { exact: true }).dblclick();
  dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox').fill('Unsaved change belongs only to new-2');
  activate(profiles[0]);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('active server changed');
  assert.equal(requests.at(-1).profile, 'new-2');
  assert.equal(requests.at(-1).workspace, 'new-2');
  await expect(page.getByRole('region', { name: 'Server controls', includeHidden: true })).toContainText('FTB Infinity Evolved', { timeout: 20_000 });
  await expect(selector).toContainText('Fresh world');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox')).toHaveValue('Unsaved change belongs only to new-2');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('Saved');
  assert.equal(requests.at(-1).profile, 'infinity');
  assert.equal(requests.at(-1).workspace, 'new-2');
  assert.equal(fileContents.get('new-2'), 'Unsaved change belongs only to new-2');
  assert.equal(fileContents.has('infinity'), false);
  await dialog.getByRole('button', { name: 'Close editor', exact: true }).click();
  await page.getByRole('button', { name: 'Set active', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Set Fresh world active?', exact: true });
  await dialog.getByRole('button', { name: 'Set active', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Switching to Fresh world' })).toBeVisible();
  await expect.poll(() => typeof completeProfileOperation).toBe('function');
  status.jobRunning = false;
  status.server.busy = false;
  status.server.profileError = 'Fixture switch failed without changing the active server.';
  completeProfileOperation = undefined;
  await expect(page.getByRole('alert')).toContainText('Fixture switch failed', { timeout: 20_000 });
  await expect(page.getByRole('status').filter({ hasText: 'Switching to Fresh world' })).toBeHidden();
  assert.equal(status.profiles.activeId, 'infinity');
  await page.getByRole('button', { name: 'New server', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Create a saved server', exact: true });
  await dialog.getByLabel('Server name').fill('Rejected world');
  await dialog.getByRole('button', { name: 'Create and switch', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('fixture rejected');
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'New server', exact: true }).click();
  await dialog.getByLabel('Server name').fill('Broken world');
  await dialog.getByRole('button', { name: 'Create and switch', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Creating Broken world...' })).toBeVisible();
  await expect.poll(() => typeof completeProfileOperation).toBe('function');
  status.jobRunning = false;
  status.server.busy = false;
  status.server.profileError = 'Fixture installer failed safely.';
  completeProfileOperation = undefined;
  await expect(page.getByRole('alert')).toContainText('Fixture installer failed safely.', { timeout: 20_000 });
  await expect(page.getByRole('status').filter({ hasText: 'Creating Broken world...' })).toBeHidden();
  assert.equal(profiles.length, 2);
  assert.equal(status.profiles.activeId, 'infinity');
  while (profiles.length < 5) profiles.push({ ...profiles[0], id: `slot-${profiles.length}`, name: `Saved ${profiles.length + 1}` });
  await page.reload();
  await expect(page.getByRole('button', { name: 'New server', exact: true })).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(selector).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.screenshot({ path: path.join(outputDirectory, 'saved-servers-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: ['Exact Dictionary Minecraft Server heading', 'Selecting an editing workspace does not stop or activate a server', 'Inactive files editable while active server runs', 'Inactive mod changes leave active mods untouched', 'Running server permits add and pack download but locks Advanced writes', 'Separate active and workspace request headers', 'Set active confirmation and cancellation', 'Late previous-workspace mod response ignored', 'New blank server naming and confirmation', 'Create and switch show progress until polling confirms completion', 'Async switch failure clears progress and preserves active server', 'Create request failure leaves an actionable dialog', 'Async create failure clears progress without adding a slot', 'Rename confirmation without switching', 'Delete confirmation and active-server protection', 'Five-server limit', 'Stale active header rejected without retargeting edits', 'Active change preserves editing workspace and unsaved editor', 'Responsive saved-server controls', 'No browser exceptions'], screenshots: ['inactive-server-workspace.png', 'saved-server-create.png', 'saved-servers-mobile.png'], liveServersChanged: false }, null, 2));
} finally {
  releaseOldMods?.();
  await browser.close();
  await new Promise(resolve => fixture.close(resolve));
}
