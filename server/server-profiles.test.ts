import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { ServerProfiles, type ServerProfilesDependencies } from './server-profiles.js';
import type { InstalledServer, ServerTarget } from './loader-installation.js';

const target: ServerTarget = { minecraftVersion: '26.3', loader: 'Fabric', loaderVersion: '0.19.5' };
const alternate: ServerTarget = { minecraftVersion: '1.20.1', loader: 'Fabric', loaderVersion: '0.18.4' };
const json = async (file: string, value: unknown) => writeFile(file, JSON.stringify(value));
const readJson = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
const absent = async (file: string) => assert.rejects(access(file), { code: 'ENOENT' });

async function provision(directory: string, requested = target): Promise<void> {
  const minecraft = path.join(directory, 'minecraft');
  for (const name of ['world', 'mods', 'config']) await mkdir(path.join(minecraft, name), { recursive: true });
  for (const name of ['backups', 'installation-snapshots']) await mkdir(path.join(directory, name), { recursive: true });
  const installed: InstalledServer = { ...requested, javaMajor: requested.minecraftVersion.startsWith('26.') ? 25 : 17, launchArgs: ['-jar', 'fabric-server-launch.jar'], installedAt: new Date().toISOString() };
  await json(path.join(minecraft, 'installation.json'), installed);
  await writeFile(path.join(minecraft, 'world', 'level.dat'), requested.minecraftVersion);
  await writeFile(path.join(minecraft, 'mods', 'sample.jar'), requested.loaderVersion);
  await json(path.join(minecraft, 'config', 'sample.json'), requested);
}

async function fixture(t: TestContext, dependencies: Partial<ServerProfilesDependencies> = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'aron-profile-unit-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await provision(root);
  await writeFile(path.join(root, 'controller-token.txt'), 'untouched control data');
  const options = { directory: root, fallbackTarget: target };
  const profiles = new ServerProfiles(options, dependencies);
  await profiles.initialize();
  return { root, options, profiles, registry: path.join(root, 'server-profiles.json'), journal: path.join(root, 'server-profiles-operation.json') };
}

test('initialization keeps the original server in place and records one persistent legacy profile', async t => {
  const setup = await fixture(t);
  const state = await setup.profiles.list();
  assert.equal(state.limit, 5);
  assert.equal(state.profiles.length, 1);
  assert.equal(state.profiles[0]!.name, 'Main server');
  assert.equal(setup.profiles.activeDirectory(), setup.root);
  assert.equal(setup.profiles.requiresProfileBinding(), false);
  const registry = await readJson(setup.registry);
  assert.equal(registry.profiles[0].location, 'legacy');
  const restarted = new ServerProfiles(setup.options);
  await restarted.initialize();
  assert.equal(restarted.activeId(), state.activeId);
  assert.equal(await readFile(path.join(setup.root, 'minecraft', 'world', 'level.dat'), 'utf8'), target.minecraftVersion);
  assert.equal(await readFile(path.join(setup.root, 'controller-token.txt'), 'utf8'), 'untouched control data');
});

test('new profiles use permanent isolated roots and selecting preserves each world and its actual version', async t => {
  const setup = await fixture(t);
  const original = setup.profiles.activeId();
  let provisioned = '';
  const created = await setup.profiles.create('  Classic world  ', async directory => { provisioned = directory; await provision(directory, alternate); });
  assert.equal(created.name, 'Classic world');
  assert.equal(created.minecraftVersion, alternate.minecraftVersion);
  assert.equal(setup.profiles.activeId(), original);
  assert.equal(provisioned, path.join(setup.root, 'server-profiles', created.id));
  assert.equal(setup.profiles.directoryFor(created.id), provisioned);
  assert.equal(setup.profiles.requiresProfileBinding(), true);
  await setup.profiles.select(created.id);
  assert.equal(setup.profiles.activeDirectory(), provisioned);
  await writeFile(path.join(provisioned, 'minecraft', 'world', 'level.dat'), 'new world changes');
  await setup.profiles.select(original);
  assert.equal(await readFile(path.join(setup.root, 'minecraft', 'world', 'level.dat'), 'utf8'), target.minecraftVersion);
  assert.equal(await readFile(path.join(provisioned, 'minecraft', 'world', 'level.dat'), 'utf8'), 'new world changes');
  await setup.profiles.select(created.id);
  const restarted = new ServerProfiles(setup.options);
  await restarted.initialize();
  assert.equal(restarted.activeId(), created.id);
  assert.equal(restarted.activeDirectory(), provisioned);
});

test('profile listing refreshes actual installation metadata after version changes', async t => {
  const setup = await fixture(t);
  await provision(setup.root, alternate);
  assert.equal((await setup.profiles.list()).profiles[0]!.minecraftVersion, alternate.minecraftVersion);
  await json(path.join(setup.root, 'minecraft', 'installation.json'), { minecraftVersion: '1.21.1', loaderVersion: '0.16.0', installerVersion: '1.0.0' });
  const legacy = (await setup.profiles.list()).profiles[0]!;
  assert.equal(legacy.minecraftVersion, '1.21.1');
  assert.equal(legacy.loader, 'Fabric');
  assert.equal(legacy.loaderVersion, '0.16.0');
});

test('concurrent creates enforce five total slots before invoking the rejected provision callbacks', async t => {
  const setup = await fixture(t);
  let calls = 0;
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => setup.profiles.create(`World ${index}`, async directory => { calls++; await provision(directory); })));
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 4);
  assert.equal(calls, 4);
  assert.equal((await setup.profiles.list()).profiles.length, 5);
  assert.equal((await readdir(path.join(setup.root, 'server-profiles'))).length, 4);
});

test('committed profile listings remain responsive during long provisioning', async t => {
  const setup = await fixture(t);
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const creation = setup.profiles.create('Installing', async directory => { enter(); await waiting; await provision(directory); });
  await entered;
  try {
    const listing = await Promise.race([setup.profiles.list(), new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Profile listing blocked behind installation.')), 500); timer.unref(); })]);
    assert.equal(listing.profiles.length, 1);
    assert.equal(listing.activeId, setup.profiles.activeId());
  } finally { release(); await creation; }
  assert.equal((await setup.profiles.list()).profiles.length, 2);
});

test('names and ids are validated without permitting caller-selected paths', async t => {
  const setup = await fixture(t);
  for (const name of ['', ' ', 'x'.repeat(65), 'control\u0000name', 'line\nbreak']) {
    await assert.rejects(setup.profiles.create(name, provision), /between 1 and 64/);
    await assert.rejects(setup.profiles.rename(setup.profiles.activeId(), name), /between 1 and 64/);
  }
  for (const id of ['../minecraft', '/tmp/arbitrary', 'minecraft', randomUUID()]) {
    assert.throws(() => setup.profiles.directoryFor(id), /Choose a saved server|does not exist/);
    await assert.rejects(setup.profiles.select(id));
    await assert.rejects(setup.profiles.remove(id));
  }
  await setup.profiles.rename(setup.profiles.activeId(), '  Friends  ');
  const restarted = new ServerProfiles(setup.options);
  await restarted.initialize();
  assert.equal((await restarted.list()).profiles[0]!.name, 'Friends');
});

test('removal retains a recoverable managed root and never disables profile binding', async t => {
  const setup = await fixture(t);
  const created = await setup.profiles.create('Second', provision);
  const original = setup.profiles.activeId();
  await assert.rejects(setup.profiles.remove(original), /Switch to another/);
  const directory = setup.profiles.directoryFor(created.id);
  await setup.profiles.remove(created.id);
  await absent(directory);
  const recovered = path.join(setup.root, 'deleted-server-profiles', created.id);
  assert.equal(await readFile(path.join(recovered, 'runtime', 'minecraft', 'world', 'level.dat'), 'utf8'), target.minecraftVersion);
  assert.equal((await readJson(path.join(recovered, 'profile.json'))).name, 'Second');
  assert.equal((await setup.profiles.list()).profiles.length, 1);
  assert.equal(setup.profiles.requiresProfileBinding(), true);
  await assert.rejects(setup.profiles.remove(original), /at least one/);
  const restarted = new ServerProfiles(setup.options);
  await restarted.initialize();
  assert.equal(restarted.requiresProfileBinding(), true);
});

test('deleting the inactive legacy profile moves only its Minecraft data and leaves the runtime root intact', async t => {
  const setup = await fixture(t);
  const original = setup.profiles.activeId();
  const created = await setup.profiles.create('Replacement', directory => provision(directory, alternate));
  await setup.profiles.select(created.id);
  await writeFile(path.join(setup.root, 'backups', 'backup.zip'), 'legacy backup');
  await writeFile(path.join(setup.root, 'installation-snapshots', 'receipt.json'), 'legacy snapshot');
  await setup.profiles.remove(original);
  assert.equal(await readFile(path.join(setup.root, 'controller-token.txt'), 'utf8'), 'untouched control data');
  assert.equal((await readJson(setup.registry)).activeId, created.id);
  assert.equal(await readFile(path.join(setup.profiles.activeDirectory(), 'minecraft', 'world', 'level.dat'), 'utf8'), alternate.minecraftVersion);
  const recovered = path.join(setup.root, 'deleted-server-profiles', original);
  for (const name of ['minecraft', 'backups', 'installation-snapshots']) { await absent(path.join(setup.root, name)); await access(path.join(recovered, name)); }
  const restarted = new ServerProfiles(setup.options);
  await restarted.initialize();
  assert.equal(restarted.activeId(), created.id);
  await absent(path.join(setup.root, 'minecraft'));
});

test('failed provisioning preserves partial files without registering a new slot', async t => {
  const setup = await fixture(t);
  let directory = '';
  await assert.rejects(setup.profiles.create('Failed install', async destination => {
    directory = destination;
    await writeFile(path.join(destination, 'partial.jar'), 'downloaded bytes');
    throw new Error('Installer unavailable');
  }), /Installer unavailable/);
  assert.equal((await setup.profiles.list()).profiles.length, 1);
  assert.equal(setup.profiles.requiresProfileBinding(), false);
  await absent(directory);
  const recovered = path.join(setup.root, 'deleted-server-profiles', path.basename(directory));
  assert.equal(await readFile(path.join(recovered, 'runtime', 'partial.jar'), 'utf8'), 'downloaded bytes');
  assert.equal((await readJson(path.join(recovered, 'profile.json'))).incomplete, true);
  await absent(setup.journal);
});

test('linked folders and hard-linked files cannot be selected, deleted, or registered', async t => {
  const setup = await fixture(t);
  const created = await setup.profiles.create('Untrusted', provision);
  const directory = setup.profiles.directoryFor(created.id);
  await symlink(setup.root, path.join(directory, 'minecraft', 'config', 'outside'));
  await assert.rejects(setup.profiles.select(created.id), /symbolic links or hard links/);
  await assert.rejects(setup.profiles.remove(created.id), /symbolic links or hard links/);
  await rm(path.join(directory, 'minecraft', 'config', 'outside'));
  await link(path.join(setup.root, 'controller-token.txt'), path.join(directory, 'minecraft', 'config', 'linked.txt'));
  await assert.rejects(setup.profiles.select(created.id), /symbolic links or hard links/);
  await assert.rejects(setup.profiles.create('Linked install', async destination => {
    await mkdir(path.join(destination, 'minecraft'));
    await symlink(setup.root, path.join(destination, 'minecraft', 'outside'));
  }), /symbolic links or hard links/);
  assert.equal((await setup.profiles.list()).profiles.length, 2);
  assert.equal(await readFile(path.join(setup.root, 'controller-token.txt'), 'utf8'), 'untouched control data');
});

test('managed parent and Minecraft directory symlinks fail closed', async t => {
  const setup = await fixture(t);
  await symlink(setup.root, path.join(setup.root, 'server-profiles'));
  await assert.rejects(setup.profiles.create('Escape', provision), /regular directory/);
  await rm(path.join(setup.root, 'server-profiles'));
  const created = await setup.profiles.create('Saved', provision);
  const minecraft = path.join(setup.profiles.directoryFor(created.id), 'minecraft');
  await rename(minecraft, `${minecraft}-saved`);
  await symlink(path.join(setup.root, 'minecraft'), minecraft);
  await assert.rejects(setup.profiles.select(created.id), /regular directory/);
  await assert.rejects(setup.profiles.list(), /regular directory/);
  assert.equal(setup.profiles.activeDirectory(), setup.root);
});

test('invalid registries and linked metadata are rejected without rewriting them', async t => {
  const setup = await fixture(t);
  const initial = await readJson(setup.registry);
  for (const invalid of [{ ...initial, activeId: randomUUID() }, { ...initial, profiles: [...initial.profiles, initial.profiles[0]] }, { ...initial, profiles: [{ ...initial.profiles[0], location: '/tmp' }] }, { ...initial, extra: true }]) {
    await json(setup.registry, invalid);
    await assert.rejects(new ServerProfiles(setup.options).initialize(), /registry is invalid/);
    assert.deepEqual(await readJson(setup.registry), invalid);
  }
  await rm(setup.registry);
  await symlink(path.join(setup.root, 'controller-token.txt'), setup.registry);
  await assert.rejects(new ServerProfiles(setup.options).initialize(), /symbolic links or hard links/);
  assert.equal(await readFile(path.join(setup.root, 'controller-token.txt'), 'utf8'), 'untouched control data');
});

test('missing registries never silently forget existing saved servers', async t => {
  const setup = await fixture(t);
  await setup.profiles.create('Saved', provision);
  await rm(setup.registry);
  await assert.rejects(new ServerProfiles(setup.options).initialize(), /folders exist without a registry/);
  await absent(setup.registry);
});

test('a failed legacy directory move rolls back earlier moves and preserves every registered server', async t => {
  let fail = false;
  const setup = await fixture(t, { rename: async (source, destination) => {
    if (fail && path.basename(String(source)) === 'backups') { fail = false; throw new Error('Synthetic move failure'); }
    return rename(source, destination);
  } });
  const original = setup.profiles.activeId();
  const created = await setup.profiles.create('Active', provision);
  await setup.profiles.select(created.id);
  fail = true;
  await assert.rejects(setup.profiles.remove(original), /Synthetic move failure/);
  for (const name of ['minecraft', 'backups', 'installation-snapshots']) await access(path.join(setup.root, name));
  assert.equal((await setup.profiles.list()).profiles.length, 2);
  await absent(setup.journal);
  await absent(path.join(setup.root, 'deleted-server-profiles', original));
});

test('a failed registry commit rolls back a deleted root and leaves no temporary metadata behind', async t => {
  let fail = false;
  const setup = await fixture(t, { rename: async (source, destination) => {
    if (fail && path.basename(String(destination)) === 'server-profiles.json') { fail = false; throw new Error('Synthetic registry failure'); }
    return rename(source, destination);
  } });
  const created = await setup.profiles.create('Saved', provision);
  const directory = setup.profiles.directoryFor(created.id);
  fail = true;
  await assert.rejects(setup.profiles.remove(created.id), /Synthetic registry failure/);
  await access(path.join(directory, 'minecraft', 'world', 'level.dat'));
  assert.equal((await setup.profiles.list()).profiles.length, 2);
  assert(!(await readdir(setup.root)).some(name => name.endsWith('.tmp')));
  await absent(setup.journal);
});

test('a ready creation recovers a failed registry commit as one successful durable creation', async t => {
  let fail = false;
  const setup = await fixture(t, { rename: async (source, destination) => {
    if (fail && path.basename(String(destination)) === 'server-profiles.json') { fail = false; throw new Error('Synthetic registry failure'); }
    return rename(source, destination);
  } });
  fail = true;
  const created = await setup.profiles.create('Saved', provision);
  assert.equal((await setup.profiles.list()).profiles.length, 2);
  assert.equal((await readJson(setup.registry)).profiles[1].id, created.id);
  await absent(setup.journal);
});

test('restart rolls back partially moved legacy deletions when the registry still contains the profile', async t => {
  const setup = await fixture(t);
  const original = setup.profiles.activeId();
  const created = await setup.profiles.create('Active', provision);
  await setup.profiles.select(created.id);
  const stored = (await readJson(setup.registry)).profiles.find((profile: { id: string }) => profile.id === original);
  const bundle = path.join(setup.root, 'deleted-server-profiles', original);
  await mkdir(bundle, { recursive: true });
  await json(path.join(bundle, 'profile.json'), { id: original });
  await json(setup.journal, { operation: 'delete', profile: stored, moves: ['minecraft', 'backups', 'installation-snapshots'] });
  await rename(path.join(setup.root, 'minecraft'), path.join(bundle, 'minecraft'));
  const restarted = new ServerProfiles(setup.options);
  await restarted.initialize();
  assert.equal((await restarted.list()).profiles.length, 2);
  await access(path.join(setup.root, 'minecraft', 'world', 'level.dat'));
  await absent(bundle);
  await absent(setup.journal);
});

test('restart completes committed deletions without moving recovered data back into service', async t => {
  const setup = await fixture(t);
  const created = await setup.profiles.create('Saved', provision);
  const registry = await readJson(setup.registry);
  const stored = registry.profiles.find((profile: { id: string }) => profile.id === created.id);
  const bundle = path.join(setup.root, 'deleted-server-profiles', created.id);
  await mkdir(bundle, { recursive: true });
  await json(setup.journal, { operation: 'delete', profile: stored, moves: ['runtime'] });
  await rename(setup.profiles.directoryFor(created.id), path.join(bundle, 'runtime'));
  registry.profiles = registry.profiles.filter((profile: { id: string }) => profile.id !== created.id);
  await json(setup.registry, registry);
  const restarted = new ServerProfiles(setup.options);
  await restarted.initialize();
  assert.equal((await restarted.list()).profiles.length, 1);
  await access(path.join(bundle, 'runtime', 'minecraft', 'world', 'level.dat'));
  await absent(path.join(setup.root, 'server-profiles', created.id));
  await absent(setup.journal);
});

test('restart registers ready creations but quarantines interrupted incomplete provisioning', async t => {
  const setup = await fixture(t);
  const ready = { id: randomUUID(), name: 'Ready', location: 'managed' };
  await provision(path.join(setup.root, 'server-profiles', ready.id), alternate);
  await json(setup.journal, { operation: 'create', profile: ready, phase: 'ready' });
  const restarted = new ServerProfiles(setup.options);
  await restarted.initialize();
  assert.equal((await restarted.list()).profiles.find(profile => profile.id === ready.id)?.minecraftVersion, alternate.minecraftVersion);
  assert.equal(restarted.requiresProfileBinding(), true);
  const partial = { id: randomUUID(), name: 'Partial', location: 'managed' };
  const directory = path.join(setup.root, 'server-profiles', partial.id);
  await mkdir(directory);
  await writeFile(path.join(directory, 'partial.bin'), 'partial bytes');
  await json(setup.journal, { operation: 'create', profile: partial, phase: 'provisioning' });
  const afterInterruption = new ServerProfiles(setup.options);
  await afterInterruption.initialize();
  assert.equal((await afterInterruption.list()).profiles.length, 2);
  await absent(directory);
  assert.equal(await readFile(path.join(setup.root, 'deleted-server-profiles', partial.id, 'runtime', 'partial.bin'), 'utf8'), 'partial bytes');
  await absent(setup.journal);
});

test('ambiguous deletion recovery fails closed and preserves both copies and the journal', async t => {
  const setup = await fixture(t);
  const created = await setup.profiles.create('Saved', provision);
  const stored = (await readJson(setup.registry)).profiles.find((profile: { id: string }) => profile.id === created.id);
  const bundle = path.join(setup.root, 'deleted-server-profiles', created.id);
  await provision(path.join(bundle, 'runtime'), alternate);
  await json(setup.journal, { operation: 'delete', profile: stored, moves: ['runtime'] });
  const restarted = new ServerProfiles(setup.options);
  await assert.rejects(restarted.initialize(), /ambiguous/);
  assert.throws(() => restarted.activeId(), /not initialized/);
  await access(path.join(bundle, 'runtime', 'minecraft', 'world', 'level.dat'));
  await access(path.join(setup.profiles.directoryFor(created.id), 'minecraft', 'world', 'level.dat'));
  await access(setup.journal);
});

test('untrusted recovery paths are rejected before touching any runtime directory', async t => {
  const setup = await fixture(t);
  const created = await setup.profiles.create('Saved', provision);
  const stored = (await readJson(setup.registry)).profiles.find((profile: { id: string }) => profile.id === created.id);
  for (const moves of [['../minecraft'], ['minecraft'], ['runtime', 'runtime']]) {
    await json(setup.journal, { operation: 'delete', profile: stored, moves });
    await assert.rejects(new ServerProfiles(setup.options).initialize(), /invalid/);
    await access(path.join(setup.profiles.directoryFor(created.id), 'minecraft', 'world', 'level.dat'));
    await access(setup.journal);
  }
});
