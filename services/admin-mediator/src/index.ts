// @ts-nocheck
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { registerWithOpenHIM } from './openhim.js';
import { migrate } from './db/pool.js';
import { scanForDuplicates } from './services/scanner.js';
import { createApp } from './app.js';

const app = createApp();

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
