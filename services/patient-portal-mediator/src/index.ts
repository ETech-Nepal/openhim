// @ts-nocheck
import { config } from './config.js';
import { registerWithOpenHIM } from './openhim.js';
import { logger } from './lib/logger.js';
import { createApp } from './app.js';

const app = createApp();

async function start() {
  try {
    await registerWithOpenHIM();
  } catch (err) {
    logger.warn({ err: err.message }, 'OpenHIM registration failed — starting in standalone mode');
  }
  app.listen(config.MEDIATOR_PORT, () => {
    logger.info(`Patient-portal mediator listening on :${config.MEDIATOR_PORT}`);
  });
}
start();
// @ts-nocheck
