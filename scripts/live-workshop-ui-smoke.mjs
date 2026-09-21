import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const buildDirectory = path.resolve(process.argv[2] ?? '/tmp/aron-combined-ui-build/browser');
const outputDirectory = fileURLToPath(new URL('../.runtime/ui-check/', import.meta.url));
await mkdir(outputDirectory, { recursive: true });
const profiles = [
  { id: 'running', name: 'Running world', minecraftVersion: '1.20.1', loader: 'Fabric', loaderVersion: '0.18.4' },
  { id: 'editing', name: 'Editing world', minecraftVersion: '1.12.2', loader: 'Forge', loaderVersion: '14.23.5.2860' },
];
const requests = [];
const downloads = [];
const uploads = new Map();
const jobs = new Map();
const mods = new Map(profiles.map(profile => [profile.id, [{ path: 'mods/original.jar', name: 'original.jar', size: 100, modifiedAt: '2026-09-21T17:05:00.000Z', text: false, enabled: true }, { path: 'mods/disabled.jar.disabled', name: 'disabled.jar', size: 100, modifiedAt: '2026-09-21T17:05:00.000Z', text: false, enabled: false }]]));
let updatedAt = '2026-09-21T17:05:00.000Z';
let players = { online: 2, max: 20, names: ['Aron', 'Dictionary'] };
let pollError = false;
let rejectBackup = false;
const serverStatus = { state: 'running', address: 'mc.example.test', uptimeSeconds: 120, busy: false };
const mimeTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const fixture = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const json = (value, code = 200) => { response.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
  const record = body => requests.push({ method: request.method, path: url.pathname, body, active: request.headers['x-server-profile'], workspace: request.headers['x-workspace-profile'] });
  try {
    if (url.pathname === '/site-config.json') return json({ workshop: true });
    const workspace = profiles.find(profile => profile.id === request.headers['x-workspace-profile']) ?? profiles[0];
    if (url.pathname === '/api/status') return json({
      history: [], requests: [], activity: [], jobRunning: false,
      profiles: { activeId: profiles[0].id, profiles, limit: 5 },
      server: { ...serverStatus, players },
      workspace: { profileId: workspace.id, updatedAt, server: { ...serverStatus, state: workspace.id === profiles[0].id ? serverStatus.state : 'stopped' } },
      pack: { name: 'Dictionary Minecraft Server', ...workspace, version: '', mods: [], releases: [] },
      capabilities: { authorized: true, workspaceWrite: true, server: true, curseforgeSearch: false, publish: false, update: false, localProfile: false },
    });
    if (url.pathname === '/api/server/logs') return json({ lines: ['Running world remains online'] });
    if (url.pathname === '/api/workspace/mods') return json({ mods: mods.get(workspace.id) });
    if (url.pathname === '/api/workspace/files') return json({ files: [{ path: 'config/example.txt', name: 'example.txt', text: true, size: 10, modifiedAt: updatedAt }], directories: [], truncated: false });
    if (url.pathname === '/api/workspace/files/text') return json({ path: 'config/example.txt', name: 'example.txt', contents: 'Read only while running', revision: 'fixture', text: true, size: 23, modifiedAt: updatedAt });
    if (url.pathname === '/api/pack/download') {
      record();
      response.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="fixture-pack.zip"' });
      return response.end(Buffer.from('PK\u0003\u0004fixture-pack'));
    }
    const backupPath = url.pathname.match(/^\/api\/server\/backups\/([^/]+)(\/download)?$/);
    if (backupPath && request.method === 'GET') {
      record();
      const job = jobs.get(backupPath[1]);
      if (!job) return json({ error: 'Backup not found.' }, 404);
      if (backupPath[2]) {
        downloads.push({ id: job.id, cookie: request.headers.cookie, active: request.headers['x-server-profile'], workspace: request.headers['x-workspace-profile'] });
        if (job.state !== 'ready') return json({ error: 'Backup not ready.' }, 409);
        response.writeHead(200, { 'content-type': 'application/gzip', 'content-disposition': `attachment; filename="${job.filename}"` });
        return response.end(Buffer.from('fixture-backup'));
      }
      if (pollError) return json({ error: 'Fixture backup status temporarily unavailable.' }, 503);
      return json(job);
    }
    if (url.pathname.startsWith('/api/') && ['POST', 'PUT', 'DELETE'].includes(request.method)) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const contents = Buffer.concat(chunks).toString();
      const body = contents ? JSON.parse(contents) : {};
      record(body);
      if (request.headers['x-server-profile'] !== profiles[0].id) return json({ error: 'Wrong active profile.' }, 409);
      if (url.pathname === '/api/server/backups') {
        if (rejectBackup) return json({ error: 'Fixture backup creation rejected.' }, 503);
        const job = { id: `backup-${jobs.size + 1}`, profileId: profiles[0].id, state: 'running', filename: `running-world-${jobs.size + 1}.tar.gz` };
        jobs.set(job.id, job);
        return json({ id: job.id, profileId: job.profileId }, 202);
      }
      if (url.pathname === '/api/workspace/uploads') {
        assert.equal(body.replace, false);
        const upload = { id: `upload-${uploads.size + 1}`, path: body.path, size: body.size, profileId: workspace.id, received: 0 };
        uploads.set(upload.id, upload);
        return json({ id: upload.id, chunkBytes: 65536 });
      }
      const uploadPath = url.pathname.match(/^\/api\/workspace\/uploads\/([^/]+)(\/chunks|\/complete)?$/);
      if (uploadPath) {
        const upload = uploads.get(uploadPath[1]);
        assert.equal(workspace.id, upload.profileId);
        if (uploadPath[2] === '/chunks') { upload.received += Buffer.from(body.data, 'base64').length; return json({ received: upload.received, complete: upload.received === upload.size }); }
        if (uploadPath[2] === '/complete') {
          const file = { path: upload.path, name: upload.path.split('/').at(-1), size: upload.size, modifiedAt: updatedAt, text: false, enabled: true };
          mods.get(upload.profileId).push(file);
          return json(file);
        }
        return json({});
      }
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', timezoneId: 'Asia/Tokyo', acceptDownloads: true });
  await context.addCookies([{ name: 'fixture-access', value: 'granted', url: origin, httpOnly: true, sameSite: 'Strict' }]);
  const page = await context.newPage();
  const playerTooltip = page.locator('.player-list-tooltip .mat-mdc-tooltip-surface');
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await expect(page.locator('.player-count')).toHaveText('2 / 20 players');
  await page.locator('.player-count').hover();
  await expect(playerTooltip).toBeVisible();
  await expect(playerTooltip).toHaveText('Aron\nDictionary');
  assert.equal(await playerTooltip.evaluate(element => getComputedStyle(element).whiteSpace), 'pre-line');
  await page.locator('.player-count').press('Escape');
  await expect(playerTooltip).toBeHidden();
  await page.locator('.player-count').focus();
  await page.locator('.player-count').press('Enter');
  await expect(playerTooltip).toBeVisible();
  await expect(playerTooltip).toHaveText('Aron\nDictionary');
  await page.locator('.player-count').press('Escape');
  await expect(page.locator('.server-timestamps')).toContainText('Sep 21, 2026, 12:05 PM CDT');
  await expect(page.getByRole('button', { name: 'Add mod', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Download pack ZIP', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Disable', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Enable', exact: true })).toBeDisabled();
  for (const button of await page.getByRole('button', { name: 'Uninstall', exact: true }).all()) await expect(button).toBeDisabled();
  await page.getByRole('button', { name: 'Add mod', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Add mod', exact: true });
  await dialog.locator('input[type=file]').setInputFiles({ name: 'new-mod.jar', mimeType: 'application/java-archive', buffer: Buffer.from('fixture jar') });
  await dialog.getByRole('button', { name: 'Add mod', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name: 'new-mod.jar', exact: true })).toBeVisible();
  const uploadRequests = requests.filter(request => request.path.startsWith('/api/workspace/uploads'));
  assert.equal(uploadRequests.length, 3);
  assert(uploadRequests.every(request => request.active === 'running' && request.workspace === 'running'));
  assert.equal(serverStatus.state, 'running');
  const packDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download pack ZIP', exact: true }).click();
  assert.equal((await packDownload).suggestedFilename(), 'dictionary-minecraft-server.zip');
  assert.equal(requests.at(-1).path, '/api/pack/download');
  assert.equal(requests.at(-1).workspace, 'running');
  await page.getByRole('tab', { name: 'Advanced', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Choose files', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Edit config/example.txt', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'example.txt', exact: true });
  await expect(dialog.getByRole('textbox')).not.toBeEditable();
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Close editor', exact: true }).click();
  await page.getByRole('button', { name: 'Select saved server', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit Editing world', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Choose files', exact: true })).toBeEnabled();
  await expect(page.locator('.server-timestamps')).toContainText('Editing world');
  await expect(page.getByRole('region', { name: 'Server controls' })).toContainText('Running world');
  const editingPackDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download pack ZIP', exact: true }).click();
  await editingPackDownload;
  assert.equal(requests.at(-1).workspace, 'editing');
  const backUp = async () => {
    await page.getByRole('button', { name: 'Back up', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Back up Running world', exact: true });
    await expect(modal).toBeVisible();
    return modal;
  };
  const latestJob = () => [...jobs.values()].at(-1);
  const backupPosts = () => requests.filter(request => request.method === 'POST' && request.path === '/api/server/backups');
  dialog = await backUp();
  await expect(dialog.getByRole('checkbox', { name: 'Also download to my computer' })).toBeChecked();
  await expect(dialog).toContainText('Players will briefly disconnect');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(backupPosts().length, 0);
  dialog = await backUp();
  await dialog.getByRole('checkbox').uncheck();
  await dialog.getByRole('button', { name: 'Back up', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Saving your backup');
  await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeDisabled();
  assert.equal(backupPosts().at(-1).active, 'running');
  assert.equal(backupPosts().at(-1).workspace, undefined);
  latestJob().state = 'ready';
  await expect(dialog.getByRole('status')).toHaveText('Backup saved on the server.');
  assert.equal(downloads.length, 0);
  const link = dialog.getByRole('link', { name: 'Download backup', exact: true });
  await expect(link).toHaveAttribute('href', '/api/server/backups/backup-1/download');
  const manualDownload = page.waitForEvent('download');
  await link.click();
  assert.equal((await manualDownload).suggestedFilename(), 'running-world-1.tar.gz');
  assert.deepEqual(downloads[0], { id: 'backup-1', cookie: 'fixture-access=granted', active: undefined, workspace: undefined });
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  dialog = await backUp();
  await dialog.getByRole('button', { name: 'Back up and download', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Saving your backup');
  await expect.poll(() => jobs.size).toBe(2);
  const automaticDownload = page.waitForEvent('download');
  latestJob().state = 'ready';
  assert.equal((await automaticDownload).suggestedFilename(), 'running-world-2.tar.gz');
  await expect(dialog.getByRole('link', { name: 'Download backup', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  dialog = await backUp();
  await dialog.getByRole('button', { name: 'Back up and download', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Saving your backup');
  await expect.poll(() => jobs.size).toBe(3);
  Object.assign(latestJob(), { state: 'failed', error: 'Fixture backup failed safely.' });
  await expect(dialog.getByRole('alert')).toContainText('Fixture backup failed safely.');
  await expect(dialog.getByRole('status')).toBeHidden();
  await expect(dialog.getByRole('link', { name: 'Download backup', exact: true })).toBeHidden();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  dialog = await backUp();
  await dialog.getByRole('checkbox').uncheck();
  pollError = true;
  await dialog.getByRole('button', { name: 'Back up', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('temporarily unavailable');
  await expect(dialog.getByRole('status')).toBeHidden();
  const postsBeforeRetry = backupPosts().length;
  pollError = false;
  latestJob().state = 'ready';
  await dialog.getByRole('button', { name: 'Check backup', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('Backup saved on the server.');
  assert.equal(backupPosts().length, postsBeforeRetry);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  dialog = await backUp();
  await dialog.getByRole('checkbox').uncheck();
  await dialog.getByRole('button', { name: 'Back up', exact: true }).click();
  await expect.poll(() => jobs.size).toBe(5);
  latestJob().profileId = 'editing';
  await expect(dialog.getByRole('alert')).toContainText('could not be matched to this server');
  await expect(dialog.getByRole('link', { name: 'Download backup', exact: true })).toBeHidden();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  dialog = await backUp();
  rejectBackup = true;
  await dialog.getByRole('button', { name: 'Back up and download', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Fixture backup creation rejected.');
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  rejectBackup = false;
  assert.equal(downloads.length, 2);
  assert.equal(requests.some(request => request.path === '/api/server/action' || request.path === '/api/server/profiles/select' || request.path === '/api/workspace/mods/action'), false);
  updatedAt = '2026-01-21T18:05:00.000Z';
  players = { online: 3, max: 20, names: ['Aron', 'Dictionary'] };
  await page.reload();
  await page.locator('.player-count').hover();
  await expect(playerTooltip).toBeVisible();
  await expect(playerTooltip).toHaveText('Aron\nDictionary\n+ 1 more (names unavailable)');
  await page.locator('.player-count').press('Escape');
  players = { online: null, max: null, names: null };
  await page.reload();
  await expect(page.locator('.player-count')).toHaveText('Players unavailable');
  await page.locator('.player-count').hover();
  await expect(playerTooltip).toBeVisible();
  await expect(playerTooltip).toHaveText('Player names unavailable');
  await expect(page.locator('.server-timestamps')).toContainText('Jan 21, 2026, 12:05 PM CST');
  serverStatus.state = 'stopped';
  await page.reload();
  await expect(page.locator('.player-count')).toHaveText('0 players');
  await page.locator('.player-count').hover();
  await expect(playerTooltip).toBeVisible();
  await expect(playerTooltip).toHaveText('No players online');
  await page.locator('.player-count').press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(outputDirectory, 'live-workshop-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: ['Live new-JAR addition retains active and workspace headers', 'Live pack download remains enabled and targets selected slot', 'Enable, disable and uninstall remain locked while running', 'Advanced writes stay locked on running server and unlock for inactive slot', 'Backup confirmation cancellation performs no write', 'Backup always targets active server while editing another slot', 'Optional download off saves only until explicitly downloaded', 'Backup files download natively with invitation cookie', 'Optional download on starts download and retains fallback link', 'Backup progress clears on failure and reports server error', 'Backup polling retry reuses original job', 'Mismatched backup profile is rejected without a download', 'Backup start error leaves a dismissible dialog', 'Player counts handle online, unavailable and stopped states', 'Player hover and keyboard tooltip list one name per line', 'Partial and unavailable player lists are labeled honestly', 'Chicago timestamps respect both CDT and CST regardless of browser timezone', 'Responsive combined controls', 'No browser exceptions'], origin, screenshots: ['live-workshop-mobile.png'], liveServersChanged: false }, null, 2));
} finally {
  await browser.close();
  await new Promise(resolve => fixture.close(resolve));
}
