import axios from 'axios';
import https from 'node:https';
import { activateHeartbeat, registerMediator, authenticate, genAuthHeaders } from 'openhim-mediator-utils';

// Returns the registration helpers bound to a given config/logger, so this module
// never imports a global config singleton (keeps it testable and matches the
// parseConfig(env) pattern used across this service).
export function createOpenHimRegistration(config, logger) {
  const channels = [
    {
      name: 'NP FHIR Intake',
      urlPattern: '^/ingest/?$',
      type: 'http',
      status: 'enabled',
      allow: [config.OPENHIM_CHANNEL_ROLE],
      methods: ['POST'],
      routes: [
        {
          name: 'FHIR Intake Mediator route',
          host: config.MEDIATOR_ROUTE_HOST,
          port: config.MEDIATOR_PORT,
          path: '/ingest',
          primary: true,
          type: 'http',
        },
      ],
      requestBody: true,
      responseBody: true,
      properties: [],
      txViewAcl: [],
      txViewFullAcl: [],
    },
  ];

  const mediatorConfig = {
    urn: config.MEDIATOR_URN,
    version: '0.1.0',
    name: 'NP FHIR Intake Mediator',
    description: 'Converts raw CDRS encounter JSON and passes supported FHIR JSON through the NP FHIR MPI Orchestrator',
    defaultChannelConfig: channels,
    endpoints: [
      {
        name: 'Ingest endpoint',
        host: config.MEDIATOR_ROUTE_HOST,
        port: config.MEDIATOR_PORT,
        path: '/ingest',
        primary: true,
        type: 'http',
      },
    ],
  };

  const openhimOpts = {
    apiURL: config.OPENHIM_API_URL,
    username: config.OPENHIM_USERNAME,
    password: config.OPENHIM_PASSWORD,
    trustSelfSigned: config.OPENHIM_TRUST_SELF_SIGNED,
    urn: mediatorConfig.urn,
  };

  function getAuthHeaders() {
    return new Promise((resolve, reject) => {
      authenticate(openhimOpts, (err) => {
        if (err) return reject(err);
        try {
          resolve(genAuthHeaders(openhimOpts));
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  // OpenHIM materialises defaultChannelConfig only on the first registration of a
  // URN (or a version bump). Upsert on every boot so the channel is deterministic.
  async function syncChannels() {
    const headers = await getAuthHeaders();
    const api = axios.create({
      baseURL: config.OPENHIM_API_URL,
      headers,
      timeout: 10000,
      httpsAgent: new https.Agent({ rejectUnauthorized: !config.OPENHIM_TRUST_SELF_SIGNED }),
    });

    const { data: existing } = await api.get('/channels');
    for (const ch of channels) {
      const match = existing.find((e) => e.name === ch.name);
      if (match) {
        await api.put(`/channels/${match._id}`, ch);
        logger.info({ name: ch.name, id: match._id }, 'channel updated');
      } else {
        await api.post('/channels', ch);
        logger.info({ name: ch.name }, 'channel created');
      }
    }
  }

  function registerWithOpenHIM() {
    return new Promise((resolve, reject) => {
      registerMediator(openhimOpts, mediatorConfig, async (err) => {
        if (err) return reject(err);
        logger.info({ urn: mediatorConfig.urn }, 'Mediator registered with OpenHIM');
        activateHeartbeat(openhimOpts);
        try {
          await syncChannels();
        } catch (e) {
          logger.warn({ err: e.message }, 'channel sync failed (mediator still registered)');
        }
        resolve();
      });
    });
  }

  return { channels, syncChannels, registerWithOpenHIM };
}
