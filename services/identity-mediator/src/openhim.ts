// @ts-nocheck
import axios from 'axios';
import https from 'node:https';
import { activateHeartbeat, registerMediator, authenticate, genAuthHeaders } from 'openhim-mediator-utils';
import { config } from './config.js';
import { logger } from './lib/logger.js';

const route = (name) => ({
  name,
  host: config.MEDIATOR_ROUTE_HOST, // Docker service name on the `openhim` network
  port: config.MEDIATOR_PORT,
  primary: true,
  type: 'http',
  // The client's own token travels on: this mediator checks the caller's scopes and
  // takes the facility from the verified token.
  forwardAuthHeader: true,
});

// Patient writes on the standard FHIR base. Priority 1 so they win over the general
// /fhir channel (which routes to HAPI): every Patient write goes through identity.
// Admin review: merges route through OpenHIM so every irreversible identity change
// lands in OpenHIM's transaction log.
export const channels = [
  {
    name: 'NP Patient Identity',
    urlPattern: '^/fhir/Patient(/[^/]+)?$',
    priority: 1,
    type: 'http',
    status: 'enabled',
    allow: config.OPENHIM_PATIENT_ROLES,
    methods: ['POST', 'PUT'],
    routes: [route('Identity mediator route')],
    properties: [],
    txViewAcl: [],
    txViewFullAcl: [],
  },
  {
    name: 'NP Patient Admin Review',
    urlPattern: '^/admin/.*$',
    priority: 1,
    type: 'http',
    status: 'enabled',
    allow: [config.OPENHIM_ADMIN_ROLE],
    methods: ['GET', 'POST'],
    routes: [route('Admin review route')],
    properties: [],
    txViewAcl: [],
    txViewFullAcl: [],
  },
];

export const mediatorConfig = {
  urn: config.MEDIATOR_URN,
  version: '1.0.0',
  name: 'NP Identity Mediator',
  description: 'Patient identity: JeMPI matching, Health ID issuing, Patient writes, duplicate review and merge',
  defaultChannelConfig: channels,
  endpoints: [
    {
      name: 'Patient endpoint',
      host: config.MEDIATOR_ROUTE_HOST,
      port: config.MEDIATOR_PORT,
      path: '/fhir/Patient',
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
      try { resolve(genAuthHeaders(openhimOpts)); } catch (e) { reject(e); }
    });
  });
}

// defaultChannelConfig only materialises on the FIRST registration of a URN, so upsert
// on every boot to keep the channel deterministic.
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
// @ts-nocheck
