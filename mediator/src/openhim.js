import axios from 'axios';
import https from 'node:https';
import { activateHeartbeat, registerMediator, authenticate, genAuthHeaders } from 'openhim-mediator-utils';
import { config } from './config.js';
import { logger } from './lib/logger.js';

// ─── Channels ────────────────────────────────────────────────────────────────
// Single source of truth for the channels this mediator owns. Add as many as you
// like here — they are upserted into OpenHIM on every startup (see syncChannels),
// so they always load regardless of OpenHIM's version-gated defaultChannelConfig
// import. To change a channel, just edit it here and restart.
export const channels = [
  {
    name: 'NP FHIR Orchestrator',
    // `/fhir` itself must match, not just `/fhir/<Type>`: a transaction Bundle is
    // POSTed to the FHIR base. `^/fhir/.*$` 404s it (no channel matched).
    urlPattern: '^/fhir(/.*)?$',
    type: 'http',
    status: 'enabled',
    // Bound to the role configured in env. OpenHIM Clients with this role are accepted.
    allow: [config.OPENHIM_CHANNEL_ROLE],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    routes: [
      {
        name: 'Mediator route',
        host: config.MEDIATOR_ROUTE_HOST,  // Docker service name on the `openhim` network
        port: config.MEDIATOR_PORT,
        primary: true,
        type: 'http',
      },
    ],
    properties: [],
    txViewAcl: [],
    txViewFullAcl: [],
  },
];

export const mediatorConfig = {
  urn: config.MEDIATOR_URN,
  version: '0.1.0',
  name: 'NP FHIR MPI Orchestrator',
  description: 'Routes FHIR resources through JeMPI before persisting to HAPI FHIR',
  defaultChannelConfig: channels,
  endpoints: [
    {
      name: 'FHIR endpoint',
      host: config.MEDIATOR_ROUTE_HOST,
      port: config.MEDIATOR_PORT,
      path: '/fhir',
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

// genAuthHeaders is synchronous but needs the salt cached by authenticate() first.
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

/**
 * Idempotently create-or-update each channel via the OpenHIM API.
 *
 * Why this exists: OpenHIM only materialises a mediator's `defaultChannelConfig`
 * into real channels on the FIRST registration of a URN (or when the version
 * number increases). Re-registering the same version never recreates a deleted
 * channel, and never updates an existing one. Upserting here makes channels
 * deterministic on every boot.
 */
export async function syncChannels() {
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

export function registerWithOpenHIM() {
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
