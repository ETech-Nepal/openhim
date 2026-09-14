# FHIR transformation mediator implementation plan

Goal: a separate service for JSON → FHIR → configured external API → JSON,
with reusable mappings and OpenHIM integration. The external API owns NHID and
HAPI persistence. All changes stay inside this new service directory.

Architecture: pure, versioned mapping functions; a single synchronous execution
function; deployment-owned integration bindings and credentials; OpenHIM HTTP
envelopes and registration. No database, identity generation, or automatic write
retries. Existing converter and other services remain untouched.

Stack: TypeScript, Express 4, Zod 3, Axios, existing OpenHIM mediator utilities,
Node's test runner. Reuse dependency versions from the intake service.

- [x] Add failing behavior checks for registration without NHID, reverse mapping,
  a distinct Encounter mapping, configuration rejection, and ordered execution.
- [x] Implement `src/mappings/`, `src/config.ts`, `src/http.ts`, and
  `src/execute.ts`; verify malformed input never reaches the destination,
  ambiguous returned IDs fail, external failures retain their stage, and writes
  are never repeated after timeouts or response mapping failure.
- [x] Add `src/app.ts`, `src/openhim.ts`, and `src/index.ts`; verify identity
  allowlists, conversion-only routes, OpenHIM envelopes, and registration config.
- [x] Add service-local Docker configuration and examples documenting the
  provisional national application contract and required external API settings.
- [x] Run tests, strict type checks, build, formatting, and a local synthetic HTTP
  round trip; check that this task's edits are confined to the new service.

Verification: 17 tests pass, including actual local HTTP request/response,
timeout, redirect, and payload-limit checks. Strict type checking, lint, build,
and formatting pass. Service-local Compose configuration parses; the container
was not built or deployed. Independent review identified upstream issue-text
leakage; a failing regression reproduced it and the fix passes. Unrelated
concurrent Keycloak changes in the workspace were left untouched.

The national application and NHID API contracts have not been provided. Included
registration and encounter mappings are explicit example contracts, not a claim
of compatibility with the live service. Destination and validator URLs must be
configured by operators; registration accepts no pre-generated health ID.
