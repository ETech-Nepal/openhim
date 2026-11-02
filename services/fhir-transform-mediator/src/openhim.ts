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
  const timeout = (app: AppDefinition) =>
    // Acknowledge mode waits for validation and the dispatch acceptance. FHIR mode also
    // waits for identity and the FHIR server, row by row (five at a time).
    app.delivery?.mode === "fhir"
      ? 120000
      : app.validation.timeoutMs + (app.delivery?.timeoutMs ?? 0) + 5000;
  const groups = new Map<string, AppDefinition[]>();
  for (const app of apps)
    groups.set(app.channel, [...(groups.get(app.channel) ?? []), app]);
  const channels = [...groups].map(([name, [app, ...rest]]) => ({
    name: `FHIR Middleware: ${name}`,
    urlPattern: app.urlPattern,
    type: "http",
    status: "enabled",
    methods: ["POST"],
    allow: app.roles,
    // Ahead of the general /fhir channel to HAPI, so a Bundle POSTed to /fhir comes here.
    priority: 1,
    routes: [
      {
        name: "FHIR Transform route",
        host: config.MEDIATOR_ROUTE_HOST,
        port: config.MEDIATOR_PORT,
        primary: true,
        type: "http",
        // The client's token travels on to the identity mediator and HAPI.
        forwardAuthHeader: app.auth,
      },
    ],
    requestBody: true,
    responseBody: false,
    autoRetryEnabled: false,
    authType: "private",
    timeout: Math.max(...[app, ...rest].map(timeout)),
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
