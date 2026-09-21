import path from 'node:path';
import { readControllerConfiguration } from './controller.js';
import { LoaderInstallation } from './loader-installation.js';
import { RuntimeSandbox } from './runtime-sandbox.js';
import { ServerProfiles } from './server-profiles.js';

if (process.argv.slice(2).join(' ') !== '--controller-stopped') throw new Error('Stop the controller container first, then pass --controller-stopped. This maintenance command rebuilds official runtimes and preserves server data.');
const configuration = readControllerConfiguration();
if (configuration.CONTAINER_SANDBOX !== 'true') throw new Error('Runtime migration must run in the hardened Minecraft container.');
const profiles = new ServerProfiles({ directory: configuration.RUNTIME_DIRECTORY, fallbackTarget: { minecraftVersion: configuration.MINECRAFT_VERSION, loader: 'Fabric', loaderVersion: configuration.FABRIC_LOADER_VERSION } });
await profiles.initialize();
const javaPaths = { 8: configuration.JAVA8_PATH, 17: configuration.JAVA17_PATH, 21: configuration.JAVA21_PATH, 25: configuration.JAVA_PATH };
for (const profile of (await profiles.list()).profiles) {
  const directory = path.join(profiles.directoryFor(profile.id), 'minecraft');
  const log = (line: string) => process.stdout.write(`${line}\n`);
  const sandbox = new RuntimeSandbox({ directory, dataDirectory: configuration.RUNTIME_DIRECTORY, trustDirectory: configuration.RUNTIME_TRUST_DIRECTORY, proxyAddress: configuration.RUNTIME_PROXY_ADDRESS, javaPaths, log });
  const installer = new LoaderInstallation({ directory, javaPaths, log, hardening: sandbox.hardening(), installerProxyAddress: configuration.RUNTIME_PROXY_ADDRESS });
  await installer.install({ minecraftVersion: profile.minecraftVersion, loader: profile.loader, loaderVersion: profile.loaderVersion });
  await sandbox.verify();
  log(`Verified official runtime for ${profile.name}.`);
}
