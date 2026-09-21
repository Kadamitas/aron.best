import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { MinecraftServer } from './minecraft.js';
import { RuntimeSandbox, javaProxyArguments, type RuntimeSandboxOptions } from './runtime-sandbox.js';
import type { InstalledServer } from './loader-installation.js';

const installed: InstalledServer = { minecraftVersion: '26.3', loader: 'Fabric', loaderVersion: '0.19.5', javaMajor: 25, launchArgs: ['-jar', 'fabric-server-launch.jar'], installedAt: '2026-09-21T12:00:00.000Z' };
const fakeJava = `process.stdout.write('Done (0.01s)!\\n'); process.stdin.on('data', input => { if (input.toString().includes('stop')) process.exit(0); });`;

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'aron-runtime-sandbox-')));
  const dataDirectory = path.join(root, 'data');
  const directory = path.join(dataDirectory, 'minecraft');
  const trustDirectory = path.join(root, 'trusted');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'installation.json'), JSON.stringify(installed));
  await writeFile(path.join(directory, 'fabric-server-launch.jar'), 'trusted launcher');
  await writeFile(path.join(directory, 'server.jar'), 'trusted vanilla');
  await writeFile(path.join(directory, 'eula.txt'), 'eula=true\n');
  await writeFile(path.join(directory, 'server.properties'), 'level-name=world\nonline-mode=true\nserver-ip=127.0.0.1\nserver-port=25566\n');
  const options: RuntimeSandboxOptions = { directory, dataDirectory, trustDirectory, proxyAddress: '172.30.3.2', javaPaths: { 25: '/opt/java/openjdk/bin/java' }, log: () => undefined };
  const sandbox = new RuntimeSandbox(options);
  const manifest = path.join(trustDirectory, `${createHash('sha256').update('minecraft').digest('hex')}.json`);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, directory, trustDirectory, options, sandbox, manifest };
}

test('runtime proxy arguments require private literal IPv4 and never bypass the proxy', () => {
  for (const address of ['172.30.3.2', '10.1.2.3', '192.168.1.2']) {
    const args = javaProxyArguments(address, 3129);
    assert(args.includes(`-Dhttps.proxyHost=${address}`));
    assert(args.includes('-Dhttps.proxyPort=3129'));
    assert(args.includes('-Dhttp.nonProxyHosts='));
    assert(!args.some(value => value.includes('localhost|')));
  }
  for (const invalid of ['localhost', '127.0.0.1', '8.8.8.8', '::1', '172.15.0.1', '172.32.0.1', '192.168.1.2 -Dother=true', '10.256.0.1']) assert.throws(() => javaProxyArguments(invalid, 3128), /private IPv4/);
});

test('sandbox runtime verification requires explicit trusted sealing and rejects unpinned Java paths', async t => {
  const setup = await fixture(t);
  await assert.rejects(setup.sandbox.verify(), /missing/);
  await assert.rejects(readdir(setup.trustDirectory), { code: 'ENOENT' });
  assert.deepEqual(await setup.sandbox.hardening().seal(), installed);
  assert.deepEqual(await setup.sandbox.verify(), installed);
  await assert.rejects(setup.sandbox.launch('/tmp/replaceable-java', installed), /pinned container image/);
  assert.throws(() => new RuntimeSandbox({ ...setup.options, directory: setup.options.dataDirectory }), /inside its dedicated data volume/);
  assert.throws(() => new RuntimeSandbox({ ...setup.options, trustDirectory: path.join(setup.options.dataDirectory, 'trust') }), /outside Minecraft-writable/);
});

test('trusted preparation rejects existing modpack files before invoking any Java process', async t => {
  const setup = await fixture(t);
  for (const name of ['mods', 'config', 'world', 'kubejs', 'scripts']) {
    const staging = path.join(setup.root, `stage-${name}`);
    await mkdir(path.join(staging, name), { recursive: true });
    await assert.rejects(setup.sandbox.hardening().prepare(staging, installed, { sha1: '0'.repeat(40), size: 1 }), /fresh installer directory/);
    assert.deepEqual(await readdir(staging), [name]);
  }
  const staging = path.join(setup.root, 'missing-java-stage');
  await mkdir(staging);
  const unavailable = new RuntimeSandbox({ ...setup.options, javaPaths: {} });
  await assert.rejects(unavailable.hardening().prepare(staging, installed, { sha1: '0'.repeat(40), size: 1 }), /pinned Java runtime is unavailable/);
  assert.deepEqual(await readdir(staging), []);
});

test('Minecraft start never auto-seals a missing or tampered runtime and does not fall back to plain Java', async t => {
  const setup = await fixture(t);
  let launches = 0;
  let sandboxLaunches = 0;
  const server = new MinecraftServer({ directory: setup.directory, java: process.execPath, javaPaths: { 25: process.execPath }, memoryMb: 512, version: '26.3', address: 'fixture.invalid', activity: () => undefined,
    sandbox: { verify: () => setup.sandbox.verify(), launch: async () => { sandboxLaunches++; throw new Error('Unexpected launcher call.'); } },
  }, { launch: () => { launches++; throw new Error('Plain Java must not be launched.'); } });
  try {
    await server.initialize();
    await assert.rejects(server.action('start'), /missing/);
    assert.equal(server.status().state, 'failed');
    assert.match(server.status().failure?.message ?? '', /integrity verification failed/);
    assert.equal(launches, 0);
    assert.equal(sandboxLaunches, 0);
    await assert.rejects(readdir(setup.trustDirectory), { code: 'ENOENT' });
    await setup.sandbox.hardening().seal();
    const before = await readFile(setup.manifest, 'utf8');
    await writeFile(path.join(setup.directory, 'fabric-server-launch.jar'), 'tampered launcher');
    await assert.rejects(server.action('start'), /integrity verification failed/);
    assert.equal(await readFile(setup.manifest, 'utf8'), before);
    assert.equal(launches, 0);
    assert.equal(sandboxLaunches, 0);
  } finally { await server.shutdown(); }
});

test('Minecraft launches only through its sandbox and uses the verified descriptor without rereading mutable metadata', async t => {
  const setup = await fixture(t);
  await setup.sandbox.hardening().seal();
  const observed: Array<{ command: string; args: string[] }> = [];
  let verifications = 0;
  const server = new MinecraftServer({ directory: setup.directory, java: process.execPath, javaPaths: { 25: process.execPath }, memoryMb: 512, version: '26.3', address: 'fixture.invalid', activity: () => undefined,
    sandbox: {
      verify: async () => { verifications++; return setup.sandbox.verify(); },
      launch: async (java, sealed) => {
        assert.equal(java, process.execPath);
        assert.deepEqual(sealed, installed);
        await writeFile(path.join(setup.directory, 'installation.json'), JSON.stringify({ ...installed, launchArgs: ['-javaagent:mods/evil.jar'] }));
        return { command: '/fixture/minecraft-sandbox', prefix: ['--read', setup.directory, '--', java], javaArguments: ['-Dhttps.proxyPort=3129'] };
      },
    },
  }, { launch: (command, args, options) => {
    observed.push({ command, args });
    return spawn(process.execPath, ['-e', fakeJava], { ...options, shell: false, stdio: 'pipe' });
  } });
  try {
    await server.initialize();
    await server.action('start');
    assert.equal(verifications, 1);
    assert.equal(observed.length, 1);
    assert.equal(observed[0]!.command, '/fixture/minecraft-sandbox');
    assert.deepEqual(observed[0]!.args.slice(-3), ['-jar', 'fabric-server-launch.jar', 'nogui']);
    assert(observed[0]!.args.includes('-Dhttps.proxyPort=3129'));
    assert(!observed[0]!.args.some(value => value.includes('evil.jar')));
    await server.action('stop');
    await assert.rejects(server.action('start'), /descriptor/);
    assert.equal(observed.length, 1);
    assert.equal(verifications, 2);
  } finally { await server.shutdown(); }
});

test('Minecraft rejects duplicate escaped protected properties before launching the game process', async t => {
  const setup = await fixture(t);
  let launches = 0;
  const server = new MinecraftServer({ directory: setup.directory, java: process.execPath, javaPaths: { 25: process.execPath }, memoryMb: 512, version: '26.3', address: 'fixture.invalid', activity: () => undefined, requireOnlineMode: true }, {
    launch: () => { launches++; throw new Error('Unsafe server properties must not reach the launcher.'); },
  });
  const properties = 'online-mode=true\nserver-ip=127.0.0.1\nserver-port=25566\n';
  try {
    await server.initialize();
    for (const extra of [String.raw`\u006fnline-mode=false`, 'server-port:25565', 'level-name:../../outside']) {
      await writeFile(path.join(setup.directory, 'server.properties'), `${properties}${extra}\n`);
      await assert.rejects(server.action('start'), /duplicate|level-name=world/);
    }
    assert.equal(launches, 0);
  } finally { await server.shutdown(); }
});
