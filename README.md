# OpenHIE Nepal Health Interoperability Platform

An OpenHIE-style health information exchange for hospital systems, CDRS intake,
and patient-facing services using FHIR R4.

OpenHIM authenticates and routes requests. The mediators manage patient
identity, FHIR persistence, duplicate review, CDRS conversion, and
patient-scoped reads. HAPI FHIR stores clinical records, Keycloak issues client
tokens, and JeMPI provides the external master patient index.

## Components

- **OpenHIM Core and Console**: authentication, routing, and transaction audit trail.
- **Keycloak**: hospital and service-client authentication using RS256 JWTs.
- **FHIR MPI Orchestrator**: patient registration, Nepal Health ID generation,
  JeMPI matching, and HAPI FHIR writes.
- **FHIR Intake mediator**: converts raw CDRS encounter rows into FHIR
  transactions through `POST /ingest`.
- **Admin Review mediator**: identifies and merges possible duplicate records.
- **Patient Portal mediator**: returns patient-scoped, read-only clinical summaries.
- **HAPI FHIR**: the clinical FHIR R4 data store.
- **JeMPI**: the external master patient index.

## Start locally

```bash
git clone https://github.com/ETech-Nepal/openhim_single.git openhie_stack
cd openhie_stack
docker compose up -d --build
```

The stack needs Docker Compose v2, mediator `.env` files, and a reachable JeMPI
instance. Follow the [Linux setup guide](SETUP-LINUX.md) or the
[Windows setup guide](SETUP-WINDOWS.md) before starting it.

## Documentation

Start with the [documentation index](docs/00-documentation-index.md).

| Need | Document |
|---|---|
| Install and configure the stack | [Linux setup](SETUP-LINUX.md) · [Windows setup](SETUP-WINDOWS.md) |
| Deploy to a VPS | [VPS deployment](VPS-DEPLOYMENT.md) |
| Understand components and data flows | [Architecture and DFDs](ARCHITECTURE-AND-DFD.md) |
| Understand design choices | [Architecture decisions](ARCHITECTURE-DECISIONS.md) |
| Review API endpoints and payloads | [API reference](docs/16-api-reference.md) |
| Configure identity matching | [JeMPI configuration](jempi-config/README.md) |
| Understand Nepal Health IDs | [Health ID flow](HID-GENERATION-FLOW.md) |

## Service documentation

- [FHIR MPI Orchestrator](services/fhir-mediator/README.md)
- [FHIR Intake mediator](services/fhir-intake-mediator/README.md)
- [Admin Review mediator](services/admin-mediator/README.md)
- [Keycloak setup](keycloak/README.md)

## Security note

Keep mediators on the internal Docker network. OpenHIM provides their client
authentication and transaction logging. For a public deployment, use the Caddy
VPS profile and replace the default credentials before exposing any service.
