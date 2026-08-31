// Shared limiter-state backend.
//
// SKELETON ONLY — no implementation yet.
//
// Why it exists: 3 stateless nodes, round-robin LB, no session affinity. Bucket
// state must be shared or the limiter is wrong under load (a documented prior
// failure mode for RelayAPI).
//
// Backend is pluggable. Redis "may or may not" be available in the deployment
// slice, so the fallback is a Postgres-backed store or a documented equivalent.
// Keep this interface tiny.

export function createStore(_options = {}) {
  throw new Error('limiter store not implemented');
}

// Expected shape:
//   store.consume(key, { capacity, refillRatePerSec, count }) =>
//     { allowed, remaining, retryAfterMs }
