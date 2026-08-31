// Shared limiter-state backend — Redis, one atomic Lua script per decision.
//
// Why Redis + Lua and not GET-then-SET from Node:
//   3 stateless app nodes, round-robin LB, no session affinity. The bucket for a
//   customer must live in one place all nodes share. If Node did GET, computed,
//   then SET, two requests landing on two nodes at the same millisecond could
//   both read "1 token left", both decide "allowed", and both write "0" — the
//   customer just spent one token twice. Redis runs a script start-to-finish
//   with nothing else interleaved, so the read, the refill, the check and the
//   write happen as one indivisible step. Concurrency is serialized by Redis.
//
// The script is registered once with ioredis' defineCommand(), which sends it
// via EVALSHA (falling back to EVAL on NOSCRIPT). We never call GET/SET for a
// rate decision from here.

import Redis from 'ioredis';

// ---------------------------------------------------------------------------
// The atomic check-and-consume script.
//
//   KEYS[1] = bucket key, one per customer, e.g. "rl:{acme}"
//             (the {..} is a Redis Cluster hash tag: keeps a customer's data on
//              one slot if this is ever run on a cluster. Harmless standalone.)
//   ARGV[1] = capacity     — max tokens the bucket holds now (sustained OR burst
//                            ceiling; the caller already picked which)
//   ARGV[2] = refill_rate  — tokens added per second (always sustainedRpm / 60)
//   ARGV[3] = cost         — tokens this request wants (normally 1)
//   ARGV[4] = ttl_ms       — idle lifetime for the key, milliseconds (cleanup)
//
//   returns { allowed (0|1), remaining (int), retry_after_ms (int) }
//
// Step by step:
//
//   1. Read ONE clock. We use redis.call('TIME') — the Redis server's own clock
//      — instead of a timestamp passed in from a Node process. All three app
//      nodes share this Redis, so they share this clock, and cross-node clock
//      skew can never distort the refill math. (On Redis >= 5 a script may call
//      non-deterministic commands like TIME; effects — the HSET/PEXPIRE below —
//      are what gets replicated, which is exactly what we want.)
//
//   2. Load prior state: a hash with two fields, `tokens` (how many were left
//      last time) and `ts` (the clock value when we last touched the bucket).
//
//   3. Cold bucket (no state, or it expired): start full — tokens = capacity,
//      ts = now. A brand-new customer is not punished.
//
//   4. Lazy refill. No timer, no background job: advance the bucket only when a
//      request touches it. elapsed = now - ts, clamped at 0 so a backwards
//      clock step can't remove tokens. tokens = min(capacity, tokens + elapsed
//      * refill_rate). The min() is what caps the burst.
//
//   5. Check and consume, atomically (see top of file). If tokens >= cost,
//      allow and subtract cost. Otherwise deny and leave tokens untouched, and
//      compute how long until the missing tokens will have refilled:
//      retry_after_ms = ceil((cost - tokens) / refill_rate * 1000).
//
//   6. Persist. Always write back both fields — even on denial `ts` and the
//      refilled `tokens` moved forward — and (re)set the idle TTL so keys for
//      customers who go quiet eventually disappear.
//
//   7. Return integers only. Redis truncates Lua floats on the way out, so we
//      floor `tokens` ourselves for `remaining` (a fractional token is not a
//      request you can send) and the ceil above keeps retry_after honest.
// ---------------------------------------------------------------------------
const CONSUME_LUA = `
local capacity    = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local cost        = tonumber(ARGV[3])
local ttl_ms      = tonumber(ARGV[4])

-- Step 1: one shared clock (Redis server time), as float seconds.
local t = redis.call('TIME')
local now = tonumber(t[1]) + (tonumber(t[2]) / 1000000.0)

-- Step 2: load previous state.
local state   = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens  = tonumber(state[1])
local last_ts = tonumber(state[2])

-- Step 3: cold bucket -> start full.
if tokens == nil or last_ts == nil then
  tokens  = capacity
  last_ts = now
end

-- Step 4: lazy refill for elapsed time, capped at capacity.
local elapsed = now - last_ts
if elapsed < 0 then elapsed = 0 end
tokens = math.min(capacity, tokens + (elapsed * refill_rate))

-- Step 5: atomic check-and-consume.
local allowed = 0
local retry_after_ms = 0
if tokens >= cost then
  allowed = 1
  tokens = tokens - cost
else
  local deficit = cost - tokens
  retry_after_ms = math.ceil((deficit / refill_rate) * 1000.0)
end

-- Step 6: persist new state + refresh idle TTL.
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], ttl_ms)

-- Step 7: integers only.
return { allowed, math.floor(tokens), retry_after_ms }
`;

export function createStore({
  redisUrl = 'redis://127.0.0.1:6379',
  keyPrefix = 'rl:',
  logger = console,
} = {}) {
  const redis = new Redis(redisUrl, {
    // Bound how long a caller can wait on Redis. When Redis is unreachable a
    // command rejects after ~commandTimeout instead of hanging; the middleware
    // turns that rejection into a 503 (fail closed), which keeps the CTO's
    // "never over-limit" promise. ioredis reconnects in the background, so the
    // service self-heals when Redis returns. Offline-queueing is left on (the
    // default) so a command issued during a brief blip — including the startup
    // ping before the socket is ready — waits for the connection rather than
    // rejecting instantly.
    maxRetriesPerRequest: 2,
    commandTimeout: 1000,
  });

  // Without a listener, an emitted 'error' would crash the process.
  redis.on('error', (err) => {
    logger.warn?.(`[limiter] redis error: ${err.message}`);
  });

  // Registered once; ioredis calls it via EVALSHA and manages the script cache.
  redis.defineCommand('rlConsume', { numberOfKeys: 1, lua: CONSUME_LUA });

  return {
    /** Bucket key for a customer. Hash-tagged for Redis Cluster co-location. */
    key(customerId) {
      return `${keyPrefix}{${customerId}}`;
    },

    /**
     * Atomically refill + check + consume `cost` tokens.
     * @returns {Promise<{allowed: boolean, remaining: number, retryAfterMs: number}>}
     */
    async consume(key, { capacity, refillRatePerSec, cost = 1 }) {
      if (!(refillRatePerSec > 0)) {
        throw new Error(`store.consume: refillRatePerSec must be > 0 (got ${refillRatePerSec})`);
      }
      if (!(capacity > 0)) {
        throw new Error(`store.consume: capacity must be > 0 (got ${capacity})`);
      }
      // Enough idle time for a fully drained bucket to refill, plus a buffer.
      const ttlMs = Math.ceil((capacity / refillRatePerSec) * 1000) + 60_000;

      const res = await redis.rlConsume(key, capacity, refillRatePerSec, cost, ttlMs);
      const [allowed, remaining, retryAfterMs] = res.map(Number);
      return { allowed: allowed === 1, remaining, retryAfterMs };
    },

    /** Liveness check used at startup. */
    async ping() {
      return redis.ping();
    },

    async close() {
      try {
        await redis.quit();
      } catch {
        redis.disconnect();
      }
    },

    redis,
  };
}
