import type { Config } from './config.js';
import { buildChannels, buildPassthroughChannel } from './channels.js';
import type { Logger } from 'pino';
import axios from 'axios';
import https from 'node:https';
import {
  activateHeartbeat,
  registerMediator,
  authenticate,
  genAuthHeaders,
} from 'openhim-mediator-utils';

// Bind registration to explicit configuration without starting it during imports.
export function createOpenHimRegistration(config: Config, logger: Logger) {
  const route = { host: config.MEDIATOR_ROUTE_HOST, port: config.MEDIATOR_PORT };
  const channels = config.UPSTREAM_ROLE_HEADER
    ? [buildPassthroughChannel(route, config.OPENHIM_CHANNEL_ROLES)]
    : buildChannels(route);

  const mediatorConfig = {
    urn: config.MEDIATOR_URN,
    version: '0.1.0',
    name: 'NP FHIR Gateway Mediator',
    description: 'Verifies Keycloak JWT + DPoP and proxies /fhir to HAPI; per-role access is enforced by the channels it registers',
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

  function getAuthHeaders() {
    return new Promise<Record<string, string>>((resolve, reject) => {
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

    const { data: existing } = await api.get<{ name: string; _id: string }[]>('/channels');
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
    return new Promise<void>((resolve, reject) => {
      registerMediator(openhimOpts, mediatorConfig, async (err) => {
        if (err) return reject(err);
        logger.info({ urn: mediatorConfig.urn }, 'Mediator registered with OpenHIM');
        activateHeartbeat(openhimOpts);
        try {
          await syncChannels();
        } catch (e) {
          logger.warn(
            { err: e instanceof Error ? e.message : String(e) },
            'channel sync failed (mediator still registered)',
          );
        }
        resolve();
      });
    });
  }

  return { channels, syncChannels, registerWithOpenHIM };
}
