import { pino } from 'pino';
import { parseConfig } from './config.js';
import { createApp } from './app.js';
import { createOpenHimRegistration } from './openhim.js';

const config = parseConfig(process.env);
const logger = pino({
  level: config.NODE_ENV === 'production' ? 'info' : 'debug',
  transport: config.NODE_ENV === 'development' ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
});

try {
  await createOpenHimRegistration(config, logger).registerWithOpenHIM();
} catch (err) {
  logger.warn({ err: (err as Error).message }, 'OpenHIM registration failed — starting in standalone mode');
}

createApp(config, logger).listen(config.MEDIATOR_PORT, () => {
  logger.info(`FHIR gateway mediator listening on :${config.MEDIATOR_PORT}`);
});
