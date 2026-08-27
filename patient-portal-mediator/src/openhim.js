import axios from 'axios';
import https from 'node:https';
import { activateHeartbeat, registerMediator, authenticate, genAuthHeaders } from 'openhim-mediator-utils';
import { config } from './config.js';
import { logger } from './lib/logger.js';

// This mediator owns exactly one channel: the read-only patient-portal channel.
// GET-only and bound to its own role, so a portal credential can never write FHIR
// or reach the write-side /fhir channel owned by the other mediator.
export const channels = [
  {
    name: 'NP Patient Portal',
    urlPattern: '^/patient-portal/.*$',
    type: 'http',
    status: 'enabled',
    allow: [config.OPENHIM_PORTAL_CHANNEL_ROLE],
    methods: ['GET'],
    routes: [
      {
        name: 'Patient portal mediator route',
        host: config.MEDIATOR_ROUTE_HOST,   // Docker service name on the `openhim` network
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
  name: 'NP Patient Portal Mediator',
  description: 'Read-only patient-scoped aggregate view over HAPI FHIR for the patient portal',
  defaultChannelConfig: channels,
  endpoints: [
    {
      name: 'Patient portal endpoint',
      host: config.MEDIATOR_ROUTE_HOST,
      port: config.MEDIATOR_PORT,
      path: '/patient-portal/summary',
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

// Idempotently create-or-update each channel via the OpenHIM API (see the write-side
// mediator for the full rationale: defaultChannelConfig only materialises on first
// registration of a URN, so we upsert on every boot to stay deterministic).
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
