# FHIR Mediator — Implementation Guide

> Historical JavaScript design reference. Current TypeScript structure and commands are in `services/fhir-mediator/README.md`.

> **For Claude Code.** Read this whole file before writing any code. Phase order is mandatory. Replace every `<<CONFIRM: ... >>` with a real value before implementing the section it appears in. Do not guess.

---

## 0. Context

### 0.1 What we are building

An OpenHIE-compliant FHIR mediator that sits between client EMRs and HAPI FHIR. It:

1. Receives FHIR traffic from OpenHIM (which has already authenticated the caller's Keycloak JWT).
2. For Patient writes, resolves identity through JeMPI before persisting.
3. For all other resources, passes through to HAPI with light validation/enrichment.
4. Supports both writes (POST / Bundle transactions) and reads (GET searches).
5. Returns OpenHIM-formatted orchestration responses so every external call is captured in the OpenHIM transaction log.

### 0.2 Current deployment topology

```
┌──────────────┐    JWT     ┌──────────────┐               ┌──────────────┐         ┌──────────────┐
│  EMR client  │ ─────────▶ │   OpenHIM    │ ────────────▶ │   Mediator   │ ──────▶ │  HAPI FHIR   │
│              │  Bearer    │   (router)   │   HTTP        │ (this app)   │  HTTP   │              │
└──────────────┘            └──────┬───────┘               └──────┬───────┘         └──────────────┘
                                   │                              │
                                   ▼ JWT verify                   │ HTTP over WireGuard tunnel
                            ┌──────────────┐                      ▼
                            │  Keycloak    │               ┌──────────────┐
                            │  public key  │               │    JeMPI     │
                            │  (RS256 PEM) │               │   on VPS     │
                            └──────────────┘               └──────────────┘
```

**Auth flow:** EMR → Keycloak `/realms/openhie/protocol/openid-connect/token` → JWT → `Authorization: Bearer <jwt>` on every request to OpenHIM → OpenHIM verifies signature against the realm JWKS (cached) → OpenHIM maps JWT `sub` claim to a registered OpenHIM Client → forwards to mediator. **The mediator does not validate JWTs itself.**

**Stack already running locally (laptop, Docker Compose):**

- OpenHIM Core — `https://localhost:8080` (Mediator/API), `https://localhost:5000` (HTTPS transactions), `http://localhost:5001` (HTTP transactions)
- OpenHIM Console — `http://localhost:9000`
- HAPI FHIR — `http://localhost:8081/fhir`
- HAPI Postgres — `localhost:5433`
- Mongo (for OpenHIM) — internal
- Keycloak — running separately in Docker (realm `openhie`)

**JeMPI (remote, on VPS `202.51.71.81`):** Reachable from the laptop **only** over the WireGuard tunnel at `http://10.8.0.1:50000/JeMPI/...`. The `:50000` endpoint is the open API (no Keycloak); `:50001` is Keycloak-protected. Dev uses `:50000`; production will switch to `:50001` later. The tunnel itself provides transport security and access control for now.

### 0.3 Scope of resources

| Resource | Write (POST/PUT) | Read (GET search) | JeMPI involvement | Dedup strategy |
|---|---|---|---|---|
| Patient | ✅ | ✅ | **Yes** — `crRegister` / `crFind` for every write | JeMPI golden UID |
| Encounter | ✅ | ✅ | No | `ifNoneExist` in Bundle, or pass-through outside |
| Observation | ✅ | ✅ | No | Same |
| DocumentReference | ✅ | ✅ | No | Same + Binary upload step |
| Organization | ✅ | ✅ | No | Pass-through |
| Practitioner | ✅ | ✅ | No | **Mediator-side identifier dedup** (see §6.5) |
| Bundle (transaction) | ✅ | n/a | Yes for any Patient entries | HAPI handles internal refs |

### 0.4 Identifier systems used throughout

| Purpose | System URL |
|---|---|
| Patient national ID | `http://mohp.gov.np/fhir/NamingSystem/nepal-health-id` |
| JeMPI golden record UID | `http://mohp.gov.np/fhir/NamingSystem/jempi-golden-uid` |
| Encounter number | `http://mohp.gov.np/fhir/NamingSystem/encounter-number` |
| Registration number | `http://mohp.gov.np/fhir/NamingSystem/registration-number` |
| Practitioner — NMC | `http://mohp.gov.np/fhir/NamingSystem/nepal-medical-council` |
| Practitioner — NNC | `http://mohp.gov.np/fhir/NamingSystem/nepal-nursing-council` |
| Practitioner — NAMC | `http://mohp.gov.np/fhir/NamingSystem/nepal-ayurveda-medical-council` |
| Practitioner — NHPC | `http://mohp.gov.np/fhir/NamingSystem/nepal-health-professional-council` |
| Practitioner — NPC | `http://mohp.gov.np/fhir/NamingSystem/nepal-pharmacy-council` |

`<<CONFIRM: the five Practitioner council system URLs above are placeholders — replace with the exact URLs from the np-core ImplementationGuide before Phase 3.>>`

---

## 1. Phase order (do not deviate)

| Phase | What | Exit check |
|---|---|---|
| **Phase 0** | Confirm JeMPI API surface | All `<<CONFIRM>>` placeholders in §5 are filled |
| **Phase 1** | Scaffold + OpenHIM auto-registration (role + channel) | Mediator registers itself, console shows it heartbeating |
| **Phase 2** | JeMPI provider module | Sample Patient round-trips to JeMPI, returns golden UID |
| **Phase 3** | Resource handlers — Patient, Encounter, Observation, Organization, Practitioner, DocumentReference | curl-based smoke test per resource passes |
| **Phase 4** | Bundle transaction handler | Sample bundle (Patient + 2 Encounters) persists atomically |
| **Phase 5** | GET search handlers | All four sample searches return expected Bundles |
| **Phase 6** | End-to-end test against full stack via OpenHIM with a real JWT | E2E script passes |

---

## 2. Project layout

```
services/fhir-mediator/
├── package.json
├── .env.example
├── .env                           # gitignored
├── src/
│   ├── index.js                   # Express app, routes, startup
│   ├── config.js                  # env validation
│   ├── openhim.js                 # role + channel + mediator registration
│   ├── providers/
│   │   └── jempiProvider.js       # Phase 2
│   ├── handlers/
│   │   ├── patient.js
│   │   ├── encounter.js
│   │   ├── observation.js
│   │   ├── organization.js
│   │   ├── practitioner.js
│   │   ├── documentReference.js
│   │   ├── bundle.js
│   │   └── search.js              # generic GET search forwarder
│   ├── fhir/
│   │   ├── hapiClient.js
│   │   └── identifiers.js         # identifier system constants + helpers
│   └── lib/
│       ├── orchestration.js
│       └── logger.js
├── scripts/
│   ├── test-jempi.js
│   ├── test-handler.sh
│   └── e2e.sh
└── README.md
```

---

## 3. Phase 1 — Scaffold and OpenHIM registration

### 3.1 `package.json`

```json
{
  "name": "openhie-fhir-mediator",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "start": "node src/index.js",
    "dev": "node --watch src/index.js",
    "test:jempi": "node scripts/test-jempi.js"
  },
  "dependencies": {
    "axios": "^1.7.0",
    "dotenv": "^16.4.0",
    "express": "^4.19.0",
    "openhim-mediator-utils": "^0.2.4",
    "pino": "^9.0.0",
    "pino-http": "^10.0.0",
    "pino-pretty": "^11.0.0",
    "uuid": "^10.0.0",
    "zod": "^3.23.0"
  }
}
```

### 3.2 `.env.example`

```
# Mediator
MEDIATOR_PORT=4000
MEDIATOR_URN=urn:mediator:fhir-mpi-orchestrator
NODE_ENV=development

# OpenHIM Core API (local docker stack)
OPENHIM_API_URL=https://localhost:8080
OPENHIM_USERNAME=root@openhim.org
OPENHIM_PASSWORD=<<SET to whatever your local OpenHIM root password is>>
OPENHIM_TRUST_SELF_SIGNED=true

# OpenHIM role to bind to the auto-created channel
OPENHIM_CHANNEL_ROLE=np-fhir-clients

# HAPI FHIR (local docker stack)
HAPI_FHIR_BASE_URL=http://localhost:8081/fhir
HAPI_TIMEOUT_MS=15000

# JeMPI (over WireGuard tunnel)
JEMPI_BASE_URL=http://10.8.0.1:50000/JeMPI
JEMPI_REGISTER_ROUTE=<<CONFIRM in Phase 0 — typical: /crRegister>>
JEMPI_FIND_ROUTE=<<CONFIRM — typical: /crFind>>
JEMPI_GOLDEN_GET_ROUTE=<<CONFIRM — typical: /expandedGoldenRecord/{uid}>>
JEMPI_TIMEOUT_MS=10000
```

### 3.3 `src/config.js`

```js
import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  MEDIATOR_PORT: z.coerce.number().default(4000),
  MEDIATOR_URN: z.string().min(1),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  OPENHIM_API_URL: z.string().url(),
  OPENHIM_USERNAME: z.string().min(1),
  OPENHIM_PASSWORD: z.string().min(1),
  OPENHIM_TRUST_SELF_SIGNED: z.coerce.boolean().default(false),
  OPENHIM_CHANNEL_ROLE: z.string().default('np-fhir-clients'),

  HAPI_FHIR_BASE_URL: z.string().url(),
  HAPI_TIMEOUT_MS: z.coerce.number().default(15000),

  JEMPI_BASE_URL: z.string().url(),
  JEMPI_REGISTER_ROUTE: z.string().min(1),
  JEMPI_FIND_ROUTE: z.string().min(1),
  JEMPI_GOLDEN_GET_ROUTE: z.string().min(1),
  JEMPI_TIMEOUT_MS: z.coerce.number().default(10000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid env config:', parsed.error.format());
  process.exit(1);
}
export const config = parsed.data;
```

### 3.4 `src/lib/logger.js`

```js
import pino from 'pino';
import { config } from '../config.js';

export const logger = pino({
  level: config.NODE_ENV === 'production' ? 'info' : 'debug',
  transport: config.NODE_ENV === 'development'
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } }
    : undefined,
});
```

### 3.5 `src/openhim.js` — auto-registration of role + channel

```js
import { activateHeartbeat, registerMediator } from 'openhim-mediator-utils';
import { config } from './config.js';
import { logger } from './lib/logger.js';

export const mediatorConfig = {
  urn: config.MEDIATOR_URN,
  version: '0.1.0',
  name: 'NP FHIR MPI Orchestrator',
  description: 'Routes FHIR resources through JeMPI before persisting to HAPI FHIR',
  defaultChannelConfig: [
    {
      name: 'NP FHIR Orchestrator',
      urlPattern: '^/fhir/.*$',
      type: 'http',
      // Bound to the role configured in env. OpenHIM Clients with this role are accepted.
      allow: [config.OPENHIM_CHANNEL_ROLE],
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      routes: [
        {
          name: 'Mediator route',
          host: 'host.docker.internal',  // OpenHIM is in docker, mediator runs on host
          port: config.MEDIATOR_PORT,
          primary: true,
          type: 'http',
        },
      ],
      properties: [],
      txViewAcl: [],
      txViewFullAcl: [],
    },
  ],
  endpoints: [
    {
      name: 'FHIR endpoint',
      host: 'host.docker.internal',
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

export function registerWithOpenHIM() {
  return new Promise((resolve, reject) => {
    registerMediator(openhimOpts, mediatorConfig, (err) => {
      if (err) return reject(err);
      logger.info({ urn: mediatorConfig.urn }, 'Mediator registered with OpenHIM');
      activateHeartbeat(openhimOpts);
      resolve();
    });
  });
}
```

> **Note on `host.docker.internal`:** because OpenHIM Core runs in Docker but the mediator runs on the host (laptop), OpenHIM must reach the mediator via the Docker host gateway, not `localhost`. On Linux this resolves correctly only if `extra_hosts: ["host.docker.internal:host-gateway"]` is set on the `openhim-core` service. **Add that to your existing `docker-compose.yml`** if it's not already there:
>
> ```yaml
> openhim-core:
>   ...
>   extra_hosts:
>     - "host.docker.internal:host-gateway"
> ```

### 3.6 `src/lib/orchestration.js`

```js
export function buildOpenHIMResponse({ status, body, orchestrations = [], urn }) {
  return {
    'x-mediator-urn': urn,
    status: status >= 200 && status < 300 ? 'Successful' : 'Failed',
    response: {
      status,
      headers: { 'Content-Type': 'application/fhir+json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      timestamp: new Date().toISOString(),
    },
    orchestrations,
  };
}

export function orch(name, method, path, reqBody, status, resBody) {
  return {
    name,
    request: {
      method, path,
      timestamp: new Date().toISOString(),
      body: reqBody ? JSON.stringify(reqBody).slice(0, 8000) : undefined,
    },
    response: {
      status,
      timestamp: new Date().toISOString(),
      body: resBody ? JSON.stringify(resBody).slice(0, 8000) : undefined,
    },
  };
}
```

### 3.7 `src/fhir/identifiers.js`

```js
// Centralised identifier system URLs. Keep this file as the single source of truth.
export const SYS = {
  NEPAL_HEALTH_ID: 'http://mohp.gov.np/fhir/NamingSystem/nepal-health-id',
  JEMPI_GOLDEN_UID: 'http://mohp.gov.np/fhir/NamingSystem/jempi-golden-uid',
  ENCOUNTER_NUMBER: 'http://mohp.gov.np/fhir/NamingSystem/encounter-number',
  REGISTRATION_NUMBER: 'http://mohp.gov.np/fhir/NamingSystem/registration-number',
  // Practitioner councils
  NMC: 'http://mohp.gov.np/fhir/NamingSystem/nepal-medical-council',
  NNC: 'http://mohp.gov.np/fhir/NamingSystem/nepal-nursing-council',
  NAMC: 'http://mohp.gov.np/fhir/NamingSystem/nepal-ayurveda-medical-council',
  NHPC: 'http://mohp.gov.np/fhir/NamingSystem/nepal-health-professional-council',
  NPC: 'http://mohp.gov.np/fhir/NamingSystem/nepal-pharmacy-council',
};

// All identifier systems that should trigger Practitioner dedup
export const PRACTITIONER_DEDUP_SYSTEMS = [SYS.NMC, SYS.NNC, SYS.NAMC, SYS.NHPC, SYS.NPC];

export function findIdentifier(resource, system) {
  return (resource.identifier || []).find(i => i.system === system);
}

export function hasIdentifier(resource, system, value) {
  return (resource.identifier || []).some(i => i.system === system && i.value === value);
}

export function appendIdentifier(resource, system, value) {
  resource.identifier = resource.identifier || [];
  if (!hasIdentifier(resource, system, value)) {
    resource.identifier.push({ system, value });
  }
  return resource;
}
```

### 3.8 `src/fhir/hapiClient.js`

```js
import axios from 'axios';
import { config } from '../config.js';

export const hapi = axios.create({
  baseURL: config.HAPI_FHIR_BASE_URL,
  timeout: config.HAPI_TIMEOUT_MS,
  headers: {
    'Content-Type': 'application/fhir+json',
    'Accept': 'application/fhir+json',
  },
  maxBodyLength: Infinity,
  maxContentLength: Infinity,
});

export async function postResource(resourceType, body) {
  const { data, status } = await hapi.post(`/${resourceType}`, body);
  return { data, status };
}

export async function postBinary(buffer, contentType) {
  const { data, status } = await hapi.post('/Binary', buffer, {
    headers: { 'Content-Type': contentType, 'Accept': 'application/fhir+json' },
  });
  return { data, status };
}

export async function searchByIdentifier(resourceType, system, value) {
  const q = encodeURIComponent(`${system}|${value}`);
  const { data, status } = await hapi.get(`/${resourceType}?identifier=${q}&_count=1`);
  return { data, status, resource: data.entry?.[0]?.resource };
}

export async function passthroughGet(resourceType, queryString) {
  const path = queryString ? `/${resourceType}?${queryString}` : `/${resourceType}`;
  const { data, status } = await hapi.get(path);
  return { data, status, path };
}

export async function postBundle(bundle) {
  const { data, status } = await hapi.post('/', bundle);
  return { data, status };
}
```

### 3.9 `src/index.js`

```js
import express from 'express';
import pinoHttp from 'pino-http';
import { config } from './config.js';
import { registerWithOpenHIM } from './openhim.js';
import { logger } from './lib/logger.js';
import { patientHandler } from './handlers/patient.js';
import { encounterHandler } from './handlers/encounter.js';
import { observationHandler } from './handlers/observation.js';
import { organizationHandler } from './handlers/organization.js';
import { practitionerHandler } from './handlers/practitioner.js';
import { documentReferenceHandler } from './handlers/documentReference.js';
import { bundleHandler } from './handlers/bundle.js';
import { searchHandler } from './handlers/search.js';

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(pinoHttp({ logger }));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Bundle (transaction or batch) — must come BEFORE individual /fhir/<Type> routes
app.post('/fhir', bundleHandler);             // POST /fhir with type=transaction|batch
app.post('/fhir/', bundleHandler);

// ── Writes
app.post('/fhir/Patient',           patientHandler);
app.post('/fhir/Encounter',         encounterHandler);
app.post('/fhir/Observation',       observationHandler);
app.post('/fhir/Organization',      organizationHandler);
app.post('/fhir/Practitioner',      practitionerHandler);
app.post('/fhir/DocumentReference', documentReferenceHandler);

// ── Reads (Pattern A: all GETs through the mediator)
app.get('/fhir/:resourceType',      searchHandler);
app.get('/fhir/:resourceType/:id',  searchHandler);

app.use((err, _req, res, _next) => {
  logger.error({ err: err.message, stack: err.stack }, 'unhandled error');
  res.status(500).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'exception', diagnostics: err.message }] });
});

async function start() {
  try {
    await registerWithOpenHIM();
  } catch (err) {
    logger.warn({ err: err.message }, 'OpenHIM registration failed — starting in standalone mode');
  }
  app.listen(config.MEDIATOR_PORT, () => {
    logger.info(`Mediator listening on :${config.MEDIATOR_PORT}`);
  });
}
start();
```

### 3.10 Phase 1 exit check

```bash
cd services/fhir-mediator
npm install
cp .env.example .env   # fill in OPENHIM_PASSWORD and any other <<SET>> values
npm run dev
```

Verify:
1. `curl http://localhost:4000/health` → `{"status":"ok"}`
2. OpenHIM Console (`http://localhost:9000`) → Mediators tab shows **NP FHIR MPI Orchestrator** as green/heartbeating.
3. Channels tab shows **NP FHIR Orchestrator** with `urlPattern ^/fhir/.*$`.

---

## 4. Phase 2 — JeMPI provider (placeholder version)

Until Phase 0 is complete the provider stays placeholder-driven. The interface is final; only the route names and request/response shapes need updating later.

### 4.1 `src/providers/jempiProvider.js`

```js
import axios from 'axios';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { SYS } from '../fhir/identifiers.js';
import { orch } from '../lib/orchestration.js';

const client = axios.create({
  baseURL: config.JEMPI_BASE_URL,
  timeout: config.JEMPI_TIMEOUT_MS,
  headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
});

/**
 * Register a new patient interaction with JeMPI.
 * On success returns { ok, goldenUid, interactionUid, raw, orchestration }.
 *
 * <<CONFIRM in Phase 0:
 *   - exact route (likely `/crRegister`)
 *   - request body shape — typical JeMPI v2 envelope:
 *       { sourceId: { facility, patient },
 *         uniqueInteractionData: { auxDateCreated, auxId, ... },
 *         demographicData: { givenName, familyName, gender, dob, nationalId, ... } }
 *   - response body shape — typical:
 *       { linkInfo: { goldenUID, interactionID, score } }  OR
 *       { goldenUID, interactionID }
 * >>
 */
export async function registerInteraction(fhirPatient) {
  const payload = mapFhirPatientToJempi(fhirPatient);
  const path = config.JEMPI_REGISTER_ROUTE;
  try {
    const { data, status } = await client.post(path, payload);
    logger.debug({ status, data }, 'JeMPI register response');
    return {
      ok: true,
      goldenUid: extractGoldenUid(data),
      interactionUid: extractInteractionUid(data),
      raw: data,
      orchestration: orch('JeMPI register', 'POST', path, payload, status, data),
    };
  } catch (err) {
    const status = err.response?.status ?? 0;
    const body = err.response?.data ?? { message: err.message };
    logger.error({ status, body }, 'JeMPI register failed');
    return {
      ok: false,
      error: err.message,
      orchestration: orch('JeMPI register', 'POST', path, payload, status, body),
    };
  }
}

/**
 * Probabilistic find — used before registering to check if the patient already exists.
 * Optional; depending on JeMPI config, `crRegister` may already handle the find-or-create
 * semantics internally. <<CONFIRM in Phase 0>>
 */
export async function findInteraction(fhirPatient) {
  const payload = mapFhirPatientToJempi(fhirPatient);
  const path = config.JEMPI_FIND_ROUTE;
  try {
    const { data, status } = await client.post(path, payload);
    return {
      ok: true,
      candidates: extractCandidates(data),
      raw: data,
      orchestration: orch('JeMPI find', 'POST', path, payload, status, data),
    };
  } catch (err) {
    const status = err.response?.status ?? 0;
    return {
      ok: false,
      error: err.message,
      orchestration: orch('JeMPI find', 'POST', path, payload, status, err.response?.data),
    };
  }
}

export async function getGoldenRecord(goldenUid) {
  const path = config.JEMPI_GOLDEN_GET_ROUTE.replace('{uid}', encodeURIComponent(goldenUid));
  try {
    const { data, status } = await client.get(path);
    return {
      ok: true,
      record: data,
      orchestration: orch('JeMPI getGoldenRecord', 'GET', path, null, status, data),
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      orchestration: orch('JeMPI getGoldenRecord', 'GET', path, null, err.response?.status ?? 0, err.response?.data),
    };
  }
}

// ─── Mapping ─────────────────────────────────────────────────────────────────
// <<CONFIRM in Phase 0 — exact demographic field names from JeMPI's
//  configurationReference / config-api.json on the running deployment.>>

function mapFhirPatientToJempi(p) {
  const name = (p.name || []).find(n => n.use === 'official') || p.name?.[0] || {};
  const nationalId = (p.identifier || []).find(i => i.system === SYS.NEPAL_HEALTH_ID);
  return {
    sourceId: {
      facility: '<<CONFIRM: how facility is determined — from headers? hardcoded? per-channel?>>',
      patient: nationalId?.value || '',
    },
    uniqueInteractionData: {
      auxDateCreated: new Date().toISOString(),
      auxId: nationalId?.value || '',
    },
    demographicData: {
      givenName: (name.given || []).join(' '),
      familyName: name.family || '',
      gender: p.gender || '',
      dob: p.birthDate || '',
      nationalId: nationalId?.value || '',
      // <<CONFIRM: add fields per JeMPI configurationReference — phone, address parts, etc.>>
    },
  };
}

function extractGoldenUid(data)      { return data?.linkInfo?.goldenUID ?? data?.goldenUID ?? data?.goldenUid ?? null; }
function extractInteractionUid(data) { return data?.linkInfo?.interactionID ?? data?.interactionID ?? data?.interactionUid ?? null; }
function extractCandidates(data)     { return data?.candidates ?? data?.goldenRecords ?? []; }
```

### 4.2 `scripts/test-jempi.js`

```js
import { registerInteraction } from '../src/providers/jempiProvider.js';
import { SYS } from '../src/fhir/identifiers.js';

const sample = {
  resourceType: 'Patient',
  identifier: [{ system: SYS.NEPAL_HEALTH_ID, value: '747128126' }],
  name: [{ use: 'official', family: 'SHRESTHA', given: ['KAMANA'] }],
  gender: 'female',
  birthDate: '2001-06-25',
};

const result = await registerInteraction(sample);
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
```

### 4.3 Phase 2 exit check

Run `npm run test:jempi` twice in a row with the same demographics. Second run must return the **same** `goldenUid`. If it doesn't, the mapping or the `crRegister` semantics need adjusting.

---

## 5. Phase 3 — Resource handlers

### 5.1 Patient — `src/handlers/patient.js`

```js
import { registerInteraction } from '../providers/jempiProvider.js';
import { postResource } from '../fhir/hapiClient.js';
import { buildOpenHIMResponse, orch } from '../lib/orchestration.js';
import { appendIdentifier, SYS } from '../fhir/identifiers.js';
import { config } from '../config.js';

export async function patientHandler(req, res) {
  const patient = req.body;
  const orchestrations = [];

  const link = await registerInteraction(patient);
  orchestrations.push(link.orchestration);
  if (!link.ok || !link.goldenUid) {
    return res.status(502).json(buildOpenHIMResponse({
      status: 502,
      body: oo(`JeMPI register failed: ${link.error ?? 'no goldenUid returned'}`),
      orchestrations, urn: config.MEDIATOR_URN,
    }));
  }

  appendIdentifier(patient, SYS.JEMPI_GOLDEN_UID, link.goldenUid);

  let hapi;
  try {
    hapi = await postResource('Patient', patient);
  } catch (err) {
    return res.status(502).json(buildOpenHIMResponse({
      status: 502, body: oo(`HAPI write failed: ${err.message}`),
      orchestrations, urn: config.MEDIATOR_URN,
    }));
  }
  orchestrations.push(orch('POST HAPI Patient', 'POST', '/Patient', patient, hapi.status, hapi.data));

  res.status(hapi.status).json(buildOpenHIMResponse({
    status: hapi.status, body: hapi.data, orchestrations, urn: config.MEDIATOR_URN,
  }));
}

function oo(diagnostics) {
  return { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'exception', diagnostics }] };
}
```

### 5.2 Encounter — `src/handlers/encounter.js`

```js
import { hapi, postResource } from '../fhir/hapiClient.js';
import { buildOpenHIMResponse, orch } from '../lib/orchestration.js';
import { config } from '../config.js';

export async function encounterHandler(req, res) {
  const enc = req.body;
  const orchestrations = [];

  // If subject is a conditional reference (Patient?identifier=...), resolve in HAPI
  if (enc.subject?.reference?.startsWith('Patient?')) {
    const query = enc.subject.reference.substring('Patient?'.length);
    const search = await hapi.get(`/Patient?${query}&_count=1`);
    orchestrations.push(orch('GET HAPI Patient search', 'GET', `/Patient?${query}`, null, search.status, search.data));
    const entry = search.data.entry?.[0];
    if (!entry) {
      return res.status(404).json(buildOpenHIMResponse({
        status: 404, body: oo(`No Patient matched ${enc.subject.reference}`),
        orchestrations, urn: config.MEDIATOR_URN,
      }));
    }
    enc.subject.reference = `Patient/${entry.resource.id}`;
  }

  const result = await postResource('Encounter', enc);
  orchestrations.push(orch('POST HAPI Encounter', 'POST', '/Encounter', enc, result.status, result.data));
  res.status(result.status).json(buildOpenHIMResponse({
    status: result.status, body: result.data, orchestrations, urn: config.MEDIATOR_URN,
  }));
}

function oo(diagnostics) { return { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found', diagnostics }] }; }
```

### 5.3 Observation — `src/handlers/observation.js`

Same shape as Encounter, but `subject` may be on `subject` or `patient`. Resolve whichever is present.

```js
import { hapi, postResource } from '../fhir/hapiClient.js';
import { buildOpenHIMResponse, orch } from '../lib/orchestration.js';
import { config } from '../config.js';

export async function observationHandler(req, res) {
  const obs = req.body;
  const orchestrations = [];
  const refField = obs.subject?.reference ? 'subject' : (obs.patient?.reference ? 'patient' : null);

  if (refField && obs[refField].reference.startsWith('Patient?')) {
    const query = obs[refField].reference.substring('Patient?'.length);
    const search = await hapi.get(`/Patient?${query}&_count=1`);
    orchestrations.push(orch('GET HAPI Patient search', 'GET', `/Patient?${query}`, null, search.status, search.data));
    const entry = search.data.entry?.[0];
    if (!entry) {
      return res.status(404).json(buildOpenHIMResponse({
        status: 404, body: oo(`No Patient matched ${obs[refField].reference}`),
        orchestrations, urn: config.MEDIATOR_URN,
      }));
    }
    obs[refField].reference = `Patient/${entry.resource.id}`;
  }

  const result = await postResource('Observation', obs);
  orchestrations.push(orch('POST HAPI Observation', 'POST', '/Observation', obs, result.status, result.data));
  res.status(result.status).json(buildOpenHIMResponse({
    status: result.status, body: result.data, orchestrations, urn: config.MEDIATOR_URN,
  }));
}

function oo(diagnostics) { return { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found', diagnostics }] }; }
```

### 5.4 Organization — `src/handlers/organization.js`

```js
import { postResource } from '../fhir/hapiClient.js';
import { buildOpenHIMResponse, orch } from '../lib/orchestration.js';
import { config } from '../config.js';

export async function organizationHandler(req, res) {
  const org = req.body;
  const result = await postResource('Organization', org);
  res.status(result.status).json(buildOpenHIMResponse({
    status: result.status, body: result.data,
    orchestrations: [orch('POST HAPI Organization', 'POST', '/Organization', org, result.status, result.data)],
    urn: config.MEDIATOR_URN,
  }));
}
```

### 5.5 Practitioner — `src/handlers/practitioner.js` (Option 2 dedup)

```js
import { hapi, postResource } from '../fhir/hapiClient.js';
import { buildOpenHIMResponse, orch } from '../lib/orchestration.js';
import { PRACTITIONER_DEDUP_SYSTEMS } from '../fhir/identifiers.js';
import { config } from '../config.js';

export async function practitionerHandler(req, res) {
  const prac = req.body;
  const orchestrations = [];

  // Check every registered council identifier the resource carries
  const councilIds = (prac.identifier || []).filter(i =>
    PRACTITIONER_DEDUP_SYSTEMS.includes(i.system) && i.value
  );

  for (const ident of councilIds) {
    const q = encodeURIComponent(`${ident.system}|${ident.value}`);
    const search = await hapi.get(`/Practitioner?identifier=${q}&_count=1`);
    orchestrations.push(orch('GET HAPI Practitioner dedup', 'GET', `/Practitioner?identifier=${q}`, null, search.status, search.data));
    const existing = search.data.entry?.[0]?.resource;
    if (existing) {
      // Merge: keep existing id, union identifiers, prefer incoming name/telecom/etc.
      const merged = mergePractitioners(existing, prac);
      const { data, status } = await hapi.put(`/Practitioner/${existing.id}`, merged);
      orchestrations.push(orch('PUT HAPI Practitioner', 'PUT', `/Practitioner/${existing.id}`, merged, status, data));
      return res.status(status).json(buildOpenHIMResponse({
        status, body: data, orchestrations, urn: config.MEDIATOR_URN,
      }));
    }
  }

  // No dedup hit — create new
  const result = await postResource('Practitioner', prac);
  orchestrations.push(orch('POST HAPI Practitioner', 'POST', '/Practitioner', prac, result.status, result.data));
  res.status(result.status).json(buildOpenHIMResponse({
    status: result.status, body: result.data, orchestrations, urn: config.MEDIATOR_URN,
  }));
}

function mergePractitioners(existing, incoming) {
  const idMap = new Map();
  for (const i of (existing.identifier || [])) idMap.set(`${i.system}|${i.value}`, i);
  for (const i of (incoming.identifier || [])) idMap.set(`${i.system}|${i.value}`, i);
  return {
    ...existing,
    ...incoming,
    id: existing.id,
    identifier: Array.from(idMap.values()),
    meta: existing.meta,
  };
}
```

### 5.6 DocumentReference — `src/handlers/documentReference.js`

```js
import { hapi, postBinary, postResource } from '../fhir/hapiClient.js';
import { buildOpenHIMResponse, orch } from '../lib/orchestration.js';
import { config } from '../config.js';

const VALID_MIME = /^(application\/pdf|image\/(png|jpe?g)|application\/fhir\+json|text\/plain)$/;

export async function documentReferenceHandler(req, res) {
  const docRef = req.body;
  const orchestrations = [];

  const att = docRef.content?.[0]?.attachment;
  if (!att) return res.status(400).json(buildOpenHIMResponse({ status: 400, body: oo('attachment is required'), urn: config.MEDIATOR_URN }));
  if (!att.contentType || !VALID_MIME.test(att.contentType))
    return res.status(400).json(buildOpenHIMResponse({ status: 400, body: oo(`Invalid contentType: ${att.contentType}`), urn: config.MEDIATOR_URN }));
  if (!att.data && !att.url)
    return res.status(400).json(buildOpenHIMResponse({ status: 400, body: oo('attachment.data or .url required'), urn: config.MEDIATOR_URN }));

  // Resolve conditional patient reference
  if (docRef.subject?.reference?.startsWith('Patient?')) {
    const query = docRef.subject.reference.substring('Patient?'.length);
    const search = await hapi.get(`/Patient?${query}&_count=1`);
    orchestrations.push(orch('GET HAPI Patient search', 'GET', `/Patient?${query}`, null, search.status, search.data));
    const entry = search.data.entry?.[0];
    if (!entry) return res.status(404).json(buildOpenHIMResponse({ status: 404, body: oo(`No Patient matched ${docRef.subject.reference}`), orchestrations, urn: config.MEDIATOR_URN }));
    docRef.subject.reference = `Patient/${entry.resource.id}`;
  }

  // Upload Binary if inline data
  if (att.data) {
    const buf = Buffer.from(att.data, 'base64');
    const bin = await postBinary(buf, att.contentType);
    orchestrations.push(orch('POST HAPI Binary', 'POST', '/Binary', { size: buf.length, contentType: att.contentType }, bin.status, { id: bin.data.id }));
    delete att.data;
    att.url = `Binary/${bin.data.id}`;
  }

  const result = await postResource('DocumentReference', docRef);
  orchestrations.push(orch('POST HAPI DocumentReference', 'POST', '/DocumentReference', docRef, result.status, result.data));
  res.status(result.status).json(buildOpenHIMResponse({
    status: result.status, body: result.data, orchestrations, urn: config.MEDIATOR_URN,
  }));
}

function oo(diagnostics) { return { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'invalid', diagnostics }] }; }
```

### 5.7 Phase 3 exit check

Use `scripts/test-handler.sh` to fire one curl per resource type with a known-good payload. Each should return 201 with HAPI's resource body and the mediator orchestrations visible in the OpenHIM Transactions tab.

---

## 6. Phase 4 — Bundle transactions

The sample Bundle you provided uses:
- `type: "transaction"`
- Internal `urn:uuid:` references (e.g., Encounter's `subject` points at `urn:uuid:747128126`)
- `ifNoneExist` on entries for idempotency

HAPI resolves all of this atomically when given the whole bundle. The mediator's job is only to **preprocess Patient entries through JeMPI** before forwarding the bundle.

### 6.1 `src/handlers/bundle.js`

```js
import { registerInteraction } from '../providers/jempiProvider.js';
import { postBundle } from '../fhir/hapiClient.js';
import { buildOpenHIMResponse, orch } from '../lib/orchestration.js';
import { appendIdentifier, SYS } from '../fhir/identifiers.js';
import { config } from '../config.js';

export async function bundleHandler(req, res) {
  const bundle = req.body;
  if (bundle.resourceType !== 'Bundle')
    return res.status(400).json(buildOpenHIMResponse({ status: 400, body: oo('Expected resourceType=Bundle'), urn: config.MEDIATOR_URN }));
  if (!['transaction', 'batch'].includes(bundle.type))
    return res.status(400).json(buildOpenHIMResponse({ status: 400, body: oo(`Bundle.type=${bundle.type} not supported`), urn: config.MEDIATOR_URN }));

  const orchestrations = [];

  // Preprocess every Patient entry through JeMPI, tag with golden UID in-place
  for (const entry of bundle.entry || []) {
    if (entry.resource?.resourceType !== 'Patient') continue;

    const link = await registerInteraction(entry.resource);
    orchestrations.push(link.orchestration);
    if (!link.ok || !link.goldenUid) {
      return res.status(502).json(buildOpenHIMResponse({
        status: 502,
        body: oo(`JeMPI register failed for Patient ${entry.fullUrl ?? '(no fullUrl)'}: ${link.error ?? 'no goldenUid'}`),
        orchestrations, urn: config.MEDIATOR_URN,
      }));
    }
    appendIdentifier(entry.resource, SYS.JEMPI_GOLDEN_UID, link.goldenUid);
  }

  // Post the whole (preprocessed) bundle to HAPI as a single transaction
  let result;
  try {
    result = await postBundle(bundle);
  } catch (err) {
    const status = err.response?.status ?? 502;
    return res.status(status).json(buildOpenHIMResponse({
      status, body: err.response?.data ?? oo(err.message),
      orchestrations, urn: config.MEDIATOR_URN,
    }));
  }

  orchestrations.push(orch('POST HAPI Bundle', 'POST', '/', { type: bundle.type, entryCount: bundle.entry?.length ?? 0 }, result.status, result.data));
  res.status(result.status).json(buildOpenHIMResponse({
    status: result.status, body: result.data, orchestrations, urn: config.MEDIATOR_URN,
  }));
}

function oo(diagnostics) { return { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'invalid', diagnostics }] }; }
```

### 6.2 Phase 4 exit check

POST the sample bundle from §0 to `http://localhost:4000/fhir`. Expect:
- 200 with a `Bundle.type=transaction-response`
- Each entry has a `response.status` of `201` (first run) or `200` with `ifNoneExist` no-op (second run)
- A subsequent `GET /fhir/Patient?identifier=http://mohp.gov.np/fhir/NamingSystem/nepal-health-id|747128126` returns one Patient with both the national-id and the `jempi-golden-uid` identifiers.

---

## 7. Phase 5 — GET search forwarding

### 7.1 `src/handlers/search.js`

```js
import { hapi } from '../fhir/hapiClient.js';
import { buildOpenHIMResponse, orch } from '../lib/orchestration.js';
import { config } from '../config.js';

const ALLOWED = new Set([
  'Patient', 'Encounter', 'Observation', 'Organization', 'Practitioner',
  'DocumentReference', 'Binary',
]);

export async function searchHandler(req, res) {
  const { resourceType, id } = req.params;
  if (!ALLOWED.has(resourceType)) {
    return res.status(404).json(buildOpenHIMResponse({
      status: 404, body: oo(`Resource type ${resourceType} not supported`),
      urn: config.MEDIATOR_URN,
    }));
  }

  const qs = new URLSearchParams(req.query).toString();
  const path = id
    ? `/${resourceType}/${id}${qs ? '?' + qs : ''}`
    : `/${resourceType}${qs ? '?' + qs : ''}`;

  try {
    const { data, status } = await hapi.get(path);
    res.status(status).json(buildOpenHIMResponse({
      status, body: data,
      orchestrations: [orch(`GET HAPI ${resourceType}`, 'GET', path, null, status, data)],
      urn: config.MEDIATOR_URN,
    }));
  } catch (err) {
    const status = err.response?.status ?? 502;
    res.status(status).json(buildOpenHIMResponse({
      status, body: err.response?.data ?? oo(err.message),
      orchestrations: [orch(`GET HAPI ${resourceType}`, 'GET', path, null, status, err.response?.data)],
      urn: config.MEDIATOR_URN,
    }));
  }
}

function oo(diagnostics) { return { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found', diagnostics }] }; }
```

### 7.2 Phase 5 exit check

All four sample searches must return Bundles with the expected entries:

```bash
curl -s 'http://localhost:4000/fhir/Observation?patient.identifier=http://mohp.gov.np/fhir/NamingSystem/nepal-health-id|668213210' | jq '.entry | length'
curl -s 'http://localhost:4000/fhir/Encounter?patient.identifier=http://mohp.gov.np/fhir/NamingSystem/nepal-health-id|747128126' | jq '.entry | length'
curl -s 'http://localhost:4000/fhir/Organization?identifier=3130400221' | jq '.entry | length'
curl -s 'http://localhost:4000/fhir/Patient?identifier=http://mohp.gov.np/fhir/NamingSystem/nepal-health-id|747128126' | jq '.entry | length'
```

---

## 8. Phase 6 — E2E through OpenHIM with a real JWT

### 8.1 Get a JWT from Keycloak

```bash
TOKEN=$(curl -s -X POST 'http://localhost:8088/realms/openhie/protocol/openid-connect/token' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=password' \
  -d 'client_id=<<CONFIRM: client_id from your Keycloak realm>>' \
  -d 'username=<<CONFIRM: test user>>' \
  -d 'password=<<CONFIRM>>' \
  | jq -r '.access_token')
echo "$TOKEN" | cut -c1-40
```

### 8.2 Register an OpenHIM Client whose `sub` matches the JWT

The mediator only auto-registers role + channel. The **Client record** that maps the Keycloak `sub` claim to the OpenHIM role must be created manually once via the OpenHIM Console (or seeded via a one-off script):

- Client ID: the `sub` claim value from the JWT
- Roles: `np-fhir-clients`
- (No password — JWT-only)

Confirm the Console shows the Client record before running the E2E script.

### 8.3 Hit OpenHIM end-to-end

```bash
curl -k -X POST 'https://localhost:5000/fhir' \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/fhir+json' \
  -d @scripts/sample-bundle.json
```

Expect 200 + a transaction-response Bundle. Check the OpenHIM Console Transactions tab — every step (JeMPI register, HAPI POST) should be listed as an orchestration on the transaction.

---

## 9. Out of scope (track separately)

- Per-EMR OpenHIM Client provisioning (manual today; could be automated against Keycloak as a future task)
- Switching JeMPI base URL to the Keycloak-protected `:50001` endpoint
- TLS termination in front of OpenHIM (currently self-signed dev cert)
- HAPI FHIR partitioning / multitenancy
- Production deployment topology
- Subscription / notification forwarding from HAPI

---

## 10. File checklist

- [ ] `package.json`
- [ ] `.env.example`, `.env` (gitignored)
- [ ] `src/index.js`
- [ ] `src/config.js`
- [ ] `src/openhim.js`
- [ ] `src/lib/logger.js`
- [ ] `src/lib/orchestration.js`
- [ ] `src/fhir/identifiers.js`
- [ ] `src/fhir/hapiClient.js`
- [ ] `src/providers/jempiProvider.js` *(placeholders until Phase 0 done)*
- [ ] `src/handlers/patient.js`
- [ ] `src/handlers/encounter.js`
- [ ] `src/handlers/observation.js`
- [ ] `src/handlers/organization.js`
- [ ] `src/handlers/practitioner.js`
- [ ] `src/handlers/documentReference.js`
- [ ] `src/handlers/bundle.js`
- [ ] `src/handlers/search.js`
- [ ] `scripts/test-jempi.js`
- [ ] `scripts/test-handler.sh`
- [ ] `scripts/e2e.sh`
- [ ] `scripts/sample-bundle.json`
- [ ] `README.md` (one-pager pointing at this guide)
