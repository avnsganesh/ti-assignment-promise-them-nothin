// Stand up the full distributed setup with one command:
//
//   npm run cluster
//
//   - 3 app node processes on ports 3001/3002/3003 (src/server.js), all pointed
//     at the same Redis/Memurai instance
//   - a round-robin reverse proxy on port 3000 that spreads each request to the
//     next node (mirrors RelayAPI's LB: no session affinity)
//
// Ctrl+C tears the whole thing down. If any node dies the cluster exits non-zero.
//
// Config (env):
//   PROXY_PORT             client-facing port                 (default 3000)
//   NODE_PORTS             comma list of node ports           (default 3001,3002,3003)
//   REDIS_URL              shared limiter state               (default redis://127.0.0.1:6379)
//   CLUSTER_TEST_CLOCK=0   disable the X-RateLimit-Now test seam on the nodes
//   CLUSTER_VERBOSE=1      forward each node's per-request audit log to stdout

import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'src', 'server.js');

const PROXY_PORT = Number(process.env.PROXY_PORT ?? 3000);
const NODE_PORTS = (process.env.NODE_PORTS ?? '3001,3002,3003')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter(Boolean);
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const TEST_CLOCK = process.env.CLUSTER_TEST_CLOCK !== '0';
const VERBOSE = process.env.CLUSTER_VERBOSE === '1';

const children = [];
let proxy = null;
let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[cluster] shutting down…');
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* already gone */
    }
  }
  if (proxy) proxy.close();
  setTimeout(() => process.exit(code), 400).unref();
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

function spawnNode(port, index) {
  const env = {
    ...process.env,
    PORT: String(port),
    NODE_ID: `node-${index + 1}`,
    REDIS_URL,
  };
  if (TEST_CLOCK) env.RATELIMIT_ALLOW_NOW_HEADER = '1';

  const child = spawn(process.execPath, [SERVER], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const tag = `[node-${index + 1}]`;
  child.stderr.on('data', (b) => process.stderr.write(`${tag} ${b}`));
  child.stdout.on('data', (b) => {
    // Node stdout is one JSON audit line per request — very noisy under load.
    if (VERBOSE) process.stdout.write(`${tag} ${b}`);
  });
  child.on('exit', (code, signal) => {
    if (!shuttingDown) {
      console.error(`[cluster] node-${index + 1} exited (code=${code} signal=${signal}) — bringing the cluster down`);
      shutdown(1);
    }
  });
  return child;
}

async function waitForHealth(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 1000 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
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
}

function startProxy() {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 512 });
  let cursor = 0;

  proxy = http.createServer((cReq, cRes) => {
    const target = NODE_PORTS[cursor % NODE_PORTS.length];
    cursor = (cursor + 1) % NODE_PORTS.length;

    const pReq = http.request(
      {
        host: '127.0.0.1',
        port: target,
        method: cReq.method,
        path: cReq.url,
        headers: { ...cReq.headers, host: `127.0.0.1:${target}` },
        agent,
      },
      (pRes) => {
        cRes.writeHead(pRes.statusCode, { ...pRes.headers, 'x-proxied-to': `127.0.0.1:${target}` });
        pRes.pipe(cRes);
      },
    );
    pReq.on('error', (err) => {
      if (!cRes.headersSent) cRes.writeHead(502, { 'content-type': 'application/json' });
      cRes.end(JSON.stringify({ error: 'bad gateway', target, detail: err.message }));
    });
    cReq.pipe(pReq);
  });

  return new Promise((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(PROXY_PORT, '0.0.0.0', resolve);
  });
}

async function main() {
  console.log(`[cluster] starting ${NODE_PORTS.length} nodes -> Redis ${REDIS_URL}`);
  NODE_PORTS.forEach((port, i) => children.push(spawnNode(port, i)));

  const health = await Promise.all(NODE_PORTS.map((p) => waitForHealth(p)));
  const bad = NODE_PORTS.filter((_, i) => !health[i]);
  if (bad.length) {
    console.error(`[cluster] nodes on ports ${bad.join(', ')} never became healthy`);
    return shutdown(1);
  }

  await startProxy();

  const line = '─'.repeat(58);
  console.log(
    [
      '',
      line,
      ' cluster ready',
      line,
      `   proxy (round-robin) :  http://127.0.0.1:${PROXY_PORT}`,
      ...NODE_PORTS.map((p, i) => `   node-${i + 1}             :  http://127.0.0.1:${p}`),
      `   redis               :  ${REDIS_URL}`,
      `   test clock header   :  ${TEST_CLOCK ? 'ENABLED (X-RateLimit-Now) — test rig only' : 'disabled'}`,
      '',
      '   run the harness in another shell:  npm run harness',
      '   stop the cluster                :  Ctrl+C',
      line,
      '',
    ].join('\n'),
  );
}

main().catch((err) => {
  console.error('[cluster] fatal:', err);
  shutdown(1);
});
