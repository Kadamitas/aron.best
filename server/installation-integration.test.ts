import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readInstalled, type InstalledServer } from './loader-installation.js';
import { MinecraftServer } from './minecraft.js';

const processFixture = `
  process.stdout.write('Done (0.01s)!\\n');
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', input => { if (input.includes('stop')) process.exit(0); });
`;
const javaPaths: Record<number, string> = {
  8: '/configured/java8/bin/java',
  17: '/configured/java17/bin/java',
  21: '/configured/java21/bin/java',
  25: '/configured/java25/bin/java',
};
const installedAt = '2026-09-21T12:00:00.000Z';
const installations: InstalledServer[] = [
  { minecraftVersion: '1.7.10', loader: 'Forge', loaderVersion: '10.13.4.1614', javaMajor: 8, launchArgs: ['-jar', 'forge-1.7.10-10.13.4.1614-1.7.10-universal.jar'], installedAt },
  { minecraftVersion: '1.20.1', loader: 'Forge', loaderVersion: '47.4.10', javaMajor: 17, launchArgs: ['@libraries/net/minecraftforge/forge/1.20.1-47.4.10/unix_args.txt'], installedAt },
  { minecraftVersion: '1.21.1', loader: 'NeoForge', loaderVersion: '21.1.200', javaMajor: 21, launchArgs: ['@libraries/net/neoforged/neoforge/21.1.200/unix_args.txt'], installedAt },
  { minecraftVersion: '26.1', loader: 'Fabric', loaderVersion: '0.18.4', javaMajor: 25, launchArgs: ['-jar', 'fabric-server-launch.jar'], installedAt },
  { minecraftVersion: '1.20.1', loader: 'Quilt', loaderVersion: '0.30.0', javaMajor: 17, launchArgs: ['-jar', 'quilt-server-launch.jar'], installedAt },
];

async function writeInstallation(directory: string, installed: InstalledServer): Promise<void> {
  const launcher = installed.launchArgs[0] === '-jar' ? installed.launchArgs[1]! : installed.launchArgs[0]!.slice(1);
  await mkdir(path.dirname(path.join(directory, launcher)), { recursive: true });
  await writeFile(path.join(directory, launcher), 'Fixture launcher, never executed.');
  await writeFile(path.join(directory, 'installation.next'), JSON.stringify(installed));
  await rename(path.join(directory, 'installation.next'), path.join(directory, 'installation.json'));
}

async function fixture(installed: InstalledServer, configuredJavaPaths = javaPaths) {
  const root = await mkdtemp(path.join(tmpdir(), 'aron-installation-runtime-'));
  const directory = path.join(root, 'minecraft');
  await mkdir(directory);
  await writeFile(path.join(directory, 'eula.txt'), 'eula=true\n');
  await writeFile(path.join(directory, 'server.properties'), 'online-mode=true\nserver-ip=127.0.0.1\nserver-port=25566\n');
  await writeInstallation(directory, installed);
  const launches: Array<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
  const server = new MinecraftServer({ directory, java: '/fallback/java/bin/java', javaPaths: configuredJavaPaths, memoryMb: 1024, version: 'fallback-version', loaderVersion: 'fallback-loader', address: 'mc.example.test', activity: () => undefined, requireOnlineMode: true }, {
    launch: (command, args, options) => {
      launches.push({ command, args, cwd: options.cwd, env: { ...options.env } });
      return spawn(process.execPath, ['-e', processFixture], { ...options, shell: false, stdio: 'pipe' });
    },
  });
  return { directory, server, launches, dispose: async () => { await server.shutdown(); await rm(root, { recursive: true, force: true }); } };
}

test('installed loaders choose their configured Java major and validated launch arguments', async t => {
  for (const installation of installations) await t.test(`${installation.loader} ${installation.minecraftVersion} uses Java ${installation.javaMajor}`, async () => {
    const setup = await fixture(installation);
    try {
      await setup.server.initialize();
      assert.equal(setup.server.status().state, 'stopped');
      assert.equal(setup.server.status().version, installation.minecraftVersion);
      assert.equal(setup.server.status().loader, installation.loader);
      assert.equal(setup.server.status().loaderVersion, installation.loaderVersion);
      await setup.server.action('start');
      assert.equal(setup.server.status().state, 'running');
      assert.deepEqual(setup.launches, [{
        command: javaPaths[installation.javaMajor],
        args: ['-Xms512M', '-Xmx1024M', ...installation.launchArgs, 'nogui'],
        cwd: setup.directory,
        env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', JAVA_HOME: path.resolve(javaPaths[installation.javaMajor]!, '..', '..') },
      }]);
    } finally { await setup.dispose(); }
  });
});

test('restart rereads the installed descriptor instead of reusing the prior loader and Java runtime', async () => {
  const original = installations[3]!;
  const replacement = installations[2]!;
  const setup = await fixture(original);
  try {
    await setup.server.initialize();
    await setup.server.action('start');
    await writeInstallation(setup.directory, replacement);
    await setup.server.action('restart');
    assert.equal(setup.launches.length, 2);
    assert.equal(setup.launches[0]!.command, javaPaths[25]);
    assert.equal(setup.launches[1]!.command, javaPaths[21]);
    assert.deepEqual(setup.launches[1]!.args, ['-Xms512M', '-Xmx1024M', ...replacement.launchArgs, 'nogui']);
    assert.equal(setup.server.status().version, replacement.minecraftVersion);
    assert.equal(setup.server.status().loader, replacement.loader);
    assert.equal(setup.server.status().loaderVersion, replacement.loaderVersion);
  } finally { await setup.dispose(); }
});

test('an unconfigured required Java runtime fails before launching and never falls back to another Java', async () => {
  const setup = await fixture(installations[0]!, { 17: javaPaths[17]!, 21: javaPaths[21]!, 25: javaPaths[25]! });
  try {
    await setup.server.initialize();
    await assert.rejects(setup.server.action('start'), /Java 8.*not configured/);
    assert.deepEqual(setup.launches, []);
    assert.equal(setup.server.status().state, 'stopped');
  } finally { await setup.dispose(); }
});

test('tampered descriptors cannot select arbitrary executables, paths, or extra JVM arguments', async t => {
  const valid = installations[3]!;
  const invalid = [
    { ...valid, java: '/usr/bin/osascript' },
    { ...valid, javaMajor: 99 },
    { ...valid, launchArgs: ['/bin/sh', '-c'] },
    { ...valid, launchArgs: ['-jar', '../../outside.jar'] },
    { ...valid, launchArgs: ['-jar', 'fabric-server-launch.jar', '-javaagent:outside.jar'] },
    { ...valid, launchArgs: ['@/private/args.txt'] },
  ];
  for (const [index, descriptor] of invalid.entries()) await t.test(`invalid descriptor ${index + 1}`, async () => {
    const setup = await fixture(valid);
    try {
      await writeFile(path.join(setup.directory, 'installation.json'), JSON.stringify(descriptor));
      await assert.rejects(readInstalled(setup.directory), /unsupported launch command/);
      await assert.rejects(setup.server.initialize(), /unsupported launch command/);
      assert.deepEqual(setup.launches, []);
    } finally { await setup.dispose(); }
  });
});

test('descriptor tampering after initialization is rejected on start before any child is launched', async () => {
  const setup = await fixture(installations[3]!);
  try {
    await setup.server.initialize();
    await writeFile(path.join(setup.directory, 'installation.json'), JSON.stringify({ ...installations[3], launchArgs: ['-jar', '../../outside.jar'] }));
    await assert.rejects(setup.server.action('start'), /unsupported launch command/);
    assert.deepEqual(setup.launches, []);
  } finally { await setup.dispose(); }
});
