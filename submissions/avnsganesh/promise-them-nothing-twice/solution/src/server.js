// Single app node entry point.
//
// Three of these run behind a round-robin load balancer (see scripts/cluster.js).
// Nodes share nothing in memory; any cross-node coordination goes through the
// limiter store (src/limiter/store.js).

import { createApp } from './app.js';
import { loadConfig } from './config/index.js';

const PORT = Number(process.env.PORT ?? 3000);
const NODE_ID = process.env.NODE_ID ?? `node-${PORT}`;

const config = loadConfig();
const app = createApp({ config, nodeId: NODE_ID });

const server = app.listen(PORT, () => {
  console.log(`[${NODE_ID}] RelayAPI listening on http://127.0.0.1:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[${NODE_ID}] ${signal} received, shutting down`);
    server.close(() => process.exit(0));
  });
}
