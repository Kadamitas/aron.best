import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const projects = ['aron-best-transfer-test', 'aron-best-transfer-test-restored', 'aron-best-transfer-test-malicious'];

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, { cwd: repository, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`${binary} failed: ${result.stderr || result.error?.message || result.stdout}`);
  return result.stdout;
}

function archiveEntry(name, { type = '0', link = '', data = '' } = {}) {
  const bytes = Buffer.from(data);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write('0000600\0', 100, 8);
  header.write('0023421\0', 108, 8);
  header.write('0023421\0', 116, 8);
  header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124, 12);
  header.write('00000000000\0', 136, 12);
  header.fill(32, 148, 156);
  header.write(type, 156, 1);
  header.write(link, 157, 100);
  header.write('ustar\0', 257, 6);
  header.write('00', 263, 2);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}

test('Docker state transfers preserve data and reject unsafe restores', { skip: process.env.DOCKER_INTEGRATION !== 'true', timeout: 180000 }, async t => {
  for (const project of projects) {
    assert.equal(command('docker', ['volume', 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Name}}']).trim(), '', `${project} already has volumes; inspect them before this test.`);
    assert.equal(command('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]).trim(), '', `${project} already has containers; inspect them before this test.`);
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aron-docker-transfer-'));
  const environmentFile = path.join(directory, 'compose.env');
  const secrets = path.join(directory, 'secrets');
  await mkdir(secrets, { mode: 0o700 });
  await writeFile(environmentFile, '', { mode: 0o600 });
  for (const name of ['controller_token', 'friend_access_token', 'curseforge_api_key', 'curseforge_upload_token']) {
    await writeFile(path.join(secrets, name), `${name}-synthetic-testing-token-1234567890`, { mode: 0o444 });
  }
  const environment = project => ({ ...process.env, COMPOSE_PROJECT_NAME: project, DOCKER_SECRETS_DIRECTORY: secrets,
    WEB_SUBNET: `10.239.${81 + projects.indexOf(project)}.0/24`, CADDY_ADDRESS: `10.239.${81 + projects.indexOf(project)}.2` });
  const compose = (project, args) => command('docker', ['compose', '--env-file', environmentFile, '-f', 'compose.yaml', ...args], { env: environment(project) });
  const state = (project, args, expectedSuccess = true) => {
    const result = spawnSync(process.execPath, ['scripts/docker-state.mjs', ...args, '--env-file', environmentFile], { cwd: repository, env: environment(project), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (expectedSuccess) assert.equal(result.status, 0, result.stderr || result.stdout);
    else assert.notEqual(result.status, 0, 'Operation unexpectedly succeeded.');
    return result;
  };
  const inspect = (project, service, script) => JSON.parse(compose(project, ['run', '--rm', '--no-deps', '-T', '--entrypoint', 'node', service, '-e', script]));
  t.after(async () => {
    for (const project of projects) compose(project, ['down', '--volumes', '--remove-orphans']);
    await rm(directory, { recursive: true, force: true });
  });

  const snapshot = path.join(directory, 'offline-snapshot');
  await mkdir(path.join(snapshot, 'minecraft/world'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(snapshot, 'backups'), { mode: 0o700 });
  const fixtures = {
    'pack.json': '{"name":"Synthetic transfer fixture"}\n',
    'ip-access.json': '{"grants":[]}\n',
    'minecraft/server.properties': 'server-port=25566\nonline-mode=true\n',
    'minecraft/world/level.dat': 'synthetic-world-bytes\0\u0001\u0002',
    'backups/fixture.txt': 'synthetic prior backup\n',
  };
  for (const [filename, content] of Object.entries(fixtures)) await writeFile(path.join(snapshot, filename), content, { mode: 0o600 });
  state(projects[0], ['import-local', '--offline-snapshot', snapshot]);
  const inspectApp = "const f=require('node:fs');console.log(JSON.stringify({pack:f.readFileSync('/data/pack.json','utf8'),grants:f.readFileSync('/data/ip-access.json','utf8'),entries:f.readdirSync('/data')}))";
  const inspectGame = "const f=require('node:fs');console.log(JSON.stringify({properties:f.readFileSync('/data/minecraft/server.properties','utf8'),world:f.readFileSync('/data/minecraft/world/level.dat','utf8'),backup:f.readFileSync('/data/backups/fixture.txt','utf8'),entries:f.readdirSync('/data')}))";
  const importedApp = inspect(projects[0], 'app', inspectApp);
  const importedGame = inspect(projects[0], 'minecraft', inspectGame);
  assert.equal(importedApp.pack, fixtures['pack.json']);
  assert.equal(importedGame.world, fixtures['minecraft/world/level.dat']);
  const deniedOverwrite = state(projects[0], ['import-local', '--offline-snapshot', snapshot], false);
  assert.match(deniedOverwrite.stderr, /empty volume/);
  assert.deepEqual(inspect(projects[0], 'app', inspectApp), importedApp);

  const legacyId = '11111111-1111-4111-8111-111111111111';
  const savedIds = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555'];
  const deletedId = '66666666-6666-4666-8666-666666666666';
  const profileFixtures = {
    'server-profiles.json': JSON.stringify({ version: 1, activeId: savedIds[2], bindingRequired: true, profiles: [
      { id: legacyId, name: 'Original imported server', location: 'legacy' },
      ...savedIds.map((id, index) => ({ id, name: `Saved server ${index + 1}`, location: 'managed' })),
    ] }),
    'installation-snapshots/before-version-change/world/level.dat': 'retained-original-installation-world\0',
    [`deleted-server-profiles/${deletedId}/profile.json`]: JSON.stringify({ id: deletedId, name: 'Deleted server fixture', location: 'managed', removedAt: '2026-09-21T12:00:00.000Z' }),
    [`deleted-server-profiles/${deletedId}/runtime/minecraft/world/level.dat`]: 'recoverable-deleted-world\0\u0003',
    [`deleted-server-profiles/${deletedId}/runtime/minecraft/config/settings.json`]: '{"recovery":"retained"}\n',
    [`deleted-server-profiles/${deletedId}/runtime/backups/deleted-server.txt`]: 'recoverable-server-backup\n',
  };
  for (const [index, id] of savedIds.entries()) {
    const folder = `server-profiles/${id}`;
    Object.assign(profileFixtures, {
      [`${folder}/minecraft/installation.json`]: JSON.stringify({ minecraftVersion: '1.21.1', loader: 'Fabric', loaderVersion: '0.18.4', javaMajor: 21, launchArgs: ['-jar', 'fabric-server-launch.jar'], installedAt: '2026-09-21T12:00:00.000Z' }),
      [`${folder}/minecraft/fabric-server-launch.jar`]: `synthetic-launcher-${index}, never executed`,
      [`${folder}/minecraft/world/level.dat`]: `independent-saved-world-${index}\0\u0001`,
      [`${folder}/minecraft/config/settings.json`]: JSON.stringify({ savedSlot: index, value: `configuration-${index}` }),
      [`${folder}/minecraft/mods/fixture.jar`]: `independent-mod-bytes-${index}`,
      [`${folder}/backups/snapshot.txt`]: `independent-backup-${index}`,
      [`${folder}/installation-snapshots/previous/world/level.dat`]: `independent-installation-snapshot-${index}`,
    });
  }
  compose(projects[0], ['run', '--rm', '--no-deps', '-T', '--entrypoint', 'node', 'minecraft', '-e', `const fs=require('node:fs'),path=require('node:path');for(const [name,contents] of Object.entries(${JSON.stringify(profileFixtures)})){const file=path.join('/data',name);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,contents,{flag:'wx',mode:0o600});}`]);
  const inspectProfiles = `const fs=require('node:fs');console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(Object.keys(profileFixtures))}.map(name=>[name,fs.readFileSync('/data/'+name,'utf8')]))))`;
  assert.deepEqual(inspect(projects[0], 'minecraft', inspectProfiles), profileFixtures);
  const portableGame = inspect(projects[0], 'minecraft', inspectGame);

  const backup = path.join(directory, 'backup');
  state(projects[0], ['export', backup]);
  state(projects[1], ['restore', backup]);
  assert.deepEqual(inspect(projects[1], 'app', inspectApp), importedApp);
  assert.deepEqual(inspect(projects[1], 'minecraft', inspectGame), portableGame);
  const restoredProfiles = inspect(projects[1], 'minecraft', inspectProfiles);
  assert.deepEqual(restoredProfiles, profileFixtures);
  const restoredRegistry = JSON.parse(restoredProfiles['server-profiles.json']);
  assert.equal(restoredRegistry.activeId, savedIds[2]);
  assert.equal(restoredRegistry.bindingRequired, true);
  assert.equal(restoredRegistry.profiles.length, 5);
  const restoredSelection = inspect(projects[1], 'minecraft', "(async()=>{const {ServerProfiles}=await import('./dist/server/server-profiles.js');const profiles=new ServerProfiles({directory:'/data',fallbackTarget:{minecraftVersion:'26.3',loader:'Fabric',loaderVersion:'0.19.5'}});await profiles.initialize();console.log(JSON.stringify({directory:profiles.activeDirectory(),binding:profiles.requiresProfileBinding(),...(await profiles.list())}));})().catch(error=>{console.error(error);process.exitCode=1;})");
  assert.equal(restoredSelection.activeId, savedIds[2]);
  assert.equal(restoredSelection.directory, `/data/server-profiles/${savedIds[2]}`);
  assert.equal(restoredSelection.binding, true);
  assert.equal(restoredSelection.profiles.length, 5);
  assert.equal(restoredSelection.profiles.find(profile => profile.id === savedIds[2]).minecraftVersion, '1.21.1');
  t.diagnostic('Synthetic app metadata, original world and backup, all five server slots, active selection, profile binding, independent mods/config, installation snapshots and deleted-server recovery survived export and restore. Existing-volume overwrite was refused.');

  const malicious = path.join(directory, 'malicious');
  await mkdir(malicious, { mode: 0o700 });
  await copyFile(path.join(backup, 'minecraft.tar'), path.join(malicious, 'minecraft.tar'));
  const minecraftHash = createHash('sha256').update(await readFile(path.join(malicious, 'minecraft.tar'))).digest('hex');
  const attacks = [
    { name: 'symlink', entry: archiveEntry('world-link', { type: '2', link: '/tmp/escaped' }), error: /link or special file/ },
    { name: 'hardlink', entry: archiveEntry('world-link', { type: '1', link: 'pack.json' }), error: /link or special file/ },
    { name: 'traversal', entry: archiveEntry('../escaped', { data: 'must not be extracted' }), error: /unsafe file path/ },
    { name: 'absolute path', entry: archiveEntry('/tmp/escaped', { data: 'must not be extracted' }), error: /unsafe file path/ },
    { name: 'FIFO', entry: archiveEntry('pipe', { type: '6' }), error: /link or special file/ },
  ];
  for (const attack of attacks) {
    const archive = Buffer.concat([archiveEntry('pack.json', { data: 'must not be published' }), attack.entry, Buffer.alloc(1024)]);
    await writeFile(path.join(malicious, 'app.tar'), archive, { mode: 0o600 });
    await writeFile(path.join(malicious, 'manifest.json'), JSON.stringify({ format: 1, files: { 'app.tar': createHash('sha256').update(archive).digest('hex'), 'minecraft.tar': minecraftHash } }), { mode: 0o600 });
    const rejected = state(projects[2], ['restore', malicious], false);
    assert.match(rejected.stderr, attack.error, attack.name);
    assert.deepEqual(inspect(projects[2], 'app', "console.log(JSON.stringify(require('node:fs').readdirSync('/data')))"), [], attack.name);
    t.diagnostic(`Rejected ${attack.name} archive and left destination empty.`);
  }
});
