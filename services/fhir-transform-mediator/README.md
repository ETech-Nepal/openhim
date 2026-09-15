# FHIR Transform mediator

This mediator maps an accepted source payload to FHIR, validates the FHIR
resource, and returns it to OpenHIM. OpenHIM authenticates and authorizes
callers before it routes traffic here.

```text
Nagarik app or EMR → OpenHIM → Transform mediator → FHIR validator
                           ← validated FHIR resource ←
```

It does not look up patients, generate NHIDs, write to NHID/HAPI/JeMPI, forward
requests, or authenticate callers. A future downstream service belongs in an
OpenHIM route after this mediator; it is not configured here.

## Routes

| Route | Input | Result |
| --- | --- | --- |
| `POST /nagarik/registration` | Nagarik registration JSON | Validated FHIR Patient |
| `POST /emr/fhir` | FHIR Patient from an EMR | The validated FHIR Patient |

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
  openhie-fhir-transform-mediator
```

For Compose, use the equivalent read-only bind mount:

```yaml
volumes:
  - ./integrations.json:/config/integrations.json:ro
```

Each integration needs an OpenHIM role, a versioned mapping, mapping options,
and optionally a FHIR validator. Set `VALIDATOR_URL` to an HTTP(S) endpoint
accepting a FHIR resource POST and returning an `OperationOutcome`; `fatal` and
`error` issues reject the resource. If no validator is configured, mapping-only
operation remains available for local development.

Keep this service reachable only from OpenHIM. OpenHIM owns user validation and
channel authorization; the mediator deliberately has no second client allowlist.

## Errors

Mapping errors return 400, invalid FHIR returns 422, malformed validator replies
return 502, and validator timeouts return 504. Orchestrations record validation
metadata only, never patient payloads or credentials.
