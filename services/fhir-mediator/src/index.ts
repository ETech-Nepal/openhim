import { upstreamError } from './lib/errors.js';
import { createApp } from './app.js';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { registerWithOpenHIM } from './openhim/registration.js';

const app = createApp();

async function start() {
  try {
    await registerWithOpenHIM();
  } catch (caught) {
    const err = upstreamError(caught);
    logger.warn({ err: err.message }, 'OpenHIM registration failed — starting in standalone mode');
  }
  app.listen(config.MEDIATOR_PORT, () => {
    logger.info(`Mediator listening on :${config.MEDIATOR_PORT}`);
  });
}
start();
