import assert from 'node:assert/strict';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const actualRepository = fileURLToPath(new URL('../../', import.meta.url));
const composeSource = await readFile(path.join(actualRepository, 'compose.yaml'), 'utf8');
const publicComposeSource = await readFile(path.join(actualRepository, 'compose.public.yaml'), 'utf8');
const variables = new Set([...`${composeSource}\n${publicComposeSource}`.matchAll(/\$\{([A-Z_]+)/g)].map(match => match[1]));
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
    assert.ok((service.volumes ?? []).every(volume => volume.type === 'volume'));
  }
});

test('website, game data and credentials stay in separate containers', { skip: !composeAvailable }, () => {
  const { services, networks } = configuration();
  assert.deepEqual(services.app.volumes.map(volume => volume.source), ['app-state']);
  assert.deepEqual(services.minecraft.volumes.map(volume => volume.source), ['minecraft-data', 'runtime-trust']);
  assert.deepEqual(services.minecraft.secrets.map(secret => secret.source), ['controller_token']);
  assert.ok(!services.minecraft.environment.FRIEND_ACCESS_TOKEN);
  assert.ok(!services.minecraft.environment.FRIEND_ACCESS_TOKEN_FILE);
  assert.equal(services.app.environment.CONTROLLER_URL, 'http://minecraft:3001');
  assert.equal(services.minecraft.environment.CONTAINER_SANDBOX, 'true');
  assert.equal(services.minecraft.environment.RUNTIME_TRUST_DIRECTORY, '/runtime-trust');
  assert.notEqual(services.minecraft.environment.RUNTIME_TRUST_DIRECTORY, services.minecraft.environment.RUNTIME_DIRECTORY);
  assert.deepEqual(services.minecraft.volumes.map(volume => volume.target), ['/data', '/runtime-trust']);
  assert.ok(Object.entries(services).filter(([name]) => name !== 'minecraft').every(([, service]) => !(service.volumes ?? []).some(volume => volume.source === 'minecraft-data' || volume.source === 'runtime-trust')));
  assert.equal(services.app.environment.IP_GRANTS, 'false');
  assert.equal(networks.control.internal, true);
  assert.equal(networks.web.internal, true);
  assert.equal(networks.game.internal, true);
  for (const name of ['control', 'game']) {
    assert.equal(networks[name].driver_opts['com.docker.network.bridge.gateway_mode_ipv4'], 'isolated');
    assert.equal(networks[name].driver_opts['com.docker.network.bridge.gateway_mode_ipv6'], 'isolated');
  }
  assert.deepEqual(Object.keys(services.minecraft.networks).sort(), ['control', 'game']);
  assert.deepEqual(Object.keys(services.app.networks).filter(name => name in services.minecraft.networks), ['control']);
  assert.deepEqual(Object.keys(services.app.networks).filter(name => name in services.caddy.networks), ['web']);
  assert.equal(services.app.environment.TRUST_PROXY, services.caddy.networks.web.ipv4_address);
});

test('network edge owns game ingress without game data, credentials or controller access', { skip: !composeAvailable }, () => {
  const { services } = configuration();
  const edge = services['network-edge'];
  assert.deepEqual(edge.volumes ?? [], []);
  assert.deepEqual(edge.secrets ?? [], []);
  assert.deepEqual(Object.keys(edge.networks).sort(), ['edge', 'game']);
  assert.deepEqual(Object.keys(services.minecraft.networks).filter(name => name in edge.networks), ['game']);
  assert.deepEqual(Object.keys(services.app.networks).filter(name => name in edge.networks), []);
  assert.deepEqual(services.minecraft.ports ?? [], []);
  assert.equal(services.minecraft.environment.RUNTIME_PROXY_ADDRESS, edge.networks.game.ipv4_address);
  assert.equal(services.minecraft.environment.NODE_USE_ENV_PROXY, '1');
  assert.equal(services.minecraft.environment.HTTPS_PROXY, `http://${edge.networks.game.ipv4_address}:3128`);
  assert.equal(services.minecraft.environment.HTTP_PROXY, services.minecraft.environment.HTTPS_PROXY);
  assert.deepEqual(services.minecraft.extra_hosts, ['api.minecraftservices.com', 'api.mojang.com', 'discovery.minecraftservices.com', 'sessionserver.mojang.com'].map(host => `${host}=${edge.networks.game.ipv4_address}`));
  assert.equal(edge.sysctls['net.ipv4.ip_unprivileged_port_start'], '0');
  assert.deepEqual(edge.ports.map(port => port.target), [25565]);
  assert.deepEqual(edge.extra_hosts ?? [], []);
  assert.equal(services.minecraft.depends_on['network-edge'].condition, 'service_healthy');
  assert.ok(edge.healthcheck.test.some(argument => argument.includes('http://127.0.0.1:3130/health')));
});

test('preview ports stay local and production exposes only the intended listeners', { skip: !composeAvailable }, () => {
  const preview = configuration();
  assert.equal(preview.services.app.ports[0].host_ip, '127.0.0.1');
  assert.equal(preview.services.app.ports[0].published, '3300');
  assert.equal(preview.services['network-edge'].ports[0].host_ip, '127.0.0.1');
  assert.equal(preview.services['network-edge'].ports[0].published, '25575');
  assert.deepEqual(preview.services.caddy.profiles, ['tls']);
  const production = configuration(true);
  assert.equal(production.services.app.ports[0].host_ip, '127.0.0.1');
  assert.deepEqual(production.services.minecraft.ports ?? [], []);
  assert.equal(production.services['network-edge'].ports.length, 1);
  assert.equal(production.services['network-edge'].ports[0].published, '25565');
  assert.equal(production.services['network-edge'].ports[0].host_ip, '0.0.0.0');
  assert.ok(!production.services.caddy.profiles?.length);
  assert.deepEqual(production.services.caddy.ports.map(port => port.published), ['80', '443']);
  assert.equal(production.services.app.environment.PUBLIC_ORIGIN, 'https://mc.modpack.aron.best');
  assert.ok(Object.values(production.services).flatMap(service => service.ports ?? []).every(port => ![3001, 3128, 3129, 3130, 25566].includes(port.target)));
});

test('Minecraft image packages an immutable sandbox launcher and independent trust storage', async () => {
  const dockerfile = await readFile(path.join(actualRepository, 'Dockerfile'), 'utf8');
  const minecraft = dockerfile.split('FROM runtime AS minecraft\n')[1].split('\nFROM runtime AS network-edge')[0];
  assert.match(minecraft, /COPY --from=sandbox-build \/build\/minecraft-sandbox \/usr\/local\/bin\/minecraft-sandbox/);
  assert.match(minecraft, /install -d -o 10001 -g 10001 -m 0700 \/runtime-trust/);
  assert.match(minecraft, /\/usr\/local\/share\/minecraft-java\.json/);
  assert.match(minecraft, /USER 10001:10001/);
  const edge = dockerfile.split('FROM runtime AS network-edge\n')[1].split('\nFROM ')[0];
  assert.match(edge, /CMD \["node", "dist\/server\/network-edge-index\.js"\]/);
  assert.doesNotMatch(edge, /COPY --from=java|VOLUME|USER root/);
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
