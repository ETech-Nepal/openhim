// @ts-nocheck
import express from 'express';
import pinoHttp from 'pino-http';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { registerWithOpenHIM } from './openhim.js';
import { migrate } from './db/pool.js';
import { buildOpenHIMResponse } from './lib/orchestration.js';
import { scanForDuplicates } from './services/scanner.js';
import {
  listHandler, detailHandler, scanHandler, mergeHandler, dismissHandler, auditHandler,
} from './handlers/review.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(pinoHttp({ logger }));

// Not under /admin, so it stays a plain (non-envelope) reply for container health checks.
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Mediator replies are OpenHIM envelopes. OpenHIM only unwraps them (returning
// response.body to the caller) when the reply carries this content type — otherwise the
// client silently receives the raw envelope. Every /admin reply, errors included, must
// therefore be an envelope.
app.use('/admin', (_req, res, next) => {
  res.type('application/json+openhim');
  next();
});

app.get('/admin/review/tasks', listHandler);
app.get('/admin/review/tasks/:id', detailHandler);
app.post('/admin/review/tasks/:id/merge', mergeHandler);
app.post('/admin/review/tasks/:id/dismiss', dismissHandler);
app.post('/admin/review/scan', scanHandler);
app.get('/admin/review/golden/:gid/audit', auditHandler);

app.use((err, req, res, _next) => {
  logger.error({ err: err.message, stack: err.stack }, 'unhandled error');
  const body = { error: err.message };
  // Keep the envelope on the /admin routes so OpenHIM unwraps failures too.
  if (req.path.startsWith('/admin')) {
    return res.status(500).type('application/json+openhim').send(buildOpenHIMResponse({ status: 500, body }));
  }
  res.status(500).json(body);
});

async function start() {
  await migrate();

  try {
    await registerWithOpenHIM();
  } catch (err) {
    logger.warn({ err: err.message }, 'OpenHIM registration failed — starting in standalone mode');
  }

  app.listen(config.MEDIATOR_PORT, () => {
    logger.info(`Admin review mediator listening on :${config.MEDIATOR_PORT}`);
  });

  if (config.SCAN_ON_BOOT) {
    scanForDuplicates({}).catch((err) => logger.error({ err: err.message }, 'boot scan failed'));
  }
}

start().catch((err) => {
  logger.error({ err: err.message, stack: err.stack }, 'failed to start');
  process.exit(1);
});
// @ts-nocheck
