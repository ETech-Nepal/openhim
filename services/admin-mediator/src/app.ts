import express, { type ErrorRequestHandler } from 'express';
import { pinoHttp } from 'pino-http';
import { logger } from './lib/logger.js';
import { buildOpenHIMResponse } from './lib/orchestration.js';
import {
  auditHandler,
  detailHandler,
  dismissHandler,
  listHandler,
  mergeHandler,
  scanHandler,
} from './handlers/review.js';

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(pinoHttp({ logger }));
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
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
  const onError: ErrorRequestHandler = (err, req, res, _next) => {
    const message = err instanceof Error ? err.message : 'internal server error';
    logger.error({ err: message }, 'unhandled error');
    const body = { error: message };
    if (req.path.startsWith('/admin')) {
      res.status(500).type('application/json+openhim').send(buildOpenHIMResponse({ status: 500, body }));
      return;
    }
    res.status(500).json(body);
  };
  app.use(onError);
  return app;
}
