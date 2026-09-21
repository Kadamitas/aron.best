import { createController, readControllerConfiguration } from './controller.js';
import { bootstrapContainer } from './container-bootstrap.js';
import { ServerProfiles } from './server-profiles.js';

const configuration = readControllerConfiguration();
const profiles = new ServerProfiles({ directory: configuration.RUNTIME_DIRECTORY, fallbackTarget: { minecraftVersion: configuration.MINECRAFT_VERSION, loader: 'Fabric', loaderVersion: configuration.FABRIC_LOADER_VERSION } });
await profiles.initialize();
if (process.env['BOOTSTRAP_MINECRAFT'] === 'true') await bootstrapContainer({ ...configuration, RUNTIME_DIRECTORY: profiles.activeDirectory() }, process.env['EULA_ACCEPTED'] === 'true');
const app = await createController(configuration);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
await app.listen({ host: configuration.HOST, port: configuration.CONTROLLER_PORT });
