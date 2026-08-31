// Express app factory.
//
// Wiring only — the rate-limit middleware is currently a pass-through stub.

import express from 'express';
import { rateLimit } from './middleware/rateLimit.js';

export function createApp({ config, nodeId }) {
  const app = express();
  app.disable('x-powered-by');

  // Identity + node tagging. `X-Customer-Id` is trusted from the API gateway today.
  app.use((req, _res, next) => {
    req.nodeId = nodeId;
    req.customerId = req.get('X-Customer-Id') ?? null;
    next();
  });

  // Per-customer rate limiting. STUB: passes everything through for now.
  app.use(rateLimit({ config }));

  app.get('/healthz', (req, res) => {
    res.json({ ok: true, nodeId: req.nodeId });
  });

  // The one metered endpoint for the vertical slice.
  app.get('/api/v1/ping', (req, res) => {
    res.json({
      pong: true,
      nodeId: req.nodeId,
      customerId: req.customerId,
      ts: Date.now(),
    });
  });

  return app;
}
