import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const repository = fileURLToPath(new URL('../', import.meta.url));
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'env-file': { type: 'string', default: path.join(repository, '.runtime/docker/compose.env') },
    'offline-snapshot': { type: 'string' },
  },
});
const [operation, destination] = positionals;
const services = ['app', 'minecraft'];
const composeArguments = ['compose', '--env-file', path.resolve(values['env-file']), '-f', path.join(repository, 'compose.yaml')];

function subprocess(command, args, stdio = 'inherit') {
  const child = spawn(command, args, { cwd: repository, stdio, env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`${command} exited with status ${code}.`)));
  });
  return { child, completed };
}

async function compose(args, capture = false) {
  const process = subprocess('docker', [...composeArguments, ...args], capture ? ['ignore', 'pipe', 'inherit'] : 'inherit');
  let output = '';
  if (capture) process.child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  await process.completed;
  return output;
}

async function assertStopped() {
  const output = await compose(['ps', '--status', 'running', '--format', 'json'], true);
  const rows = !output.trim() ? [] : output.trim().startsWith('[') ? JSON.parse(output) : output.trim().split('\n').map(line => JSON.parse(line));
  if (rows.some(row => services.includes(row.Service))) throw new Error('Stop the Docker app and Minecraft services before transferring their state.');
}

async function assertEmptyVolumes() {
  for (const service of services) {
    await compose(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'node', service, '/app/deploy/docker/restore-state.mjs', '--check']);
  }
}

async function inspectTree(directory) {
  const information = await lstat(directory);
  if (information.isSymbolicLink()) throw new Error(`Symbolic links cannot be imported: ${directory}`);
  if (information.isFile()) {
    if (information.nlink > 1) throw new Error(`Hard links cannot be imported: ${directory}`);
    return;
  }
  if (!information.isDirectory()) throw new Error(`Only regular files and directories can be imported: ${directory}`);
  for (const name of await readdir(directory)) await inspectTree(path.join(directory, name));
}

async function connect(source, target) {
  const copying = pipeline(source.child.stdout, target.child.stdin);
  try { await Promise.all([source.completed, target.completed, copying]); }
  catch (error) {
    source.child.kill('SIGTERM');
    target.child.kill('SIGTERM');
    await Promise.allSettled([source.completed, target.completed, copying]);
    throw error;
  }
}

function restore(service) {
  return subprocess('docker', [...composeArguments, 'run', '--rm', '--no-deps', '-T', '--entrypoint', 'node', service, '/app/deploy/docker/restore-state.mjs'], ['pipe', 'inherit', 'inherit']);
}

async function hash(filename) {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(filename)) digest.update(bytes);
  return digest.digest('hex');
}

async function importLocal() {
  if (!values['offline-snapshot']) throw new Error('Import requires --offline-snapshot pointing to a runtime copy made after stopping the original Minecraft server.');
  const snapshot = path.resolve(values['offline-snapshot']);
  const folders = { app: ['pack.json', 'ip-access.json'], minecraft: ['minecraft', 'backups', 'backup-objects'] };
  const root = await lstat(snapshot);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('The offline snapshot must be a real directory.');
  await access(path.join(snapshot, 'minecraft', 'server.properties'));
  for (const service of services) {
    const available = [];
    for (const name of folders[service]) {
      const filename = path.join(snapshot, name);
      try { await access(filename); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      await inspectTree(filename);
      available.push(name);
    }
    if (!available.length) throw new Error(`The offline snapshot does not contain ${service} state.`);
    folders[service] = available;
  }
  await assertEmptyVolumes();
  for (const service of services) {
    const metadata = process.platform === 'darwin' ? ['--no-xattrs', '--no-acls', '--no-fflags'] : ['--no-xattrs', '--no-acls', '--no-selinux'];
    const archive = subprocess('tar', [...metadata, '-C', snapshot, '-cpf', '-', ...folders[service]], ['ignore', 'pipe', 'inherit']);
    await connect(archive, restore(service));
  }
}

async function exportState() {
  if (!destination) throw new Error('Export requires a new backup directory path.');
  const configuration = JSON.parse(await compose(['config', '--format', 'json'], true));
  for (const name of ['app-state', 'minecraft-data']) {
    await subprocess('docker', ['volume', 'inspect', configuration.volumes[name].name], ['ignore', 'ignore', 'inherit']).completed;
  }
  const directory = path.resolve(destination);
  await mkdir(directory, { mode: 0o700 });
  const manifest = { format: 1, createdAt: new Date().toISOString(), files: {} };
  for (const service of services) {
    const filename = `${service}.tar`;
    const archive = subprocess('docker', [...composeArguments, 'run', '--rm', '--no-deps', '-T', '--entrypoint', 'tar', service, '-C', '/data', '-cpf', '-', '.'], ['ignore', 'pipe', 'inherit']);
    const copying = pipeline(archive.child.stdout, createWriteStream(path.join(directory, filename), { flags: 'wx', mode: 0o600 }));
    try { await Promise.all([archive.completed, copying]); }
    catch (error) { archive.child.kill('SIGTERM'); await Promise.allSettled([archive.completed, copying]); throw error; }
    manifest.files[filename] = await hash(path.join(directory, filename));
  }
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

async function restoreState() {
  if (!destination) throw new Error('Restore requires an exported backup directory path.');
  const directory = path.resolve(destination);
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.format !== 1) throw new Error('Unsupported backup format.');
  for (const service of services) {
    const filename = `${service}.tar`;
    if (await hash(path.join(directory, filename)) !== manifest.files?.[filename]) throw new Error(`Backup checksum mismatch: ${filename}`);
  }
  await assertEmptyVolumes();
  for (const service of services) {
    const target = restore(service);
    const copying = pipeline(createReadStream(path.join(directory, `${service}.tar`)), target.child.stdin);
    try { await Promise.all([target.completed, copying]); }
    catch (error) { target.child.kill('SIGTERM'); await Promise.allSettled([target.completed, copying]); throw error; }
  }
}

if (!['import-local', 'export', 'restore'].includes(operation) || positionals.length > 2) {
  throw new Error('Usage: node scripts/docker-state.mjs import-local --offline-snapshot PATH | export NEW_DIRECTORY | restore BACKUP_DIRECTORY');
}
await assertStopped();
if (operation === 'import-local') await importLocal();
if (operation === 'export') await exportState();
if (operation === 'restore') await restoreState();
console.log(`${operation} completed. No application or Minecraft process was started. Source data was preserved.`);
