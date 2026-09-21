import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const buildDirectory = path.resolve(process.argv[2] ?? '/tmp/aron-operation-ui-build/browser');
const outputDirectory = fileURLToPath(new URL('../.runtime/ui-check/', import.meta.url));
await mkdir(outputDirectory, { recursive: true });
const target = { minecraftVersion: '26.3', loader: 'Fabric', loaderVersion: '0.19.5' };
const profiles = [{ ...target, id: 'active', name: 'Current world' }, { ...target, id: 'spare', name: 'Spare world' }];
const server = { state: 'running', address: 'mc.example.test', uptimeSeconds: 120, busy: false, players: { online: 2, max: 12, names: ['Aron', 'Friend'] } };
let workspaceOperation;
let forcedWorkspace;
let releaseAction;
let lastAction;
const mimeTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const fixture = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const json = (value, code = 200) => { response.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
  try {
    if (url.pathname === '/site-config.json') return json({ workshop: true });
    const workspace = profiles.find(profile => profile.id === (forcedWorkspace ?? request.headers['x-workspace-profile'])) ?? profiles[0];
    if (url.pathname === '/api/status') return json({
      history: [], requests: [], activity: [], jobRunning: server.busy,
      profiles: { activeId: profiles[0].id, profiles, limit: 5 }, server,
      workspace: { profileId: workspace.id, server: { ...server, state: workspace.id === 'active' ? server.state : 'stopped', operation: workspaceOperation ?? server.operation } },
      pack: { name: 'Dictionary Minecraft Server', ...workspace, version: '', mods: [], releases: [] },
      capabilities: { authorized: true, workspaceWrite: true, server: true, curseforgeSearch: false, publish: false, update: false, localProfile: false },
    });
    if (url.pathname === '/api/server/logs') return json({ lines: [] });
    if (url.pathname === '/api/workspace/mods') return json({ mods: [] });
    if (request.method === 'POST' && ['/api/server/action', '/api/server/profiles/select'].includes(url.pathname)) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      lastAction = JSON.parse(Buffer.concat(chunks).toString());
      await new Promise(resolve => { releaseAction = resolve; });
      return json({ accepted: true }, 202);
    }
    if (url.pathname.startsWith('/api/')) return json({ error: `Unexpected fixture request: ${request.method} ${url.pathname}` }, 500);
    const file = path.resolve(buildDirectory, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
    if (!file.startsWith(`${buildDirectory}${path.sep}`)) return json({ error: 'Invalid file path.' }, 400);
    response.writeHead(200, { 'content-type': mimeTypes[path.extname(file)] ?? 'application/octet-stream' });
    response.end(await readFile(file));
  } catch (error) { if (!response.headersSent) json({ error: error.message }, 500); else response.end(); }
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
  const operation = page.locator('.operation-status');
  const assertSingle = async label => {
    await expect(operation).toHaveCount(1);
    await expect(operation).toHaveText(label);
    await expect(operation.locator('mat-spinner')).toHaveCount(1);
    await expect(page.locator('.profile-progress')).toHaveCount(0);
    await expect(page.getByText('Working', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Server operation in progress...', { exact: true })).toHaveCount(0);
    await expect(page.locator('main > .notice[role="status"]')).toHaveCount(0);
  };
  const clear = () => { server.busy = false; delete server.operation; delete server.profileError; workspaceOperation = undefined; forcedWorkspace = undefined; };
  for (const label of ['Starting server', 'Restarting server', 'Shutting down server', 'Saving backup', 'Saving safety backup', 'Switching to Spare world', 'Restoring server', 'Installing Minecraft 1.20.1 with Forge 47.4.0', 'Creating New adventures']) {
    clear();
    server.operation = label;
    server.busy = true;
    await page.goto(origin);
    await assertSingle(label);
    await page.reload();
    await assertSingle(label);
  }
  clear();
  forcedWorkspace = 'spare';
  workspaceOperation = 'Saving file changes for Spare world';
  server.state = 'running';
  await page.reload();
  await assertSingle(workspaceOperation);
  await expect(page.locator('.active-server-name')).toHaveText('Active: Current world');
  await expect(page.locator('.server-state')).not.toContainText('Restarting');
  for (const [action, label] of [['start', 'Starting server'], ['restart', 'Restarting server'], ['stop', 'Shutting down server']]) {
    clear();
    server.state = action === 'start' ? 'stopped' : 'running';
    releaseAction = undefined;
    await page.reload();
    await expect(operation).toHaveCount(0);
    await page.getByRole('button', { name: action === 'start' ? 'Start' : action === 'restart' ? 'Restart' : 'Stop', exact: true }).click();
    if (action !== 'start') await page.getByRole('dialog').getByRole('button', { name: action === 'restart' ? 'Restart server' : 'Stop server', exact: true }).click();
    await expect.poll(() => typeof releaseAction).toBe('function');
    await assertSingle(label);
    assert.equal(lastAction.action, action);
    server.busy = true;
    server.operation = 'Saving safety backup';
    releaseAction();
    await assertSingle('Saving safety backup');
  }
  clear();
  server.state = 'running';
  releaseAction = undefined;
  await page.reload();
  await page.getByRole('button', { name: 'Select saved server', exact: true }).click();
  await page.getByRole('menuitem').filter({ hasText: 'Spare world' }).click();
  await page.getByRole('button', { name: 'Set active', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Stop and set active', exact: true }).click();
  await expect.poll(() => typeof releaseAction).toBe('function');
  await assertSingle('Switching to Spare world');
  assert.equal(lastAction.id, 'spare');
  server.busy = true;
  server.operation = 'Switching to Spare world';
  releaseAction();
  await page.reload();
  await assertSingle('Switching to Spare world');
  await expect(page.locator('.operation-detail')).toContainText('selected server will stay stopped');
  await page.setViewportSize({ width: 390, height: 844 });
  server.operation = `Switching to ${'A very long saved server name '.repeat(2).trim()}`;
  await page.reload();
  await assertSingle(server.operation);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.screenshot({ path: path.join(outputDirectory, 'specific-operation-mobile.png'), fullPage: true });
  clear();
  server.profileError = 'The switch failed. Your original server is still available.';
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('The switch failed.');
  await expect(operation).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: ['One specific operation indicator with one spinner', 'Backend operation survives reload without local state', 'Start restart stop and backup labels', 'Backend phase overrides pending local action', 'Switching names the destination server before and after acceptance', 'Inactive workspace operations do not imply active server restart', 'Useful installation and switch details remain', 'No duplicate generic banners', 'Failure clears the indicator', 'Responsive long server names', 'No browser exceptions'], liveServersChanged: false }, null, 2));
} finally {
  releaseAction?.();
  await browser.close();
  await new Promise(resolve => fixture.close(resolve));
}
