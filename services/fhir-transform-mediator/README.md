# FHIR Transform mediator

An OpenHIM mediator that turns a source system's JSON into validated FHIR and
hands it to a named downstream channel. Applications and FHIR mappings are
configuration, not code: adding a source system means adding an app config
file and, only when needed, a new versioned resource mapping.

It runs three apps, each registered as its own OpenHIM channel
(`FHIR Middleware: <app id>`) with its own config:

| App (OpenHIM channel)         | Route                   | Client role            | After validation                                                     |
| ----------------------------- | ----------------------- | ---------------------- | -------------------------------------------------------------------- |
| `normal-mapper-v1`            | `/transform/patient`    | `transform-clients`    | Returns the FHIR Patient (`200`). Nothing is sent anywhere.          |
| `nagarik-app-registration-v1` | `/nagarik/registration` | `national-app-clients` | POSTs the Patient to the NHID service (`nhid-registration`), `202`   |
| `emr-mapper-v1`               | `/emr/encounter`        | `emr-clients`          | POSTs a transaction Bundle to the OpenHIM `/fhir` channel (`hapi-fhir`), which fhir-mediator routes to JeMPI and HAPI, `202` |

```text
Client → OpenHIM Core → Transform mediator → NP Core validator (in-container)
                                           → the app's delivery channel, if any (one-way hand-off)
       ← 200 FHIR (normal) | 202 {"status":"accepted","correlationId":"…"} ←
```

- **[Nagarik registration API](docs/nagarik-registration.md)** covers the request
  and response contract, the FHIR mapping, and error codes.
- The rest of this README covers configuration and operation.

The mediator **does not** authenticate callers (OpenHIM does), and it does not
wait for downstream business processing. The downstream channel owns Health ID
generation, persistence, deduplication, and all later errors and results.

## Components

| Path                      | Role                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------- |
| `src/index.ts`            | Startup: loads the catalog, registers with OpenHIM, starts the HTTP server              |
| `src/config.ts`           | Environment schema and `loadCatalog`. An invalid catalog stops startup before registration. |
| `src/mapping/select.ts`   | Source selectors (`$`, `.name`, `[n]` only)                                              |
| `src/mapping/template.ts` | Resource mapping templates (five directives, below)                                     |
| `src/execute.ts`          | Pipeline: extract → map → validate → dispatch → acknowledge                             |
| `src/app.ts`              | Express routes, content-type and body-size guards, OpenHIM response envelope            |
| `src/http.ts`             | Outbound JSON transport (no proxy, no redirects, 1 MiB cap)                             |
| `src/openhim.ts`          | Mediator registration, channel upsert, heartbeat                                        |
| `config/`                 | The catalog (below). Built into the image at `/app/config`.                              |
| `start.sh`                | Starts the HAPI validator CLI on `127.0.0.1:8081`, waits for it, then starts Node        |

## Configuration catalog

```text
config/
  apps.json                          registry: app ID → app config file
  channels.json                      named endpoints, by environment-variable name
  apps/
    nagarik-registration.v1.json     Patient → NHID service
    normal-mapper.v1.json            Patient → returned to the caller
    emr-mapper.v1.json               Patient + Encounter → transaction Bundle → HAPI FHIR channel
  mappings/
    patient.np-core.v1.json          shared NP Core Patient contract
    encounter.r4.v1.json             shared R4 Encounter contract
```

Only apps listed in `apps.json` are loaded and registered; remove an entry to
disable that app and its OpenHIM channel. All files are validated at startup: unknown mappings or channels,
duplicate app IDs or routes, paths outside the config directory, unset or
unsafe endpoint URLs, unsupported template directives, and mappings whose
required fields an app does not provide all stop startup before OpenHIM
registration.

### `channels.json`

```json
{
  "validator": { "urlEnv": "VALIDATOR_URL", "timeoutMs": 15000 },
  "nhid-registration": { "urlEnv": "NHID_REGISTRATION_URL", "timeoutMs": 10000 },
  "hapi-fhir": {
    "urlEnv": "HAPI_FHIR_CHANNEL_URL",
    "authorizationEnv": "HAPI_FHIR_CHANNEL_AUTHORIZATION",
    "timeoutMs": 15000
  }
}
```

`urlEnv` and `authorizationEnv` are environment-variable **names**. URLs and
credentials never appear in any config file. URLs must be HTTP(S), with no
embedded credentials and no fragment. Only channels that a loaded app uses must
be set. `timeoutMs` is 10–120000, default 15000.

### App config

| Key                         | Meaning                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `route`                     | Unique. The OpenHIM channel matches `^<route>/?$`, `POST` only.                                      |
| `role`                      | OpenHIM client role the channel allows                                                               |
| `input.strict`              | `true` rejects any input key that no field selector covers                                           |
| `input.fields.<name>`       | One canonical field: `path` (a selector) or `value` (a fixed app-level value), plus the rules below  |
| `resources[]`               | `{ key, mapping, refs?, request? }`. One entry returns that resource; several build one Bundle.      |
| `bundleType`                | `collection` or `transaction`; required exactly when there are several resources                     |
| `resources[].refs`          | `{ "<canonical field>": "<other resource key>" }`: the field receives that entry's `urn:uuid:` fullUrl |
| `resources[].request`       | Transaction entry request; defaults to `{ "method": "POST", "url": "<resourceType>" }`               |
| `validation`                | `{ channel, profile?, ignore?, messages? }`. `ignore` lists validator message fragments that do not block, such as the Health ID slice the downstream service fills in. `messages` sets the rule text per issue code (`code-invalid`, `required`, `default`), e.g. `"is not a valid NP Core code"`. |
| `delivery`                  | Optional `{ channel, successStatuses, relayErrors? }`. Absent: the validated FHIR is returned with `200`. |
| `errors`                    | Optional `{ messages, template }`: the app's own error body (see below)                              |
| `acknowledgement`           | Optional `{ message, template? }`: the body returned with `202` (see below)                          |

Field rules: `required`, `type` (`string` default, or `integer`), `maxLength`,
`pattern` (always matched against the whole value), `format` (`date`,
`email`), `enum`, `minimum`/`maximum`, and `rule`, the fixed text shown when the
value is invalid. Strings are trimmed. `echo: true` lets an error template read
the field; use it only for request identifiers, never patient data.

### Selectors

`$`, `.name`, and `[n]` only, for example `$.citizen.nameEn.family` or
`$.patients[0].last_name`. There are no wildcards, filters, functions, or
scripts. A path the input does not contain yields no value.

### Resource mappings

A mapping file declares its canonical fields (`required` or `optional`) and a
FHIR template. It contains no source-specific paths. Mappings are immutable
versioned contracts: the file name must equal `<id>.json`, and a changed
contract gets a new file such as `patient.np-core.v2.json`.

| Directive                               | Result                                                                       |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| `{ "$field": "name" }`                  | The field's value. An absent field is a `400 request_mapping_failed`.        |
| `{ "$literal": <json> }`                | The JSON as is, even if it looks like a directive                            |
| `{ "$lookup": "name", "map": {…} }`     | `map[value]`; a value missing from the map is a `400`                        |
| `{ "$if": "name" \| ["a","b"], "then": <template> }` | `then` when any named field is present; otherwise the key or array element is omitted |
| `{ "$format": "Ward {ward_no}" }`       | String interpolation; every placeholder must be present                      |

Every other JSON value is a literal. Optional output must be wrapped in `$if`,
so an absent field is omitted, never serialized as `null` or `"undefined"`.

## Dispatch, acknowledgement, and errors

After validation, an app with `delivery` POSTs the FHIR resource or Bundle to
its channel with an `X-Correlation-ID` header and waits only for the
acceptance status:

- A status in `successStatuses` → `202` with the app's acknowledgement:
  `{"status":"accepted","message":"<acknowledgement.message>","correlationId":"…"}`,
  or the `acknowledgement.template` rendered with `ack.status`, `ack.message`,
  `ack.correlation_id`, and echo fields. A success body from downstream is never read.
- A 4xx/5xx with a JSON object body, when `relayErrors` is `true` → that status
  and body, unchanged. Nagarik uses this so the NHID service's own
  `{"status":false,"message":"…"}` reaches the user.
- Any other status, or a connection failure → `502 dispatch_failed`.
- A timeout → `504 dispatch_timeout`.

Dispatch is **never retried**: a timed-out request may already have been
accepted. Downstream consumers must be idempotent on the correlation ID and
must carry it in their own callback, event, or error path. If a caller cannot
receive a callback, result storage and lookup by correlation ID belong to a
separate service.

Mediator-owned errors:

| Status | `code`                     | Stage                |
| ------ | -------------------------- | -------------------- |
| 400    | `request_mapping_failed`   | `request-mapping`    |
| 400    | `invalid_request_body`     | `input`              |
| 413    | `invalid_request_body`     | `input`              |
| 415    | `unsupported_content_type` | `input`              |
| 422    | `fhir_validation_failed`   | `request-validation` |
| 502    | `validator_failed`, `upstream_unavailable` | `request-validation` |
| 504    | `upstream_timeout`         | `request-validation` |
| 502    | `dispatch_failed`          | `dispatch`           |
| 504    | `dispatch_timeout`         | `dispatch`           |

Without an `errors.template`, the body is
`{ error, stage, correlationId, issues? }`. With one, the template is rendered
with `error.code`, `error.stage`, `error.message`, `error.correlation_id`,
`error.field`, `error.path`, `error.issues` (only when there are several), and
the app's `echo` fields. Issue messages are fixed text and field names; they
never contain submitted values, validator diagnostics, or credentials. Only a
relayed downstream error (`relayErrors`) carries downstream text. A validator issue is attributed to the source field that
produced the failing FHIR element when it can be.

## Environment

See `.env.example`.

| Variable                    | Default                        | Notes                                                                 |
| --------------------------- | ------------------------------ | --------------------------------------------------------------------- |
| `MEDIATOR_PORT`             | `4005`                         | HTTP port                                                             |
| `MEDIATOR_URN`              | `urn:mediator:fhir-transform`  | OpenHIM mediator URN                                                  |
| `MEDIATOR_ROUTE_HOST`       | `fhir-transform-mediator`      | Hostname OpenHIM uses to reach this container                         |
| `CONFIG_DIR`                | `config` (`/app/config` in the image) | Catalog directory                                              |
| `MAX_BODY_BYTES`            | `1048576`                      | 1 KiB–10 MiB                                                          |
| `FHIR_VALIDATOR_IG`         | `/config/np.core-1.0.0.tgz`    | NP Core package that the validator loads                              |
| `VALIDATOR_URL`             | `http://127.0.0.1:8081/validateResource` | Must stay on this value. `start.sh` starts the validator here. |
| `NHID_REGISTRATION_URL`     | —                              | NHID service that receives Nagarik Patients, for example `https://hiecoretest.mohp.gov.np/healthid/api/generate` |
| `HAPI_FHIR_CHANNEL_URL`     | —                              | OpenHIM FHIR base for EMR Bundles, for example `http://openhim-core:5001/fhir` |
| `HAPI_FHIR_CHANNEL_AUTHORIZATION` | —                        | Sent as `Authorization` on that channel (client with role `np-fhir-clients`) |
| `OPENHIM_REGISTER`          | `true`                         | Set `false` only for isolated local development                       |
| `OPENHIM_API_URL`           | `https://openhim-core:8080`    | OpenHIM Core API                                                      |
| `OPENHIM_USERNAME` / `OPENHIM_PASSWORD` | —                  | Required when registration is on                                      |
| `OPENHIM_TRUST_SELF_SIGNED` | `false`                        | Set `true` for the default self-signed OpenHIM certificate            |

## Build, test, run

Requires Node 20.19 or later.

```bash
cd services/fhir-transform-mediator
npm ci
npm test && npm run typecheck && npm run lint && npm run format:check
npm run build
```

The tests stub the validator and the delivery channels. For local development
without OpenHIM, run the validator CLI yourself, set `OPENHIM_REGISTER=false`,
then `npm run dev`.

### Container

CI publishes `ghcr.io/etech-nepal/fhir-transform-mediator:<sha>`. The image
contains Node, Java 17, `validator_cli.jar`, and the default catalog at
`/app/config`. It does **not** contain the IG package. To run a different
catalog, mount it read-only over `/app/config`:

```yaml
volumes:
  - ./config:/app/config:ro             # optional: override the built-in catalog
  - ./np.core-1.0.0.tgz:/config/np.core-1.0.0.tgz:ro
```

Startup order: `start.sh` starts the validator and waits for it; Node parses the
environment and the catalog (any error exits with `Mediator startup failed…`
and logs no details, because configuration can hold secrets); if
`OPENHIM_REGISTER=true` it registers, **creates or overwrites** each channel by
name, and starts the heartbeat; then it listens.

## Operating

- **Health:** `GET /health` returns `{"status":"ok"}`. It checks only the Node process.
- **Channel changes:** each restart overwrites `FHIR Middleware: <app id>`
  channels from the catalog, including `allow`, `timeout`, and `urlPattern`.
  The channel timeout is validation `timeoutMs` + delivery `timeoutMs` + 5 s; it
  never includes downstream processing time.
- **Tracing:** every response has `X-Correlation-ID`, which is also sent to the
  delivery channel. OpenHIM transactions record `properties.correlationId`,
  `integration`, `mapping`, and one orchestration per stage
  (`<id>: request-validation`, `<id>: dispatch`).
- **What is logged:** no patient payloads, validator diagnostics, downstream
  bodies, or credentials, in stdout or orchestrations.
- **Network exposure:** only OpenHIM should reach port 4005.

### Troubleshooting

| Symptom                                   | Check                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| Container exits with `Mediator startup failed` | Catalog is valid (`npm test` loads it), every channel an app uses has its env vars set, OpenHIM credentials and URL are correct. |
| `upstream_unavailable` at request-validation | The in-container validator crashed; check `docker logs`.                                |
| `dispatch_failed`                         | The delivery channel is unreachable or returned a status not in `successStatuses`. Check the downstream OpenHIM transaction with the same correlation ID. |
| `dispatch_timeout`                        | The request may still have been accepted. Check downstream by correlation ID before resubmitting. |
| `fhir_validation_failed` for valid-looking data | Codes not in NP Core 1.0.0. Run the mapped resource through the validator manually; callers do not receive diagnostics. |

## Adding an app

1. Add `config/apps/<name>.v1.json` with selectors for the canonical fields
   the chosen mappings declare.
2. Add a channel to `config/channels.json` if it delivers somewhere new, and
   set its environment variables.
3. Add `{ "id": "<name>-v1", "config": "apps/<name>.v1.json" }` to
   `config/apps.json`, and a test in `test/mediator.test.ts`.

Add a mapping only when no existing versioned mapping produces the resource you
need. No TypeScript changes are needed for either.
