# OpenHIE Nepal Health Interoperability Platform

An OpenHIE-style health information exchange for hospital and laboratory systems
and CDRS intake, using FHIR R4 and the NP Core 1.0.0 implementation guide.

OpenHIM authenticates every request (DPoP-bound Keycloak token) and routes it.
FHIR clients use the standard `/fhir` base: Patient writes go to the identity
mediator, Bundles to the transform mediator, everything else straight to HAPI
FHIR. HAPI enforces the access rules itself, so a client's rights are the same
whichever route its request takes.

## Components

| Component | Source | Does |
| --- | --- | --- |
| HAPI FHIR + access rules | [`hapi-interceptors/`](hapi-interceptors/README.md) | Clinical store. The plugin verifies the token on every request, checks SMART v2 scopes, stamps and checks the owning facility, limits searches to one patient, redirects references to merged Patients, and accepts Patient writes only from the identity mediator |
| Identity mediator | [`services/identity-mediator/`](services/identity-mediator/README.md) | Every Patient write: JeMPI match, Health ID issuing (its `health_ids` table is the only issuer), HAPI Patient upsert with `If-Match`, per-hospital MRNs. Duplicate review and merge for the admin portal (`/admin`) |
| Transform mediator | [`services/fhir-transform-mediator/`](services/fhir-transform-mediator/README.md) | Config-driven input: CDRS rows on `/transform/cdrs`, FHIR Bundles posted to `/fhir`. Validates against NP Core, sends Patients to the identity mediator and the rest to HAPI with the client's token, one result per row |
| OpenHIM Core and Console | | Authentication, routing, transaction log |
| Keycloak | [`keycloak/`](keycloak/README.md) | Clients, SMART scopes per client type, DPoP-bound tokens |
| JeMPI | [`jempi-config/`](jempi-config/README.md) | Client registry (golden records), on its own host |

`services/patient-portal-mediator` serves the patient portal (outside the PRS scope).
It reads HAPI with its own read-only client, the only client allowed to find a
Patient by phone.

Routes:

| Route | Goes to |
| --- | --- |
| `POST`, `PUT /fhir/Patient[/<id>]` | Identity mediator |
| `POST /fhir` (Bundle) | Transform mediator, `fhir-bundle-v1` |
| `POST /transform/cdrs` | Transform mediator, `cdrs-v1` (up to 100 rows) |
| `GET /fhir/...`, `POST`, `PUT /fhir/<Type>[/<id>]` | HAPI |
| `/admin/*` | Identity mediator (admin portal only) |

No route allows DELETE, and no facility may write Organizations or Practitioners.
The design and the defects it fixes are in [CRITICAL-FIXES.md](CRITICAL-FIXES.md).

## Deploy

The deployment lives in the `single_stack` repository
([openhim_single](https://github.com/ETech-Nepal/openhim_single)); its README covers
configuration, first start, onboarding, upgrading an existing stack and the smoke
test. It pulls the images CI publishes from this repository, tagged with the commit
SHA: `openhie-hapi`, `openhie-identity-mediator`, `fhir-transform-mediator`.

`docker-compose.yml` here builds the same services from source for development.

## Test

| What | How |
| --- | --- |
| Identity mediator | `cd services/identity-mediator && npm test` (needs PostgreSQL; see its README) |
| Transform mediator | `cd services/fhir-transform-mediator && npm test` |
| HAPI plugin | `cd hapi-interceptors`, then `mvn package` and `./it/run.sh` (real HAPI image; see its README) |
| Whole stack | Build the three images with tag `e2e`, run `e2e/up.sh <scratch-dir>` (local stack with a JeMPI stub, ports 15000, 18080, 18081, 18083), run `docs/tor/evidence/run_e2e.py` against it (settings in the script's header), then `e2e/down.sh <scratch-dir>` |

A run against the JeMPI stub checks behaviour only. The evidence files in
`docs/tor/evidence/` must come from a run against the real stack and JeMPI.

## Documentation

Operator and architecture documentation is in
[openhim_docs](https://github.com/ETech-Nepal/openhim_docs/blob/main/docs/00-documentation-index.md).
