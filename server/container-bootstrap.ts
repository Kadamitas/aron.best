import { access, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { downloadArtifact } from './download.js';
import type { ControllerConfiguration } from './controller.js';
import { LoaderInstallation, readInstalled } from './loader-installation.js';
import { RuntimeSandbox } from './runtime-sandbox.js';

export async function assertInstallationPresent(runtimeDirectory: string): Promise<void> {
  const root = path.resolve(runtimeDirectory);
  const directory = path.join(root, 'minecraft');
  const active = await lstat(directory).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
  if (active && (!active.isDirectory() || active.isSymbolicLink())) throw new Error('The active Minecraft installation must be a regular directory, not a symbolic link.');
  if (active && (await readdir(directory)).length) return;
  const siblings: string[] = await readdir(root).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; });
  let retained = siblings.some(name => name.startsWith('.installation-'));
  if (siblings.includes('installation-snapshots')) {
    const snapshots = path.join(root, 'installation-snapshots');
    const metadata = await lstat(snapshots);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Installation snapshot storage must be a regular directory. Restore the intended server before starting.');
    retained ||= (await readdir(snapshots)).length > 0;
  }
  if (retained) throw new Error('The active Minecraft installation is missing or empty while retained installation data exists. Restore the intended server from installation-snapshots or the staged installation before starting. Nothing was bootstrapped.');
}

export async function bootstrapContainer(configuration: ControllerConfiguration, acceptEula: boolean, dataDirectory = configuration.RUNTIME_DIRECTORY): Promise<void> {
  const directory = path.resolve(configuration.RUNTIME_DIRECTORY, 'minecraft');
  await assertInstallationPresent(configuration.RUNTIME_DIRECTORY);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await readInstalled(directory)) return;
  const launcher = path.join(directory, 'fabric-server-launch.jar');
  const installed = await access(launcher).then(() => true, () => false);
  if (!installed && configuration.CONTAINER_SANDBOX === 'true') {
    await writeServerDefaults(directory, acceptEula);
    const javaPaths = { 8: configuration.JAVA8_PATH, 17: configuration.JAVA17_PATH, 21: configuration.JAVA21_PATH, 25: configuration.JAVA_PATH };
    const sandbox = new RuntimeSandbox({ directory, dataDirectory, trustDirectory: configuration.RUNTIME_TRUST_DIRECTORY, proxyAddress: configuration.RUNTIME_PROXY_ADDRESS, javaPaths, log: line => process.stdout.write(`${line}\n`) });
    const installer = new LoaderInstallation({ directory, javaPaths, log: line => process.stdout.write(`${line}\n`), hardening: sandbox.hardening(), installerProxyAddress: configuration.RUNTIME_PROXY_ADDRESS });
    await installer.install({ minecraftVersion: configuration.MINECRAFT_VERSION, loader: 'Fabric', loaderVersion: configuration.FABRIC_LOADER_VERSION });
    return;
  }
  if (installed) {
    const installation = JSON.parse(await readFile(path.join(directory, 'installation.json'), 'utf8')) as { minecraftVersion: string; loaderVersion: string };
    if (installation.minecraftVersion !== configuration.MINECRAFT_VERSION || installation.loaderVersion !== configuration.FABRIC_LOADER_VERSION) throw new Error('Installed Minecraft target differs from configuration. Restore the matching version settings before starting.');
  } else {
    const response = await fetch('https://meta.fabricmc.net/v2/versions/installer', { signal: AbortSignal.timeout(30_000), redirect: 'error' });
    if (!response.ok) throw new Error('Fabric installer metadata is unavailable.');
    const installers = z.array(z.object({ version: z.string().regex(/^[0-9.]+$/), stable: z.boolean() })).parse(await response.json());
    const installer = installers.find(item => item.stable);
    if (!installer) throw new Error('No stable Fabric installer was found.');
    const source = `https://meta.fabricmc.net/v2/versions/loader/${configuration.MINECRAFT_VERSION}/${configuration.FABRIC_LOADER_VERSION}/${installer.version}/server/jar`;
    await downloadArtifact(source, launcher, { maximumBytes: 16 * 1024 ** 2 });
    await writeFile(path.join(directory, 'installation.json'), JSON.stringify({ minecraftVersion: configuration.MINECRAFT_VERSION, loaderVersion: configuration.FABRIC_LOADER_VERSION, installerVersion: installer.version, source, installedAt: new Date().toISOString() }), { mode: 0o600 });
  }
  await writeServerDefaults(directory, acceptEula);
}

export async function writeServerDefaults(directory: string, acceptEula: boolean): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const name of ['mods', 'config']) await mkdir(path.join(directory, name), { recursive: true, mode: 0o700 });
  const properties = path.join(directory, 'server.properties');
  if (!await access(properties).then(() => true, () => false)) await writeFile(properties, [
    'server-ip=127.0.0.1', 'server-port=25566', 'online-mode=true', 'enable-rcon=false', 'enable-query=false',
    'max-players=12', 'view-distance=8', 'simulation-distance=6', 'motd=Dictionary Minecraft Server', 'white-list=false', '',
  ].join('\n'), { mode: 0o600 });
  if (acceptEula) await writeFile(path.join(directory, 'eula.txt'), 'eula=true\n', { mode: 0o600 });
}
