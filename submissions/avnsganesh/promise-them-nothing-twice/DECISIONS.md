# Decisions — Promise Them Nothing Twice

## Conflict resolution

RelayAPI's CTO required hard, auditable enforcement with no hidden exceptions; the Support Lead required Northwind never see a 429 during their nightly batch, even though that traffic is 3-4x their contracted 300 RPM. I rejected both literal readings. Northwind's config record carries two enforced numbers — 300 RPM sustained (their actual contract) and 1200 RPM burst, active only during their documented 02:00–04:00 UTC window. Outside that window they're capped at 300 like any customer and receive 429s past it (harness scenario 7: 400 sent, 300 allowed). Even inside the window, exceeding 1200 still gets 429s (scenario 11: 2100 sent, 1201 allowed) — there is no unlimited exception, so the CTO's "never over-limit" promise holds. This lives entirely as data in customers.json; a grep for `if (customerId ===` returns nothing in the request path, satisfying the CTO's ban on hardcoded special-casing. I explicitly rejected "never a 429 for Northwind" as operationally equivalent to no limit, and rejected a single flat number for every customer as a guaranteed nightly 429-storm for RelayAPI's largest account during a renewal window.

## Technical design

Token bucket per customer, refill rate = sustainedRpm/60 tokens/sec, capacity = burst ceiling when inside the customer's burst window else sustained rate. Coordination across the 3 stateless nodes is a single atomic Redis Lua script (EVALSHA/EVAL) doing read-refill-check-consume-persist as one indivisible step, using Redis's own TIME as the shared clock so node clock skew can't distort refill math. This was chosen over fixed-window specifically to avoid the boundary double-spend RelayAPI's prior limiter suffered — proven directly in harness scenario 5, where a full quota sent twice in rapid succession still yielded only 100 allowed, not ~200. On Redis/store failure the middleware fails closed (503 + Retry-After), preserving the CTO's error-direction requirement (under-limit, never over-limit) over availability.

## Verification

The harness (13 scenarios, all passing) and 12 unit tests prove: exact single-node enforcement at the boundary; exact enforcement of a shared quota when 300 requests are split randomly across 3 nodes via round-robin (100 allowed, not ~300 — the core distributed-correctness requirement); per-customer isolation under simultaneous load; avoidance of the fixed-window double-spend bug; correct tier switching for Northwind inside/outside its burst window with hard enforcement at both ceilings; fail-closed behavior and automatic recovery when the store goes down and comes back without a service restart; and atomic correctness under 300-way concurrent contention against a partially-drained (not just empty) bucket. It does not prove behavior under Redis Cluster/sharding, network partition between app nodes and Redis (only clean unavailability), sustained load beyond what this laptop generates in a ~30ms burst window, or multi-instance Redis failover/HA.

## If I had four more hours

- Add Redis Sentinel/replica failover instead of a single instance
- Replace the static customers.json with a small admin API so commercial exceptions are provisioned without a deploy
- Add Prometheus-style metrics on the burst-tier audit log for the compliance one-pager platform-context.md mentions
- Load-test at sustained real-world RPM over minutes rather than a single fast burst, to see refill-rate behavior under prolonged contention
