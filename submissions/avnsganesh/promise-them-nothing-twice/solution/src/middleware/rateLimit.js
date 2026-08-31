// Per-customer rate-limiting middleware.
//
// Flow:
//   1. read the caller id from `X-Customer-Id` (trusted from the gateway)
//   2. resolve their config record (defaults for unknown ids)
//   3. ask the token bucket to refill + check + consume one token
//   4. emit one structured log line naming the tier that served the request
//      (sustained vs burst) — this is the audit trail
//   5. allow -> next(); deny -> 429 + Retry-After; limiter error -> 503

import { resolveCustomer } from '../config/index.js';

export function rateLimit({
  config,
  limiter,
  logger = console,
  failOpen = false,
  // Test-only seam: when true, an `X-RateLimit-Now` request header (ISO 8601)
  // overrides "now" for burst-window selection, so a harness can exercise the
  // 02:00-04:00 window deterministically. Off by default; `npm start` never
  // enables it. It only shifts which tier is chosen — refill still uses the
  // real Redis clock.
  allowNowHeader = false,
}) {
  if (!limiter) throw new Error('rateLimit(): a limiter is required');

  return async function rateLimitMiddleware(req, res, next) {
    const customerId = req.customerId || req.get('X-Customer-Id') || '';
    if (!customerId) {
      return res.status(400).json({ error: 'missing X-Customer-Id header' });
    }

    const customer = resolveCustomer(config, customerId);

    let now = new Date();
    if (allowNowHeader) {
      const raw = req.get('X-RateLimit-Now');
      if (raw) {
        const parsed = new Date(raw);
        if (!Number.isNaN(parsed.getTime())) now = parsed;
      }
    }

    let result;
    try {
      result = await limiter.consume(customer, { now });
    } catch (err) {
      logger.error?.(
        JSON.stringify({
          evt: 'ratelimit_error',
          nodeId: req.nodeId,
          customerId,
          msg: err.message,
          ts: new Date().toISOString(),
        }),
      );
      // Redis unreachable. Fail closed by default so we never over-limit; flip
      // failOpen only if availability is worth more than the quota guarantee.
      if (failOpen) return next();
      res.set('Retry-After', '1');
      return res.status(503).json({ error: 'rate limiter unavailable' });
    }

    res.set('X-RateLimit-Tier', result.tier);
    res.set('X-RateLimit-Limit', String(result.capacity));
    res.set('X-RateLimit-Remaining', String(result.remaining));

    // Audit line: which tier served (or rejected) this request.
    logger.log?.(
      JSON.stringify({
        evt: 'ratelimit',
        nodeId: req.nodeId,
        customerId,
        tier: result.tier, // 'sustained' | 'burst'
        capacity: result.capacity,
        allowed: result.allowed,
        remaining: result.remaining,
        retryAfterMs: result.allowed ? 0 : result.retryAfterMs,
        now: now.toISOString(),
        ts: new Date().toISOString(),
      }),
    );

    if (!result.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        error: 'rate limit exceeded',
        tier: result.tier,
        retryAfterMs: result.retryAfterMs,
      });
    }

    return next();
  };
}
