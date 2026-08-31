// Config loader.
//
// Every customer is one data record. There are no `if (customerId === ...)`
// branches anywhere in the request path — commercial exceptions (e.g. a burst
// allowance) are expressed here as data.
//
// SKELETON: just reads and returns the JSON. Validation / schema checks TBD.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_PATH = fileURLToPath(new URL('./customers.json', import.meta.url));

export function loadConfig({ path = DEFAULT_PATH } = {}) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
