# FHIR Transform mediator

This mediator maps an accepted source payload to FHIR, validates the FHIR
resource, and returns it to OpenHIM. OpenHIM authenticates and authorizes
callers before it routes traffic here.

```text
Nagarik app → OpenHIM → Transform mediator → local NP Core validator
                       ← validated FHIR resource ←
```

It does not look up patients, generate NHIDs, write to NHID/HAPI/JeMPI, forward
requests, or authenticate callers. A future downstream service belongs in an
OpenHIM route after this mediator; it is not configured here.

## Routes

| Route | Input | Result |
| --- | --- | --- |
| `POST /nagarik/registration` | Nagarik registration JSON | Validated FHIR Patient |

Responses are OpenHIM envelopes (`application/json+openhim`); the FHIR resource
is in `response.body`. The mediator accepts `application/json` and
`application/fhir+json`.

## Configure and run

```bash
npm ci
cp examples/integrations.example.json integrations.json
npm run typecheck
npm test
npm run build
```

The image does not contain deployment integrations. Mount the selected JSON
configuration read-only when starting the container:

```bash
docker run --env-file .env \
  -v "$PWD/integrations.json:/config/integrations.json:ro" \
  -v "$PWD/../../hapi-config/np.core-1.0.0.tgz:/config/np.core-1.0.0.tgz:ro" \
  openhie-fhir-transform-mediator
```

For Compose, use the equivalent read-only bind mount:

```yaml
volumes:
  - ./integrations.json:/config/integrations.json:ro
  - ./np.core-1.0.0.tgz:/config/np.core-1.0.0.tgz:ro
```

The image starts HAPI's validator CLI once as a local HTTP service and waits for
it before the mediator accepts requests. It validates against the mounted NP
Core package at `FHIR_VALIDATOR_IG`; `VALIDATOR_URL` must remain
`http://127.0.0.1:8081/validateResource`. `fatal` and `error` issues reject the
resource, except the sole NP Core requirement for
`Patient.identifier:healthId`, which is temporarily ignored.

Keep this service reachable only from OpenHIM. OpenHIM owns user validation and
channel authorization; the mediator deliberately has no second client allowlist.

## Errors

Mapping errors return 400, invalid FHIR returns 422, malformed validator replies
return 502, and validator timeouts return 504. Orchestrations record validation
metadata only, never patient payloads or credentials.
