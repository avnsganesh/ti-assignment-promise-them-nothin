// Assembles the limiter: Redis-backed atomic store + token-bucket policy.

import { createStore } from './store.js';
import { TokenBucketLimiter } from './tokenBucket.js';

export function createLimiter({
  redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  keyPrefix,
  logger,
} = {}) {
  const store = createStore({ redisUrl, keyPrefix, logger });
  return new TokenBucketLimiter({ store });
}

export { TokenBucketLimiter } from './tokenBucket.js';
export { createStore } from './store.js';
