import axios from "axios";
import https from "node:https";
import {
  activateHeartbeat,
  authenticate,
  genAuthHeaders,
  registerMediator,
  deactivateHeartbeat,
} from "openhim-mediator-utils";
import type { AppDefinition, Config } from "./config.js";

export function mediatorDefinition(config: Config, apps: AppDefinition[]) {
  const channels = apps.map((app) => ({
    name: `FHIR Middleware: ${app.id}`,
    urlPattern: `^${app.route}/?$`,
    type: "http",
    status: "enabled",
    methods: ["POST"],
    allow: [app.role],
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
    // Validation, then only the dispatch acceptance; downstream processing is not awaited.
    timeout: app.validation.timeoutMs + (app.delivery?.timeoutMs ?? 0) + 5000,
    properties: [],
    txViewAcl: [],
    txViewFullAcl: [],
  }));
  return {
    urn: config.MEDIATOR_URN,
    version: "0.1.0",
    name: "FHIR Middleware",
    description:
      "Configuration-driven FHIR transform and validation middleware",
    defaultChannelConfig: channels,
    endpoints: apps.map((app) => ({
      name: "Middleware endpoint",
      host: config.MEDIATOR_ROUTE_HOST,
      port: config.MEDIATOR_PORT,
      path: app.route,
      primary: true,
      type: "http",
    })),
  };
}

export async function registerOpenHim(config: Config, apps: AppDefinition[]) {
  const definition = mediatorDefinition(config, apps);
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
