import { totalmem } from 'node:os';
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const repository = fileURLToPath(new URL('../', import.meta.url));
const destination = path.join(repository, '.runtime', 'docker');
const source = process.argv[2] ? path.resolve(process.argv[2]) : path.join(repository, '.env');
const environment = await readFile(source, 'utf8').then(parseEnv).catch(error => {
  if (error.code === 'ENOENT' && !process.argv[2]) return {};
  throw error;
});

async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const information = await lstat(directory);
  if (!information.isDirectory() || information.isSymbolicLink()) throw new Error(`Expected a real directory: ${directory}`);
  await chmod(directory, 0o700);
}

async function createFile(filename, content, mode) {
  try { await writeFile(filename, content, { flag: 'wx', mode }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const information = await lstat(filename);
    if (!information.isFile() || information.isSymbolicLink()) throw new Error(`Refusing an unusual existing file: ${filename}`);
  }
}

function value(name, fallback) {
  const result = environment[name] || fallback;
  if (!/^[A-Za-z0-9_.:/,@-]+$/.test(result)) throw new Error(`Invalid ${name} in the source environment.`);
  return result;
}

await privateDirectory(path.join(repository, '.runtime'));
await privateDirectory(destination);
await privateDirectory(path.join(destination, 'secrets'));

const invitation = environment.FRIEND_ACCESS_TOKEN || randomBytes(32).toString('hex');
if (invitation.length < 32 || invitation.length > 256 || /\s/.test(invitation)) {
  throw new Error('The existing invitation token must contain 32 to 256 non-whitespace characters.');
}
for (const [name, content] of Object.entries({
  friend_access_token: invitation,
  controller_token: randomBytes(32).toString('hex'),
  curseforge_api_key: environment.CURSEFORGE_API_KEY || '',
  curseforge_upload_token: environment.CURSEFORGE_UPLOAD_TOKEN || '',
})) {
  await createFile(path.join(destination, 'secrets', name), content, 0o444);
}

const gameMemoryLimitMiB = Math.floor(totalmem() / 1048576 * 0.8);
const gameHeapMiB = Math.max(2048, gameMemoryLimitMiB - 1536);

const settings = {
  COMPOSE_PROJECT_NAME: 'aron-best',
  PORTFOLIO_HOST: 'aron.best',
  PORTFOLIO_ALIAS: 'www.aron.best',
  WORKSHOP_HOST: 'mc.modpack.aron.best',
  ACME_EMAIL: 'agmlodkowski@gmail.com',
  MINECRAFT_ADDRESS: value('MINECRAFT_ADDRESS', 'mc.aron.best'),
  MINECRAFT_VERSION: value('MINECRAFT_VERSION', '26.3'),
  FABRIC_LOADER_VERSION: value('FABRIC_LOADER_VERSION', '0.19.5'),
  // The game may use up to 80% of this Mac's memory. The JVM heap stays 1.5 GiB
  // under the container limit for off-heap memory; the Docker VM must be sized above it.
  MINECRAFT_MEMORY_MB: value('MINECRAFT_MEMORY_MB', String(gameHeapMiB)),
  MINECRAFT_MEMORY_LIMIT: `${gameMemoryLimitMiB}m`,
  MINECRAFT_CPUS: '6',
  MINECRAFT_START_TIMEOUT_SECONDS: value('MINECRAFT_START_TIMEOUT_SECONDS', '600'),
  MINECRAFT_AUTOSTART: 'false',
  BOOTSTRAP_MINECRAFT: 'true',
  EULA_ACCEPTED: 'true',
  IP_GRANTS: 'false',
  APP_PUBLISHED_PORT: '3300',
  MINECRAFT_PUBLISHED_PORT: '25575',
  MINECRAFT_PUBLIC_PORT: '25565',
  HTTP_BIND_ADDRESS: '0.0.0.0',
  MINECRAFT_BIND_ADDRESS: '0.0.0.0',
  WEB_SUBNET: '172.30.1.0/24',
  CADDY_ADDRESS: '172.30.1.2',
  APP_ADDRESS: '172.30.1.3',
  ...(environment.CURSEFORGE_PROJECT_ID ? { CURSEFORGE_PROJECT_ID: value('CURSEFORGE_PROJECT_ID', '') } : {}),
};
await createFile(path.join(destination, 'compose.env'), Object.entries(settings).map(([key, entry]) => `${key}=${entry}\n`).join(''), 0o600);
console.log(`Docker configuration is ready in ${destination}. Existing files were preserved. No containers were started.`);
