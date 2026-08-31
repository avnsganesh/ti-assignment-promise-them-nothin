// Unit tests for the pure policy logic. No Redis, no HTTP.
//
//   npm test        (-> node --test)

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseHHMM, isWithinWindow, TokenBucketLimiter } from '../src/limiter/tokenBucket.js';

// A UTC instant with an explicit time-of-day (date part is irrelevant to the
// functions under test, which only read getUTC{Hours,Minutes,Seconds,...}).
const at = (h, m = 0, s = 0, ms = 0) => new Date(Date.UTC(2026, 0, 15, h, m, s, ms));
const MS = (h, m = 0) => (h * 60 + m) * 60 * 1000;

// ---------------------------------------------------------------------------
// parseHHMM
// ---------------------------------------------------------------------------
test('parseHHMM: valid times -> ms since UTC midnight', () => {
  assert.equal(parseHHMM('00:00'), 0);
  assert.equal(parseHHMM('02:00'), MS(2));
  assert.equal(parseHHMM('04:00'), MS(4));
  assert.equal(parseHHMM('23:59'), MS(23, 59));
  assert.equal(parseHHMM(' 02:00 '), MS(2)); // trimmed
});

test('parseHHMM: malformed input throws', () => {
  for (const bad of ['2:00', '0200', '', '24:00', '02:60', '99:99', 'noon', '02:00:00']) {
    assert.throws(() => parseHHMM(bad), /invalid HH:MM time/, `expected throw for ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// isWithinWindow — non-wrapping window (Northwind's own: 02:00-04:00 UTC)
// ---------------------------------------------------------------------------
const NW_WINDOW = { start: '02:00', end: '04:00' };

test('isWithinWindow: non-wrapping window, interior', () => {
  assert.equal(isWithinWindow(at(3), NW_WINDOW), true);
  assert.equal(isWithinWindow(at(2, 0, 0, 1), NW_WINDOW), true);
  assert.equal(isWithinWindow(at(3, 59, 59, 999), NW_WINDOW), true);
});

test('isWithinWindow: non-wrapping window, exact boundary instants', () => {
  // start is inclusive, end is exclusive
  assert.equal(isWithinWindow(at(2, 0, 0, 0), NW_WINDOW), true, 'exactly 02:00:00.000 is inside');
  assert.equal(isWithinWindow(at(4, 0, 0, 0), NW_WINDOW), false, 'exactly 04:00:00.000 is outside');
  assert.equal(isWithinWindow(at(1, 59, 59, 999), NW_WINDOW), false, '1ms before start is outside');
  assert.equal(isWithinWindow(at(4, 0, 0, 1), NW_WINDOW), false, '1ms after end is outside');
});

test('isWithinWindow: non-wrapping window, far outside', () => {
  assert.equal(isWithinWindow(at(0), NW_WINDOW), false);
  assert.equal(isWithinWindow(at(12), NW_WINDOW), false);
  assert.equal(isWithinWindow(at(23, 59), NW_WINDOW), false);
});

// ---------------------------------------------------------------------------
// isWithinWindow — wrapping window (crosses midnight), e.g. 22:00-04:00 UTC.
// Northwind's window does not wrap, but the function must handle it generically.
// ---------------------------------------------------------------------------
const WRAP_WINDOW = { start: '22:00', end: '04:00' };

test('isWithinWindow: midnight-wrapping window', () => {
  assert.equal(isWithinWindow(at(22, 0, 0, 0), WRAP_WINDOW), true, 'exactly start is inside');
  assert.equal(isWithinWindow(at(23, 30), WRAP_WINDOW), true, 'late evening is inside');
  assert.equal(isWithinWindow(at(0, 0, 0, 0), WRAP_WINDOW), true, 'midnight is inside');
  assert.equal(isWithinWindow(at(3, 59, 59, 999), WRAP_WINDOW), true, 'just before end is inside');
  assert.equal(isWithinWindow(at(4, 0, 0, 0), WRAP_WINDOW), false, 'exactly end is outside');
  assert.equal(isWithinWindow(at(4, 0, 0, 1), WRAP_WINDOW), false, '1ms after end is outside');
  assert.equal(isWithinWindow(at(21, 59, 59, 999), WRAP_WINDOW), false, '1ms before start is outside');
  assert.equal(isWithinWindow(at(12), WRAP_WINDOW), false, 'midday is outside');
});

// ---------------------------------------------------------------------------
// isWithinWindow — start === end means "never" (not "always / 24h")
// ---------------------------------------------------------------------------
test('isWithinWindow: start === end is an empty window', () => {
  const empty = { start: '06:00', end: '06:00' };
  assert.equal(isWithinWindow(at(6, 0, 0, 0), empty), false, 'the instant itself is not inside');
  assert.equal(isWithinWindow(at(6, 30), empty), false);
  assert.equal(isWithinWindow(at(0), empty), false);
  assert.equal(isWithinWindow(at(18), empty), false);
});

// ---------------------------------------------------------------------------
// selectAllowance
// ---------------------------------------------------------------------------
const limiter = new TokenBucketLimiter({ store: {} }); // selectAllowance never touches the store

const PLAIN = { id: 'plain', sustainedRpm: 100, burst: null };
const NORTHWIND = {
  id: 'northwind',
  sustainedRpm: 300,
  burst: { ceilingRpm: 1200, windowUtc: NW_WINDOW },
};

test('selectAllowance: no burst config -> always sustained', () => {
  const expected = { tier: 'sustained', capacity: 100, refillRatePerSec: 100 / 60 };
  assert.deepEqual(limiter.selectAllowance(PLAIN, at(3)), expected, 'even during 02:00-04:00');
  assert.deepEqual(limiter.selectAllowance(PLAIN, at(13)), expected);
});

test('selectAllowance: burst customer inside window -> burst ceiling, refill unchanged', () => {
  assert.deepEqual(limiter.selectAllowance(NORTHWIND, at(3)), {
    tier: 'burst',
    capacity: 1200,
    refillRatePerSec: 300 / 60,
  });
});

test('selectAllowance: burst customer outside window -> sustained', () => {
  const sustained = { tier: 'sustained', capacity: 300, refillRatePerSec: 300 / 60 };
  assert.deepEqual(limiter.selectAllowance(NORTHWIND, at(1)), sustained, 'before the window');
  assert.deepEqual(limiter.selectAllowance(NORTHWIND, at(4)), sustained, 'exactly at end (exclusive)');
  assert.deepEqual(limiter.selectAllowance(NORTHWIND, at(12)), sustained, 'midday');
});

test('selectAllowance: burst.ceilingRpm < sustainedRpm throws (inside the window)', () => {
  const misconfigured = {
    id: 'misconfigured',
    sustainedRpm: 300,
    burst: { ceilingRpm: 200, windowUtc: NW_WINDOW },
  };
  assert.throws(
    () => limiter.selectAllowance(misconfigured, at(3)),
    /burst\.ceilingRpm .* must be >= sustainedRpm/,
  );
  // Outside the window the burst branch is never taken, so it must NOT throw.
  assert.deepEqual(limiter.selectAllowance(misconfigured, at(12)), {
    tier: 'sustained',
    capacity: 300,
    refillRatePerSec: 300 / 60,
  });
});

test('selectAllowance: non-positive sustainedRpm throws', () => {
  assert.throws(
    () => limiter.selectAllowance({ id: 'zero', sustainedRpm: 0, burst: null }, at(3)),
    /sustainedRpm must be > 0/,
  );
});
