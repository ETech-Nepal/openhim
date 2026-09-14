import { parseConfig } from './config.js';
import { createLogger } from './lib/logger.js';
import { createFhirOrchestratorClient } from './clients/fhirOrchestrator.js';
import { createApp } from './app.js';
import { createOpenHimRegistration } from './openhim.js';

const config = parseConfig(process.env);
const logger = createLogger(config.NODE_ENV);

const fhirClient = createFhirOrchestratorClient({
  baseURL: config.FHIR_ORCHESTRATOR_BASE_URL,
  timeoutMs: config.FHIR_ORCHESTRATOR_TIMEOUT_MS,
});

const app = createApp({ config, fhirClient, logger });

const { registerWithOpenHIM } = createOpenHimRegistration(config, logger);

try {
  await registerWithOpenHIM();
} catch (err) {
  logger.warn(
    { err: err instanceof Error ? err.message : String(err) },
    'OpenHIM registration failed — starting in standalone mode',
  );
}

app.listen(config.MEDIATOR_PORT, () => {
  logger.info(`FHIR intake mediator listening on :${config.MEDIATOR_PORT}`);
});
