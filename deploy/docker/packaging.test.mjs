import assert from 'node:assert/strict';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const actualRepository = fileURLToPath(new URL('../../', import.meta.url));
const composeSource = await readFile(path.join(actualRepository, 'compose.yaml'), 'utf8');
const variables = new Set([...composeSource.matchAll(/\$\{([A-Z_]+)/g)].map(match => match[1]));
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !variables.has(key)));
const composeAvailable = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;

function configuration(production = false) {
  return JSON.parse(execFileSync('docker', ['compose', '--env-file', '/dev/null', '-f', 'compose.yaml',
    ...(production ? ['-f', 'compose.public.yaml'] : []), '--profile', 'tls', 'config', '--format', 'json'],
  { cwd: actualRepository, env: environment, encoding: 'utf8' }));
}

test('every runtime drops host privileges and limits its resources', { skip: !composeAvailable }, () => {
  for (const service of Object.values(configuration().services)) {
    assert.equal(service.user, '10001:10001');
    assert.equal(service.read_only, true);
    assert.equal(service.init, true);
    assert.deepEqual(service.cap_drop, ['ALL']);
    assert.ok(service.security_opt.includes('no-new-privileges:true'));
    assert.ok(service.pids_limit > 0);
    assert.ok(service.mem_limit > 0);
    assert.ok(Number(service.cpus) > 0);
    assert.notEqual(service.privileged, true);
    assert.notEqual(service.network_mode, 'host');
    assert.ok(service.volumes.every(volume => volume.type === 'volume'));
  }
});

test('website, game data and credentials stay in separate containers', { skip: !composeAvailable }, () => {
  const { services, networks } = configuration();
  assert.deepEqual(services.app.volumes.map(volume => volume.source), ['app-state']);
  assert.deepEqual(services.minecraft.volumes.map(volume => volume.source), ['minecraft-data']);
  assert.deepEqual(services.minecraft.secrets.map(secret => secret.source), ['controller_token']);
  assert.ok(!services.minecraft.environment.FRIEND_ACCESS_TOKEN);
  assert.ok(!services.minecraft.environment.FRIEND_ACCESS_TOKEN_FILE);
  assert.equal(services.app.environment.CONTROLLER_URL, 'http://minecraft:3001');
  assert.equal(services.minecraft.environment.CONTAINER_SANDBOX, 'true');
  assert.equal(services.app.environment.IP_GRANTS, 'false');
  assert.equal(networks.control.internal, true);
  assert.equal(networks.web.internal, true);
  assert.deepEqual(Object.keys(services.app.networks).filter(name => name in services.minecraft.networks), ['control']);
  assert.deepEqual(Object.keys(services.app.networks).filter(name => name in services.caddy.networks), ['web']);
  assert.equal(services.app.environment.TRUST_PROXY, services.caddy.networks.web.ipv4_address);
});

test('preview ports stay local and production exposes only the intended listeners', { skip: !composeAvailable }, () => {
  const preview = configuration();
  assert.equal(preview.services.app.ports[0].host_ip, '127.0.0.1');
  assert.equal(preview.services.app.ports[0].published, '3300');
  assert.equal(preview.services.minecraft.ports[0].host_ip, '127.0.0.1');
  assert.equal(preview.services.minecraft.ports[0].published, '25575');
  assert.deepEqual(preview.services.caddy.profiles, ['tls']);
  const production = configuration(true);
  assert.equal(production.services.app.ports[0].host_ip, '127.0.0.1');
  assert.equal(production.services.minecraft.ports.length, 1);
  assert.equal(production.services.minecraft.ports[0].published, '25565');
  assert.equal(production.services.minecraft.ports[0].host_ip, '0.0.0.0');
  assert.ok(!production.services.caddy.profiles?.length);
  assert.deepEqual(production.services.caddy.ports.map(port => port.published), ['80', '443']);
  assert.equal(production.services.app.environment.PUBLIC_ORIGIN, 'https://mc.modpack.aron.best');
  assert.ok(Object.values(production.services).flatMap(service => service.ports ?? []).every(port => ![3001, 25566].includes(port.target)));
});

test('preparation preserves existing invitations and never prints credentials', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aron-docker-prepare-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'scripts'));
  const script = path.join(directory, 'scripts/docker-prepare.mjs');
  await copyFile(path.join(actualRepository, 'scripts/docker-prepare.mjs'), script);
  const token = 'original-invitation-secret-for-packaging-test';
  await writeFile(path.join(directory, '.env'), `FRIEND_ACCESS_TOKEN=${token}\nCURSEFORGE_UPLOAD_TOKEN=upload-test-secret\n`);
  const first = execFileSync(process.execPath, [script], { encoding: 'utf8' });
  const secrets = path.join(directory, '.runtime/docker/secrets');
  assert.equal(await readFile(path.join(secrets, 'friend_access_token'), 'utf8'), token);
  assert.equal(await readFile(path.join(secrets, 'curseforge_upload_token'), 'utf8'), 'upload-test-secret');
  assert.ok(!first.includes(token) && !first.includes('upload-test-secret'));
  assert.equal((await lstat(secrets)).mode & 0o777, 0o700);
  assert.equal((await lstat(path.join(secrets, 'controller_token'))).mode & 0o777, 0o444);
  const controllerToken = await readFile(path.join(secrets, 'controller_token'), 'utf8');
  await writeFile(path.join(directory, '.env'), 'FRIEND_ACCESS_TOKEN=a-new-invitation-secret-for-packaging-test\n');
  execFileSync(process.execPath, [script]);
  assert.equal(await readFile(path.join(secrets, 'friend_access_token'), 'utf8'), token);
  assert.equal(await readFile(path.join(secrets, 'controller_token'), 'utf8'), controllerToken);
});

test('preparation rejects a redirected runtime directory', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aron-docker-symlink-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'scripts'));
  await mkdir(path.join(directory, 'outside'));
  const script = path.join(directory, 'scripts/docker-prepare.mjs');
  await copyFile(path.join(actualRepository, 'scripts/docker-prepare.mjs'), script);
  await symlink(path.join(directory, 'outside'), path.join(directory, '.runtime'));
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Expected a real directory/);
});
