// @ts-nocheck
import axios from 'axios';
import https from 'node:https';
import { activateHeartbeat, registerMediator, authenticate, genAuthHeaders } from 'openhim-mediator-utils';
import { config } from './config.js';
import { logger } from './lib/logger.js';

// This mediator owns one channel: the admin duplicate-review channel. It is bound to
// its own role so an admin credential is separate from the write-side /fhir channel
// and the read-only patient portal channel. Routing merges through OpenHIM (rather
// than letting the UI call this service directly) is deliberate: every merge then
// lands in OpenHIM's transaction log, which is the audit record for an irreversible
// change to patient identity.
export const channels = [
  {
    name: 'NP Patient Admin Review',
    urlPattern: '^/admin/.*$',
    type: 'http',
    status: 'enabled',
    allow: [config.OPENHIM_CHANNEL_ROLE],
    methods: ['GET', 'POST'],
    routes: [
      {
        name: 'Admin review mediator route',
        host: config.MEDIATOR_ROUTE_HOST, // Docker service name on the `openhim` network
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
  name: 'NP Patient Admin Review Mediator',
  description: 'Duplicate-patient review queue; merges resolve in both JeMPI and HAPI FHIR',
  defaultChannelConfig: channels,
  endpoints: [
    {
      name: 'Admin review endpoint',
      host: config.MEDIATOR_ROUTE_HOST,
      port: config.MEDIATOR_PORT,
      path: '/admin/review/tasks',
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
