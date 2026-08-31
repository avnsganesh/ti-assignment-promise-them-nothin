// Token bucket, one logical bucket per customer.
//
// SKELETON ONLY — no implementation yet.
//
// Planned model (see ../../DECISIONS.md):
//   refillRatePerSec = sustainedRpm / 60
//   capacity         = burstCeilingRpm / 60   (== sustained unless a burst tier applies)
//
// Bucket state is not held in this process — it lives in the shared store
// (./store.js) so all three nodes agree. Error direction on contention must be
// under-limiting (reject), never over-limiting.

export class TokenBucket {
  constructor(_options = {}) {
    throw new Error('TokenBucket not implemented');
  }

  // async tryConsume(count = 1) => { allowed: boolean, retryAfterMs: number, tier: string }
}
