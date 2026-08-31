# RelayAPI rate limiter — solution

> **Status: skeleton.** Project structure and dependencies only. No rate-limiting
> logic yet. This README is a placeholder to be filled in as the slice is built.

## What this will be

A thin vertical slice of RelayAPI's per-customer rate limiter:

- one metered endpoint (`GET /api/v1/ping`)
- real limiter middleware enforcing per-customer RPM
- config for fake customers including a Northwind stand-in
- a load harness that drives the service at quota boundaries and reports results
- a way to run 3 nodes behind a round-robin proxy to prove distributed correctness

## Resolution being implemented (summary)

Each customer config carries **two enforced numbers**: a sustained rate (contract
RPM) and an optional burst ceiling that applies only inside a documented UTC
window. Northwind: 300 sustained / 1200 burst during 02:00–04:00 UTC. Outside the
window Northwind is capped at 300 like anyone else and gets 429s past it; past
1200 inside the window it also gets 429s. Burst-tier requests are tagged for
audit. This lives in config data, not in code branches. Full rationale in
`../DECISIONS.md`.

## Algorithm

Token bucket per customer: refill rate = sustained RPM, capacity = burst ceiling
(equal to sustained when no burst allowance applies). Avoids the fixed-window
boundary double-spend.

## Layout

```
solution/
├── package.json
├── src/
│   ├── server.js              # single node entry point
│   ├── app.js                 # express app factory (limiter wired as a stub)
│   ├── config/
│   │   ├── index.js           # config loader
│   │   └── customers.json     # per-customer records (fake IDs)
│   ├── middleware/
│   │   └── rateLimit.js       # STUB: pass-through
│   └── limiter/
│       ├── tokenBucket.js     # STUB
│       └── store.js           # STUB: shared cross-node state backend
├── scripts/
│   └── cluster.js             # STUB: spawn 3 nodes + round-robin proxy
└── harness/
    └── loadTest.js            # STUB: boundary load generator + report
```

## Requirements

- Node.js >= 20 (uses ESM and built-in `fetch` / `node:test`)

## Setup

```bash
npm install
```

## Run (single node)

```bash
npm start
# GET http://127.0.0.1:3000/api/v1/ping  with header  X-Customer-Id: acme
```

`npm run cluster` and `npm run harness` are stubs for now and exit non-zero.
