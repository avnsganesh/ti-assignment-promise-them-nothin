// Express app factory.

import express from 'express';
import { rateLimit } from './middleware/rateLimit.js';

export function createApp({ config, nodeId, limiter, failOpen = false, allowNowHeader = false }) {
  if (!limiter) throw new Error('createApp(): a limiter is required');

  const app = express();
  app.disable('x-powered-by');

  // Identity + node tagging. `X-Customer-Id` is trusted from the API gateway today.
  app.use((req, _res, next) => {
    req.nodeId = nodeId;
    req.customerId = req.get('X-Customer-Id') ?? null;
    next();
  });

  // Health check is not metered.
  app.get('/healthz', (req, res) => {
    res.json({ ok: true, nodeId: req.nodeId });
  });

  // Per-customer rate limiting for everything below.
  app.use(rateLimit({ config, limiter, failOpen, allowNowHeader }));

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
