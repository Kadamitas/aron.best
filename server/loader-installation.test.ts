import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { LoaderInstallation, LoaderInstallationError, readInstalled, type LoaderInstallationDependencies, type ServerTarget } from './loader-installation.js';

const fabric: ServerTarget = { minecraftVersion: '26.3', loader: 'Fabric', loaderVersion: '0.19.5' };
const vanilla = Buffer.from('official server jar');
const installer = Buffer.from('official installer jar');
const hash = (contents: string | Buffer) => createHash('sha1').update(contents).digest('hex');
const minecraftVersions = ['26.3', '26.2', '26.1.2', '26.3-pre-1', '1.21.1', '1.20.1', '1.19.2', '1.18.2', '1.16.5', '1.12.2', '1.7.10', '1.6.4', '1.5.2'];
const forgeVersions: Record<string, string> = { '26.3': '66.0.2', '1.21.1': '52.1.16', '1.20.1': '47.4.23', '1.19.2': '43.5.2', '1.18.2': '40.3.12', '1.16.5': '36.2.42', '1.12.2': '14.23.5.2864', '1.7.10': '10.13.4.1614', '1.6.4': '9.11.1.1345' };

async function fixture(t: TestContext, overrides: Partial<LoaderInstallationDependencies> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'aron-loader-install-'));
  const directory = path.join(root, 'minecraft');
  await mkdir(path.join(directory, 'world'), { recursive: true });
  await mkdir(path.join(directory, 'mods'));
  await mkdir(path.join(directory, 'config'));
  await mkdir(path.join(directory, 'libraries', 'old-loader'), { recursive: true });
  await writeFile(path.join(directory, 'world', 'level.dat'), 'world bytes');
  await writeFile(path.join(directory, 'mods', 'existing.jar'), 'mod bytes');
  await writeFile(path.join(directory, 'config', 'settings.json'), '{"keep":true}');
  await writeFile(path.join(directory, 'libraries', 'old-loader', 'old.jar'), 'outdated runtime');
  await writeFile(path.join(directory, 'fabric-server-launch.jar'), 'previous launcher');
  await writeFile(path.join(directory, 'server.properties'), 'server-ip=127.0.0.1\nserver-port=25566\nonline-mode=true\n');
  await writeFile(path.join(directory, 'eula.txt'), 'eula=true\n');
  t.after(() => rm(root, { recursive: true, force: true }));
  const responses = new Map<string, string | Buffer>();
  const requests: string[] = [];
  const executions: Array<{ java: string; args: string[]; directory: string }> = [];
  const logs: string[] = [];
  const releases = minecraftVersions.map(version => {
    const contents = JSON.stringify({ javaVersion: { majorVersion: version.startsWith('26.') ? 25 : version.startsWith('1.21') ? 21 : /1\.(18|19|20)/.test(version) ? 17 : 8 }, downloads: { server: { url: `https://piston-data.mojang.com/v1/objects/${hash(vanilla)}/server.jar`, size: vanilla.length, sha1: hash(vanilla) } } });
    const url = `https://piston-meta.mojang.com/v1/packages/${hash(contents)}/${version}.json`;
    responses.set(url, contents);
    return { id: version, type: version.includes('pre') ? 'snapshot' : 'release', url, sha1: hash(contents) };
  });
  responses.set('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', JSON.stringify({ versions: releases }));
  responses.set(`https://piston-data.mojang.com/v1/objects/${hash(vanilla)}/server.jar`, vanilla);
  for (const host of ['https://meta.fabricmc.net/v2', 'https://meta.quiltmc.org/v3']) {
    responses.set(`${host}/versions/game`, JSON.stringify(minecraftVersions.filter(version => version.startsWith('26.') || /^1\.(16|18|19|20|21)/.test(version)).map(version => ({ version, stable: true }))));
    for (const version of minecraftVersions) responses.set(`${host}/versions/loader/${version}`, JSON.stringify([{ loader: { version: host.includes('fabric') ? '0.19.5' : '0.31.0-beta.4', stable: true } }]));
  }
  responses.set('https://meta.fabricmc.net/v2/versions/installer', JSON.stringify([{ version: '1.1.2', stable: true }]));
  responses.set('https://meta.fabricmc.net/v2/versions/loader/26.3/0.19.5/1.1.2/server/jar', installer);
  responses.set('https://meta.quiltmc.org/v3/versions/installer', JSON.stringify([{ version: '0.15.1', url: 'https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/0.15.1/quilt-installer-0.15.1.jar', file_size: installer.length, hashes: { sha1: '0'.repeat(40) } }]));
  responses.set('https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/0.15.1/quilt-installer-0.15.1.jar', installer);
  responses.set('https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/0.15.1/quilt-installer-0.15.1.jar.sha1', hash(installer));
  responses.set('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json', JSON.stringify({ promos: Object.fromEntries(Object.entries(forgeVersions).map(([mc, version]) => [`${mc}-latest`, version])) }));
  const coordinates = Object.entries(forgeVersions).map(([mc, version]) => `${mc}-${version}${mc === '1.7.10' ? '-1.7.10' : ''}`);
  responses.set('https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml', `<versions>${coordinates.map(version => `<version>${version}</version>`).join('')}</versions>`);
  responses.set('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml', '<versions><version>21.1.251</version><version>26.1.2.109</version><version>26.2.0.88</version><version>26.3.0.7-beta</version></versions>');
  responses.set('https://maven.neoforged.net/releases/net/neoforged/forge/maven-metadata.xml', '<versions><version>1.20.1-47.1.106</version></versions>');
  for (const coordinate of coordinates) {
    const url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${coordinate}/forge-${coordinate}-installer.jar`;
    responses.set(url, installer);
    responses.set(`${url}.sha1`, hash(installer));
  }
  for (const coordinate of ['21.1.251', '26.3.0.7-beta', '1.20.1-47.1.106']) {
    const artifact = coordinate.startsWith('1.20') ? 'forge' : 'neoforge';
    const url = `https://maven.neoforged.net/releases/net/neoforged/${artifact}/${coordinate}/${artifact}-${coordinate}-installer.jar`;
    responses.set(url, installer);
    responses.set(`${url}.sha1`, hash(installer));
  }
  const dependencies: LoaderInstallationDependencies = {
    fetch: async value => {
      const url = String(value);
      requests.push(url);
      const body = responses.get(url);
      return body === undefined ? new Response('not found', { status: 404 }) : new Response(typeof body === 'string' ? body : Uint8Array.from(body));
    },
    run: async (java, args, staged) => {
      executions.push({ java, args, directory: staged });
      if (args.includes('server')) await writeFile(path.join(staged, 'quilt-server-launch.jar'), 'quilt launcher');
      else {
        const download = requests.filter(url => url.endsWith('-installer.jar')).at(-1)!;
        const parts = new URL(download).pathname.split('/');
        const coordinate = parts.at(-2)!;
        if (coordinate.startsWith('1.7.10')) await writeFile(path.join(staged, `forge-${coordinate}-universal.jar`), 'legacy forge');
        else {
          const group = download.includes('maven.minecraftforge.net') ? 'net/minecraftforge/forge' : coordinate.startsWith('1.20.1') ? 'net/neoforged/forge' : 'net/neoforged/neoforge';
          const location = path.join(staged, 'libraries', group, coordinate);
          await mkdir(location, { recursive: true });
          await writeFile(path.join(location, 'unix_args.txt'), '-cp libraries/official.jar main.Class');
        }
      }
    },
    availableBytes: async () => 100n * 1024n ** 3n,
    rename,
    ...overrides,
  };
  const options = { directory, javaPaths: { 8: '/java/8/bin/java', 17: '/java/17/bin/java', 21: '/java/21/bin/java', 25: '/java/25/bin/java' }, log: (line: string) => logs.push(line) };
  const service = new LoaderInstallation(options, dependencies);
  return { root, directory, responses, requests, executions, logs, service, options, dependencies };
}

test('catalog combines curated classic versions with official stable 26+ releases and compatible loaders', async t => {
  const setup = await fixture(t);
  const catalog = await setup.service.catalog();
  assert.equal(catalog.minecraftVersion, '26.3');
  assert(catalog.versions.includes('1.6.4'));
  assert(catalog.versions.includes('26.1.2'));
  assert(!catalog.versions.includes('1.5.2'));
  assert(!catalog.versions.includes('26.3-pre-1'));
  assert.deepEqual(catalog.loaders.map(value => value.loader), ['Fabric', 'Forge', 'NeoForge', 'Quilt']);
  assert.deepEqual((await setup.service.catalog('1.7.10')).loaders, [{ loader: 'Forge', loaderVersion: '10.13.4.1614' }]);
  assert.deepEqual((await setup.service.catalog('1.21.10')).loaders, []);
  assert((await setup.service.catalog('1.21.10')).versions.includes('26.3'));
  assert.equal((await setup.service.catalog('26.1.2')).loaders.find(value => value.loader === 'NeoForge')?.loaderVersion, '26.1.2.109');
});

test('an optional metadata provider failure removes its choices without hiding other loaders', async t => {
  const setup = await fixture(t);
  setup.responses.delete('https://meta.quiltmc.org/v3/versions/game');
  const catalog = await setup.service.catalog();
  assert.deepEqual(catalog.loaders.map(value => value.loader), ['Fabric', 'Forge', 'NeoForge']);
  assert(setup.logs.some(line => line.includes('Quilt version lookup')));
});

test('Fabric installation replaces only runtime files and retains a complete original snapshot', async t => {
  const setup = await fixture(t);
  await mkdir(path.join(setup.directory, 'custom-world'));
  await writeFile(path.join(setup.directory, 'custom-world', 'level.dat'), 'another world');
  const installed = await setup.service.install(fabric);
  assert.deepEqual(installed.launchArgs, ['-jar', 'fabric-server-launch.jar']);
  assert.equal(installed.javaMajor, 25);
  assert.deepEqual(await readInstalled(setup.directory), installed);
  assert.equal(await readFile(path.join(setup.directory, 'world', 'level.dat'), 'utf8'), 'world bytes');
  assert.equal(await readFile(path.join(setup.directory, 'custom-world', 'level.dat'), 'utf8'), 'another world');
  assert.equal(await readFile(path.join(setup.directory, 'mods', 'existing.jar'), 'utf8'), 'mod bytes');
  assert.equal(await readFile(path.join(setup.directory, 'config', 'settings.json'), 'utf8'), '{"keep":true}');
  assert.equal(await readFile(path.join(setup.directory, 'eula.txt'), 'utf8'), 'eula=true\n');
  await assert.rejects(readFile(path.join(setup.directory, 'libraries', 'old-loader', 'old.jar')), { code: 'ENOENT' });
  const snapshots = await readdir(path.join(setup.root, 'installation-snapshots'));
  assert.equal(snapshots.length, 1);
  assert.equal(await readFile(path.join(setup.root, 'installation-snapshots', snapshots[0]!, 'libraries', 'old-loader', 'old.jar'), 'utf8'), 'outdated runtime');
  assert.equal(await readFile(path.join(setup.root, 'installation-snapshots', snapshots[0]!, 'world', 'level.dat'), 'utf8'), 'world bytes');
  assert.equal(setup.executions.length, 0);
});

test('Forge and NeoForge run only fixed installer arguments and store validated relative argument-file launches', async t => {
  for (const target of [{ minecraftVersion: '26.3', loader: 'Forge', loaderVersion: '66.0.2' }, { minecraftVersion: '26.3', loader: 'NeoForge', loaderVersion: '26.3.0.7-beta' }, { minecraftVersion: '1.20.1', loader: 'NeoForge', loaderVersion: '47.1.106' }] satisfies ServerTarget[]) {
    const setup = await fixture(t);
    const installed = await setup.service.install(target);
    assert.deepEqual(setup.executions[0]!.args, ['-jar', 'installer.jar', '--installServer']);
    assert.equal(setup.executions[0]!.java, `/java/${target.minecraftVersion === '1.20.1' ? 17 : 25}/bin/java`);
    assert.match(installed.launchArgs[0]!, /^@libraries\/net\/(?:minecraftforge|neoforged)\//);
    assert.equal(installed.launchArgs.length, 1);
    assert.deepEqual(await readInstalled(setup.directory), installed);
    await assert.rejects(readFile(path.join(setup.directory, 'installer.jar')), { code: 'ENOENT' });
  }
});

test('preserved data safely takes precedence over installer-created default directories and files', async t => {
  const setup = await fixture(t);
  const run = setup.dependencies.run;
  const service = new LoaderInstallation(setup.options, { ...setup.dependencies, run: async (java, args, directory, log) => {
    await run(java, args, directory, log);
    await mkdir(path.join(directory, 'config'));
    await mkdir(path.join(directory, 'mods'));
    await writeFile(path.join(directory, 'config', 'settings.json'), '{"installerDefault":true}');
    await writeFile(path.join(directory, 'config', 'new-default.json'), '{"new":true}');
    await writeFile(path.join(directory, 'mods', 'existing.jar'), 'installer default mod');
  } });
  await service.install({ minecraftVersion: '26.3', loader: 'Forge', loaderVersion: '66.0.2' });
  assert.equal(await readFile(path.join(setup.directory, 'config', 'settings.json'), 'utf8'), '{"keep":true}');
  assert.equal(await readFile(path.join(setup.directory, 'mods', 'existing.jar'), 'utf8'), 'mod bytes');
  assert.equal(await readFile(path.join(setup.directory, 'config', 'new-default.json'), 'utf8'), '{"new":true}');
});

test('legacy Forge resolves its suffixed Maven coordinate, downloads vanilla first and launches its universal JAR with Java 8', async t => {
  const setup = await fixture(t);
  const installed = await setup.service.install({ minecraftVersion: '1.7.10', loader: 'Forge', loaderVersion: '10.13.4.1614' });
  assert.deepEqual(installed.launchArgs, ['-jar', 'forge-1.7.10-10.13.4.1614-1.7.10-universal.jar']);
  assert.equal(installed.javaMajor, 8);
  assert.equal(setup.executions[0]!.java, '/java/8/bin/java');
  assert.equal(await readFile(path.join(setup.directory, 'minecraft_server.1.7.10.jar'), 'utf8'), vanilla.toString());
  assert(setup.requests.some(url => url.endsWith('forge-1.7.10-10.13.4.1614-1.7.10-installer.jar')));
  assert.deepEqual(await readInstalled(setup.directory), installed);
});

test('Quilt installs its explicitly selected loader into the staging directory and fetches a verified vanilla server', async t => {
  const setup = await fixture(t);
  const installed = await setup.service.install({ minecraftVersion: '26.3', loader: 'Quilt', loaderVersion: '0.31.0-beta.4' });
  assert.deepEqual(setup.executions[0]!.args, ['-jar', 'installer.jar', 'install', 'server', '26.3', '0.31.0-beta.4', '--install-dir=.']);
  assert.deepEqual(installed.launchArgs, ['-jar', 'quilt-server-launch.jar']);
  assert.equal(await readFile(path.join(setup.directory, 'server.jar'), 'utf8'), vanilla.toString());
});

test('invalid targets and missing Java reject before changing existing server data', async t => {
  const setup = await fixture(t);
  for (const target of [{ ...fabric, minecraftVersion: '1.5.2' }, { ...fabric, loaderVersion: 'not-published' }, { ...fabric, loaderVersion: '../../exec' }]) await assert.rejects(setup.service.install(target), LoaderInstallationError);
  const service = new LoaderInstallation({ ...setup.options, javaPaths: {} }, setup.dependencies);
  await assert.rejects(service.install(fabric), /Java 25/);
  assert.equal(await readFile(path.join(setup.directory, 'fabric-server-launch.jar'), 'utf8'), 'previous launcher');
  assert.deepEqual(await readdir(setup.root), ['minecraft']);
});

test('failed checksums and installer failures leave the original installation and worlds untouched', async t => {
  const setup = await fixture(t, { run: async () => { throw new Error('installer failure'); } });
  await assert.rejects(setup.service.install({ minecraftVersion: '26.3', loader: 'Forge', loaderVersion: '66.0.2' }), /installer failure/);
  setup.responses.set(`https://piston-data.mojang.com/v1/objects/${hash(vanilla)}/server.jar`, 'tampered');
  await assert.rejects(setup.service.install(fabric), /checksum/);
  assert.equal(await readFile(path.join(setup.directory, 'world', 'level.dat'), 'utf8'), 'world bytes');
  assert.equal(await readFile(path.join(setup.directory, 'fabric-server-launch.jar'), 'utf8'), 'previous launcher');
  assert.deepEqual(await readdir(path.join(setup.root, 'installation-snapshots')), []);
  assert(!(await readdir(setup.root)).some(name => name.startsWith('.installation-')));
});

test('source links, insufficient disk and full snapshot retention all fail safely before the swap', async t => {
  const linked = await fixture(t);
  const outside = path.join(linked.root, 'outside');
  await writeFile(outside, 'private');
  await symlink(outside, path.join(linked.directory, 'config', 'linked.txt'));
  await assert.rejects(linked.service.install(fabric), /links/);
  await rm(path.join(linked.directory, 'config', 'linked.txt'));
  await link(outside, path.join(linked.directory, 'config', 'hard.txt'));
  await assert.rejects(linked.service.install(fabric), /links/);
  const full = await fixture(t, { availableBytes: async () => 1024n });
  await assert.rejects(full.service.install(fabric), /free storage/);
  const retained = await fixture(t);
  await mkdir(path.join(retained.root, 'installation-snapshots'));
  for (let index = 0; index < 5; index++) await mkdir(path.join(retained.root, 'installation-snapshots', String(index)));
  await assert.rejects(retained.service.install(fabric), /Five installation snapshots/);
  for (const setup of [linked, full, retained]) assert.equal(await readFile(path.join(setup.directory, 'world', 'level.dat'), 'utf8'), 'world bytes');
});

test('a failed second rename restores the complete original installation', async t => {
  let moves = 0;
  const setup = await fixture(t, { rename: async (source, destination) => { if (++moves === 2) throw new Error('simulated swap failure'); await rename(source, destination); } });
  await assert.rejects(setup.service.install(fabric), /simulated swap failure/);
  assert.equal(await readFile(path.join(setup.directory, 'world', 'level.dat'), 'utf8'), 'world bytes');
  assert.equal(await readFile(path.join(setup.directory, 'fabric-server-launch.jar'), 'utf8'), 'previous launcher');
  assert.equal(await readFile(path.join(setup.directory, 'libraries', 'old-loader', 'old.jar'), 'utf8'), 'outdated runtime');
  assert.deepEqual(await readdir(path.join(setup.root, 'installation-snapshots')), []);
});

test('untrusted artifact redirects cannot reach private networks', async t => {
  const setup = await fixture(t);
  const original = setup.dependencies.fetch;
  const service = new LoaderInstallation(setup.options, { ...setup.dependencies, fetch: async (url, init) => String(url).endsWith('/server/jar') ? new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:3001/status' } }) : original(url, init) });
  await assert.rejects(service.install(fabric), /approved official HTTPS/);
  assert(!setup.requests.some(url => url.includes('127.0.0.1')));
  assert.equal(await readFile(path.join(setup.directory, 'fabric-server-launch.jar'), 'utf8'), 'previous launcher');
});

test('installation descriptors reject arbitrary JVM flags, outside paths, forged loader paths and linked control files', async t => {
  const setup = await fixture(t);
  assert.equal(await readInstalled(setup.directory), undefined);
  const descriptor = path.join(setup.directory, 'installation.json');
  await writeFile(descriptor, JSON.stringify({ minecraftVersion: '26.3', loaderVersion: '0.19.5', source: 'legacy' }));
  assert.equal(await readInstalled(setup.directory), undefined);
  for (const launchArgs of [['-javaagent:/outside.jar'], ['-jar', '../../outside.jar'], ['-jar', 'mods/evil.jar'], ['@libraries/net/neoforged/neoforge/evil/unix_args.txt'], ['-jar', 'fabric-server-launch.jar', '-Dexec=true']]) {
    await writeFile(descriptor, JSON.stringify({ ...fabric, javaMajor: 25, launchArgs, installedAt: new Date().toISOString() }));
    await assert.rejects(readInstalled(setup.directory), /unsupported launch command/);
  }
  await rm(descriptor);
  await symlink(path.join(setup.directory, 'server.properties'), descriptor);
  await assert.rejects(readInstalled(setup.directory), /links/);
});

test('trusted preparation runs before modpack data is copied and sealing runs only after the committed swap', async t => {
  const setup = await fixture(t);
  const events: string[] = [];
  const service = new LoaderInstallation({ ...setup.options, hardening: {
    prepare: async (staging, installed, source) => {
      events.push('prepare');
      assert.notEqual(staging, setup.directory);
      assert.deepEqual(installed.launchArgs, ['-jar', 'fabric-server-launch.jar']);
      assert.deepEqual({ sha1: source.sha1, size: source.size }, { sha1: hash(vanilla), size: vanilla.length });
      assert.equal(await readFile(path.join(staging, 'fabric-server-launch.jar'), 'utf8'), installer.toString());
      for (const preserved of ['mods', 'config', 'world', 'eula.txt', 'server.properties']) await assert.rejects(readFile(path.join(staging, preserved)), { code: 'ENOENT' });
      await mkdir(path.join(staging, 'libraries', 'prepared'), { recursive: true });
      await writeFile(path.join(staging, 'libraries', 'prepared', 'runtime.jar'), 'trusted-prepared-runtime');
    },
    seal: async () => {
      events.push('seal');
      assert.equal((await readInstalled(setup.directory))?.loader, 'Fabric');
      assert.equal(await readFile(path.join(setup.directory, 'libraries', 'prepared', 'runtime.jar'), 'utf8'), 'trusted-prepared-runtime');
      assert.equal(await readFile(path.join(setup.directory, 'mods', 'existing.jar'), 'utf8'), 'mod bytes');
      assert.equal(await readFile(path.join(setup.directory, 'world', 'level.dat'), 'utf8'), 'world bytes');
    },
  } }, { ...setup.dependencies, rename: async (source, destination) => {
    events.push(path.basename(String(source)) === 'minecraft' ? 'archive-original' : 'commit-staging');
    await rename(source, destination);
  } });
  await service.install(fabric);
  assert.deepEqual(events, ['prepare', 'archive-original', 'commit-staging', 'seal']);
});

test('failed trusted preparation never seals or replaces the original runtime', async t => {
  const setup = await fixture(t);
  let seals = 0;
  const service = new LoaderInstallation({ ...setup.options, hardening: { prepare: async () => { throw new Error('trusted preparation failed'); }, seal: async () => { seals++; } } }, setup.dependencies);
  await assert.rejects(service.install(fabric), /trusted preparation failed/);
  assert.equal(seals, 0);
  assert.equal(await readFile(path.join(setup.directory, 'fabric-server-launch.jar'), 'utf8'), 'previous launcher');
  assert.equal(await readFile(path.join(setup.directory, 'mods', 'existing.jar'), 'utf8'), 'mod bytes');
  assert.deepEqual(await readdir(path.join(setup.root, 'installation-snapshots')), []);
});

test('failed installation commit never publishes new trust over a restored original runtime', async t => {
  let moves = 0;
  let seals = 0;
  const setup = await fixture(t, { rename: async (source, destination) => { if (++moves === 2) throw new Error('commit failed'); await rename(source, destination); } });
  const service = new LoaderInstallation({ ...setup.options, hardening: { prepare: async () => undefined, seal: async () => { seals++; } } }, setup.dependencies);
  await assert.rejects(service.install(fabric), /commit failed/);
  assert.equal(seals, 0);
  assert.equal(await readFile(path.join(setup.directory, 'fabric-server-launch.jar'), 'utf8'), 'previous launcher');
  assert.equal(await readFile(path.join(setup.directory, 'world', 'level.dat'), 'utf8'), 'world bytes');
});

test('failed seal keeps the prior installation snapshot and reports failure rather than trusting the new runtime', async t => {
  const setup = await fixture(t);
  const service = new LoaderInstallation({ ...setup.options, hardening: { prepare: async () => undefined, seal: async () => { throw new Error('seal publication failed'); } } }, setup.dependencies);
  await assert.rejects(service.install(fabric), /seal publication failed/);
  assert.equal(await readFile(path.join(setup.directory, 'fabric-server-launch.jar'), 'utf8'), installer.toString());
  const snapshots = await readdir(path.join(setup.root, 'installation-snapshots'));
  assert.equal(snapshots.length, 1);
  assert.equal(await readFile(path.join(setup.root, 'installation-snapshots', snapshots[0]!, 'fabric-server-launch.jar'), 'utf8'), 'previous launcher');
  assert(!setup.logs.some(line => line.startsWith('Installation ready.')));
});

test('old executable root files are never preserved into a newly trusted runtime', async t => {
  const setup = await fixture(t);
  const unsafe = ['arbitrary.jar', 'minecraftforge-universal-1.6.4-9.11.1.1345.jar', 'injected.args', 'helper.sh', 'native.so', 'Payload.class'];
  for (const name of unsafe) await writeFile(path.join(setup.directory, name), 'previous untrusted runtime');
  let sealed = false;
  const service = new LoaderInstallation({ ...setup.options, hardening: { prepare: async () => undefined, seal: async () => {
    for (const name of unsafe) await assert.rejects(readFile(path.join(setup.directory, name)), { code: 'ENOENT' });
    sealed = true;
  } } }, setup.dependencies);
  await service.install(fabric);
  assert.equal(sealed, true);
  assert.equal(await readFile(path.join(setup.directory, 'mods', 'existing.jar'), 'utf8'), 'mod bytes');
});
