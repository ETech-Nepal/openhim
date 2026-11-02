# HAPI access rules

A HAPI FHIR interceptor that enforces the platform's access rules inside the FHIR server.
OpenHIM routes `/fhir` straight to HAPI; this module is the one place every read and
write is checked, whichever route or mediator the request came through.

It runs in the stock `hapiproject/hapi:v8.12.0-1` image. Every library it uses (HAPI,
Spring, nimbus-jose-jwt) is already in that image, so the jar holds only these classes.

## What it enforces

| Rule | Where |
| --- | --- |
| A verified Keycloak token on every request (RS256, realm JWKS, issuer, expiry), checked before request validation. `GET /metadata` is open. | `authenticate` |
| SMART v2 `system/` scopes for the operation: read, search, create, update, delete. No client is given delete. | `incoming`, storage hooks |
| Transaction and batch entries checked one by one, as requested and as stored. | `bundleRequest`, storage hooks |
| Patient create and update only from the identity mediator (`NP_IDENTITY_CLIENT_ID`). | `patientWriter` |
| On create, the resource gets the caller's `source-facility` tag; an Encounter gets the caller's Organization as `serviceProvider`. | `created` |
| Only the facility in the `source-facility` tag may update a record; the tag never changes. The identity mediator may move records between Patients on a merge. | `updated` |
| An identifier or conditional URL in another facility's NHFR namespace (`http://nhfr.digitalhealth.gov.np/<code>`) is refused. | `foreignNamespaces`, `foreignNamespaceUrl` |
| A Patient reference by MRN on the shared `hospital-mrn` system is refused; MRNs are scoped `hospital-mrn/<NHFR>`. | `bareMrnReferences` |
| A reference to a retired (merged) Patient is rewritten to the survivor. | `redirectRetiredPatients` |
| Searches name one patient (`Patient`: `identifier`/`_id`, or `telecom` for `NP_PHONE_LOOKUP_CLIENT_IDS`; clinical types: `patient`/`subject`); no chained or modified parameters, no wildcard `_include`, no Binary search, no type or system history. `_count` is capped at 100 by `max_page_size`. | `Rules.refuseSearch` |
| A conditional reference that matches several Patients fails with `412` (HAPI's own behaviour). | — |

## Configuration

`hapi-config/application.yaml`:

```yaml
hapi:
  fhir:
    custom-bean-packages: np.openhie.hapi
    custom-interceptor-classes: np.openhie.hapi.AccessInterceptor
    max_page_size: 100
```

Environment of the `fhir` container:

| Variable | Value |
| --- | --- |
| `NP_AUTH_ISSUER` | The realm issuer, exactly as in the tokens (same as OpenHIM's `KEYCLOAK_ISSUER`). |
| `NP_AUTH_JWKS_URI` | The realm JWKS, reachable from the container. |
| `NP_IDENTITY_CLIENT_ID` | The identity mediator's Keycloak client (default `identity-mediator`). |
| `NP_PHONE_LOOKUP_CLIENT_IDS` | Comma-separated clients that may also search Patient by `telecom` (the patient portal mediator's OTP login). Default: none. |

Mount the jar at `/app/extra-classes` (the image's loader path).

Operators no longer write to HAPI without a token. Organizations and Practitioners are
created by the `onboarding` client (`system/Organization.cru system/Practitioner.cru`).

## Build and test

No local Java is needed:

```bash
docker run --rm -v "$PWD:/w" -w /w maven:3.9-eclipse-temurin-21 mvn -B package
./it/run.sh
```

`mvn package` runs the unit tests (`Rules`). `it/run.sh` starts the real HAPI image with
the jar, a disposable PostgreSQL and a local JWKS server, and runs every rule above
against it. Run both before upgrading the HAPI image; keep `hapi.version` in `pom.xml`
equal to the image's HAPI version.
