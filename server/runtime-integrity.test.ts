import assert from 'node:assert/strict';
import { chmod, link, mkdir, mkdtemp, open, readFile, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { classifyRuntimePath, RuntimeIntegrity, RuntimeIntegrityError, type RuntimeIntegrityOptions } from './runtime-integrity.js';
import type { InstalledServer } from './loader-installation.js';

const installation: InstalledServer = { minecraftVersion: '26.3', loader: 'Fabric', loaderVersion: '0.19.5', javaMajor: 25, launchArgs: ['-jar', 'fabric-server-launch.jar'], installedAt: '2026-09-21T12:00:00.000Z' };

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'aron-runtime-integrity-')));
  const writableDirectory = path.join(root, 'data');
  const directory = path.join(writableDirectory, 'minecraft');
  const trustDirectory = path.join(root, 'trusted');
  const options: RuntimeIntegrityOptions = { directory, writableDirectory, trustDirectory, identity: 'fixture-server' };
  const write = async (relative: string, contents: string) => {
    const destination = path.join(directory, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents);
    return destination;
  };
  await write('installation.json', JSON.stringify(installation));
  await write('fabric-server-launch.jar', 'trusted-launcher');
  await write('server.jar', 'trusted-vanilla');
  await write('libraries/example/runtime.jar', 'trusted-library');
  await write('.fabric/server/mapped.jar', 'trusted-remapped-server');
  await write('.fabric/processedMods/cache.jar', 'untrusted-generated-mod-cache');
  await write('mods/example.jar', 'user-selected-mod');
  await write('config/settings.json', '{}');
  const integrity = new RuntimeIntegrity(options);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, directory, writableDirectory, trustDirectory, options, integrity, write, manifest: path.join(trustDirectory, 'fixture-server.json') };
}

test('runtime seals persist SHA256 outside writable data and verify without enrolling changes', async t => {
  const setup = await fixture(t);
  await assert.rejects(setup.integrity.verify(), RuntimeIntegrityError);
  assert.deepEqual(await setup.integrity.seal(), installation);
  const before = await readFile(setup.manifest, 'utf8');
  const manifest = JSON.parse(before);
  assert.equal(manifest.identity, 'fixture-server');
  assert(manifest.files.every((entry: { sha256: string }) => /^[a-f0-9]{64}$/.test(entry.sha256)));
  assert.deepEqual(manifest.files.map((entry: { path: string }) => entry.path), ['.fabric/server/mapped.jar', 'fabric-server-launch.jar', 'installation.json', 'libraries/example/runtime.jar', 'server.jar']);
  await setup.write('mods/example.jar', 'another-user-selected-mod');
  await setup.write('config/settings.json', '{"changed":true}');
  await setup.write('.fabric/processedMods/new-cache.jar', 'regenerated-cache');
  assert.deepEqual(await setup.integrity.verify(), installation);
  assert.equal(await readFile(setup.manifest, 'utf8'), before);
  await setup.write('libraries/example/runtime.jar', 'tampered-runtime-library');
  await assert.rejects(setup.integrity.verify(), /integrity verification failed/);
  assert.equal(await readFile(setup.manifest, 'utf8'), before);
  await setup.integrity.seal();
  assert.deepEqual(await setup.integrity.verify(), installation);
});

test('runtime integrity detects additions, removals, jar tampering and loader argument changes', async t => {
  const setup = await fixture(t);
  await setup.integrity.seal();
  const extra = await setup.write('libraries/extra.jar', 'unapproved-runtime');
  await assert.rejects(setup.integrity.verify(), /integrity verification failed/);
  await unlink(extra);
  await rename(path.join(setup.directory, 'server.jar'), path.join(setup.directory, 'missing-server.saved'));
  await assert.rejects(setup.integrity.verify(), /integrity verification failed/);
  await rename(path.join(setup.directory, 'missing-server.saved'), path.join(setup.directory, 'server.jar'));
  await setup.write('fabric-server-launch.jar', 'changed-launcher');
  await assert.rejects(setup.integrity.verify(), /integrity verification failed/);
  await setup.write('fabric-server-launch.jar', 'trusted-launcher');
  await setup.write('user_jvm_args.txt', '-javaagent:mods/injected.jar');
  await assert.rejects(setup.integrity.verify(), /integrity verification failed/);
  await unlink(path.join(setup.directory, 'user_jvm_args.txt'));
  assert.deepEqual(await setup.integrity.verify(), installation);
});

test('runtime integrity rejects unsafe, unsupported and altered descriptors', async t => {
  const setup = await fixture(t);
  await setup.integrity.seal();
  for (const launchArgs of [['-jar', '../outside.jar'], ['@config/args.txt'], ['-jar', '/tmp/outside.jar'], ['-jar', 'fabric-server-launch.jar', '-javaagent:evil.jar']]) {
    await setup.write('installation.json', JSON.stringify({ ...installation, launchArgs }));
    await assert.rejects(setup.integrity.verify(), /descriptor/);
    await assert.rejects(setup.integrity.seal(), /descriptor/);
  }
  await setup.write('installation.json', JSON.stringify({ ...installation, loaderVersion: '0.20.0' }));
  await assert.rejects(setup.integrity.verify(), /integrity verification failed/);
  await setup.write('installation.json', JSON.stringify({ ...installation, arbitrary: 'field' }));
  await assert.rejects(setup.integrity.seal(), /descriptor/);
  await setup.write('installation.json', 'x'.repeat(16 * 1024 + 1));
  await assert.rejects(setup.integrity.seal(), /size limit/);
});

test('runtime trust storage refuses writable placement, weak permissions and tampered manifests', async t => {
  const setup = await fixture(t);
  assert.throws(() => new RuntimeIntegrity({ ...setup.options, trustDirectory: path.join(setup.writableDirectory, 'trust') }), /outside Minecraft-writable/);
  assert.throws(() => new RuntimeIntegrity({ ...setup.options, trustDirectory: setup.root }), /outside Minecraft-writable/);
  assert.throws(() => new RuntimeIntegrity({ ...setup.options, identity: '../escape' }), /identity/);
  await setup.integrity.seal();
  await chmod(setup.trustDirectory, 0o755);
  await assert.rejects(setup.integrity.verify(), /private to the controller/);
  await chmod(setup.trustDirectory, 0o700);
  await chmod(setup.manifest, 0o644);
  await assert.rejects(setup.integrity.verify(), /private to the controller/);
  await chmod(setup.manifest, 0o600);
  const original = await readFile(setup.manifest, 'utf8');
  const source = JSON.parse(original);
  for (const modified of [
    { ...source, identity: 'other-server' },
    { ...source, files: [...source.files, source.files[0]] },
    { ...source, files: [{ ...source.files[0], path: '../secret' }, ...source.files.slice(1)] },
    { ...source, files: [{ ...source.files[0], path: '.fabric/processedMods/evil.jar' }, ...source.files.slice(1)] },
  ]) {
    await writeFile(setup.manifest, JSON.stringify(modified));
    await assert.rejects(setup.integrity.verify(), RuntimeIntegrityError);
  }
  await writeFile(setup.manifest, original);
  assert.deepEqual(await setup.integrity.verify(), installation);
});

test('runtime integrity refuses symbolic links, hard links and replaced runtime roots', async t => {
  const setup = await fixture(t);
  await setup.integrity.seal();
  const outside = path.join(setup.root, 'outside.jar');
  await writeFile(outside, 'outside-runtime');
  const linked = path.join(setup.directory, 'libraries', 'linked.jar');
  await symlink(outside, linked);
  await assert.rejects(setup.integrity.verify(), /regular files/);
  await unlink(linked);
  await link(outside, linked);
  await assert.rejects(setup.integrity.verify(), /regular files/);
  await unlink(linked);
  await rename(path.join(setup.directory, 'libraries'), path.join(setup.directory, 'old-libraries'));
  await symlink(path.join(setup.directory, 'old-libraries'), path.join(setup.directory, 'libraries'));
  await assert.rejects(setup.integrity.verify(), RuntimeIntegrityError);
  await unlink(path.join(setup.directory, 'libraries'));
  await rename(path.join(setup.directory, 'old-libraries'), path.join(setup.directory, 'libraries'));
  const actualTrust = path.join(setup.root, 'actual-trust');
  await rename(setup.trustDirectory, actualTrust);
  await symlink(actualTrust, setup.trustDirectory);
  await assert.rejects(setup.integrity.verify(), RuntimeIntegrityError);
});

test('runtime scans are bounded and reject unrecognized Fabric caches', async t => {
  const setup = await fixture(t);
  await setup.integrity.seal();
  for (const limits of [{ files: 2 }, { bytes: 8 }, { fileBytes: 8 }, { depth: 1 }, { entries: 2 }]) {
    await assert.rejects(new RuntimeIntegrity({ ...setup.options, limits }).verify(), /limit|nested/);
  }
  await setup.write('.fabric/future-cache/injected.jar', 'unreviewed-cache');
  await assert.rejects(setup.integrity.verify(), /unsupported loader cache/);
  assert.equal(classifyRuntimePath('.fabric/server/intermediary.jar'), 'protected');
  assert.equal(classifyRuntimePath('.fabric/processedMods/remapped.jar'), 'mutable-cache');
  assert.equal(classifyRuntimePath('.fabric/unknown/entry.jar'), 'unsupported');
  assert.equal(classifyRuntimePath('libraries/forge/unix_args.txt'), 'protected');
  assert.equal(classifyRuntimePath('.quilt/remapped.jar'), 'protected');
  assert.equal(classifyRuntimePath('mods/example.jar'), 'unmanaged');
  assert.throws(() => classifyRuntimePath('libraries/../mods/evil.jar'), RuntimeIntegrityError);
});

test('integrity trust identities support explicit staging-to-final publication without path binding', async t => {
  const setup = await fixture(t);
  await setup.integrity.seal();
  const final = path.join(setup.writableDirectory, 'relocated-minecraft');
  await rename(setup.directory, final);
  assert.deepEqual(await new RuntimeIntegrity({ ...setup.options, directory: final }).verify(), installation);
  await assert.rejects(new RuntimeIntegrity({ ...setup.options, directory: final, identity: 'different-slot' }).verify(), /missing/);
});

test('sealed Forge argument files must correspond to the trusted launch descriptor', async t => {
  const setup = await fixture(t);
  const forge: InstalledServer = { ...installation, minecraftVersion: '1.20.1', loader: 'Forge', loaderVersion: '47.4.0', javaMajor: 17, launchArgs: ['@libraries/net/minecraftforge/forge/1.20.1-47.4.0/unix_args.txt'] };
  await setup.write('installation.json', JSON.stringify(forge));
  await assert.rejects(setup.integrity.seal(), /launcher is missing/);
  await setup.write(forge.launchArgs[0]!.slice(1), '-cp libraries/example/runtime.jar\nexample.Main');
  await setup.integrity.seal();
  assert.deepEqual(await setup.integrity.verify(), forge);
  await setup.write(forge.launchArgs[0]!.slice(1), '-javaagent:mods/evil.jar');
  await assert.rejects(setup.integrity.verify(), /integrity verification failed/);
});

test('runtime verification refuses a library modified concurrently with its descriptor-anchored scan', async t => {
  const setup = await fixture(t);
  const library = path.join(setup.directory, 'libraries', 'large.jar');
  await writeFile(library, Buffer.alloc(8 * 1024 * 1024, 1));
  await setup.integrity.seal();
  const writer = await open(library, 'r+');
  let running = true;
  const changes = (async () => {
    const bytes = Buffer.alloc(64 * 1024, 2);
    let offset = 0;
    while (running) {
      await writer.write(bytes, 0, bytes.length, offset);
      offset = (offset + bytes.length) % (8 * 1024 * 1024);
    }
  })();
  try { await assert.rejects(setup.integrity.verify(), RuntimeIntegrityError); }
  finally { running = false; await changes; await writer.close(); }
});
