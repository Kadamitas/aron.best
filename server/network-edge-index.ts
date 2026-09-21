import { createNetworkEdge, readNetworkEdgeConfiguration } from './network-edge.js';

const edge = createNetworkEdge(readNetworkEdgeConfiguration());
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  void edge.close().then(() => process.exit(0), () => process.exit(1));
});
await edge.listen();
