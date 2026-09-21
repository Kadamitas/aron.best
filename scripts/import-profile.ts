import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { parseInstalledProfile } from '../server/modpack.js';

const metadataArgument = process.argv[2];
if (!metadataArgument || process.argv.length !== 3) throw new Error('Usage: node --import tsx scripts/import-profile.ts /absolute/path/to/minecraftinstance.json');
if (!path.isAbsolute(metadataArgument) || path.basename(metadataArgument) !== 'minecraftinstance.json') throw new Error('Pass the absolute path to the intended profile minecraftinstance.json file.');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const envPath = path.join(root, '.env');
const originalEnv = await readFile(envPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
  if (error.code === 'ENOENT') return '';
  throw error;
});
const env = parseEnv(originalEnv);
const runtime = path.resolve(root, env['RUNTIME_DIRECTORY'] ?? '.runtime');
if (!runtime.startsWith(`${root}${path.sep}`) || runtime === root || path.relative(root, runtime).startsWith('.git')) throw new Error('RUNTIME_DIRECTORY must be a private child directory of this project for profile import.');
const metadataStat = await lstat(metadataArgument);
if (!metadataStat.isFile() || metadataStat.isSymbolicLink() || metadataStat.size > 16 * 1024 * 1024) throw new Error('The profile metadata must be a regular file no larger than 16 MiB.');
const metadataBytes = await readFile(metadataArgument);
const { pack, files } = parseInstalledProfile(JSON.parse(metadataBytes.toString('utf8')));
const instance = await realpath(path.dirname(metadataArgument));
const sourceMods = path.join(instance, 'mods');
if ((await lstat(sourceMods)).isSymbolicLink()) throw new Error('The profile mods directory must not be a symbolic link.');
const statePath = path.join(runtime, 'pack.json');
if (await lstat(statePath).then(() => true, (error: NodeJS.ErrnoException) => {
  if (error.code === 'ENOENT') return false;
  throw error;
})) throw new Error('A workshop pack already exists. Preserve or migrate it explicitly before importing another profile.');
const serverDirectory = path.join(runtime, 'minecraft');
const targetMods = path.join(serverDirectory, 'mods');
if (await lstat(path.join(serverDirectory, 'world')).then(() => true, () => false)) throw new Error('The server already has a world. Use a backed-up server update instead of the initial profile importer.');
const existingMods = await readdir(targetMods).catch((error: NodeJS.ErrnoException) => {
  if (error.code === 'ENOENT') return [];
  throw error;
});
if (existingMods.length) throw new Error('The server mods directory is not empty. Stop the server and use an explicit migration instead of the initial importer.');
const reservedFiles = files.map((file) => file.fileName).sort();
const originalJars = (await readdir(sourceMods)).filter((name) => name.endsWith('.jar')).sort();
if (JSON.stringify(originalJars) !== JSON.stringify(reservedFiles)) throw new Error('The profile has untracked or disabled JARs. Review the profile and export a clean selection before importing.');
const configDirectory = path.join(instance, 'config');
const configs = await readdir(configDirectory).catch((error: NodeJS.ErrnoException) => {
  if (error.code === 'ENOENT') return [];
  throw error;
});
if (configs.length) throw new Error('The profile contains configuration overrides. Review and import its server configuration explicitly before copying mods.');

await mkdir(runtime, { recursive: true, mode: 0o700 });
const stage = path.join(runtime, `profile-import-${randomUUID()}`);
const stageMods = path.join(stage, 'mods');
await mkdir(stageMods, { recursive: true, mode: 0o700 });
const atomicWrite = async (target: string, value: string) => {
  const temporary = `${target}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, target); } finally { await rm(temporary, { force: true }); }
};
try {
  for (const file of files) {
    const source = path.join(sourceMods, file.fileName);
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== file.fileLength) throw new Error(`${file.fileName} does not match its recorded file size.`);
    const expected = file.hashes.find((hash) => hash.algo === 1)!;
    const sha1 = createHash('sha1');
    let length = 0;
    const verify = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      length += chunk.length;
      if (length > file.fileLength) { callback(new Error('Local mod changed while importing.')); return; }
      sha1.update(chunk); callback(null, chunk);
    } });
    await pipeline(createReadStream(source), verify, createWriteStream(path.join(stageMods, file.fileName), { flags: 'wx', mode: 0o600 }));
    if (length !== file.fileLength || sha1.digest('hex') !== expected.value.toLowerCase()) throw new Error(`${file.fileName} does not match its CurseForge SHA-1 checksum.`);
  }
  const currentEnv = await readFile(envPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  if (currentEnv !== originalEnv) throw new Error('.env changed during import. No server files were changed; run the importer again.');
  // All bytes were verified before changing the server's initial mod selection.
  await mkdir(serverDirectory, { recursive: true, mode: 0o700 });
  await rmdir(targetMods).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  await rename(stageMods, targetMods);
  await atomicWrite(statePath, `${JSON.stringify(pack, null, 2)}\n`);
  await atomicWrite(path.join(runtime, 'source-profile.json'), `${JSON.stringify({
    importedAt: new Date().toISOString(), sourceMetadataPath: metadataArgument,
    metadataSha256: createHash('sha256').update(metadataBytes).digest('hex'),
    minecraftVersion: pack.minecraftVersion, loader: pack.loader, loaderVersion: pack.loaderVersion,
    packVersion: pack.version, mods: files,
  }, null, 2)}\n`);
  const updated = { MINECRAFT_VERSION: pack.minecraftVersion, FABRIC_LOADER_VERSION: pack.loaderVersion };
  let nextEnv = originalEnv;
  for (const [key, value] of Object.entries(updated)) {
    const line = new RegExp(`^(?:export\\s+)?${key}\\s*=.*$`, 'gm');
    if (line.test(nextEnv)) nextEnv = nextEnv.replace(line, `${key}=${value}`);
    else nextEnv += `${nextEnv.endsWith('\n') || !nextEnv ? '' : '\n'}${key}=${value}\n`;
  }
  await atomicWrite(envPath, nextEnv);
  console.log(`Imported ${files.length} verified mod file(s), Minecraft ${pack.minecraftVersion}, Fabric ${pack.loaderVersion}.`);
  console.log('The original CurseForge profile was not modified. Private source metadata is in .runtime/source-profile.json.');
} finally {
  // This directory was created above for this invocation and contains only its staging files.
  await rm(stage, { recursive: true, force: true });
}
