import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertInstallationPresent, bootstrapContainer } from './container-bootstrap.js';
import { readControllerConfiguration } from './controller.js';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'aron-bootstrap-'));
  const configuration = readControllerConfiguration({ RUNTIME_DIRECTORY: root, CONTROLLER_TOKEN: 'bootstrap-fixture-token-12345678901234567890' });
  return { root, configuration, directory: path.join(root, 'minecraft'), dispose: () => rm(root, { recursive: true, force: true }) };
}

test('missing or empty active installation with retained snapshots refuses bootstrap without touching the snapshot', async t => {
  for (const activeExists of [false, true]) await t.test(activeExists ? 'empty active directory' : 'missing active directory', async context => {
    const setup = await fixture();
    const network = context.mock.method(globalThis, 'fetch', async () => { throw new Error('No network requests are permitted.'); });
    try {
      const snapshot = path.join(setup.root, 'installation-snapshots', 'interrupted-server', 'world');
      await mkdir(snapshot, { recursive: true });
      await writeFile(path.join(snapshot, 'level.dat'), 'original-world');
      if (activeExists) await mkdir(setup.directory);
      await assert.rejects(bootstrapContainer(setup.configuration, true), /Restore the intended server.*Nothing was bootstrapped/);
      assert.equal(network.mock.callCount(), 0);
      assert.equal(await readFile(path.join(snapshot, 'level.dat'), 'utf8'), 'original-world');
      if (activeExists) assert.deepEqual(await readdir(setup.directory), []);
      else await assert.rejects(access(setup.directory), { code: 'ENOENT' });
    } finally { await setup.dispose(); }
  });
});

test('interrupted installation staging blocks bootstrap even before a snapshot was created', async t => {
  const setup = await fixture();
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('No network requests are permitted.'); });
  try {
    const staging = path.join(setup.root, '.installation-interrupted');
    await mkdir(staging);
    await writeFile(path.join(staging, 'installation.json'), '{"retained":"staged"}');
    await assert.rejects(bootstrapContainer(setup.configuration, true), /Restore the intended server/);
    assert.equal(network.mock.callCount(), 0);
    await assert.rejects(access(setup.directory), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(staging, 'installation.json'), 'utf8'), '{"retained":"staged"}');
  } finally { await setup.dispose(); }
});

test('clean first-run bootstrap remains supported when snapshot storage is empty', async t => {
  const setup = await fixture();
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push(url);
    if (url === 'https://meta.fabricmc.net/v2/versions/installer') return Response.json([{ version: '1.1.0', stable: true }]);
    assert.equal(url, 'https://meta.fabricmc.net/v2/versions/loader/26.3/0.19.5/1.1.0/server/jar');
    return new Response('Synthetic launcher, never executed.');
  });
  try {
    await mkdir(path.join(setup.root, 'installation-snapshots'));
    await bootstrapContainer(setup.configuration, true);
    assert.equal(requests.length, 2);
    assert.equal(await readFile(path.join(setup.directory, 'fabric-server-launch.jar'), 'utf8'), 'Synthetic launcher, never executed.');
    assert.equal(await readFile(path.join(setup.directory, 'eula.txt'), 'utf8'), 'eula=true\n');
    assert.match(await readFile(path.join(setup.directory, 'server.properties'), 'utf8'), /^online-mode=true$/m);
  } finally { await setup.dispose(); }
});

test('a valid initialized installation is unchanged when historical snapshots and abandoned staging remain', async t => {
  const setup = await fixture();
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('No network requests are permitted.'); });
  try {
    await mkdir(setup.directory);
    await mkdir(path.join(setup.root, 'installation-snapshots', 'previous'), { recursive: true });
    await mkdir(path.join(setup.root, '.installation-abandoned'));
    const descriptor = JSON.stringify({ minecraftVersion: '1.21.1', loader: 'Fabric', loaderVersion: '0.18.4', javaMajor: 21, launchArgs: ['-jar', 'fabric-server-launch.jar'], installedAt: '2026-09-21T12:00:00.000Z' });
    await writeFile(path.join(setup.directory, 'installation.json'), descriptor);
    await writeFile(path.join(setup.directory, 'fabric-server-launch.jar'), 'existing-launcher');
    await bootstrapContainer(setup.configuration, false);
    assert.equal(network.mock.callCount(), 0);
    assert.equal(await readFile(path.join(setup.directory, 'installation.json'), 'utf8'), descriptor);
    assert.equal(await readFile(path.join(setup.directory, 'fabric-server-launch.jar'), 'utf8'), 'existing-launcher');
  } finally { await setup.dispose(); }
});

test('linked active directories or snapshot storage cannot redirect bootstrap writes', async t => {
  for (const target of ['minecraft', 'installation-snapshots']) await t.test(target, async context => {
    const setup = await fixture();
    const network = context.mock.method(globalThis, 'fetch', async () => { throw new Error('No network requests are permitted.'); });
    try {
      const outside = path.join(setup.root, 'outside');
      await mkdir(outside);
      await writeFile(path.join(outside, 'retained.txt'), 'unrelated');
      await symlink(outside, path.join(setup.root, target));
      await assert.rejects(bootstrapContainer(setup.configuration, true), /regular directory/);
      assert.equal(network.mock.callCount(), 0);
      assert.deepEqual(await readdir(outside), ['retained.txt']);
    } finally { await setup.dispose(); }
  });
});

test('installation safety check does not create directories on a fresh runtime path', async () => {
  const setup = await fixture();
  try {
    const uncreated = path.join(setup.root, 'new-runtime');
    await assertInstallationPresent(uncreated);
    await assert.rejects(access(uncreated), { code: 'ENOENT' });
  } finally { await setup.dispose(); }
});
