// Per-customer rate-limiting middleware.
//
// SKELETON ONLY — currently a pass-through. Not yet implemented:
//   - resolve the caller's config record (src/config)
//   - pick sustained vs. burst allowance for "now" (UTC batch window check)
//   - consume from the customer's token bucket via the shared store
//   - on denial: respond 429 with a `Retry-After` header
//   - tag/log every request with the tier it was served under (audit trail)

export function rateLimit(_options = {}) {
  return function rateLimitMiddleware(_req, _res, next) {
    // TODO: enforcement
    next();
  };
}
