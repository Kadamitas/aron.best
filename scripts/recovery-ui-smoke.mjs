import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const buildDirectory = path.resolve(process.argv[2] ?? '/tmp/aron-recovery-ui-build/browser');
const outputDirectory = fileURLToPath(new URL('../.runtime/ui-check/', import.meta.url));
await mkdir(outputDirectory, { recursive: true });
const target = { minecraftVersion: '1.20.1', loader: 'Fabric', loaderVersion: '0.18.4' };
const profiles = [{ ...target, id: 'active', name: 'Current world' }, { ...target, id: 'inactive', name: 'Spare world' }];
const deleted = [{ ...target, id: 'deleted', name: 'Old adventures', removedAt: '2026-09-20T18:05:00.000Z' }];
const backups = [
  { id: '2026-09-21T17-05-00.000Z-automatic', profileId: 'active', createdAt: '2026-09-21T17:05:00.000Z', kind: 'automatic', sizeBytes: '1048576' },
  { id: 'manual-keep-me', profileId: 'deleted', createdAt: '2026-09-20T17:05:00.000Z', kind: 'manual', sizeBytes: '2097152' },
];
let releaseRecovery;
let holdRecovery = true;
let listingError = false;
let restoreError = false;
let automaticError = '';
const restores = [];
const downloads = [];
const paths = [];
const mimeTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const fixture = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const json = (value, code = 200) => { response.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
  try {
    if (url.pathname === '/site-config.json') return json({ workshop: true });
    paths.push(url.pathname);
    const workspace = profiles.find(profile => profile.id === request.headers['x-workspace-profile']) ?? profiles[0];
    const server = { state: 'running', address: 'mc.example.test', uptimeSeconds: 120, busy: false, backupError: automaticError || undefined, players: { online: 2, max: 20, names: ['Aron', 'Friend'] } };
    if (url.pathname === '/api/status') return json({
      history: [], requests: [], activity: [], jobRunning: false,
      profiles: { activeId: profiles[0].id, profiles, limit: 5 }, server,
      workspace: { profileId: workspace.id, server: { ...server, state: workspace.id === profiles[0].id ? 'running' : 'stopped' } },
      pack: { name: 'Dictionary Minecraft Server', ...workspace, version: '', mods: [], releases: [] },
      capabilities: { authorized: true, workspaceWrite: true, server: true, curseforgeSearch: false, publish: false, update: false, localProfile: false },
    });
    if (url.pathname === '/api/server/logs') return json({ lines: ['Current world remains online'] });
    if (url.pathname === '/api/workspace/mods') return json({ mods: [] });
    if (url.pathname === '/api/server/recovery') {
      if (holdRecovery) { holdRecovery = false; await new Promise(resolve => { releaseRecovery = resolve; }); }
      if (listingError) return json({ error: 'Fixture recovery storage is temporarily unavailable.' }, 503);
      return json({ servers: [...profiles.map(profile => ({ ...profile, deleted: false })), ...deleted.map(profile => ({ ...profile, deleted: true }))], backups, automatic: { enabled: true, intervalHours: 6, retained: 6, error: automaticError || null } });
    }
    const download = url.pathname.match(/^\/api\/server\/recovery\/backups\/([^/]+)\/([^/]+)\/download$/);
    if (download) {
      downloads.push({ profileId: decodeURIComponent(download[1]), id: decodeURIComponent(download[2]), cookie: request.headers.cookie });
      const backup = backups.find(item => item.profileId === download[1] && item.id === download[2]);
      if (!backup) return json({ error: 'Backup not found.' }, 404);
      response.writeHead(200, { 'content-type': 'application/gzip', 'content-disposition': 'attachment; filename="retained-backup.tar.gz"' });
      return response.end(Buffer.from('fixture-backup'));
    }
    if (url.pathname === '/api/server/profiles/restore' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      restores.push(body);
      if (restoreError) return json({ error: 'Fixture restore failed. Nothing changed.' }, 503);
      if (profiles.length >= 5) return json({ error: 'All saved server slots are in use.' }, 409);
      const index = deleted.findIndex(profile => profile.id === body.id);
      if (index < 0) return json({ error: 'Deleted server not found.' }, 404);
      const [profile] = deleted.splice(index, 1);
      profiles.push(profile);
      return json({ restored: true });
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
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await expect(page.getByRole('tab')).toHaveText(['Basic', 'Advanced', 'Server Log']);
  await page.getByRole('button', { name: 'Recovery', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Recovery', exact: true });
  await expect(dialog.getByRole('status')).toContainText('Loading recovery storage');
  await expect(dialog.getByRole('button', { name: 'Refresh recovery', exact: true })).toBeDisabled();
  await expect.poll(() => typeof releaseRecovery).toBe('function');
  releaseRecovery();
  await expect(dialog.getByRole('heading', { name: 'Backups', exact: true })).toBeVisible();
  await expect(dialog).toContainText('Every 6 hours when idle');
  await expect(dialog).toContainText('Edits within 15 minutes share a snapshot.');
  await expect(dialog).toContainText('latest 6 backups per server');
  await expect(dialog).toContainText('including manual backups. Unchanged files share storage.');
  await expect(dialog.locator('.backup-row time')).toHaveText('Sep 21, 2026, 12:05 PM CDT');
  await expect(dialog.locator('.backup-row')).toContainText('Automatic · 1.0 MiB');
  assert.equal(paths.includes('/api/workspace/files'), false);
  const firstDownload = page.waitForEvent('download');
  await dialog.getByRole('link', { name: 'Download backup from Sep 21, 2026, 12:05 PM CDT', exact: true }).click();
  assert.equal((await firstDownload).suggestedFilename(), 'retained-backup.tar.gz');
  assert.deepEqual(downloads[0], { profileId: 'active', id: backups[0].id, cookie: 'fixture-access=granted' });
  await dialog.getByRole('combobox', { name: 'Server', exact: true }).click();
  await page.getByRole('option', { name: 'Old adventures (deleted)', exact: true }).click();
  await expect(dialog).toContainText('This server is deleted. Its backups are still available to download.');
  await expect(dialog.locator('.backup-row')).toContainText('Manual · 2.0 MiB');
  const deletedDownload = page.waitForEvent('download');
  await dialog.getByRole('link', { name: 'Download backup from Sep 20, 2026, 12:05 PM CDT', exact: true }).click();
  await deletedDownload;
  assert.equal(downloads[1].profileId, 'deleted');
  await page.screenshot({ path: path.join(outputDirectory, 'recovery-desktop.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Restore Old adventures', exact: true }).click();
  let confirmation = page.getByRole('dialog', { name: 'Restore Old adventures?', exact: true });
  await expect(confirmation).toContainText('The active server keeps running');
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(restores.length, 0);
  restoreError = true;
  await dialog.getByRole('button', { name: 'Restore Old adventures', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Restore server', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Fixture restore failed. Nothing changed.');
  await expect(dialog.getByRole('button', { name: 'Restore Old adventures', exact: true })).toBeDisabled();
  restoreError = false;
  await dialog.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeHidden();
  await dialog.getByRole('button', { name: 'Restore Old adventures', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Restore server', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Old adventures restored. The active server has not changed.');
  await expect(dialog).toContainText('No deleted servers');
  assert.deepEqual(restores, [{ id: 'deleted' }, { id: 'deleted' }]);
  assert.equal(profiles[0].id, 'active');
  assert.equal(backups.length, 2);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Select saved server', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Edit Old adventures', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'Server controls', exact: true })).toContainText('Current world');
  await expect(page.getByRole('button', { name: 'Restart', exact: true })).toBeEnabled();
  profiles.push({ ...target, id: 'four', name: 'Fourth server' }, { ...target, id: 'five', name: 'Fifth server' });
  deleted.push({ ...target, id: 'another', name: 'Another old world', removedAt: '2026-09-20T18:05:00.000Z' });
  automaticError = 'Fixture automatic backup needs disk space.';
  listingError = true;
  await page.getByRole('button', { name: 'Recovery', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Fixture recovery storage is temporarily unavailable.');
  await expect(dialog.getByRole('status')).toBeHidden();
  listingError = false;
  await dialog.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Automatic backups need attention.');
  await expect(dialog).toContainText('All saved server slots are in use');
  await expect(dialog.getByRole('button', { name: 'Restore Another old world', exact: true })).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog.getByRole('heading', { name: 'Backups', exact: true })).toBeVisible();
  assert.equal(await dialog.evaluate(element => element.scrollWidth > element.clientWidth), false);
  await page.screenshot({ path: path.join(outputDirectory, 'recovery-mobile.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Automatic backup needs attention.');
  await page.getByRole('button', { name: 'View recovery', exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: ['Existing Basic, Advanced and Server Log tabs preserved', 'Recovery loading and retry states', 'Chicago timestamps independent of browser timezone', 'Opaque backup identifiers and cookie-authorized downloads', 'Deleted-server backups remain downloadable', 'Restore confirmation and cancellation', 'Failed restore is recoverable without a stuck spinner', 'Restore refreshes saved servers without changing the active server', 'Backup history survives restoration', 'Full server-slot limit explained', 'Automatic backup errors visible', 'Recovery storage never uses Advanced file APIs', 'Responsive dialog and no browser exceptions'], screenshots: ['recovery-desktop.png', 'recovery-mobile.png'], liveServersChanged: false }, null, 2));
} finally {
  await browser.close();
  await new Promise(resolve => fixture.close(resolve));
}
