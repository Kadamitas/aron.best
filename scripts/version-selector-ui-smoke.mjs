import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const buildDirectory = path.resolve(process.argv[2] ?? '/tmp/aron-version-ui-build/browser');
const outputDirectory = fileURLToPath(new URL('../.runtime/ui-check/', import.meta.url));
await mkdir(outputDirectory, { recursive: true });
const installationRequests = [];
const versions = ['1.20.1', '1.21.1', '26.1'];
const loaderChoices = {
  '1.20.1': [{ loader: 'Fabric', loaderVersion: '0.18.4' }, { loader: 'Forge', loaderVersion: '47.4.10' }],
  '1.21.1': [{ loader: 'Fabric', loaderVersion: '0.18.4' }, { loader: 'NeoForge', loaderVersion: '21.1.200' }],
  '26.1': [{ loader: 'Fabric', loaderVersion: '0.18.4' }, { loader: 'Quilt', loaderVersion: '0.30.0' }],
};
const status = {
  history: [], requests: [], activity: [], jobRunning: false,
  pack: { name: 'Dictionary Minecraft Server', minecraftVersion: '1.21.1', loader: 'Fabric', loaderVersion: '0.18.4', version: '', mods: [], releases: [] },
  server: { state: 'stopped', address: 'mc.example.test', installationError: '' },
  capabilities: { authorized: true, workspaceWrite: true, server: true, curseforgeSearch: false, publish: false, update: false, localProfile: false },
};
const mimeTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
let releaseMetadata;
let holdMetadata = false;
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const json = (data, code = 200) => { response.writeHead(code, { 'content-type': 'application/json' }); response.end(JSON.stringify(data)); };
  try {
    if (url.pathname === '/site-config.json') return json({ workshop: true });
    if (url.pathname === '/api/status') return json(status);
    if (url.pathname === '/api/server/logs') return json({ lines: [] });
    if (url.pathname === '/api/workspace/mods') return json({ mods: [] });
    if (url.pathname === '/api/server/versions') {
      const version = url.searchParams.get('minecraftVersion') ?? status.pack.minecraftVersion;
      if (holdMetadata && version === '1.20.1') await new Promise(resolve => { releaseMetadata = resolve; });
      return json({ versions, minecraftVersion: version, loaders: loaderChoices[version] ?? [] });
    }
    if (url.pathname === '/api/server/installation' && request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      installationRequests.push(JSON.parse(Buffer.concat(chunks).toString()));
      status.jobRunning = true;
      return json({ accepted: true }, 202);
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'Unexpected fixture request.' }, 500);
    const file = path.resolve(buildDirectory, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
    if (!file.startsWith(`${buildDirectory}${path.sep}`)) return json({ error: 'Invalid file path.' }, 400);
    response.writeHead(200, { 'content-type': mimeTypes[path.extname(file)] ?? 'application/octet-stream' });
    response.end(await readFile(file));
  } catch { if (!response.headersSent) response.writeHead(500); response.end(); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (existsSync(macChrome) ? macChrome : undefined);
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const browserErrors = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.goto(origin);
  const minecraft = page.getByRole('button', { name: 'Change Minecraft version', exact: true });
  const loader = page.getByRole('button', { name: 'Change mod loader', exact: true });
  const chooseVersion = async version => {
    await minecraft.click();
    await page.getByRole('menuitem', { name: `Minecraft ${version}`, exact: true }).click();
    await expect(page.getByLabel('Loading compatible versions')).toBeHidden();
  };
  const chooseForge = async () => {
    await chooseVersion('1.20.1');
    await loader.click();
    assert.deepEqual((await page.getByRole('menuitem').allTextContents()).map(text => text.trim()), ['Fabric 0.18.4', 'Forge 47.4.10']);
    await page.getByRole('menuitem', { name: 'Forge 47.4.10', exact: true }).click();
  };
  await minecraft.click();
  await expect(page.getByRole('menuitem')).toHaveCount(3);
  assert.deepEqual((await page.getByRole('menuitem').allTextContents()).map(text => text.trim()), versions.map(version => `Minecraft ${version}`));
  await page.keyboard.press('Escape');
  await chooseForge();
  await expect(minecraft).toContainText('1.20.1');
  await expect(loader).toContainText('Forge');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Change Minecraft and loader?', exact: true });
  await expect(confirmation).toContainText('Current: Minecraft 1.21.1, Fabric 0.18.4.');
  await expect(confirmation).toContainText('Change to Minecraft 1.20.1, Forge 47.4.10.');
  await expect(confirmation).toContainText('may be incompatible');
  await page.screenshot({ path: path.join(outputDirectory, 'version-confirmation.png'), fullPage: true });
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(installationRequests.length, 0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(minecraft).toContainText('1.21.1');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeHidden();
  await minecraft.click();
  await expect(page.getByRole('menuitem', { name: 'Minecraft 1.20.1', exact: true })).toBeEnabled();
  holdMetadata = true;
  await page.getByRole('menuitem', { name: 'Minecraft 1.20.1', exact: true }).click();
  await expect.poll(() => typeof releaseMetadata).toBe('function');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  const metadataResponse = page.waitForResponse(response => response.url().includes('/api/server/versions?minecraftVersion=1.20.1'));
  holdMetadata = false;
  releaseMetadata();
  await metadataResponse;
  await expect(minecraft).toContainText('1.21.1');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeHidden();
  await chooseForge();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Back up and change', exact: true }).click();
  await expect.poll(() => installationRequests.length).toBe(1);
  assert.deepEqual(installationRequests, [{ minecraftVersion: '1.20.1', loader: 'Forge', loaderVersion: '47.4.10' }]);
  await expect(page.getByRole('button', { name: 'Saving...', exact: true })).toBeDisabled();
  status.jobRunning = false;
  status.server.installationError = 'The fixture installer failed safely.';
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('The fixture installer failed safely.');
  status.server.installationError = '';
  status.server.state = 'running';
  await page.reload();
  await chooseForge();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  assert.equal(installationRequests.length, 1);
  assert.deepEqual(browserErrors, []);
  console.log(JSON.stringify({ passed: ['Metadata-driven version and compatible loader choices', 'Version selection keeps the matching loader', 'Explicit current/next version confirmation', 'Cancellation never submits an installation', 'Pending metadata cannot restore a canceled edit', 'Confirmation submits one exact target to fixture only', 'Async installation failure shown', 'Save locked while Minecraft runs', 'No browser exceptions'], screenshot: path.join(outputDirectory, 'version-confirmation.png'), liveInstallationChanged: false }, null, 2));
} finally {
  releaseMetadata?.();
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
