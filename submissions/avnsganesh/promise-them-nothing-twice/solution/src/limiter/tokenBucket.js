// Token bucket, one logical bucket per customer.
//
// The bucket's numbers come entirely from the customer's config record — there
// is no per-customer code path. Every customer has the same shape:
//
//   refillRatePerSec = sustainedRpm / 60          (never changes)
//   capacity         = sustainedRpm               outside any burst window
//                    = burst.ceilingRpm           inside the burst window
//
// Northwind's nightly-batch behaviour is just a `burst` object in its record;
// a customer with `burst: null` is capped at `sustainedRpm` around the clock.
//
// Note on units / burst characteristic: `capacity` is a token count equal to
// the RPM number, and `refillRatePerSec` refills a full capacity's worth every
// 60s. So across any rolling 60s a customer can spend at most
// capacity + sustainedRpm tokens (a drained-then-refilled bucket). That burst
// headroom is the point of choosing token bucket; it is a deliberate, tunable
// knob (shrink `capacity` below `sustainedRpm` for a stricter limiter).

/** "HH:MM" -> milliseconds since UTC midnight. */
export function parseHHMM(value) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(value).trim());
  if (!m) throw new Error(`invalid HH:MM time: ${value}`);
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) throw new Error(`invalid HH:MM time: ${value}`);
  return (hours * 60 + minutes) * 60 * 1000;
}

/**
 * Is `now` (a Date) within the UTC window { start: "HH:MM", end: "HH:MM" }?
 * end is exclusive. Windows that wrap past midnight (start > end) are supported
 * generically; start === end is treated as "never", not "always".
 */
export function isWithinWindow(now, windowUtc) {
  const msSinceMidnight =
    ((now.getUTCHours() * 60 + now.getUTCMinutes()) * 60 + now.getUTCSeconds()) * 1000 +
    now.getUTCMilliseconds();
  const start = parseHHMM(windowUtc.start);
  const end = parseHHMM(windowUtc.end);
  if (start === end) return false;
  if (start < end) return msSinceMidnight >= start && msSinceMidnight < end;
  return msSinceMidnight >= start || msSinceMidnight < end;
}

export class TokenBucketLimiter {
  constructor({ store }) {
    if (!store) throw new Error('TokenBucketLimiter: store is required');
    this.store = store;
  }

  /**
   * Pick which of the customer's two enforced numbers applies at `now`.
   * Pure function of the config record — no id checks.
   */
  selectAllowance(customer, now) {
    const sustainedRpm = Number(customer.sustainedRpm);
    if (!(sustainedRpm > 0)) {
      throw new Error(`customer ${customer.id}: sustainedRpm must be > 0`);
    }
    const refillRatePerSec = sustainedRpm / 60;

    const burst = customer.burst;
    if (burst && burst.windowUtc && isWithinWindow(now, burst.windowUtc)) {
      const ceilingRpm = Number(burst.ceilingRpm);
      if (!(ceilingRpm >= sustainedRpm)) {
        throw new Error(
          `customer ${customer.id}: burst.ceilingRpm (${ceilingRpm}) must be >= sustainedRpm (${sustainedRpm})`,
        );
      }
      return { tier: 'burst', capacity: ceilingRpm, refillRatePerSec };
    }
    return { tier: 'sustained', capacity: sustainedRpm, refillRatePerSec };
  }

  /**
   * Refill + check + consume for one request.
   * @param {{id:string, sustainedRpm:number, burst:object|null}} customer
   * @returns {Promise<{allowed:boolean, remaining:number, retryAfterMs:number,
   *                    tier:'sustained'|'burst', capacity:number, sustainedRpm:number}>}
   */
  async consume(customer, { now = new Date(), cost = 1 } = {}) {
    const { tier, capacity, refillRatePerSec } = this.selectAllowance(customer, now);
    const key = this.store.key(customer.id);
    const res = await this.store.consume(key, { capacity, refillRatePerSec, cost });
    return {
      allowed: res.allowed,
      remaining: res.remaining,
      retryAfterMs: res.retryAfterMs,
      tier,
      capacity,
      sustainedRpm: Number(customer.sustainedRpm),
    };
  }

  close() {
    return this.store.close();
  }
}
