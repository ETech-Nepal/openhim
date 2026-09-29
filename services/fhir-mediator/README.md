# FHIR MPI mediator

The `mediator` Compose service owns `/fhir`. It resolves Patient identity through JeMPI before writing HAPI FHIR. Its runtime hostname, channel name, URN configuration, and port remain unchanged.

## Run and verify

Requires Node.js 20.19 or newer. From this service directory:

```bash
npm ci
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm start
```

Use `npm run dev` for TypeScript watch mode. Configure `.env` using `.env.example`; `src/config.ts` defines the environment contract. Tests use synthetic configuration and upstream substitutes, with local HTTP listeners for app tests.

From the repository root:

```bash
docker build -t fhir-mediator:local services/fhir-mediator
docker compose up -d --build mediator
docker compose exec mediator node -e "fetch('http://127.0.0.1:4000/health').then(r => r.json()).then(console.log)"
```

Compose exposes no host port for this service. OpenHIM authenticates clients and reaches `mediator:4000` internally. The channel is `NP FHIR Orchestrator`, pattern `^/fhir(/.*)?$`, with the configured `OPENHIM_CHANNEL_ROLE`.

## Structure

```text
src/
  index.ts                 startup and registration
  app.ts                   HTTP assembly without listening
  config.ts                environment configuration
  clients/                 HAPI and JeMPI HTTP adapters
  modules/patient/         identity resolution, Health ID, Patient handler
  modules/bundle/          Bundle preprocessing and submission
  modules/resources/       other resource write handlers
  modules/search/          supported-resource reads
  fhir/                    local resource types, identifiers, provenance
  openhim/                 channel registration
  lib/                     logging, errors, orchestration envelopes
  scripts/                 explicitly invoked operational tools
test/                      TypeScript regression tests
scripts/                   shell smoke tests and sample Bundle
```

Each service installs and builds independently. Production source and tools compile in strict TypeScript to `dist/`; tests run as TypeScript using tsx and Node's test runner. Production images exclude tests and development dependencies.

## Request flow

1. Parse the supported JSON content type.
2. Dispatch the matching FHIR handler.
3. Resolve identity or conditional references when required.
4. Call HAPI and return the existing OpenHIM response envelope.

All async route rejections now reach HTTP error middleware instead of leaving requests hanging. Health returns plain JSON. Existing generic error replies remain OperationOutcome responses.

## Identity invariants

Patient and Bundle ingestion share one identity function. JeMPI's golden record owns the Health ID; HAPI assigns an opaque resource ID. Patient writes are conditional on the Health-ID identifier, never on a caller-supplied resource ID. Valid legacy numeric Health IDs remain accepted alongside the letter-prefixed format.

Identifiers retain previous facilities' MRNs. Incoming values replace stale values for other explicitly supplied systems. Authenticated `X-OpenHIM-ClientID` determines facility provenance, with configured legacy registry overrides. Payload organization is a fallback only for local callers without that header.

Bundle Patient fullUrl references remain intact for HAPI transaction resolution. Clinical provenance is added only when exactly one Patient is present; multi-Patient attribution is not guessed. JeMPI timestamps keep nonzero milliseconds so Java's serialization cannot omit seconds.

JeMPI registration followed by failed HAPI writing is tested with a synthetic duplicate response on retry. This verifies mediator identity reuse, not live upstream guarantees. Admin merge correctness remains separate from this migration.

## Operational tools

Build before invoking compiled tools:

| Command | Effect |
| --- | --- |
| `npm run create-client` | Provision/update an OpenHIM client using HIP_CLIENT_SUB and configured administrator credentials |
| `npm run test:jempi` | Submit a sample Patient interaction to the configured JeMPI instance |
| `node dist/scripts/check-openhim-auth.js <candidates>` | Check supplied authentication candidates; prints candidate numbers, not passwords |
| `scripts/test-handler.sh` | Send resource smoke requests to a running stack |
| `scripts/e2e.sh` | Exercise a running stack through OpenHIM |

These commands are operational actions and are not invoked by routine validation.
