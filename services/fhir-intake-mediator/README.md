# FHIR Intake Mediator

An OpenHIM mediator that owns `POST /ingest`. It accepts either raw CDRS encounter
JSON or supported FHIR JSON, and pushes both through the existing **NP FHIR MPI
Orchestrator** (`mediator:4000` on the `openhim` network). The orchestrator stays
responsible for JeMPI, Nepal Health ID generation, provenance, and HAPI writes —
this service only converts and forwards, then merges the downstream orchestrations
into one OpenHIM transaction.

## Content-type contract

| Request `Content-Type`            | Treated as | Behaviour                                                    |
| --------------------------------- | ---------- | ----------------------------------------------------------- |
| `application/json`                | raw        | Validate one CDRS encounter row, convert to a two-entry FHIR R4 transaction Bundle (Patient + Encounter), forward to `/fhir`. |
| `application/fhir+json`           | FHIR       | Validate the resource type, forward **unmutated** to the matching `/fhir` path. |
| anything else (`application/json+fhir`, `text/plain`, none) | — | `415` with a FHIR OperationOutcome. |

An optional `; charset=...` parameter is allowed on both accepted types. No other
parameters are.

Supported FHIR inputs: `Patient`, `Encounter`, `Observation`, `Organization`,
`Practitioner`, `DocumentReference`, and `transaction` / `batch` Bundles. A
`collection` Bundle or any other `resourceType` returns `400`.

## Trust boundary and facility identity

The facility is the OpenHIM-supplied **`X-OpenHIM-ClientID`**, and nothing else.
OpenHIM sets it from the authenticated client (it equals the Keycloak token
`sub`) and strips any inbound copy, so a caller cannot forge it. That value is
the facility's **NHFR code**. Any client-supplied `X-NHFR-ID` header or
`organization_id` field in the payload is never used for attribution, and only
`X-OpenHIM-ClientID` is forwarded downstream.

Before converting a raw row the mediator resolves the facility once —
`GET Organization?identifier=http://mohp.gov.np/fhir/NamingSystem/nhfr|<clientID>` —
and requires **exactly one** match. `Patient.managingOrganization` and
`Encounter.serviceProvider` are then stamped with that resolved
`Organization/<uuid>`. `Organization.id` is a server-assigned UUID; the NHFR code
lives in `Organization.identifier`.

| Status | Meaning |
| ------ | ------- |
| `403`  | The request carries no `X-OpenHIM-ClientID` (not an authenticated OpenHIM client). |
| `415`  | Unsupported `Content-Type`. |
| `422`  | No Organization — or more than one — has NHFR identifier `<clientID>`. Nothing is written. |
| `400`  | Raw row failed validation, or an unsupported FHIR resource / Bundle type. |
| `502`  | The FHIR orchestrator could not be reached or returned a non-envelope response. Downstream *application* errors (`4xx`/`5xx` inside a valid envelope) are passed through unchanged, not turned into `502`. |

> Provision each facility with `keycloak/create-org.sh <nhfr-id> "<name>"` (one
> Organization per NHFR code — the script enforces it) and set the hospital
> client's Keycloak token `sub` to that same code (see `keycloak/SETUP.md`
> §4e/§6d).

## Raw CDRS row

Required: `hospital_patient_number`, `encounter_number`, one of
`first_name` / `last_name`, `sex`, `department_type` (`C`, `E`, or `N`),
`department_id`, `department_name`, `visit_date_ad_time`
(`YYYY-MM-DD HH:MM:SS.mmm`, a real calendar date/time).

Optional: `imis_id` (9-digit BIMA insurance number), `dob` (`YYYY-MM-DD`),
`phone_number` (10 digits). The strings `""`, `"  "`, and `"None"` (any case) are
treated as absent. Identifier leading zeroes are preserved.

Mapping highlights:

- `imis_id` → `Patient.identifier` with system `.../bima-insurance-number` (omitted when absent).
- `hospital_patient_number` → `Patient.identifier` `.../hospital-mrn`, scoped by an `assigner` reference to the resolved `Organization/<uuid>`.
- `department_type` `C` → `AMB`, `E` → `EMER`, `N` → `IMP` on `Encounter.class`.
- `visit_date_ad_time` → `Encounter.period.start` with the `+05:45` Nepal offset.
- `Encounter` entry carries `ifNoneExist=identifier=<encounter-number>` so a replay does not create a duplicate.

## Configuration

Copy `.env.example` to `.env` and set `OPENHIM_PASSWORD`. Every variable is
documented in `.env.example`; `src/config.ts` parses and freezes it at startup.
There is no facility registry — identity comes from the request.

## Run

```bash
# local checks (synthetic data; HTTP tests use loopback)
npm ci
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build

# local development / compiled runtime
npm run dev
npm start

# from the repository root
docker compose up -d --build mediator fhir-intake-mediator
docker compose logs --tail=100 fhir-intake-mediator   # expect: listening on :4003, channel "NP FHIR Intake" upserted
```

There is no host port. OpenHIM reaches the service at `fhir-intake-mediator:4003`
and exposes it as the `NP FHIR Intake` channel (`^/ingest/?$`, `POST` only, role
`np-fhir-intake-clients`).

Health check: `GET /health` → `{"status":"ok"}`.

## Example requests (through OpenHIM)

Raw:

```bash
curl -H "Authorization: Bearer $ACCESS_TOKEN" \
     -H "Content-Type: application/json" \
     --data-binary '{
       "imis_id":"771929535","hospital_patient_number":"2405078",
       "encounter_number":"2110732","first_name":"CHANDRIKA","last_name":"KANDEL",
       "sex":"Female","dob":"1986-07-28","phone_number":"9864437500",
       "department_type":"C","department_id":"22","department_name":"Family Medicine",
       "visit_date_ad_time":"2026-07-28 00:02:00.000"
     }' \
     "$OPENHIM_URL/ingest"
```

FHIR pass-through:

```bash
curl -H "Authorization: Bearer $ACCESS_TOKEN" \
     -H "Content-Type: application/fhir+json" \
     --data-binary '{"resourceType":"Patient","name":[{"family":"Kandel"}]}' \
     "$OPENHIM_URL/ingest"
```

## Orchestration trail

Each request produces **one** OpenHIM transaction. For a raw row its
orchestrations are, in order: the intake→orchestrator `GET Organization?identifier=…`,
the orchestrator's own nested HAPI Organization read, the intake→orchestrator
Bundle POST, then the orchestrator's nested JeMPI and HAPI writes. A FHIR
pass-through skips the two Organization steps.

## End-to-end script

`scripts/e2e.sh` replays fixtures through a running stack. It requires
`OPENHIM_TRANSACTION_URL`, `ACCESS_TOKEN`, `TEST_NHFR_ID` (the NHFR code stamped
as an `Organization.identifier` for the reachability check), and `HAPI_FHIR_URL`,
and exits with a message if any is missing.


## Source layout

`src/index.ts` starts the service and registers with OpenHIM. `src/app.ts` builds the HTTP app without listening. `src/modules/ingest/` owns input validation, CDRS mapping, and the linear ingestion handler. `src/middleware/` handles content types; `src/clients/` owns downstream HTTP and envelope decoding. Small service-local helpers live in `src/lib/`.

TypeScript checks production source in strict mode. Tests run directly as TypeScript with the Node test runner through tsx. Production images contain compiled `dist/` and production dependencies only. Build independently from the repository root with `docker build -t fhir-intake-mediator:local services/fhir-intake-mediator`.

Malformed Organization lookup results are rejected at the downstream boundary, before conversion. OpenHIM registration failures still allow standalone startup. No live provisioning or patient write is part of `npm test`.
