// Single app node entry point.
//
// Three of these run behind a round-robin proxy (see scripts/cluster.js). Nodes
// share nothing in memory; all rate-limit state lives in Redis via the limiter.

import { createApp } from './app.js';
import { loadConfig } from './config/index.js';
import { createLimiter } from './limiter/index.js';

const PORT = Number(process.env.PORT ?? 3000);
const NODE_ID = process.env.NODE_ID ?? `node-${PORT}`;
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const FAIL_OPEN = process.env.RATELIMIT_FAIL_OPEN === '1';
const ALLOW_NOW_HEADER = process.env.RATELIMIT_ALLOW_NOW_HEADER === '1';

const config = loadConfig();
const limiter = createLimiter({ redisUrl: REDIS_URL });

try {
  await limiter.store.ping();
  console.log(`[${NODE_ID}] connected to Redis at ${REDIS_URL}`);
} catch (err) {
  console.warn(
    `[${NODE_ID}] WARNING: Redis not reachable at ${REDIS_URL} (${err.message}); ` +
      `requests will ${FAIL_OPEN ? 'pass through (fail-open)' : 'return 503 (fail-closed)'} until it is up`,
  );
}

const app = createApp({
  config,
  nodeId: NODE_ID,
  limiter,
  failOpen: FAIL_OPEN,
  allowNowHeader: ALLOW_NOW_HEADER,
});
if (ALLOW_NOW_HEADER) {
  console.log(`[${NODE_ID}] test seam ON: X-RateLimit-Now header will override burst-window clock`);
}

const server = app.listen(PORT, () => {
  console.log(`[${NODE_ID}] RelayAPI listening on http://127.0.0.1:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[${NODE_ID}] ${signal} received, shutting down`);
    server.close(async () => {
      await limiter.close();
      process.exit(0);
    });
  });
}
