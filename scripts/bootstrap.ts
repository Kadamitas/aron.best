import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { downloadArtifact } from '../server/download.js';
try { process.loadEnvFile('.env'); } catch {}
const minecraftVersion = process.env['MINECRAFT_VERSION'] ?? '26.3';
const directory = path.resolve(process.env['RUNTIME_DIRECTORY'] ?? '.runtime', 'minecraft');
await mkdir(directory, { recursive: true, mode: 0o700 });
const launcherPath = path.join(directory, 'fabric-server-launch.jar');
const installed = await access(launcherPath).then(() => true, () => false);
if (installed) {
  const metadata = JSON.parse(await readFile(path.join(directory, 'installation.json'), 'utf8')) as { minecraftVersion: string; loaderVersion: string };
  if (metadata.minecraftVersion !== minecraftVersion || (process.env['FABRIC_LOADER_VERSION'] && metadata.loaderVersion !== process.env['FABRIC_LOADER_VERSION'])) throw new Error('The installed launcher targets another game or loader version. Back up the server and perform an explicit migration.');
}
if (!installed) {
  const response = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(minecraftVersion)}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Fabric version lookup failed (${response.status}).`);
  const versions = await response.json() as { loader: { version: string; stable: boolean } }[];
  const requested = process.env['FABRIC_LOADER_VERSION'];
  const loader = requested ? versions.find(value => value.loader.version === requested)?.loader : versions.find(value => value.loader.stable)?.loader;
  if (!loader) throw new Error('No compatible Fabric loader was found for the configured Minecraft version.');
  const installerResponse = await fetch('https://meta.fabricmc.net/v2/versions/installer', { signal: AbortSignal.timeout(30_000) });
  if (!installerResponse.ok) throw new Error('Fabric installer lookup failed.');
  const installers = await installerResponse.json() as { version: string; stable: boolean }[];
  const installer = installers.find(value => value.stable);
  if (!installer) throw new Error('No stable Fabric installer found.');
  const url = `https://meta.fabricmc.net/v2/versions/loader/${minecraftVersion}/${loader.version}/${installer.version}/server/jar`;
  await downloadArtifact(url, launcherPath, { maximumBytes: 16 * 1024 * 1024 });
  await writeFile(path.join(directory, 'installation.json'), JSON.stringify({ minecraftVersion, loaderVersion: loader.version, installerVersion: installer.version, source: url, installedAt: new Date().toISOString() }, null, 2));
  console.log(`Installed Minecraft ${minecraftVersion}, Fabric ${loader.version} launcher.`);
}
const propertiesPath = path.join(directory, 'server.properties');
if (!await access(propertiesPath).then(() => true, () => false)) await writeFile(propertiesPath, [
  'server-ip=127.0.0.1', 'server-port=25566', 'online-mode=true', 'enable-rcon=false', 'enable-query=false',
  'max-players=12', 'view-distance=12', 'simulation-distance=8', 'motd=Aron & friends', 'difficulty=normal',
  'spawn-protection=16', 'network-compression-threshold=256', 'rate-limit=0', 'sync-chunk-writes=true',
  'max-tick-time=60000', 'white-list=false', '',
].join('\n'), { mode: 0o600 });
const eulaPath = path.join(directory, 'eula.txt');
const accepted = process.argv.includes('--accept-eula');
if (accepted) {
  await writeFile(eulaPath, '# Owner accepted https://www.minecraft.net/eula\neula=true\n', { mode: 0o600 });
} else if (!await access(eulaPath).then(() => true, () => false)) {
  await writeFile(eulaPath, '# Read https://www.minecraft.net/eula before accepting.\neula=false\n', { mode: 0o600 });
}
const eula = await readFile(eulaPath, 'utf8');
console.log(/^eula=true\s*$/m.test(eula) ? 'Server is ready to start from the workshop.' : 'Launcher installed. Starting the server requires owner EULA acceptance: npm run bootstrap -- --accept-eula');
console.log('Minecraft stays on 127.0.0.1:25566. The managed nginx gateway exposes port 25565 with connection limits. Do not forward the Java port directly.');
