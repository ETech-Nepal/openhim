# FHIR Transform mediator

An OpenHIM mediator that turns a source system's JSON into a validated FHIR
resource and passes it to the next service. In production it runs a single
integration, **Nagarik App citizen registration**
(`nagarik-app-registration-v1`):

```text
Nagarik App → OpenHIM Core → Transform mediator → NP Core validator (in-container)
                                               → NHID generator (assigns Health ID, stores Patient)
            ← flat JSON with the stored Patient and Health ID ←
```

- **[Nagarik registration API](docs/nagarik-registration.md)** covers the request
  and response contract, the FHIR mapping, error codes, and known limitations.
  Start here if you integrate with the Nagarik App.
- The rest of this README covers how to run and operate the service.

The mediator **does not** authenticate callers. OpenHIM does that. It also does
not look up, deduplicate, or store patients. The NHID generator, HAPI, and JeMPI
do that.

## Components

| Path                         | Role                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `src/index.ts`               | Startup: loads the config, registers with OpenHIM, starts the HTTP server, handles shutdown |
| `src/config.ts`              | Environment and `integrations.json` schema (zod). An invalid config stops startup.          |
| `src/app.ts`                 | Express routes, content-type and body-size guards, OpenHIM response envelope                 |
| `src/execute.ts`             | Pipeline: map → validate → NHID generation → response mapping, with error classification     |
| `src/http.ts`                | Outbound JSON transport (no proxy, no redirects, 1 MiB cap)                                 |
| `src/openhim.ts`             | Mediator registration, channel upsert, heartbeat                                            |
| `src/mappings/nagarik-app.ts`| **Nagarik mapping**: `toFhir`, `fromFhir`, `toError`                                        |
| `src/mappings/*.ts`          | Other mappings (`patient-registration-v1`, `hospital-encounter-v1`, `emr-fhir-patient-v1`). They are not deployed. |
| `start.sh`                   | Starts the HAPI validator CLI on `127.0.0.1:8081`, waits for it, then starts Node           |

## Configuration

### Environment

See `.env.example`.

| Variable                    | Default                        | Notes                                                                                          |
| --------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------- |
| `MEDIATOR_PORT`             | `4005`                         | HTTP port                                                                                      |
| `MEDIATOR_URN`              | `urn:mediator:fhir-transform`  | OpenHIM mediator URN                                                                           |
| `MEDIATOR_ROUTE_HOST`       | `fhir-transform-mediator`      | Hostname OpenHIM uses to reach this container. It must resolve on the OpenHIM network.        |
| `INTEGRATIONS_FILE`         | `/config/integrations.json`    | Mounted read-only in the image                                                                 |
| `MAX_BODY_BYTES`            | `1048576`                      | 1 KiB–10 MiB                                                                                   |
| `FHIR_VALIDATOR_IG`         | `/config/np.core-1.0.0.tgz`    | NP Core package that the validator loads                                                       |
| `VALIDATOR_URL`             | `http://127.0.0.1:8081/validateResource` | Must stay on this value. `start.sh` starts the validator on this port.               |
| `NHID_GENERATOR_URL`        | —                              | Required for Nagarik, for example `http://nhid-generator:9090/generate`                        |
| `OPENHIM_REGISTER`          | `true`                         | Set `false` only for isolated local development                                                |
| `OPENHIM_API_URL`           | `https://openhim-core:8080`    | OpenHIM Core API                                                                               |
| `OPENHIM_USERNAME` / `OPENHIM_PASSWORD` | —                  | Required when registration is on                                                               |
| `OPENHIM_TRUST_SELF_SIGNED` | `false`                        | Set `true` for the default self-signed OpenHIM certificate                                     |

URLs must be HTTP(S), with no embedded credentials and no fragment.
`OPENHIM_NETWORK` in `.env.example` is not read by the code. It only records the
Docker network name.

### `integrations.json`

The file is a list, and each entry is one channel. The deployed file enables only
Nagarik:

```json
[
  {
    "id": "nagarik-app-registration-v1",
    "channelPath": "/nagarik/registration",
    "mapping": "nagarik-app-registration-v1",
    "role": "national-app-clients",
    "options": {},
    "validation": {
      "urlEnv": "VALIDATOR_URL",
      "timeoutMs": 15000,
      "requestProfile": "http://fhir.digitalhealth.gov.np/core/StructureDefinition/np-core-patient"
    },
    "nhidGenerator": { "urlEnv": "NHID_GENERATOR_URL", "timeoutMs": 15000 }
  }
]
```

| Key                  | Meaning                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `id`                 | Unique. Appears in the OpenHIM channel name `FHIR Middleware: <id>` and in orchestration names. |
| `channelPath`        | Unique. The OpenHIM channel matches `^<channelPath>/?$`, `POST` only.                         |
| `mapping`            | A key of `src/mappings/index.ts`                                                              |
| `role`               | The OpenHIM client role that the channel allows                                               |
| `options`            | Mapping-specific options. Nagarik takes none (`{}`).                                          |
| `validation`         | Optional. If it is absent, the mapped resource is returned without validation.                |
| `nhidGenerator`      | Optional. If it is absent, the validated resource is returned, and the NHID generator is not called. |
| `*.urlEnv`           | Name of the environment variable that holds the URL. URLs are never written in the file.      |
| `*.authorizationEnv` | Optional. Name of the environment variable whose value is sent as `Authorization`.            |
| `*.timeoutMs`        | 10–120000, default 15000                                                                      |

`examples/integrations.example.json` shows the other mappings. They are not
used in production.

## Build, test, run

Requires Node 20.19 or later.

```bash
cd services/fhir-transform-mediator
npm ci
npm run typecheck && npm run lint && npm test
npm run build
```

The tests stub the validator and NHID generator, so they need neither service.
For local development without OpenHIM, run the validator CLI yourself, set
`OPENHIM_REGISTER=false` and `INTEGRATIONS_FILE=integrations.json`, then run
`npm run dev`, which starts the mediator directly. You can then call it on port
4005 without authentication.

### Container

CI publishes `ghcr.io/etech-nepal/fhir-transform-mediator:<sha>`
(`.github/workflows/publish-images.yml`). The image contains Node, Java 17, and
`validator_cli.jar`. It does **not** contain `integrations.json` or the IG
package, so mount both read-only:

```bash
docker run --env-file .env \
  --network openhim_openhim --name transform-mediator \
  -v "$PWD/integrations.json:/config/integrations.json:ro" \
  -v "$PWD/../../hapi-config/np.core-1.0.0.tgz:/config/np.core-1.0.0.tgz:ro" \
  ghcr.io/etech-nepal/fhir-transform-mediator:<sha>
```

```yaml
# Compose equivalent
volumes:
  - ./integrations.json:/config/integrations.json:ro
  - ./np.core-1.0.0.tgz:/config/np.core-1.0.0.tgz:ro
```

The container name, or a network alias, must match `MEDIATOR_ROUTE_HOST`.

Startup order inside the container:

1. `start.sh` starts the validator CLI (`-version 4.0.1 -ig $FHIR_VALIDATOR_IG`)
   and polls it until it answers. Loading the IG takes some time on the first
   start.
2. Node parses the environment and `integrations.json`. Any error exits with
   `Mediator startup failed…`. The mediator logs no details, because the config
   can contain secrets.
3. If `OPENHIM_REGISTER=true`, the mediator registers with OpenHIM, **creates or
   overwrites** each channel by name, and starts the heartbeat. A failure here
   also stops startup.
4. The mediator listens on `MEDIATOR_PORT`.

## Operating

- **Health:** `GET /health` on port 4005 returns `{"status":"ok"}`. It checks
  only the Node process, not the validator or the NHID generator.
- **Channel changes:** each restart overwrites channel settings from
  `integrations.json` and `src/openhim.ts`, including `allow`, `timeout`, and
  `urlPattern`. Edits made in the OpenHIM Console to `FHIR Middleware: <id>`
  are lost on restart, so change the config instead.
- **Tracing:** every response has an `X-Correlation-ID` header. OpenHIM
  transactions record `properties.correlationId`, `integration`, and `mapping`,
  plus one orchestration per stage (`<id>: request-validation`,
  `<id>: nhid-generation`), each with its status and timestamps.
- **What is logged:** the mediator logs no patient payloads, validator
  diagnostics, NHID messages, or credentials, whether in stdout or
  orchestrations. The caller receives the HealthID service's error `message`
  and the validator's diagnostics verbatim, plus a stable `code`. See the [Nagarik API doc](docs/nagarik-registration.md#error-responses).
- **Network exposure:** only OpenHIM should be able to reach port 4005. The
  mediator has no allowlist of its own, and a direct call bypasses
  authentication.
- **Validator version:** the image downloads the `latest` `validator_cli.jar`
  at build time. Validation behaviour can therefore change between image builds.
  Pin a release in the `Dockerfile` if you need reproducible builds.

### Troubleshooting

| Symptom                                               | Check                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Container exits with `Mediator startup failed`        | `integrations.json` is mounted and valid, `NHID_GENERATOR_URL` is set, and OpenHIM credentials and URL are correct (`OPENHIM_TRUST_SELF_SIGNED=true` for self-signed). |
| Startup hangs before `listening on port 4005`         | The validator is still loading the IG, or `FHIR_VALIDATOR_IG` does not point at a mounted `.tgz`.      |
| OpenHIM returns 500 or "Could not connect"            | `MEDIATOR_ROUTE_HOST` does not resolve from `openhim-core`, or the container is on another network.   |
| OpenHIM returns 401 or 403                            | Token, DPoP, or client role. This is OpenHIM-side, and the mediator was not called.                   |
| Every request returns `validator_failed` or `upstream_unavailable` at request-validation | The validator crashed inside the container. Check `docker logs` for Java errors, and restart.          |
| `upstream_unavailable` at nhid-generation             | `NHID_GENERATOR_URL` host is unreachable from this container.                                          |
| `fhir_validation_failed` for valid-looking data       | Location or caste codes not in NP Core 1.0.0. Run the mapped Patient through the validator manually to read the diagnostics. The API hides them from callers. |
| OpenHIM times out but the mediator later succeeds     | The channel timeout is validation `timeoutMs` + NHID `timeoutMs` + 5 s (35 s by default). Restart the mediator after changing either timeout so the channel is updated. |

## Adding a mapping

1. Add `src/mappings/<name>.ts` that exports an `options` zod schema and
   `toFhir`. Add `fromFhir` to reshape a success response, and `toError` to
   reshape error bodies.
2. Register it in `src/mappings/index.ts` under a versioned key, such as
   `<name>-v1`.
3. Add an entry to `integrations.json`, and add tests in
   `test/mediator.test.ts`.

`execute.ts` does not change. Breaking contract changes need a new versioned
mapping key, so existing callers keep working.
