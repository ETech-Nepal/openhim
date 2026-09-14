// Per-role access, expressed as OpenHIM channels that all route to this mediator.
// OpenHIM enforces URL + method + client role; the mediator only verifies JWT/DPoP.
// Edit the type lists here (or in the OpenHIM console) to change what a role may touch.
export const ROLE_ACCESS: Record<string, { create: string[]; read: string[] }> =
  {
    ehr: {
      create: [
        "Patient",
        "Encounter",
        "Observation",
        "Condition",
        "Procedure",
        "DiagnosticReport",
      ],
      read: [
        "Patient",
        "Encounter",
        "Observation",
        "Condition",
        "Procedure",
        "DiagnosticReport",
      ],
    },
    // ponytail: read-only by type, no per-patient compartment fence. Add a
    // Patient/$everything endpoint or a HAPI interceptor when an HIU client exists.
    patient: { create: [], read: ["Patient", "Encounter", "Observation"] },
  };

export function buildChannels(route: { host: string; port: number }) {
  const r = (name: string) => ({
    name,
    ...route,
    primary: true,
    type: "http",
    secured: false,
  });
  const base = {
    type: "http",
    status: "enabled",
    authType: "private",
    requestBody: true,
    responseBody: true,
  };
  const channels = [
    {
      ...base,
      name: "FHIR metadata",
      urlPattern: "^/fhir/metadata$",
      methods: ["GET"],
      allow: Object.keys(ROLE_ACCESS),
      routes: [r("gateway")],
    },
  ];
  for (const [role, { create, read }] of Object.entries(ROLE_ACCESS)) {
    if (create.length)
      channels.push({
        ...base,
        name: `FHIR ${role} create`,
        methods: ["POST"],
        allow: [role],
        routes: [r("gateway")],
        urlPattern: `^/fhir/(${create.join("|")})(/\\$validate)?$`,
      });
    if (read.length)
      channels.push({
        ...base,
        name: `FHIR ${role} read`,
        methods: ["GET", "HEAD"],
        allow: [role],
        routes: [r("gateway")],
        urlPattern: `^/fhir/(${read.join("|")})(/[^/]+)?(/\\$meta)?$`,
      });
  }
  return channels;
}

// hie-fhir-server mode: HAPI enforces per-role access from X-Role, so one channel is enough.
export function buildPassthroughChannel(
  route: { host: string; port: number },
  allow: string[],
) {
  return {
    name: "FHIR gateway",
    urlPattern: "^/fhir(/.*)?$",
    type: "http",
    status: "enabled",
    authType: "private",
    methods: ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"],
    allow,
    requestBody: true,
    responseBody: true,
    routes: [
      {
        name: "gateway",
        ...route,
        primary: true,
        type: "http",
        secured: false,
      },
    ],
  };
}
