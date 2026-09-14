# FHIR Transform mediator

A separate OpenHIM mediator for versioned JSON/FHIR mappings and synchronous
external API calls. It does not generate NHIDs, use JeMPI, or persist resources.
The existing `FHIR_Convert_Server` and the other mediators are unchanged.

```text
National app → OpenHIM → this mediator → external NHID generator
                                              ↓       ↑
                                              HAPI FHIR
National app ← OpenHIM ← this mediator ← FHIR response
```

The execution path is shared. Each integration binds an authorized client list,
mapping, destination, and validator. Mapping functions perform no network I/O.
New source schemas require explicit mappings; no field meaning is inferred.

## Current scope and external contract

`nagarik-app-registration-v1` maps the supplied Nagarik App citizen request to
FHIR Patient fields defined by NP Core 1.0.0: national ID, citizenship,
insurance, English and Nepali names, gender, AD and BS dates, caste, contacts,
and Nepal administrative address extensions. Its returned Patient must include
exactly one NP Core Nepal Health ID; it returns `{ patientReference, healthId }`.
No live NHID service has been contacted, so its exact request/response envelope
and persistence acknowledgement still need contract testing.

`patient-registration-v1` remains an example contract for another source.
Nagarik fields are strict and unknown fields are rejected rather than silently
discarded. Identifiers remain strings, preserving leading zeroes.

There is deliberately no input `healthId` requirement or generated placeholder.
The NP Core Patient profile bundled in the reference converter requires an
existing health ID, so it cannot automatically be used as the pre-registration
profile. Set `validation.requestProfile` to the generator's accepted input
profile and `validation.responseProfile` to the agreed returned-resource profile.
If omitted, the validator performs base FHIR validation; this does not certify
conformance to a national implementation guide. The mapper does not assert
`meta.profile` conformance itself.

Successful submission currently requires HTTP 200 or 201 and a FHIR Patient
representation with `id` and exactly one identifier matching `healthIdSystem`.
It returns `{ "patientReference": "Patient/patient-1", "healthId": "..." }`.
The identifier system URIs in the examples come from the reference converter;
confirm them against the actual NHID API. A Bundle, Parameters, empty response,
or asynchronous 202 requires a different explicit response contract.

The second mapping, `hospital-encounter-v1`, converts an encounter JSON object
with an already resolved `patientReference`. Its identifier system is configured
per hospital, avoiding collisions between hospitals that reuse encounter numbers.
It returns `{ encounterReference, status }` from a returned FHIR Encounter.

## Endpoints

| Endpoint | Behavior |
| --- | --- |
| `GET /health` | Local process liveness; does not check external dependencies |
| `POST /transform/:integrationId/request` | JSON → FHIR, local schema checks only, no external calls |
| `POST /transform/:integrationId/response` | FHIR → JSON, local response contract checks only, no external calls |
| `POST /nagarik/registration` | Nagarik JSON → FHIR → validate → NHID → validate response → JSON |
| `POST /emr/fhir` | EMR FHIR Patient → validate → NHID → validate response → JSON |

Both JSON media types (`application/json` and `application/fhir+json`) are
accepted. The selected integration and direction determine the schema.
Conversion-only endpoints do not perform full profile validation. Submissions
require a configured validator; missing submission settings return 503.

All POST responses are OpenHIM envelopes (`application/json+openhim`). OpenHIM
unwraps `response.body` and its content type for the caller. When calling the
mediator directly in isolated local tests, decode that envelope yourself.

## Configure and run

From this directory:

```bash
npm ci
cp .env.example .env
cp examples/integrations.example.json integrations.json
npm run typecheck
npm run lint
npm test
npm run build
```

The default integration example supports conversion only. Set the actual
OpenHIM API credentials, route host, roles, and client IDs in `.env` and
`integrations.json`. Both files are ignored by Git. `allowedClients` is checked
against OpenHIM's authenticated `X-OpenHIM-ClientID`; it is not a role name.
Multiple source applications can bind different integrations to the same mapping.

To enable registration submission, copy
`examples/integrations.submission.example.json` to `integrations.json`, then set
`NHID_URL`, `NHID_AUTHORIZATION`, `FHIR_SERVER_URL`, and `PATIENT_VALIDATOR_URL`. `NHID_URL` is the HealthID Generator endpoint (the supplied collection uses `https://hiecoretest.mohp.gov.np/healthid/api/generate`). `FHIR_SERVER_URL` is the base FHIR server URL, not the HealthID validation endpoint. All URLs are full
operator-configured HTTP(S) endpoints. HTTPS is required for external production
traffic; HTTP is useful on an isolated development network. No inbound request
can supply the destination or outgoing credentials. Omit `authorizationEnv` only
if the corresponding trusted endpoint requires no Authorization header.

The validator endpoint must support a FHIR resource POST and return an
`OperationOutcome` containing at least one issue; `error` and `fatal` reject the
resource. It must load any configured profiles. `requestProfile` and
`responseProfile` are optional canonical URLs added as `?profile=...`; they may
differ. The reference converter's custom `/validateResource` protocol is not
assumed. Authentication can be configured separately for the validator using
its own `authorizationEnv`.

For service-local Docker deployment, with the existing OpenHIM network running:

```bash
docker compose -f compose.yaml up -d --build
```

This Compose file is independent of the root Compose file and publishes no host
ports. It joins the existing `openhim_openhim` network; set `OPENHIM_NETWORK` if
your network has another name. Its port/route host are fixed to 4005 and
`fhir-transform-mediator`. Deploy only after filling in the configuration.

For isolated local development, set `OPENHIM_REGISTER=false` and run `npm start`.
Do not expose the listener publicly: it trusts the identity header established
by OpenHIM, and any caller with direct network access can impersonate a client.
Registration is enabled by default and startup fails if it cannot complete.
Configure internal CA trust through Node's `NODE_EXTRA_CA_CERTS` when necessary;
`OPENHIM_TRUST_SELF_SIGNED=true` only relaxes OpenHIM API TLS for local development,
not the external API or validator.

## Example requests through OpenHIM

Use an OpenHIM client whose ID and roles match your integration settings:

```bash
curl -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @examples/nagarik-app-registration.json \
  "$OPENHIM_URL/transform/nagarik-app-registration-v1/request"

curl -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/fhir+json' \
  --data-binary @examples/registration-response.fhir.json \
  "$OPENHIM_URL/transform/nagarik-app-registration-v1/response"
```

After the submission integration and external contract are configured, POST the
same application JSON to `/nagarik/registration` to execute
the complete flow. That endpoint performs a real external write.

## Errors, retry behavior, and audit

Errors have `error`, `stage`, `correlationId`, `downstreamOutcome`, and optional
issue codes/local mapping field paths. Upstream issues expose severity and an
allowlisted code only; other codes become `processing`. Upstream diagnostics,
FHIRPath expressions, and credentials are not returned or logged. Statuses include 400 for mapping/JSON errors, 403 for
client rejection, 413 for oversized input, 415 for unsupported content, 422 for
invalid outgoing FHIR, 502 for invalid upstream responses, and 504 for timeouts.
Downstream 4xx/5xx statuses are preserved with a JSON error contract.

`downstreamOutcome` separates `not-called`, `rejected`, `unknown`, and `success`.
`success` means the external endpoint returned its expected HTTP success status;
it is not independent verification of HAPI persistence. A response mapping or
validation failure after that success retains `success`. Timeouts and incomplete
202 acknowledgments are `unknown`. Never assume a timeout means no write occurred.

There are **no automatic retries**, redirects, or follow-up HAPI writes. Registered
OpenHIM channels explicitly disable auto-retry and set their timeout to the sum
of the lookup, generator, and two validation call budgets plus five seconds. Configure any front proxy
with a larger deadline too. After an uncertain result, use the
external system's documented reconciliation/retry process. This mediator does
not store a durable idempotency ledger. `forwardIdempotencyKey=true` forwards a
SHA-256 key scoped by integration ID, authenticated client ID, and the supplied
`Idempotency-Key`. Enable it only when the external API supports that header and
its semantics; otherwise the key is not forwarded. The original app's bearer
token and identity headers are never forwarded to the external endpoint.

The mediator registers two channels per integration (conversion and submission),
then upserts only its named channels at startup and emits heartbeats. Body capture
is off by default. Orchestrations contain stage names, paths without query
strings, timestamps, and HTTP statuses, not patient payloads or Authorization
headers. Correlation and mapping IDs are returned as transaction properties.
Logs contain lifecycle messages only. Restrict direct network access to the
mediator. Removing an integration rejects it at runtime; remove its stale
OpenHIM channels separately if desired. Restart to apply mapping/config changes.

Pointing the destination to another OpenHIM channel is possible, but it must be
an independently authorized endpoint returning unwrapped FHIR. Service credentials
identify this mediator on that hop; original facility delegation needs an agreed
contract and is not inferred or forwarded as a trusted header.

## Health ID lookup before generation

Submission integrations can configure a `lookup` block with a FHIR server base URL,
optional service authorization, timeout, and `matchIdentifierSystems`. After request
FHIR validation, the middleware performs `GET {FHIR_SERVER_URL}/Patient` with one
FHIR `identifier=system|value` parameter for each configured system. It independently
requires every configured identifier to match exactly in returned Patient resources:
no match calls the HealthID Generator, one match returns its Health ID immediately,
and more than one match returns `409 multiple_existing_patients` without generating.

This deliberately makes the match policy an operator decision. The supplied example
uses the national-ID system `http://donidcr.gov.np`; use additional identifier systems
only after the national matching policy is agreed. The lookup response must be a FHIR
`Bundle` with `type: "searchset"`; invalid responses or lookup failures fail closed
and never call the generator.

## Add another integration

1. Add a pure module under `src/mappings/` with `toFhir`, `fromFhir`, and a Zod
   options schema. Define what fields are required, omitted, or normalized.
2. Register a versioned name in `src/mappings/index.ts` and test both directions.
3. Add an integration binding with its own client allowlist, role, options,
   destination, and validation profiles. Destination is optional for conversion.
4. Run tests/build and redeploy this service. The executor does not change.

Tests use synthetic data and local HTTP servers. They cover ordered execution,
conversion without writes, client isolation, response mapping failures after
submission, external validation, redirects, payload limits, timeout behavior,
and idempotency key scoping. They do not prove live OpenHIM/NHID interoperability.

Architecture references: [OpenHIM mediator contract](https://openhim.org/docs/dev-guide/developing-mediators/)
and [FHIR R4 REST interactions](https://hl7.org/fhir/R4/http.html).
