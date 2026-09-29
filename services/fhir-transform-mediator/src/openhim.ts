import axios from "axios";
import https from "node:https";
import {
  activateHeartbeat,
  authenticate,
  genAuthHeaders,
  registerMediator,
  deactivateHeartbeat,
} from "openhim-mediator-utils";
import type { Config, Integration } from "./config.js";

export function mediatorDefinition(
  config: Config,
  integrations: Integration[],
) {
  const channels = integrations.map((integration) => ({
    name: `FHIR Middleware: ${integration.id}`,
    urlPattern: `^${integration.channelPath}/?$`,
    type: "http",
    status: "enabled",
    methods: ["POST"],
    allow: [integration.role],
    routes: [
      {
        name: "FHIR Transform route",
        host: config.MEDIATOR_ROUTE_HOST,
        port: config.MEDIATOR_PORT,
        primary: true,
        type: "http",
      },
    ],
    requestBody: true,
    responseBody: false,
    autoRetryEnabled: false,
    authType: "private",
    // The mediator calls the validator, then the NHID generator, one after the other.
    timeout:
      (integration.validation?.timeoutMs ?? 0) +
      (integration.nhidGenerator?.timeoutMs ?? 0) +
      5000,
    properties: [],
    txViewAcl: [],
    txViewFullAcl: [],
  }));
  return {
    urn: config.MEDIATOR_URN,
    version: "0.1.0",
    name: "FHIR Middleware",
    description: "Nagarik registration and EMR FHIR validation middleware",
    defaultChannelConfig: channels,
    endpoints: integrations.map((integration) => ({
      name: "Middleware endpoint",
      host: config.MEDIATOR_ROUTE_HOST,
      port: config.MEDIATOR_PORT,
      path: integration.channelPath,
      primary: true,
      type: "http",
    })),
  };
}

export async function registerOpenHim(
  config: Config,
  integrations: Integration[],
) {
  const definition = mediatorDefinition(config, integrations);
  const options = {
    apiURL: config.OPENHIM_API_URL,
    username: config.OPENHIM_USERNAME,
    password: config.OPENHIM_PASSWORD,
    trustSelfSigned: config.OPENHIM_TRUST_SELF_SIGNED,
    rejectUnauthorized: !config.OPENHIM_TRUST_SELF_SIGNED,
    urn: config.MEDIATOR_URN,
  };
  await new Promise<void>((resolve, reject) =>
    registerMediator(options, definition, (error) =>
      error ? reject(error) : resolve(),
    ),
  );
  await new Promise<void>((resolve, reject) =>
    authenticate(options, (error) => (error ? reject(error) : resolve())),
  );
  const api = axios.create({
    baseURL: config.OPENHIM_API_URL,
    headers: genAuthHeaders(options),
    timeout: 10000,
    maxRedirects: 0,
    proxy: false,
    httpsAgent: new https.Agent({
      rejectUnauthorized: !config.OPENHIM_TRUST_SELF_SIGNED,
    }),
  });
  const { data: existing } =
    await api.get<Array<{ _id: string; name: string }>>("/channels");
  for (const channel of definition.defaultChannelConfig) {
    const match = existing.find((item) => item.name === channel.name);
    if (match)
      await api.put(`/channels/${encodeURIComponent(match._id)}`, channel);
    else await api.post("/channels", channel);
  }
  activateHeartbeat(options).on("error", () =>
    console.error("OpenHIM heartbeat failed"),
  );
  return deactivateHeartbeat;
}
