import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:3300');
if (!['localhost', '127.0.0.1'].includes(base.hostname) || base.protocol !== 'http:') throw new Error('UI smoke tests only operate on a local preview.');
const origin = base.origin;
const outputDirectory = fileURLToPath(new URL('../.runtime/ui-check/', import.meta.url));
await mkdir(outputDirectory, { recursive: true });
const token = (await readFile(new URL('../.runtime/docker/secrets/friend_access_token', import.meta.url), 'utf8')).trim();
const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (existsSync(macChrome) ? macChrome : undefined);
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
const rateLimitedRequest = async request => {
  for (let attempt = 0; attempt < 8; attempt++) {
    const response = await request();
    if (response.status() !== 429) return response;
    const seconds = Number(response.headers()['retry-after']) || 1;
    await new Promise(resolve => setTimeout(resolve, Math.max(1000, Math.min(10000, seconds * 1000))));
  }
  throw new Error('The local preview remained rate-limited after bounded retries.');
};
const expectCenteredIcon = async (button, label) => {
  await expect(button).toBeVisible();
  const centerOffset = () => button.evaluate(element => {
    const icon = element.querySelector('app-icon');
    if (!icon) throw new Error('The icon button must contain an app-icon.');
    const buttonBounds = element.getBoundingClientRect();
    const iconBounds = icon.getBoundingClientRect();
    return Math.max(
      Math.abs(iconBounds.x + iconBounds.width / 2 - buttonBounds.x - buttonBounds.width / 2),
      Math.abs(iconBounds.y + iconBounds.height / 2 - buttonBounds.y - buttonBounds.height / 2),
    );
  });
  await expect.poll(centerOffset, { message: `${label} icon is centered within 1px at rest.` }).toBeLessThanOrEqual(1);
  await button.hover();
  await expect.poll(centerOffset, { message: `${label} icon is centered within 1px on hover.` }).toBeLessThanOrEqual(1);
};
const expectBalancedLeadingIcon = async (button, label) => {
  await expect(button).toBeVisible();
  const icon = button.locator(':scope > app-icon[matButtonIcon]');
  await expect(icon).toBeVisible();
  if (await icon.getAttribute('name') === 'plus') {
    await expect.poll(() => icon.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height };
    }), { message: `${label} plus icon measures 24px by 24px.` }).toEqual({ width: 24, height: 24 });
  }
  await expect(button.locator('.mdc-button__label')).toHaveText(label);
  const spacing = () => button.evaluate(element => {
    const buttonBounds = element.getBoundingClientRect();
    const iconBounds = element.querySelector('app-icon').getBoundingClientRect();
    const labelBounds = element.querySelector('.mdc-button__label').getBoundingClientRect();
    return {
      leading: iconBounds.left - buttonBounds.left,
      trailing: buttonBounds.right - labelBounds.right,
      gap: labelBounds.left - iconBounds.right,
      verticalOffset: Math.abs(iconBounds.y + iconBounds.height / 2 - buttonBounds.y - buttonBounds.height / 2),
    };
  });
  for (const state of ['at rest', 'on hover']) {
    if (state === 'on hover') await button.hover();
    await expect.poll(async () => {
      const layout = await spacing();
      return Math.abs(layout.leading - layout.trailing);
    }, { message: `${label} leading and trailing spacing stays balanced ${state}.` }).toBeLessThanOrEqual(4.5);
    await expect.poll(async () => Math.abs((await spacing()).gap - 8), { message: `${label} has an 8px icon-label gap ${state}.` }).toBeLessThanOrEqual(1);
    await expect.poll(async () => (await spacing()).verticalOffset, { message: `${label} icon is vertically centered ${state}.` }).toBeLessThanOrEqual(1);
  }
};
const suffix = randomUUID();
const modName = `ui-check-${suffix}.jar`;
const textName = `ui-check-${suffix}.txt`;
const renamedTextName = `ui-edited-${suffix}.txt`;
const folderName = `ui-folder-${suffix}`;
const renamedFolderName = `ui-renamed-${suffix}`;
const nestedFolderName = `ui-nested-${suffix}`;
try {
  const redemption = await context.request.post(`${origin}/api/access/redeem`, { headers: { origin, authorization: `Bearer ${token}` }, data: {} });
  assert.equal(redemption.status(), 200);
  const statusResponse = await rateLimitedRequest(() => context.request.get(`${origin}/api/status`));
  assert.equal(statusResponse.status(), 200);
  const status = await statusResponse.json();
  if (status.profiles?.activeId) await context.setExtraHTTPHeaders({ 'X-Server-Profile': status.profiles.activeId });
  assert.equal(status.server.state, 'stopped');
  assert.equal(status.capabilities.workspaceWrite, true);
  const page = await context.newPage();
  const browserErrors = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.goto(`${origin}/?workshop=1`);
  await page.getByRole('heading', { name: 'Dictionary Minecraft Server', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Server mods' }).waitFor();
  await page.getByText('Selected server mods and configuration', { exact: true }).waitFor();
  assert.equal(await page.locator('.workspace-header').count(), 0);
  assert.equal(await page.getByText(/After hours|Request a mod|Publish to CurseForge|Pack 0\.1\.0/i).count(), 0);
  assert.deepEqual(await page.getByRole('tab').allTextContents(), ['Basic', 'Advanced', 'Server Log']);
  await expectBalancedLeadingIcon(page.getByRole('button', { name: 'Start', exact: true }), 'Start');
  await expectBalancedLeadingIcon(page.getByRole('button', { name: 'Add mod', exact: true }), 'Add mod');
  let profileControlsVerified = false;
  if (status.profiles) {
    await expectBalancedLeadingIcon(page.getByRole('button', { name: 'New server', exact: true }), 'New server');
    const active = status.profiles.profiles.find(profile => profile.id === status.profiles.activeId);
    assert(active);
    let profileRequests = 0;
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/server/profiles')) profileRequests++; });
    await expect(page.getByRole('button', { name: 'Select saved server', exact: true })).toContainText(active.name);
    await page.getByRole('button', { name: 'New server', exact: true }).click();
    const creation = page.getByRole('dialog', { name: 'Create a saved server', exact: true });
    await expect(creation).toContainText('blank world, no mods and fresh settings');
    await expect(creation).toContainText(`latest compatible ${active.loader} build`);
    await creation.getByLabel('Server name').fill('Canceled UI check');
    await page.screenshot({ path: path.join(outputDirectory, 'saved-server-create-live.png'), fullPage: true });
    await creation.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Manage saved servers', exact: true }).click();
    await page.getByRole('menuitem', { name: active.name, exact: true }).hover();
    await expect(page.getByRole('menuitem', { name: 'Delete', exact: true })).toBeDisabled();
    await expect(page.getByText('Set another server active first', { exact: true })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    const rename = page.getByRole('dialog', { name: 'Rename server', exact: true });
    await expect(rename.getByLabel('Server name')).toHaveValue(active.name);
    await rename.getByLabel('Server name').fill('Canceled rename');
    await rename.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(profileRequests, 0);
    profileControlsVerified = true;
  }
  let versionControlsVerified = false;
  if (await page.getByRole('button', { name: 'Change Minecraft version', exact: true }).count()) {
    const minecraftControl = page.getByRole('button', { name: 'Change Minecraft version', exact: true });
    const loaderControl = page.getByRole('button', { name: 'Change mod loader', exact: true });
    const originalVersion = await minecraftControl.textContent();
    const originalLoader = await loaderControl.textContent();
    let installationRequests = 0;
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/server/installation') installationRequests++; });
    await minecraftControl.click();
    const versions = page.getByRole('menuitem').filter({ hasText: /^Minecraft / });
    await expect(versions.first()).toBeEnabled({ timeout: 45000 });
    const alternative = (await versions.allTextContents()).find(label => label.trim() !== `Minecraft ${status.pack.minecraftVersion}`);
    assert(alternative, 'At least one alternative Minecraft release can be previewed.');
    await page.getByRole('menuitem', { name: alternative.trim(), exact: true }).click();
    await expect(page.locator('.installation-controls').getByRole('button', { name: 'Save', exact: true })).toBeEnabled({ timeout: 45000 });
    await loaderControl.click();
    const compatibleLoader = page.getByRole('menuitem').filter({ hasText: /^(Fabric|Forge|NeoForge|Quilt)\s/ }).first();
    await expect(compatibleLoader).toBeEnabled({ timeout: 45000 });
    await compatibleLoader.click();
    await page.locator('.installation-controls').getByRole('button', { name: 'Save', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: 'Change Minecraft and loader?', exact: true });
    await confirmation.waitFor();
    await confirmation.getByRole('button', { name: 'Back up and change', exact: true }).waitFor();
    await page.screenshot({ path: path.join(outputDirectory, 'version-confirmation.png'), fullPage: true });
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.locator('.installation-controls').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(minecraftControl).toHaveText(originalVersion);
    await expect(loaderControl).toHaveText(originalLoader);
    assert.equal(installationRequests, 0);
    versionControlsVerified = true;
  }
  assert.equal(await page.getByLabel('Minecraft server log output').isVisible(), false);
  await page.getByRole('tab', { name: 'Server Log', exact: true }).click();
  await page.getByLabel('Minecraft server log output').waitFor();
  await expectCenteredIcon(page.getByRole('button', { name: 'Refresh logs', exact: true }), 'Refresh logs');
  await page.getByRole('tab', { name: 'Basic', exact: true }).click();
  await page.getByRole('button', { name: 'Add mod', exact: true }).click();
  const addDialog = page.getByRole('dialog');
  await addDialog.getByText("Choose the mod's .jar file. It will be added directly to this saved server.", { exact: true }).waitFor();
  const chooser = page.waitForEvent('filechooser');
  await addDialog.getByRole('button', { name: 'Choose .jar files', exact: true }).click();
  await (await chooser).setFiles({ name: modName, mimeType: 'application/java-archive', buffer: Buffer.from('UI test fixture, removed before the server starts.') });
  await addDialog.getByRole('button', { name: 'Add mod', exact: true }).click();
  await page.getByRole('heading', { name: modName, exact: true }).waitFor().catch(async error => {
    console.error('Add mod diagnostic:', await page.getByRole('dialog').allTextContents());
    console.error('Visible errors:', await page.getByRole('alert').allTextContents());
    await page.screenshot({ path: path.join(outputDirectory, 'failure.png'), fullPage: true });
    throw error;
  });
  await page.getByLabel('Search mods', { exact: true }).fill(suffix);
  await page.getByRole('button', { name: 'Disable', exact: true }).click();
  await page.getByRole('button', { name: 'Enable', exact: true }).click();
  await page.getByRole('button', { name: 'Uninstall', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Uninstall', exact: true }).click();
  await page.getByText('No server mods match this search.').waitFor();
  const actualMods = await (await context.request.get(`${origin}/api/workspace/mods`)).json();
  assert(!actualMods.mods.some(mod => mod.path.includes(suffix)));
  await expectCenteredIcon(page.getByRole('button', { name: 'Clear search', exact: true }), 'Clear search');
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await page.getByRole('tab', { name: 'Advanced', exact: true }).click();
  await page.getByRole('heading', { name: 'Server files', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Destination folder', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: /New text file/i }).count(), 0);
  const fileRow = entryPath => page.locator(`.file-row[data-path="${entryPath}"]`);
  const folderRow = entryPath => page.getByRole('treeitem', { name: entryPath, exact: true });
  const chooseMenu = async (entryPath, label, sidebar = false) => {
    await (sidebar ? folderRow(entryPath) : fileRow(entryPath)).click({ button: 'right' });
    await page.getByRole('menuitem', { name: label, exact: true }).click();
  };
  const blankMenu = async label => {
    const table = page.locator('.file-table');
    await table.evaluate(target => target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 500, clientY: 400, button: 2 })));
    await page.getByRole('menuitem', { name: label, exact: true }).click();
  };
  for (const position of [{ x: 430, y: 320 }, { x: 710, y: 470 }]) {
    await page.locator('.file-table').evaluate((target, position) => target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: position.x, clientY: position.y, button: 2 })), position);
    const menu = page.getByRole('menu');
    await menu.waitFor();
    await expect.poll(async () => {
      const bounds = await menu.boundingBox();
      return bounds !== null && Math.abs(bounds.x - position.x) < 8 && Math.abs(bounds.y - position.y) < 8;
    }, { message: 'Context menu follows the pointer on every opening.' }).toBe(true).catch(async error => {
      console.error('Context menu diagnostic:', { pointer: position, menu: await menu.boundingBox() });
      await page.screenshot({ path: path.join(outputDirectory, 'failure.png'), fullPage: true });
      throw error;
    });
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
  }
  const navigate = async entryPath => {
    await folderRow(entryPath).click();
    await page.getByRole('navigation', { name: 'Current folder', exact: true }).getByRole('button').last().filter({ hasText: entryPath.split('/').at(-1) }).waitFor();
  };
  const confirmDialog = async label => {
    await page.getByRole('dialog').getByRole('button', { name: label, exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' }).catch(async error => {
      console.error('Dialog operation diagnostic:', await page.getByRole('dialog').allTextContents());
      await page.screenshot({ path: path.join(outputDirectory, 'failure.png'), fullPage: true });
      throw error;
    });
  };
  const fileChooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Choose files', exact: true }).click();
  await (await fileChooser).setFiles({ name: textName, mimeType: 'text/plain', buffer: Buffer.from('Uploaded through the Advanced tab.\n') });
  await chooseMenu(`config/${textName}`, 'Edit');
  const editor = page.getByRole('textbox', { name: `Contents of config/${textName}`, exact: true });
  assert.equal(await editor.inputValue(), 'Uploaded through the Advanced tab.\n');
  await expectCenteredIcon(page.getByRole('button', { name: 'Close editor', exact: true }), 'Close editor');
  await editor.fill('Saved through the Advanced text editor.\n');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('dialog').getByText('Saved', { exact: true }).waitFor();
  const saved = await (await context.request.get(`${origin}/api/workspace/files/text`, { params: { path: `config/${textName}` } })).json();
  assert.equal(saved.contents, 'Saved through the Advanced text editor.\n');
  await editor.fill('Unsaved changes remain until explicitly discarded.\n');
  await page.getByRole('button', { name: 'Close editor', exact: true }).click();
  const discardDialog = page.getByRole('dialog', { name: 'Discard unsaved changes?' });
  await discardDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await editor.inputValue(), 'Unsaved changes remain until explicitly discarded.\n');
  await page.getByRole('button', { name: 'Close editor', exact: true }).click();
  await discardDialog.getByRole('button', { name: 'Discard changes', exact: true }).click();
  const downloaded = page.waitForEvent('download');
  await chooseMenu(`config/${textName}`, 'Download');
  assert.equal((await downloaded).suggestedFilename(), textName);
  await chooseMenu(`config/${textName}`, 'Rename');
  await page.getByRole('dialog').getByLabel('New name', { exact: true }).fill(renamedTextName);
  await confirmDialog('Rename');
  await fileRow(`config/${renamedTextName}`).waitFor();
  await blankMenu('Create folder');
  await page.getByRole('dialog').getByLabel('Folder name', { exact: true }).fill(folderName);
  await confirmDialog('Create');
  await chooseMenu(`config/${folderName}`, 'Rename', true);
  await page.getByRole('dialog').getByLabel('New name', { exact: true }).fill(renamedFolderName);
  await confirmDialog('Rename');
  await navigate(`config/${renamedFolderName}`);
  await blankMenu('Create folder');
  await page.getByRole('dialog').getByLabel('Folder name', { exact: true }).fill(nestedFolderName);
  await confirmDialog('Create');
  await page.getByRole('button', { name: `Collapse config/${renamedFolderName}`, exact: true }).click();
  await folderRow(`config/${renamedFolderName}/${nestedFolderName}`).waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: `Expand config/${renamedFolderName}`, exact: true }).click();
  await folderRow(`config/${renamedFolderName}/${nestedFolderName}`).waitFor();
  await navigate(`config/${renamedFolderName}`);
  await blankMenu('Create file');
  await page.getByRole('dialog').getByLabel('File name', { exact: true }).fill('notes.whatever');
  await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
  const createdEditor = page.getByRole('textbox', { name: `Contents of config/${renamedFolderName}/notes.whatever`, exact: true });
  await createdEditor.fill('Created in the current folder.\n');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('dialog').getByText('Saved', { exact: true }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).waitFor();
  await page.screenshot({ path: path.join(outputDirectory, 'editor.png'), fullPage: true });
  await page.getByRole('button', { name: 'Close editor', exact: true }).click();
  await fileRow(`config/${renamedFolderName}/notes.whatever`).waitFor();
  await chooseMenu(`config/${renamedFolderName}/notes.whatever`, 'Rename');
  await page.getByRole('dialog').getByLabel('New name', { exact: true }).fill('notes.md');
  await confirmDialog('Rename');
  const arbitraryExtensionFile = await (await context.request.get(`${origin}/api/workspace/files/text`, { params: { path: `config/${renamedFolderName}/notes.md` } })).json();
  assert.equal(arbitraryExtensionFile.contents, 'Created in the current folder.\n');
  await page.locator('.file-browser').evaluate(target => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['Dragged into the current folder.\n'], 'dragged.txt', { type: 'text/plain' }));
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await fileRow(`config/${renamedFolderName}/dragged.txt`).waitFor();
  await navigate('config');
  await chooseMenu(`config/${renamedTextName}`, 'Move');
  await page.getByRole('dialog').getByRole('button', { name: `Move into config/${renamedFolderName}/${nestedFolderName}`, exact: true }).click();
  await confirmDialog('Move here');
  await chooseMenu(`config/${renamedFolderName}/${nestedFolderName}`, 'Move', true);
  await page.getByRole('dialog').getByRole('button', { name: 'Move into config', exact: true }).click();
  await confirmDialog('Move here');
  await navigate(`config/${nestedFolderName}`);
  await fileRow(`config/${nestedFolderName}/${renamedTextName}`).waitFor();
  await chooseMenu(`config/${nestedFolderName}/${renamedTextName}`, 'Delete');
  await confirmDialog('Delete');
  await fileRow(`config/${nestedFolderName}/${renamedTextName}`).waitFor({ state: 'hidden' });
  await chooseMenu(`config/${nestedFolderName}`, 'Delete', true);
  await confirmDialog('Delete');
  await folderRow(`config/${nestedFolderName}`).waitFor({ state: 'hidden' });
  await chooseMenu(`config/${renamedFolderName}`, 'Delete', true);
  await confirmDialog('Delete');
  await folderRow(`config/${renamedFolderName}`).waitFor({ state: 'hidden' });
  const inventory = await (await context.request.get(`${origin}/api/workspace/files`)).json();
  assert(!inventory.files.some(file => file.path.includes(suffix)));
  assert(!inventory.directories.some(directory => directory.path.includes(suffix)));
  await navigate('config');
  await page.screenshot({ path: path.join(outputDirectory, 'advanced.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: path.join(outputDirectory, 'advanced-mobile.png'), fullPage: true });
  await page.getByRole('tab', { name: 'Basic', exact: true }).click();
  await page.waitForTimeout(250);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: path.join(outputDirectory, 'basic-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(outputDirectory, 'basic.png'), fullPage: true });
  const packDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download pack ZIP', exact: true }).click();
  assert.equal((await packDownload).suggestedFilename(), 'dictionary-minecraft-server.zip');
  assert.deepEqual(browserErrors, []);
  const finalStatus = await rateLimitedRequest(() => context.request.get(`${origin}/api/status`));
  assert.equal(finalStatus.status(), 200);
  assert.equal((await finalStatus.json()).server.state, 'stopped');
  console.log(JSON.stringify({ passed: ['Preview invitation session', 'Correct name and three tabs without redundant header', 'Basic add/disable/enable/uninstall via actual controller', 'Advanced upload, drag/drop, and context-menu edit/save/download', 'Blank-area creation and file/folder rename/move/delete via dialogs', 'Arbitrary-extension text creation and nested folder accordion', 'Pointer-positioned menus and unsaved-change protection', 'Icon buttons centered within 1px at rest and on hover', 'Start, New server, and Add mod icons have balanced spacing and an 8px label gap', 'Current server ZIP download', 'Desktop and mobile screenshots', 'No browser exceptions', 'Minecraft kept stopped'], versionControlsVerified, profileControlsVerified, fixtures: 'Removed to recovery storage', screenshots: [path.join(outputDirectory, 'basic.png'), path.join(outputDirectory, 'advanced.png'), path.join(outputDirectory, 'editor.png'), path.join(outputDirectory, 'basic-mobile.png'), path.join(outputDirectory, 'advanced-mobile.png')] }, null, 2));
} finally {
  const remaining = await context.request.get(`${origin}/api/workspace/mods`).then(response => response.json()).catch(() => ({ mods: [] }));
  for (const mod of remaining.mods ?? []) {
    if ([`mods/${modName}`, `mods/${modName}.disabled`].includes(mod.path)) await context.request.post(`${origin}/api/workspace/mods/action`, { headers: { origin }, data: { path: mod.path, action: 'uninstall' } }).catch(() => undefined);
  }
  for (const fixture of [textName, renamedTextName, folderName, renamedFolderName, nestedFolderName]) {
    await context.request.post(`${origin}/api/workspace/entries/remove`, { headers: { origin }, data: { path: `config/${fixture}` } }).catch(() => undefined);
  }
  await browser.close();
}
