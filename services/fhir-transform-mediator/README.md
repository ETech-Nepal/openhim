# FHIR Transform mediator

This mediator maps an accepted source payload to FHIR, validates the FHIR
resource, and returns it to OpenHIM. OpenHIM authenticates and authorizes
callers before it routes traffic here.

```text
Nagarik app → OpenHIM → Transform mediator → local NP Core validator → NHID generator
                       ← NHID generator response ←
```

It does not look up patients, write to HAPI/JeMPI, or authenticate callers.
For integrations configured with `nhidGenerator`, it sends the validated FHIR
resource to that service, then returns the stored `Patient` to Nagarik as flat
JSON that uses FHIR element names and IG codes:

```json
{
  "requestId": "NAG-2026-09-14-0001842",
  "source": "nagarik-app",
  "patient": {
    "nationalId": "1234-5678-9012-3",
    "citizenshipNumber": "12-34-56-78901",
    "healthInsuranceNumber": "HIB-000123456",
    "healthId": "WE1353934",
    "name": [{ "given": ["Aarav"], "family": "Shrestha" }],
    "gender": "male",
    "birthDate": "1990-05-15",
    "birthDateBS": "2047-02-01",
    "casteEthnicity": "1",
    "telecom": { "phone": "+9779801234567" },
    "address": {
      "province": "3",
      "district": "306",
      "localLevel": "30608",
      "wardNo": 10,
      "country": "NP"
    }
  }
}
```

Codes are the IG's own (`gender` is the `AdministrativeGender` code, not a
display). A `Patient` the mapping cannot read returns 502
`response_mapping_failed`; validation and NHID failures return a Nagarik JSON
error message in `response.body`.

## Routes

| Route                        | Input                     | Result                 |
| ---------------------------- | ------------------------- | ---------------------- |
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

NHID generator failures (`{"status": false, "message": ...}`) are classified into
stable codes; the upstream message is never forwarded, only its classification:

| NHID service message                                                          | Code                                              | Status                                |
| ----------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------- |
| `Missing field(s): ...`                                                       | `nhid_missing_fields` (`issues` lists the fields) | 400                                   |
| `Gender and phone number are required to generate a new HealthID`             | `nhid_missing_gender_or_phone`                    | 400                                   |
| `Not a valid FHIR Patient request: ...`                                       | `nhid_rejected_resource`                          | 502                                   |
| `NID already exists but the provided data does not match the existing record` | `nhid_identity_mismatch`                          | 409                                   |
| `NID already exists`                                                          | `nhid_existing_record`                            | 409                                   |
| anything else (including 500/502 from the service)                            | `nhid_service_failed`                             | 400/409 passed through, otherwise 502 |
