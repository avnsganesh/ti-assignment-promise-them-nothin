// Load harness for the RelayAPI rate limiter.
//
//   npm run harness            # against a running `npm run cluster`
//
// Drives the service through 13 scenarios, each with an explicit expected
// allowed-count (a range, to absorb token refill during the burst). Prints a
// summary table, writes harness/last-report.json, and exits non-zero if any
// scenario fails — usable as a CI gate.
//
// Config (env):
//   PROXY_URL         client-facing proxy      (default http://127.0.0.1:3000)
//   NODE_URLS         comma list of node URLs  (default http://127.0.0.1:3001..3003)
//   REDIS_URL         limiter state            (default redis://127.0.0.1:6379)
//   HARNESS_CONCURRENCY  in-flight requests    (default 100)
//   BROKEN_NODE_PORT  spare port for the fail-closed test   (default 3099)
//   REDIS_SERVER_BIN  standalone redis/memurai binary for the recovery test
//                     (auto-detected; scenario 12 self-skips if not found)
//   RECOVERY_REDIS_PORT / RECOVERY_NODE_PORT  spare ports for the recovery test
//                     (defaults 6390 / 3098)

import { spawn, execSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import Redis from 'ioredis';

import { loadConfig, resolveCustomer } from '../src/config/index.js';
import { createStore } from '../src/limiter/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'src', 'server.js');
const REPORT_PATH = path.join(HERE, 'last-report.json');

const PROXY_URL = process.env.PROXY_URL ?? 'http://127.0.0.1:3000';
const NODE_URLS = (process.env.NODE_URLS ??
  'http://127.0.0.1:3001,http://127.0.0.1:3002,http://127.0.0.1:3003')
  .split(',')
  .map((s) => s.trim());
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const DEAD_REDIS_URL = process.env.DEAD_REDIS_URL ?? 'redis://127.0.0.1:6399';
const BROKEN_NODE_PORT = Number(process.env.BROKEN_NODE_PORT ?? 3099);
const CONCURRENCY = Number(process.env.HARNESS_CONCURRENCY ?? 100);

const cfg = loadConfig();
const SUSTAINED = resolveCustomer(cfg, 'acme').sustainedRpm; // shared 100-RPM tier
const NW = resolveCustomer(cfg, 'northwind');
const NW_SUSTAINED = NW.sustainedRpm; // 300
const NW_BURST = NW.burst.ceilingRpm; // 1200
const DEFAULT_RPM = cfg.defaults.sustainedRpm; // 60
const UNKNOWN_ID = 'unregistered-tenant-x';

const today = new Date().toISOString().slice(0, 10);
const IN_WINDOW = `${today}T03:00:00Z`; // 02:00-04:00 UTC
const OUT_WINDOW = `${today}T12:00:00Z`;

const store = createStore({ redisUrl: REDIS_URL });

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const range = (min, max) => ({ min, max, display: min === max ? String(min) : `${min}..${max}` });
const slack = (rpm, ms) => Math.ceil((ms / 1000) * (rpm / 60)) + 3;

async function reset(...ids) {
  await Promise.all(ids.map((id) => store.redis.del(store.key(id))));
}

async function hit(baseUrl, { customerId, now } = {}) {
  const headers = {};
  if (customerId != null) headers['X-Customer-Id'] = customerId;
  if (now) headers['X-RateLimit-Now'] = now;
  try {
    const res = await fetch(`${baseUrl}/api/v1/ping`, { headers });
    let nodeId = null;
    if (res.status === 200) {
      try {
        nodeId = (await res.json())?.nodeId ?? null;
      } catch {
        /* ignore body parse */
      }
    } else {
      try {
        await res.text();
      } catch {
        /* drain */
      }
    }
    return {
      status: res.status,
      retryAfter: res.headers.get('retry-after'),
      tier: res.headers.get('x-ratelimit-tier'),
      limit: res.headers.get('x-ratelimit-limit'),
      remaining: res.headers.get('x-ratelimit-remaining'),
      nodeId,
    };
  } catch (err) {
    return {
      status: 0,
      error: err.message,
      retryAfter: null,
      tier: null,
      limit: null,
      remaining: null,
      nodeId: null,
    };
  }
}

async function runPool(tasks, concurrency) {
  const out = new Array(tasks.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    for (;;) {
      const i = idx++;
      if (i >= tasks.length) return;
      out[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return out;
}

function summarize(res, sent, ms) {
  const allowed = res.filter((r) => r.status === 200).length;
  const denied = res.filter((r) => r.status === 429).length;
  const failClosed = res.filter((r) => r.status === 503).length;
  const badRequest = res.filter((r) => r.status === 400).length;
  const other = res.filter((r) => ![200, 429, 503, 400].includes(r.status));
  const nodes = {};
  for (const r of res) if (r.nodeId) nodes[r.nodeId] = (nodes[r.nodeId] ?? 0) + 1;
  const rejections = res.filter((r) => r.status === 429 || r.status === 503);
  const retryAfterOnAllRejections =
    rejections.length > 0 && rejections.every((r) => Number(r.retryAfter) >= 1);
  const badRequestsHaveNoRetryAfter = res
    .filter((r) => r.status === 400)
    .every((r) => r.retryAfter == null);
  const tiers = [...new Set(res.filter((r) => r.tier).map((r) => r.tier))];
  const limits = [...new Set(res.filter((r) => r.limit).map((r) => r.limit))];
  return {
    sent,
    ms,
    allowed,
    denied,
    failClosed,
    badRequest,
    otherCount: other.length,
    nodes,
    tiers,
    limits,
    retryAfterOnAllRejections,
    badRequestsHaveNoRetryAfter,
  };
}

async function blast(baseUrl, { customerId, now, count, concurrency = CONCURRENCY }) {
  const tasks = Array.from({ length: count }, () => () => hit(baseUrl, { customerId, now }));
  const t0 = performance.now();
  const res = await runPool(tasks, concurrency);
  return summarize(res, count, performance.now() - t0);
}

function waitForHealth(port, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      const ok = await new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 1000 }, (r) => {
          r.resume();
          resolve(r.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
          req.destroy();
          resolve(false);
        });
      });
      if (ok) return true;
      await sleep(200);
    }
    return false;
  })();
}

function spawnAppNode({ port, redisUrl, nodeId, allowNowHeader = false }) {
  return spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ID: nodeId,
      REDIS_URL: redisUrl,
      RATELIMIT_FAIL_OPEN: '0',
      RATELIMIT_ALLOW_NOW_HEADER: allowNowHeader ? '1' : '0',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

async function withBrokenRedisNode(fn) {
  const child = spawnAppNode({ port: BROKEN_NODE_PORT, redisUrl: DEAD_REDIS_URL, nodeId: 'broken-redis' });
  try {
    if (!(await waitForHealth(BROKEN_NODE_PORT)))
      throw new Error('broken-redis node did not become healthy');
    return await fn(`http://127.0.0.1:${BROKEN_NODE_PORT}`);
  } finally {
    child.kill();
  }
}

// Find a standalone Redis-compatible server binary for the recovery scenario
// (which needs to kill and restart *its own* store without touching the shared
// one). Returns null if none is available -> scenario 12 self-skips.
function resolveRedisServerBin() {
  const explicit = process.env.REDIS_SERVER_BIN || process.env.MEMURAI_BIN;
  if (explicit && existsSync(explicit)) return explicit;
  const fixed = [
    'C:\\Program Files\\Memurai\\memurai.exe',
    'C:\\Program Files\\Redis\\redis-server.exe',
    '/usr/bin/redis-server',
    '/usr/local/bin/redis-server',
    '/opt/homebrew/bin/redis-server',
  ];
  for (const p of fixed) if (existsSync(p)) return p;
  for (const name of ['memurai.exe', 'redis-server', 'redis-server.exe']) {
    try {
      const found = execSync(process.platform === 'win32' ? `where ${name}` : `command -v ${name}`, {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim()
        .split(/\r?\n/)[0];
      if (found && existsSync(found)) return found;
    } catch {
      /* not on PATH */
    }
  }
  return null;
}

function spawnRedisServer(bin, port) {
  return spawn(
    bin,
    ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
}

async function redisResponds(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const c = new Redis({
        host: '127.0.0.1',
        port,
        lazyConnect: true,
        connectTimeout: 700,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
      });
      c.on('error', () => {}); // expected while the server is down; swallow
      c.connect()
        .then(() => c.ping())
        .then((r) => resolve(r === 'PONG'))
        .catch(() => resolve(false))
        .finally(() => c.disconnect());
    });
    if (ok) return true;
    await sleep(150);
  }
  return false;
}

async function waitUntil(fn, timeoutMs = 10000, stepMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(stepMs);
  }
  return false;
}

// ---------------------------------------------------------------------------
// preflight
// ---------------------------------------------------------------------------
async function preflight() {
  try {
    await store.redis.ping();
  } catch (err) {
    console.error(`\n[harness] Redis not reachable at ${REDIS_URL}: ${err.message}\n`);
    process.exit(2);
  }
  for (const url of [PROXY_URL, ...NODE_URLS]) {
    try {
      const r = await fetch(`${url}/healthz`);
      if (!r.ok) throw new Error(`status ${r.status}`);
      await r.text();
    } catch (err) {
      console.error(
        `\n[harness] cannot reach ${url}/healthz (${err.message}).\n` +
          `          Start the cluster first:  npm run cluster\n`,
      );
      process.exit(2);
    }
  }
  // Confirm the X-RateLimit-Now test seam is active (needed for scenarios 6 & 7).
  await reset('northwind');
  const probe = await hit(NODE_URLS[0], { customerId: 'northwind', now: IN_WINDOW });
  await reset('northwind');
  if (probe.tier !== 'burst') {
    console.error(
      `\n[harness] the cluster is not honouring X-RateLimit-Now (probe tier=${probe.tier}).\n` +
        `          Scenarios 6 & 7 need it. Start the cluster with the default settings\n` +
        `          (npm run cluster enables it) or set RATELIMIT_ALLOW_NOW_HEADER=1.\n`,
    );
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------
const results = [];
const add = (r) => {
  r.expectedAllowed = r.expected;
  r.skipped = r.skipped === true;
  r.pass = r.skipped ? true : r.checks.every((c) => c.ok);
  results.push(r);
  const flag = r.skipped ? 'SKIP' : r.pass ? 'PASS' : 'FAIL';
  console.log(`  [${flag}] ${r.id}. ${r.name}`);
  for (const c of r.checks) if (!c.ok) console.log(`         ✗ ${c.name}`);
};

async function scenario1() {
  await reset('acme');
  const s = await blast(NODE_URLS[0], { customerId: 'acme', count: SUSTAINED });
  add({
    id: 1,
    name: 'exactly sustained RPM, single node',
    sent: s.sent,
    allowed: s.allowed,
    denied: s.denied,
    expected: range(SUSTAINED, SUSTAINED),
    details: `all ${SUSTAINED} allowed on ${NODE_URLS[0]}; 0 rejected`,
    checks: [
      { name: `allowed == ${SUSTAINED}`, ok: s.allowed === SUSTAINED },
      { name: 'no 429s', ok: s.denied === 0 },
      { name: 'no unexpected responses', ok: s.otherCount === 0 && s.failClosed === 0 },
    ],
  });
}

async function scenario2() {
  await reset('acme');
  const sent = Math.round(SUSTAINED * 1.2);
  const s = await blast(NODE_URLS[0], { customerId: 'acme', count: sent });
  const max = SUSTAINED + slack(SUSTAINED, s.ms);
  add({
    id: 2,
    name: 'sustained +20%, single node',
    sent: s.sent,
    allowed: s.allowed,
    denied: s.denied,
    expected: range(SUSTAINED, max),
    details: `${s.allowed} allowed / ${s.denied} x 429 in ${Math.round(s.ms)}ms; tier=${s.tiers} limit=${s.limits}`,
    checks: [
      { name: `allowed in ${SUSTAINED}..${max}`, ok: s.allowed >= SUSTAINED && s.allowed <= max },
      { name: 'excess rejected', ok: s.denied === sent - s.allowed && s.denied > 0 },
      { name: 'every 429 carries Retry-After', ok: s.retryAfterOnAllRejections },
      { name: 'tier=sustained, limit=100', ok: s.tiers.join() === 'sustained' && s.limits.join() === '100' },
    ],
  });
}

async function scenario3() {
  await reset('globex');
  const sent = SUSTAINED * 3;
  const s = await blast(PROXY_URL, { customerId: 'globex', count: sent });
  const max = SUSTAINED + slack(SUSTAINED, s.ms);
  const nodesHit = Object.keys(s.nodes).length;
  add({
    id: 3,
    name: 'sustained x3 across 3 nodes (proxy)',
    sent: s.sent,
    allowed: s.allowed,
    denied: s.denied,
    expected: range(SUSTAINED, max),
    details: `total allowed=${s.allowed} (NOT ~${sent}); nodes served 200s: ${JSON.stringify(s.nodes)}`,
    checks: [
      { name: `total allowed in ${SUSTAINED}..${max} (not ~${sent})`, ok: s.allowed >= SUSTAINED - 2 && s.allowed <= max },
      { name: 'all 3 nodes handled traffic', ok: nodesHit === 3 },
      { name: 'excess rejected with Retry-After', ok: s.denied > 0 && s.retryAfterOnAllRejections },
    ],
  });
}

async function scenario4() {
  await reset('acme', 'initech');
  // acme is flooded; initech sends exactly its budget at the same time.
  const [flood, victim] = await Promise.all([
    blast(NODE_URLS[0], { customerId: 'acme', count: SUSTAINED * 2 }),
    blast(NODE_URLS[0], { customerId: 'initech', count: SUSTAINED }),
  ]);
  add({
    id: 4,
    name: 'per-customer isolation under load',
    sent: victim.sent,
    allowed: victim.allowed,
    denied: victim.denied,
    expected: range(SUSTAINED, SUSTAINED),
    details: `initech got all ${victim.allowed}/${SUSTAINED} while acme was flooded (acme allowed=${flood.allowed}/${flood.sent})`,
    checks: [
      { name: `initech allowed == ${SUSTAINED}`, ok: victim.allowed === SUSTAINED },
      { name: "initech saw no 429 (budget not consumed by acme)", ok: victim.denied === 0 },
      { name: 'acme was still capped', ok: flood.allowed <= SUSTAINED + slack(SUSTAINED, flood.ms) },
    ],
  });
}

async function scenario5() {
  await reset('initech');
  const t0 = performance.now();
  const a = await blast(NODE_URLS[0], { customerId: 'initech', count: SUSTAINED });
  const b = await blast(NODE_URLS[0], { customerId: 'initech', count: SUSTAINED });
  const elapsed = performance.now() - t0;
  const total = a.allowed + b.allowed;
  const max = SUSTAINED + slack(SUSTAINED, elapsed);
  add({
    id: 5,
    name: 'rapid double-burst (fixed-window trap)',
    sent: a.sent + b.sent,
    allowed: total,
    denied: a.denied + b.denied,
    expected: range(SUSTAINED, max),
    details: `burst A allowed=${a.allowed}, burst B allowed=${b.allowed}, total=${total} over ${Math.round(elapsed)}ms — a fixed-window limiter would allow ~${SUSTAINED * 2}`,
    checks: [
      { name: `total allowed in ${SUSTAINED}..${max}`, ok: total >= SUSTAINED - 2 && total <= max },
      { name: `total NOT ~2x quota`, ok: total < SUSTAINED * 1.5 },
    ],
  });
}

async function scenario6() {
  await reset('northwind');
  const sent = NW_BURST + 100;
  const s = await blast(NODE_URLS[0], { customerId: 'northwind', now: IN_WINDOW, count: sent });
  const max = NW_BURST + slack(NW_SUSTAINED, s.ms);
  add({
    id: 6,
    name: 'Northwind inside burst window',
    sent: s.sent,
    allowed: s.allowed,
    denied: s.denied,
    expected: range(NW_BURST, max),
    details: `${s.allowed} allowed @ ceiling ${NW_BURST}; tier=${s.tiers} limit=${s.limits}`,
    checks: [
      { name: `allowed in ${NW_BURST}..${max}`, ok: s.allowed >= NW_BURST && s.allowed <= max },
      { name: 'tier=burst, limit=1200', ok: s.tiers.join() === 'burst' && s.limits.join() === '1200' },
      { name: 'excess rejected with Retry-After', ok: s.denied === sent - s.allowed && s.denied > 0 && s.retryAfterOnAllRejections },
    ],
  });
}

async function scenario7() {
  await reset('northwind');
  const sent = NW_SUSTAINED + 100;
  const s = await blast(NODE_URLS[0], { customerId: 'northwind', now: OUT_WINDOW, count: sent });
  const max = NW_SUSTAINED + slack(NW_SUSTAINED, s.ms);
  add({
    id: 7,
    name: 'Northwind outside burst window',
    sent: s.sent,
    allowed: s.allowed,
    denied: s.denied,
    expected: range(NW_SUSTAINED, max),
    details: `${s.allowed} allowed @ sustained ${NW_SUSTAINED}; tier=${s.tiers} limit=${s.limits}`,
    checks: [
      { name: `allowed in ${NW_SUSTAINED}..${max} (capped like any customer)`, ok: s.allowed >= NW_SUSTAINED && s.allowed <= max },
      { name: 'tier=sustained, limit=300', ok: s.tiers.join() === 'sustained' && s.limits.join() === '300' },
      { name: 'excess rejected with Retry-After', ok: s.denied > 0 && s.retryAfterOnAllRejections },
    ],
  });
}

async function scenario8() {
  await reset(UNKNOWN_ID);
  const sent = Math.round(DEFAULT_RPM * 1.6);
  const s = await blast(NODE_URLS[0], { customerId: UNKNOWN_ID, count: sent });
  const max = DEFAULT_RPM + slack(DEFAULT_RPM, s.ms);
  add({
    id: 8,
    name: 'unknown customer -> default tier',
    sent: s.sent,
    allowed: s.allowed,
    denied: s.denied,
    expected: range(DEFAULT_RPM, max),
    details: `${s.allowed} allowed / ${s.denied} x 429; metered at default ${DEFAULT_RPM} (tier=${s.tiers} limit=${s.limits})`,
    checks: [
      { name: `allowed in ${DEFAULT_RPM}..${max}`, ok: s.allowed >= DEFAULT_RPM && s.allowed <= max },
      { name: 'not unlimited (some 429s)', ok: s.allowed < sent && s.denied > 0 },
      { name: 'not rejected outright (some 200s)', ok: s.allowed > 0 },
      { name: 'tier=sustained, limit=60', ok: s.tiers.join() === 'sustained' && s.limits.join() === '60' },
      { name: 'every 429 carries Retry-After', ok: s.retryAfterOnAllRejections },
    ],
  });
}

async function scenario9() {
  const sent = 15;
  const s = await withBrokenRedisNode((base) =>
    blast(base, { customerId: 'acme', count: sent, concurrency: sent }),
  );
  add({
    id: 9,
    name: 'store unavailable -> fail closed',
    sent: s.sent,
    allowed: s.allowed,
    denied: s.denied,
    expected: range(0, 0),
    details: `${s.failClosed}/${sent} returned 503; 0 allowed (fails closed, not open)`,
    checks: [
      { name: 'zero allowed', ok: s.allowed === 0 },
      { name: 'all responses 503', ok: s.failClosed === sent },
      { name: 'every 503 carries Retry-After', ok: s.retryAfterOnAllRejections },
    ],
  });
}

async function scenario10() {
  const sent = 20;
  // No X-Customer-Id header at all.
  const tasks = Array.from({ length: sent }, () => () => hit(NODE_URLS[0], {}));
  const t0 = performance.now();
  const s = summarize(await runPool(tasks, sent), sent, performance.now() - t0);
  add({
    id: 10,
    name: 'missing X-Customer-Id -> 400',
    sent: s.sent,
    allowed: s.allowed,
    denied: s.denied,
    expected: range(0, 0),
    details: `${s.badRequest}/${sent} returned 400; 0 allowed, 0 metered (validation reject, not a rate-limit reject)`,
    checks: [
      { name: 'all responses 400', ok: s.badRequest === sent },
      { name: 'zero allowed', ok: s.allowed === 0 },
      { name: 'not counted as 429/503', ok: s.denied === 0 && s.failClosed === 0 },
      { name: '400 carries no Retry-After', ok: s.badRequestsHaveNoRetryAfter },
    ],
  });
}

async function scenario11() {
  await reset('northwind');
  // Way past the 1200 burst ceiling, still inside the window.
  const sent = Math.round(NW_BURST * 1.75); // 2100
  const s = await blast(NODE_URLS[0], { customerId: 'northwind', now: IN_WINDOW, count: sent });
  const max = NW_BURST + slack(NW_SUSTAINED, s.ms);
  add({
    id: 11,
    name: 'Northwind exceeds burst ceiling -> still capped',
    sent: s.sent,
    allowed: s.allowed,
    denied: s.denied,
    expected: range(NW_BURST, max),
    details: `${s.allowed} allowed / ${s.denied} x 429 of ${sent} sent — burst ceiling ${NW_BURST} is enforced, not unlimited`,
    checks: [
      { name: `allowed in ${NW_BURST}..${max} (NOT ~${sent})`, ok: s.allowed >= NW_BURST && s.allowed <= max },
      { name: 'large majority rejected', ok: s.denied >= sent - max - 2 && s.denied > NW_BURST / 2 },
      { name: 'tier=burst on served requests', ok: s.tiers.join() === 'burst' },
      { name: 'every 429 carries Retry-After', ok: s.retryAfterOnAllRejections },
    ],
  });
}

async function scenario12() {
  const bin = resolveRedisServerBin();
  if (!bin) {
    add({
      id: 12,
      name: 'store recovery: down -> 503 -> back -> normal',
      sent: 0,
      allowed: 0,
      denied: 0,
      expected: range(0, 0),
      skipped: true,
      details: 'skipped: no standalone redis-server / memurai binary found (set REDIS_SERVER_BIN)',
      checks: [],
    });
    return;
  }

  const RPORT = Number(process.env.RECOVERY_REDIS_PORT ?? 6390);
  const APORT = Number(process.env.RECOVERY_NODE_PORT ?? 3098);
  const rurl = `redis://127.0.0.1:${RPORT}`;
  let redisChild = spawnRedisServer(bin, RPORT);
  let appChild;
  try {
    if (!(await redisResponds(RPORT))) throw new Error(`private redis on :${RPORT} did not start`);
    appChild = spawnAppNode({ port: APORT, redisUrl: rurl, nodeId: 'recovery' });
    if (!(await waitForHealth(APORT))) throw new Error(`recovery node on :${APORT} did not start`);
    const base = `http://127.0.0.1:${APORT}`;

    // phase A: store up -> normal allow
    const up = await blast(base, { customerId: 'acme', count: SUSTAINED });

    // take the store down
    redisChild.kill();
    await sleep(1200);
    const down = summarize(
      await runPool(Array.from({ length: 15 }, () => () => hit(base, { customerId: 'acme' })), 15),
      15,
      0,
    );

    // bring the store back on the same port
    redisChild = spawnRedisServer(bin, RPORT);
    if (!(await redisResponds(RPORT))) throw new Error('private redis did not come back up');
    // let the app node's client reconnect (no app restart), watching a throwaway id
    const reconnected = await waitUntil(
      async () => (await hit(base, { customerId: 'reconnect-probe' })).status === 200,
      15000,
    );
    // phase C: same node, store recovered -> allow AND deny both work again
    const after = await blast(base, { customerId: 'acme', count: SUSTAINED + 15 });

    const maxUp = SUSTAINED + slack(SUSTAINED, up.ms);
    const maxAfter = SUSTAINED + slack(SUSTAINED, after.ms);
    add({
      id: 12,
      name: 'store recovery: down -> 503 -> back -> normal',
      sent: up.sent + down.sent + after.sent,
      allowed: up.allowed + down.allowed + after.allowed,
      denied: after.denied,
      expected: range(2 * SUSTAINED, maxUp + maxAfter),
      details:
        `up: ${up.allowed}/${up.sent} allowed; ` +
        `down: ${down.failClosed}/${down.sent} -> 503 (${down.allowed} allowed); ` +
        `recovered (same node, no restart): ${after.allowed} allowed / ${after.denied} x 429`,
      checks: [
        { name: 'while up: served normally', ok: up.allowed >= SUSTAINED - 2 && up.allowed <= maxUp && up.failClosed === 0 },
        { name: 'while down: all 503, none allowed', ok: down.failClosed === down.sent && down.allowed === 0 },
        { name: 'while down: 503 carries Retry-After', ok: down.retryAfterOnAllRejections },
        { name: 'reconnected without app restart', ok: reconnected },
        { name: 'after recovery: allow works again', ok: after.allowed >= SUSTAINED - 2 && after.allowed <= maxAfter },
        { name: 'after recovery: deny works again', ok: after.denied > 0 && after.failClosed === 0 },
      ],
    });
  } finally {
    if (appChild) appChild.kill();
    if (redisChild) redisChild.kill();
  }
}

async function scenario13() {
  await reset('globex');
  const base = NODE_URLS[0];
  // Drain the bucket to a partial level (not empty): spend ~60% sequentially.
  const drainCount = Math.round(SUSTAINED * 0.6);
  let last;
  for (let i = 0; i < drainCount; i++) last = await hit(base, { customerId: 'globex' });
  const remainingBefore = Number(last.remaining); // from the X-RateLimit-Remaining header

  // Now hammer the partially-full bucket with far more concurrency than it has
  // tokens left. The atomic script must hand out exactly `remainingBefore`
  // (+ tiny refill), never more, even though it's mid-range not at zero.
  const swarm = await blast(base, { customerId: 'globex', count: SUSTAINED * 3, concurrency: 200 });
  const tolerance = slack(SUSTAINED, swarm.ms);
  const maxSwarm = remainingBefore + tolerance;

  add({
    id: 13,
    name: 'contention on a partially-drained bucket',
    sent: swarm.sent,
    allowed: swarm.allowed,
    denied: swarm.denied,
    expected: range(Math.max(0, remainingBefore - 2), maxSwarm),
    details:
      `bucket had ~${remainingBefore} tokens left after draining ${drainCount}; ` +
      `${swarm.sent}-way concurrent swarm let exactly ${swarm.allowed} more through ` +
      `(expected ~${remainingBefore}), ${swarm.denied} x 429`,
    checks: [
      { name: `swarm-allowed <= remaining+refill (${maxSwarm})`, ok: swarm.allowed <= maxSwarm },
      { name: 'swarm-allowed >= remaining (no lost tokens)', ok: swarm.allowed >= remainingBefore - 2 },
      { name: 'drain + swarm never exceed capacity', ok: drainCount + swarm.allowed <= SUSTAINED + tolerance },
      { name: 'most of the swarm rejected with Retry-After', ok: swarm.denied > 0 && swarm.retryAfterOnAllRejections },
    ],
  });
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
function renderTable() {
  const rows = results.map((r) => ({
    id: String(r.id),
    name: r.name,
    sent: String(r.sent),
    allowed: String(r.allowed),
    expected: r.expectedAllowed.display,
    result: r.skipped ? 'SKIP' : r.pass ? 'PASS' : 'FAIL',
  }));
  const w = {
    id: 2,
    name: Math.max(8, ...rows.map((x) => x.name.length)),
    sent: Math.max(4, ...rows.map((x) => x.sent.length)),
    allowed: Math.max(7, ...rows.map((x) => x.allowed.length)),
    expected: Math.max(16, ...rows.map((x) => x.expected.length)),
    result: 6,
  };
  const line = (c) =>
    ` ${c.id.padEnd(w.id)}  ${c.name.padEnd(w.name)}  ${c.sent.padStart(w.sent)}  ${c.allowed.padStart(
      w.allowed,
    )}  ${c.expected.padEnd(w.expected)}  ${c.result}`;
  const header = line({
    id: '#',
    name: 'scenario',
    sent: 'sent',
    allowed: 'allowed',
    expected: 'expected_allowed',
    result: 'result',
  });
  console.log('\n' + header);
  console.log(' ' + '─'.repeat(header.length - 1));
  for (const r of rows) console.log(line(r));
}

async function main() {
  console.log(`[harness] proxy=${PROXY_URL}  nodes=${NODE_URLS.length}  redis=${REDIS_URL}`);
  await preflight();
  console.log('[harness] running scenarios…\n');

  await scenario1();
  await scenario2();
  await scenario3();
  await scenario4();
  await scenario5();
  await scenario6();
  await scenario7();
  await scenario8();
  await scenario9();
  await scenario10();
  await scenario11();
  await scenario12();
  await scenario13();

  renderTable();

  console.log('\n details:');
  for (const r of results) console.log(`  ${r.id}. ${r.details}`);

  const skipped = results.filter((r) => r.skipped).length;
  const failed = results.filter((r) => !r.skipped && !r.pass).length;
  const passed = results.length - failed - skipped;

  const report = {
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(),
    redisUrl: REDIS_URL,
    proxyUrl: PROXY_URL,
    nodeUrls: NODE_URLS,
    concurrency: CONCURRENCY,
    tiers: {
      sharedSustainedRpm: SUSTAINED,
      northwindSustainedRpm: NW_SUSTAINED,
      northwindBurstCeilingRpm: NW_BURST,
      defaultRpm: DEFAULT_RPM,
    },
    totals: { scenarios: results.length, passed, failed, skipped },
    ok: failed === 0,
    scenarios: results.map((r) => ({
      id: r.id,
      name: r.name,
      sent: r.sent,
      allowed: r.allowed,
      denied: r.denied,
      expectedAllowed: r.expectedAllowed,
      pass: r.pass,
      skipped: r.skipped,
      checks: r.checks,
      details: r.details,
    })),
  };
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  const skipNote = skipped ? ` (${skipped} skipped)` : '';
  console.log(
    `\n ${passed}/${results.length - skipped} scenarios passed${skipNote}  ->  ${report.ok ? 'OK' : 'FAILURES'}`,
  );
  console.log(` JSON report: ${REPORT_PATH}`);

  await store.close();
  process.exit(report.ok ? 0 : 1);
}

const started = Date.now();
main().catch(async (err) => {
  console.error('[harness] fatal:', err);
  try {
    await store.close();
  } catch {
    /* ignore */
  }
  process.exit(3);
});
