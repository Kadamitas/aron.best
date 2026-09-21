import { spawnSync } from 'node:child_process';
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectRouterIdentity, inspectRouterNetwork, routerNetwork } from '../deploy/router-mappings.mjs';
import { loadAgent, unloadAgent } from '../deploy/launch-agents.mjs';

const projectRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const options = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const option = process.argv[index];
  if (['--install', '--stop', '--help', '--local-only', '--with-router'].includes(option)) options.set(option, true);
  else if (['--node', '--caddy', '--nginx', '--upnpc'].includes(option) && process.argv[index + 1]) options.set(option, process.argv[++index]);
  else throw new Error(`Unrecognized or incomplete option: ${option}`);
}
if (options.has('--help')) {
  console.log('Prepare and validate: node scripts/install-services.mjs [--node /path] [--caddy /path] [--nginx /path]\nInstall and start user LaunchAgents: add --install\nOmit Caddy registration: --local-only\nPrepare router lease renewal: --with-router [--upnpc /path]\nStop registered user agents, including router renewal: --stop');
  process.exit(0);
}
if (options.has('--install') && options.has('--stop')) throw new Error('Choose either --install or --stop.');
if ((options.has('--install') || options.has('--stop')) && process.platform !== 'darwin') throw new Error('Service registration requires macOS.');
if (Number(process.versions.node.split('.')[0]) !== 26) throw new Error('Run this script with Node.js 26.');

const serviceNames = options.has('--local-only') ? ['api', 'nginx'] : ['api', 'nginx', 'caddy'];
if (options.has('--with-router')) serviceNames.push('router');
const labelFor = (name) => `best.aron.${name}`;
const agentsDirectory = join(homedir(), 'Library', 'LaunchAgents');
const launchDomain = `gui/${process.getuid?.()}`;
const xml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const nginxString = (value) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$')}"`;

function command(binary, arguments_, { allowFailure = false, environment = {} } = {}) {
  const result = spawnSync(binary, arguments_, { cwd: projectRoot, env: { ...process.env, ...environment }, encoding: 'utf8' });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (!allowFailure && (result.error || result.status !== 0)) throw new Error(`${binary} failed: ${result.error?.message ?? `exit ${result.status}`}`);
  return result;
}

function checkAgentOwnership(name) {
  const targetPath = join(agentsDirectory, `${labelFor(name)}.plist`);
  if (existsSync(targetPath) && !readFileSync(targetPath, 'utf8').includes(`<string>${xml(projectRoot)}</string>`)) {
    throw new Error(`${targetPath} belongs to another checkout. Stop and inspect it before replacing it.`);
  }
  return targetPath;
}

if (options.has('--stop')) {
  for (const name of [...new Set([...serviceNames, 'router'])].reverse()) {
    const agentPath = checkAgentOwnership(name);
    if (!existsSync(agentPath)) continue;
    await unloadAgent(`${launchDomain}/${labelFor(name)}`);
  }
  console.log('Stopped registered agents. Their plist files remain and will load at next login. See docs/hosting.md to uninstall them.');
  process.exit(0);
}

function executable(name) {
  const suppliedPath = options.get(`--${name}`);
  const candidates = suppliedPath ? [suppliedPath] : name === 'node' ? [process.execPath] : (process.env.PATH ?? '').split(':').map((directory) => join(directory, name));
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return stableExecutablePath(realpathSync(candidate));
    } catch { /* Try the next executable directory. */ }
  }
  throw new Error(`Cannot find ${name}. Install it or provide --${name} with an absolute executable path.`);
}

// A Homebrew upgrade deletes the old Cellar version directory, which would leave
// launchd pointing at a binary that no longer exists. Homebrew keeps a per-formula
// "opt" link that always resolves to the installed version, so prefer that path
// whenever it exists and currently resolves to the same file.
function stableExecutablePath(resolvedPath) {
  const cellar = resolvedPath.match(/^(\/opt\/homebrew|\/usr\/local)\/Cellar\/([^/]+)\/[^/]+\/(.+)$/);
  if (!cellar) return resolvedPath;
  const optPath = `${cellar[1]}/opt/${cellar[2]}/${cellar[3]}`;
  try {
    if (realpathSync(optPath) === resolvedPath) return optPath;
  } catch { /* No opt link for this formula; keep the resolved path. */ }
  return resolvedPath;
}

const binaries = Object.fromEntries(['node', 'nginx', 'caddy'].map((name) => [name, executable(name)]));
if (options.has('--with-router')) binaries.upnpc = executable('upnpc');
const nodeMajor = command(binaries.node, ['-p', 'process.versions.node.split(".")[0]']).stdout.trim();
if (nodeMajor !== '26') throw new Error('The service Node executable must be version 26.');
const deploymentDirectory = join(projectRoot, '.runtime', 'deploy');
const logDirectory = join(projectRoot, '.runtime', 'logs');
const caddyEnvironment = {
  XDG_DATA_HOME: join(projectRoot, '.runtime', 'caddy', 'data'),
  XDG_CONFIG_HOME: join(projectRoot, '.runtime', 'caddy', 'config'),
};
for (const directory of [deploymentDirectory, logDirectory, ...Object.values(caddyEnvironment), join(deploymentDirectory, 'body'), join(deploymentDirectory, 'proxy')]) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}

function render(template, values) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`Missing template value ${key}.`);
    return values[key];
  });
}

copyFileSync(join(projectRoot, 'deploy', 'Caddyfile.template'), join(deploymentDirectory, 'Caddyfile'));
copyFileSync(join(projectRoot, 'deploy', 'proxy.conf'), join(deploymentDirectory, 'proxy.conf'));
const nginxConfiguration = render(readFileSync(join(projectRoot, 'deploy', 'nginx.conf.template'), 'utf8'), {
  NGINX_PID: nginxString(join(deploymentDirectory, 'nginx.pid')),
  NGINX_TEMP: nginxString(join(deploymentDirectory, 'body')),
  NGINX_PROXY_TEMP: nginxString(join(deploymentDirectory, 'proxy')),
  PROXY_INCLUDE: nginxString(join(deploymentDirectory, 'proxy.conf')),
});
writeFileSync(join(deploymentDirectory, 'nginx.conf'), nginxConfiguration, { mode: 0o600 });
const settings = {
  projectRoot,
  logDirectory,
  services: {
    api: {
      binary: binaries.node,
      arguments: ['--env-file-if-exists=.env', 'dist/server/index.js'],
      environment: { NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '3000' },
    },
    nginx: {
      binary: binaries.nginx,
      arguments: ['-e', 'stderr', '-p', `${deploymentDirectory}/`, '-c', join(deploymentDirectory, 'nginx.conf')],
      environment: {},
    },
    caddy: {
      binary: binaries.caddy,
      arguments: ['run', '--config', join(deploymentDirectory, 'Caddyfile'), '--adapter', 'caddyfile'],
      environment: caddyEnvironment,
    },
  },
};
const settingsPath = join(deploymentDirectory, 'service-settings.json');
if (options.has('--with-router')) {
  await inspectRouterNetwork();
  const routerSettingsPath = join(deploymentDirectory, 'router-settings.json');
  const identity = await inspectRouterIdentity();
  if (existsSync(routerSettingsPath)) {
    const previousIdentity = JSON.parse(readFileSync(routerSettingsPath, 'utf8')).identity;
    if (JSON.stringify(previousIdentity) !== JSON.stringify(identity)) throw new Error('Previously pinned router identity changed. Inspect it and archive the old router-settings.json before preparing a replacement.');
  }
  writeFileSync(routerSettingsPath, `${JSON.stringify({ ...routerNetwork, identity, upnpcBinary: binaries.upnpc, statusPath: join(deploymentDirectory, 'router-status.json') }, null, 2)}\n`, { mode: 0o600 });
  settings.services.router = { binary: binaries.node, arguments: [join(projectRoot, 'deploy', 'router-mappings.mjs'), routerSettingsPath], environment: {} };
} else if (existsSync(settingsPath)) {
  const previous = JSON.parse(readFileSync(settingsPath, 'utf8'));
  if (previous.projectRoot === projectRoot && previous.services?.router) settings.services.router = previous.services.router;
}
writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
for (const name of serviceNames) {
  const content = render(readFileSync(join(projectRoot, 'deploy', 'launch-agent.plist.template'), 'utf8'), Object.fromEntries(Object.entries({
    LABEL: labelFor(name), NODE_BINARY: binaries.node,
    SERVICE_RUNNER: join(projectRoot, 'deploy', 'run-service.mjs'),
    SERVICE_SETTINGS: settingsPath, SERVICE_NAME: name, PROJECT_ROOT: projectRoot,
  }).map(([key, value]) => [key, xml(value)])));
  const plistPath = join(deploymentDirectory, `${labelFor(name)}.plist`);
  writeFileSync(plistPath, content, { mode: 0o600 });
  if (process.platform === 'darwin') command('/usr/bin/plutil', ['-lint', plistPath]);
}
command(binaries.nginx, ['-t', '-e', 'stderr', '-p', `${deploymentDirectory}/`, '-c', join(deploymentDirectory, 'nginx.conf')]);
command(binaries.caddy, ['validate', '--config', join(deploymentDirectory, 'Caddyfile'), '--adapter', 'caddyfile'], { environment: caddyEnvironment });
console.log(`Prepared validated service configuration in ${deploymentDirectory}.`);

if (options.has('--install')) {
  if (!existsSync(join(projectRoot, 'dist', 'server', 'index.js'))) throw new Error('Run npm run build before installing services.');
  for (const name of serviceNames) checkAgentOwnership(name);
  mkdirSync(agentsDirectory, { recursive: true, mode: 0o700 });
  for (const name of serviceNames) {
    const installedPath = checkAgentOwnership(name);
    await unloadAgent(`${launchDomain}/${labelFor(name)}`);
    copyFileSync(join(deploymentDirectory, `${labelFor(name)}.plist`), installedPath);
    await loadAgent(launchDomain, installedPath, `${launchDomain}/${labelFor(name)}`);
  }
  console.log(`Registered ${serviceNames.join(', ')} user agents. Check .runtime/logs. ${options.has('--local-only') ? 'Caddy will be enabled after DNS and port forwarding are ready.' : 'Verify HTTPS from outside your home network.'}`);
}
