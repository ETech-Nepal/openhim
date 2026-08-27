# OpenHIE (OpenHIM-first) Sandbox Template

This repo is a developer-friendly starter for learning OpenHIE-style interoperability by building:

- **OpenHIM Core + Console + MongoDB** (interoperability layer "spine")
- a **FHIR server** (HAPI) as a downstream system
- a **simple mediator** (Node/Express) that registers to OpenHIM and forwards requests to the FHIR server
- a **registration mediator** that orchestrates Organization lookup + Patient upsert + Encounter creation in one API call
- a **FHIR intake mediator** (`POST /ingest`) that converts raw CDRS encounter JSON to a Patient+Encounter transaction Bundle and passes supported FHIR JSON straight through to the registration mediator — see [`fhir-intake-mediator/README.md`](fhir-intake-mediator/README.md)

## 0) Prereqs

- Docker + Docker Compose v2+
- A terminal (bash/powershell)

## 1) Start everything

```bash
docker compose up -d --build
```

OpenHIM Console: http://localhost:9000

Default login (first run):

- username: root@openhim.org
- password: openhim-password

> You may be asked to accept the self-signed TLS certificate used by OpenHIM Core.
> Open https://localhost:8080/heartbeat in your browser and accept the certificate.

## 2) Add the mediator's default channel

The mediator registers itself with OpenHIM. To activate its channel:

1. In Console, go to **Mediators**
2. Click **FHIR Forwarder Mediator**
3. Click the green **+** button next to the default channel config to add it

This creates a channel that matches URLs starting with `/fhir/` and routes to the mediator.

## 3) Create a client for testing (Basic Auth)

1. Go to **Clients** → **+ Client**
2. Create:
   - Client ID: `DEMO`
   - Name: `Demo Client`
   - Add role: `DEMO`
   - Authentication: **Basic**
   - Password: `demopassword`
3. Edit the created channel and allow role/client `DEMO` (or keep `admin` during early testing).

## 4) Test an end-to-end request

This creates a Patient in the HAPI FHIR server (via OpenHIM → mediator → HAPI FHIR):

```bash
curl -X POST "http://localhost:5001/fhir/Patient"   -H "Authorization: Basic $(echo -n DEMO:demopassword | base64)"   -H "Content-Type: application/fhir+json"   -d '{
    "resourceType":"Patient",
    "name":[{"use":"official","family":"Test","given":["OpenHIE"]}],
    "gender":"unknown"
  }'
```

Check:

- OpenHIM Console → **Transactions**
- HAPI UI: http://localhost:8081/ (FHIR base URL is http://localhost:8081/fhir/)

## 5) Where to change things

- OpenHIM config: `docker-compose.yml` (ports, auth types, etc.)
- Mediator code: `patient-mediator/`, `organization-mediator/`, `encounter-mediator/`
- Shared NP Core builders/systems: `shared/npcore/` (imported by every mediator as `#npcore`)
- Target downstream: set `TARGET_FHIR_BASE` in docker-compose

## Notes

- If you change the OpenHIM `root@openhim.org` password on first login, update the mediator env vars accordingly.

## Registration (split by resource)

Responsibilities are split per resource and each mediator emits NP Core resources:

- **Patient** registration → patient-mediator (creates/upserts the NP Core Patient, keyed on the Nepal Health ID).
- **Encounter** registration → encounter-mediator. It does **not** create the Patient; each Encounter references the patient by Nepal Health ID.

Encounter endpoint:

```bash
POST http://localhost:3003/encounter
```

