# NP FHIR MPI Orchestrator (mediator)

OpenHIE-compliant FHIR mediator. Sits between OpenHIM and HAPI FHIR, resolving
Patient identity through JeMPI before persisting, and passing other resources
through with light validation/enrichment.

> **Full design + phase plan:** see [`../FHIR_MEDIATOR_IMPLEMENTATION.md`](../FHIR_MEDIATOR_IMPLEMENTATION.md).
> That file is the source of truth — read it before changing anything here.

## Quick start (Docker)

The mediator runs as the `mediator` service in the root `docker-compose.yml`.

```bash
cp .env.example .env        # fill in OPENHIM_PASSWORD and any JEMPI_* routes
cd ..                       # repo root
docker compose up -d mediator
docker compose logs -f mediator
```

Then verify:

1. `curl http://localhost:4000/health` → `{"status":"ok"}` (port 4000 is exposed)
2. OpenHIM Console (`http://localhost:9000`) → Mediators tab shows
   **NP FHIR MPI Orchestrator** heartbeating.
3. Channels tab shows **NP FHIR Orchestrator** (`urlPattern ^/fhir/.*$`).

## Topology

- The mediator runs **in Docker** on the `openhim` network. OpenHIM reaches it at
  `mediator:4000` (the channel route host, set via `MEDIATOR_ROUTE_HOST`). It
  talks to OpenHIM at `openhim-core:8080` and HAPI at `fhir:8080` — all internal
  service names.
- To run on the host instead, set `MEDIATOR_ROUTE_HOST=host.docker.internal`
  (and add that host-gateway mapping to `openhim-core`), point
  `OPENHIM_API_URL`/`HAPI_FHIR_BASE_URL` at `localhost`, and `npm run dev`.
- JeMPI is remote, reached over the WireGuard tunnel
  (`http://10.8.0.1:50000/JeMPI`); the container routes there via the host.

## Layout

```
src/
  index.js          Express app, routes, startup
  config.js         env validation (zod)
  openhim.js        role + channel + mediator registration
  providers/        jempiProvider.js
  handlers/         patient, encounter, observation, organization,
                    practitioner, documentReference, bundle, search
  fhir/             hapiClient.js, identifiers.js
  lib/              orchestration.js, logger.js
scripts/            test-jempi.js, test-handler.sh, sample-bundle.json, e2e.sh
```

## Scripts

| Command | What |
|---|---|
| `npm run dev` | run with `--watch` |
| `npm start` | run once |
| `npm run test:jempi` | round-trip a sample Patient to JeMPI |
| `scripts/test-handler.sh` | Phase 3 per-resource smoke test |
| `scripts/e2e.sh` | Phase 6 end-to-end through OpenHIM with a real JWT |
