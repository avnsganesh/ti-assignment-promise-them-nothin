// Config loader + per-customer resolution.
//
// Every customer is one data record. There are no `if (customerId === ...)`
// branches anywhere in the request path — commercial exceptions (e.g. a burst
// allowance) are expressed here as data.
//
// SKELETON of validation only: shape is assumed well-formed.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_PATH = fileURLToPath(new URL('./customers.json', import.meta.url));

export function loadConfig({ path = DEFAULT_PATH } = {}) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Resolve one customer id to a normalized record the limiter can use.
 * Unknown ids are still metered — `X-Customer-Id` is trusted from the gateway,
 * so an id we hold no contract row for falls back to `config.defaults`, not to
 * "unlimited". This is uniform data handling, not a special case.
 *
 * @returns {{id:string, name:string, tier:string, sustainedRpm:number, burst:object|null}}
 */
export function resolveCustomer(config, customerId) {
  const defaults = config.defaults ?? { sustainedRpm: 60, burst: null };
  const record = config.customers?.[customerId];

  if (!record) {
    return {
      id: customerId,
      name: customerId,
      tier: 'default',
      sustainedRpm: defaults.sustainedRpm,
      burst: defaults.burst ?? null,
    };
  }

  return {
    id: customerId,
    name: record.name ?? customerId,
    tier: record.tier ?? 'custom',
    sustainedRpm: record.sustainedRpm ?? defaults.sustainedRpm,
    burst: record.burst ?? null,
  };
}
