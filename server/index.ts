import { createApp, readConfiguration } from './app.js';
const configuration = readConfiguration();
const app = await createApp(configuration);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
await app.listen({ host: configuration.HOST, port: configuration.PORT });
