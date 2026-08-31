# RelayAPI rate limiter — solution

> **Status: limiter, 3-node cluster, and load harness all implemented.**

Thin vertical slice of RelayAPI's per-customer rate limiter: one metered
endpoint, real limiter middleware backed by Redis, config for fake customers
including a Northwind stand-in.

## Resolution being implemented (summary)

Each customer config carries **two enforced numbers**: a sustained rate (contract
RPM) and an optional burst ceiling that applies only inside a documented UTC
window. Northwind: 300 sustained / 1200 burst during 02:00–04:00 UTC. Outside the
window Northwind is capped at 300 like anyone else and gets 429s past it; past
1200 inside the window it also gets 429s. Every request is logged with the tier
that served it. This lives in `src/config/customers.json` as data — there is no
`if (customerId === ...)` anywhere. Full rationale in `../DECISIONS.md`.

## Algorithm

Token bucket per customer:

- `refillRatePerSec = sustainedRpm / 60` — constant
- `capacity = sustainedRpm` normally, `= burst.ceilingRpm` inside the burst window

The check-and-consume is a **single atomic Redis Lua script** (`src/limiter/store.js`),
so requests racing across the three nodes are serialized by Redis and cannot
double-spend a token. Redis is the one shared clock and the one shared state.

## Requirements

- Node.js >= 20
- A Redis 5+ server reachable at `REDIS_URL` (see below). The limiter uses a
  single Lua script with `redis.call('TIME')`; any Redis 5+ or Redis-compatible
  server (Memurai, Valkey, KeyDB, Redis in Docker/WSL/Linux) works.

## Setup (target: < 15 min)

### 1. Install dependencies

```bash
npm install
```

### 2. Get Redis running

**Windows — Memurai (recommended).** Memurai is a native Redis 7-compatible
server for Windows that installs as an auto-starting Windows service on
`127.0.0.1:6379` — nothing to start manually, survives reboots.

```powershell
winget install Memurai.MemuraiDeveloper
# verify:
Get-Service Memurai                          # -> Running
& "C:\Program Files\Memurai\memurai-cli.exe" ping   # -> PONG
```

The service is named `Memurai`; manage it with `Start-Service` / `Stop-Service`
/ `Restart-Service Memurai`. Config file: `C:\Program Files\Memurai\memurai.conf`.

> If the MSI fails with exit `1603` / `SFXCA: Failed to create temp directory.
> Error code 5`, create the missing SYSTEM-profile temp folders once (elevated)
> and re-run the install:
> ```powershell
> New-Item -ItemType Directory -Force `
>   "C:\Windows\System32\config\systemprofile\AppData\Local\Temp",`
>   "C:\Windows\SysWOW64\config\systemprofile\AppData\Local\Temp"
> ```

**macOS / Linux:** `brew install redis && brew services start redis`, or your
distro's `redis-server` package.

**Any OS with Docker (optional alternative):** a `docker-compose.yml` is included
for reviewers who prefer containers. It is **not required** — use it only if you
already have Docker:

```bash
docker compose up -d redis     # or: npm run redis:up  /  npm run redis:down
```

### 3. Start the service

```bash
npm start        # node on :3000, REDIS_URL defaults to redis://127.0.0.1:6379
```

### 4. Smoke test

```bash
curl -s localhost:3000/healthz
curl -s -D - localhost:3000/api/v1/ping -H 'X-Customer-Id: acme'
# hammer past 100 to see 429 + Retry-After:
for i in $(seq 1 150); do curl -s -o /dev/null -w '%{http_code}\n' \
  localhost:3000/api/v1/ping -H 'X-Customer-Id: acme'; done | sort | uniq -c
```

PowerShell equivalent of the loop (works in Windows PowerShell 5.1):

```powershell
1..150 | ForEach-Object {
  try { (Invoke-WebRequest localhost:3000/api/v1/ping `
          -Headers @{'X-Customer-Id'='acme'} -UseBasicParsing).StatusCode }
  catch { [int]$_.Exception.Response.StatusCode }
} | Group-Object | Select-Object Name,Count
# -> Name 200 Count ~100 ;  Name 429 Count ~50
```

## Distributed cluster + load harness

Stand up the full multi-node setup with one command:

```bash
npm run cluster
```

This spawns **3 app nodes** (ports 3001–3003) plus a **round-robin reverse
proxy** on port 3000, all sharing the one Redis. The proxy sends each request to
the next node in turn — no session affinity — so it mirrors RelayAPI's load
balancer. Ctrl+C tears it all down; if any node dies the cluster exits non-zero.

In another shell, run the harness against it:

```bash
npm run harness
```

It drives 13 scenarios, each with an explicit expected allowed-count, prints a
`scenario | sent | allowed | expected_allowed | pass/fail` table, writes
`harness/last-report.json`, and **exits non-zero if any scenario fails** (CI
gate):

1. exactly sustained RPM → all allowed
2. +20% → excess 429 + Retry-After
3. **3× over limit spread across all 3 nodes → total allowed still ≈ quota, not 3×**
4. two customers same tier → one's spike doesn't touch the other's budget
5. rapid double-burst → *not* ~2× quota (the fixed-window trap this design avoids)
6. Northwind in 02:00–04:00 UTC → up to 1200, `tier=burst`
7. Northwind outside → capped at 300, `tier=sustained`
8. unknown customer → default tier, still metered
9. Redis down → 503 + Retry-After (fail closed)
10. missing `X-Customer-Id` entirely → 400 (validation reject, no Retry-After, not metered)
11. Northwind past even the 1200 ceiling inside the window → still 429s, not unlimited
12. store **recovery**: kill the store → 503s → restart it → same node resumes allow/deny with no restart
13. concurrent swarm against a **partially-drained** bucket → atomic script exact mid-range, not just at zero

Scenarios 6, 7, 11 need the test-clock seam (see `RATELIMIT_ALLOW_NOW_HEADER`
below); `npm run cluster` enables it on its nodes automatically. Scenario 9
spawns a throwaway node pointed at a dead Redis. Scenario 12 spawns its own
private redis/memurai instance it can kill and restart (auto-detected; it
self-skips, still exit 0, if no standalone binary is found).

## Environment variables

| Var | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | listen port |
| `NODE_ID` | `node-<PORT>` | label in logs / responses |
| `REDIS_URL` | `redis://127.0.0.1:6379` | shared limiter state (Memurai / Redis / compatible) |
| `RATELIMIT_FAIL_OPEN` | unset | `1` = pass through when Redis is down (default: 503) |
| `RATELIMIT_ALLOW_NOW_HEADER` | unset | `1` = honour an `X-RateLimit-Now` request header (ISO 8601) for burst-window selection. **Test-only**; `npm start` leaves it off, `npm run cluster` turns it on for its nodes. |

Cluster-only: `PROXY_PORT`, `NODE_PORTS`, `CLUSTER_TEST_CLOCK=0` (disable the
seam), `CLUSTER_VERBOSE=1` (stream node audit logs).
Harness-only: `PROXY_URL`, `NODE_URLS`, `HARNESS_CONCURRENCY`, `BROKEN_NODE_PORT`,
`REDIS_SERVER_BIN` (standalone redis/memurai for the recovery scenario; auto-detected).

## Unit tests

```bash
npm test        # node --test
```

Covers the pure policy logic with no Redis or HTTP: `parseHHMM`, `isWithinWindow`
(non-wrapping, midnight-wrapping, exact boundary instants, `start === end` ⇒
never), and `selectAllowance` (sustained vs burst selection, and the
`burst.ceilingRpm < sustainedRpm` misconfiguration that must throw).

## Response headers

| Header | On | Meaning |
| --- | --- | --- |
| `X-RateLimit-Tier` | all | `sustained` or `burst` |
| `X-RateLimit-Limit` | all | current bucket capacity |
| `X-RateLimit-Remaining` | all | whole tokens left |
| `Retry-After` | 429 / 503 | seconds until a retry can succeed |

## Layout

```
solution/
├── docker-compose.yml         # OPTIONAL local Redis for Docker users
├── package.json
├── src/
│   ├── server.js              # single node entry point
│   ├── app.js                 # express app factory
│   ├── config/
│   │   ├── index.js           # loader + resolveCustomer (defaults for unknown ids)
│   │   └── customers.json     # per-customer records (fake IDs)
│   ├── middleware/
│   │   └── rateLimit.js       # X-Customer-Id -> bucket -> 429 + audit log line
│   └── limiter/
│       ├── index.js           # createLimiter() wiring
│       ├── tokenBucket.js     # policy: pick sustained vs burst, call store
│       └── store.js           # Redis + atomic Lua check-and-consume
├── scripts/
│   └── cluster.js             # spawn 3 nodes + round-robin proxy (one command)
├── harness/
│   ├── loadTest.js            # 13-scenario load harness, table + JSON, CI exit code
│   └── last-report.json       # written by the last harness run (gitignored)
└── test/
    └── tokenBucket.test.js    # node --test unit tests for the pure policy logic
```
