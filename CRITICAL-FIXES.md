# Restructure and Critical Fixes: Implementation Plan

This file started as the list of critical defects found when the PRS handover
documentation (`openhim-tor-docs`) was checked against the code on 29 September
2026. On 1 October 2026 the team decided to fix those defects as part of a
restructure of the platform, not inside the current mediators. Part A
describes the target architecture, Part B maps every defect to the component
that fixes it, Part C is the implementation order, and Part D lists the
document changes.

**Decisions taken on 1 October 2026**

- Implement the restructure now, before the handover, and update the handover
  documents to describe it.
- Client types: hospital and laboratory now; more types later, added as
  Keycloak scopes without code changes.
- Authorization at HAPI is a Java interceptor module, not a TypeScript proxy.
- Demographics live only in JeMPI and HAPI. A demographic change for an
  existing person updates those two, nothing else.
- The identity mediator is the only Health ID issuer. A public "find my Health
  ID" lookup is future work (Part E).
- Out of scope: the patient portal and the Nagarik app registration channel.

**Status on 2 October 2026**

| Phase (Part C) | Status | Tested by |
| --- | --- | --- |
| 1. Platform hardening | Done in `single_stack` (items 10, 11, 12) | e2e cases for DPoP and roles |
| 2. Identity mediator | Done: `services/identity-mediator` (items 1, 2, 4, 5 merge part, 9 mediator part, 3 MRN part); backfill and MRN migration scripts | 43 tests against a real PostgreSQL, including the lock test |
| 3. HAPI interceptor module | Done: `hapi-interceptors/`, image `openhie-hapi` on HAPI 8.12 (items 3, 5, 6, 7, 13) | 32 integration scenarios against the real HAPI image |
| 4. Transform mediator | Done: `cdrs-v1` (up to 100 rows) and `fhir-bundle-v1` | 25 tests |
| 5. Channels and Keycloak | Done: HAPI channels, SMART scopes per client type (`keycloak/client-types.json`), `onboard-facility.sh`, portal BFF authentication (item 9 step 3) | e2e; BFF calls through OpenHIM |
| 6. Cutover | Code side done: old mediators deleted, compose and CI rewritten, READMEs rewritten, `e2e/up.sh` local stack. **Open:** back up, backfill and MRN migration, and the switch on the real stack; evidence run against real JeMPI | `run_e2e.py`: 57 cases pass on a local stack with a JeMPI stub (not evidence) |

Differences from the plan below, as built:

- Channels (A2): HAPI gets two generic channels, `NP FHIR read` and `NP FHIR
  write` (priority 2, any resource type), not one per type. Organization and
  Practitioner writes are refused by the token scopes at HAPI, not by a channel.
  `forwardAuthHeader` works in the `etech-nepal/openhim-core` build.
- Scopes (A3): the identity mediator has `system/Patient.crus system/*.rus`. A
  fourth service type, `onboarding`, is the operators' client for
  Organizations and Practitioners (HAPI accepts no anonymous writes).
- Health IDs (A4): a candidate is reserved in `health_ids` (status `reserved`)
  before the JeMPI call and sent as the auxId; an existing golden record keeps
  its ID and the reservation is released.
- Conditional references (item 3): an ambiguous match gives `412` or `400`
  from HAPI. A conditional reference whose identifier system has no path and is
  not URL-encoded (`Patient?identifier=http://donidcr.gov.np|...`) crashes HAPI
  8.12's validator with `500`; the interceptor refuses it with `400` and asks
  for URL encoding.

Fixed on 2 October 2026, outside the original plan (all tested against the local stack):

- `admin_portal` BFF authenticates to OpenHIM as `admin-portal` with
  private-key JWT plus DPoP (item 9 step 3); `OPENHIM_CLIENT_PASSWORD` removed.
- `FHIR_mediator` adapter posts raw rows in batches to `/transform/cdrs` and
  reads one result per row; FHIR mode posts to `/fhir`. Encounter `type` is
  coded only with NP Core's `encounter-type` (unknown CodeSystems made the
  transform validator time out), and the follow-up-date extension, which NP
  Core does not define, is no longer sent.
- `patient-portal-mediator` reads HAPI with its own read-only client
  (`patient-portal-mediator` type, read and search scopes only). HAPI lets
  only that client search Patient by `telecom` (`NP_PHONE_LOOKUP_CLIENT_IDS`),
  for the portal's OTP login. The portal stays outside the PRS scope.

Repositories referenced:

- `openhie`: this repository (mediators under `services/`)
- `single_stack`: deployment (`docker-compose.yml`, `env/`, `scripts/`, `keycloak/`)
- `admin_portal`: administration portal BFF and UI

---

# Part A. Target architecture

## A1. Components

| Component | Responsibility |
| --- | --- |
| Keycloak | Clients, SMART v2 scopes, DPoP-bound tokens |
| OpenHIM | Authenticates every request (token + DPoP), routes by path and method, coarse role check per channel, transaction log |
| Transform mediator | Every non-FHIR input (one config-driven app per source) and FHIR Bundles that contain Patients: input check, mapping, NP Core validation, identity step, delivery to HAPI |
| Identity mediator (new) | Every Patient write: JeMPI match and update, Health ID issuing (`health_ids` table), HAPI Patient upsert, merge and review API for the admin portal |
| HAPI FHIR + interceptor module (new) | Storage, NP Core validation, SMART scope checks, facility stamping and ownership, read limits, retired-Patient redirect |
| JeMPI | Client Registry (golden records) |

**Deleted:** `fhir-mediator`, `fhir-intake-mediator`, `admin-mediator`.
`patient-portal-mediator` is out of scope and is not changed.

Rule: a hospital's identity and permissions travel with its own token. Every
hop that writes on a hospital's behalf forwards that token, and HAPI checks it.
No internal hop is trusted because of where it comes from.

## A2. Routes and OpenHIM channels

FHIR clients use the standard base `/fhir` only. Non-FHIR sources each get
their own route. The test endpoint `/ingest` is removed.

| Priority | Methods | urlPattern | Routes to |
| --- | --- | --- | --- |
| 1 | POST, PUT | `^/fhir/Patient(/[^/]+)?$` | Identity mediator |
| 1 | POST | `^/fhir/?$` (Bundle) | Transform mediator, FHIR Bundle pipeline |
| 2 | POST, PUT | `^/fhir/(Encounter\|Observation\|DocumentReference\|DiagnosticReport\|Specimen\|...)(/[^/]+)?$` | HAPI |
| 2 | GET, HEAD | `^/fhir/<types>(/[^/]+)?$`, `^/fhir/metadata$` | HAPI |
| 1 | POST | `^/transform/cdrs/?$` | Transform mediator, CDRS app |
| 1 | GET, POST | `^/admin/.*$` | Identity mediator (role `np-admin-clients`) |

- No channel allows DELETE. No channel lets a client write Organization or
  Practitioner. Organizations come from facility onboarding (NHFR) and
  Practitioners from the government workforce registry (NHWR), both written
  to HAPI directly.
- Channel roles are coarse (`hospital`, `laboratory`). The detailed rules are
  the token scopes checked by HAPI and the identity mediator.
- Routes to HAPI and to the mediators set `forwardAuthHeader: true`, so the
  client's token reaches them. Confirm the option name in the
  `etech-nepal/openhim-core` build before relying on it.

## A3. Client types and scopes (SMART v2)

Scopes are Keycloak client scopes assigned per client. Changing what a client
may do is a Keycloak change only.

| Client type | Scopes |
| --- | --- |
| hospital | `system/Patient.crus system/Encounter.crus system/Observation.crus system/DocumentReference.crus system/Condition.crus system/Procedure.crus system/AllergyIntolerance.crus system/Immunization.crus system/MedicationRequest.crus system/ServiceRequest.crus system/DiagnosticReport.rs system/Specimen.rs system/Practitioner.rs system/Organization.rs system/Binary.r` |
| laboratory | `system/Patient.crus system/ServiceRequest.rs system/Specimen.crus system/Observation.crus system/DiagnosticReport.crus system/Organization.rs system/Practitioner.rs` |
| identity mediator | `system/Patient.cru` and read on clinical types (merge record move: `system/*.ru`) |
| admin portal | `np-admin-clients` role for `/admin/*` only |

The exact resource list per type is confirmed with MoHP before go-live. No
client gets a `d` (delete) scope.

Each client token carries the facility's NHFR code as `client_id` (and an
`nhfr` claim). HAPI and the identity mediator take the caller's facility from
the verified token, never from a header or the payload.

## A4. Health ID issuing (inside the identity mediator)

Table in the identity mediator's database (the existing `admin_review`
database, renamed to `identity` during the restructure):

```sql
CREATE TABLE health_ids (
  health_id   text PRIMARY KEY,
  golden_uid  text UNIQUE,
  status      text NOT NULL DEFAULT 'active',  -- active | retired
  replaced_by text REFERENCES health_ids,
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

Register a Patient:

1. JeMPI match gives the golden UID (new or existing golden record). JeMPI's
   demographics are updated with the incoming values.
2. Existing person: reuse `health_id` for that `golden_uid`. New person:
   generate a candidate (current format, two letters, six digits, Damm check
   digit, using `crypto.randomInt`), `INSERT ... ON CONFLICT DO NOTHING
   RETURNING`, retry up to 5 times, then fail with `502` and write nothing.
3. Store the Health ID as the golden record's `auxId` in JeMPI.
4. Upsert the HAPI Patient: existing Patient with `If-Match`, MRNs added, never
   replaced; new Patient by conditional create on the Health ID.

The primary key makes concurrent allocation of one ID impossible, and
`golden_uid UNIQUE` gives one ID per person even when two hospitals register
the same new person at once. On merge the survivor keeps its ID; the loser's
row becomes `retired` with `replaced_by`. Retired IDs are never reissued.

Before go-live, load every Health ID already in HAPI into `health_ids`.

## A5. MRN identifiers

Per-hospital system, standard type code, assigner as a label:

```json
{
  "use": "usual",
  "type": { "coding": [{ "system": "http://terminology.hl7.org/CodeSystem/v2-0203", "code": "MR" }] },
  "system": "http://mohp.gov.np/fhir/NamingSystem/hospital-mrn/<NHFR>",
  "value": "1001",
  "assigner": { "reference": "Organization/<hospital>" }
}
```

NP Core 1.0.0 `np-core-patient` slices `identifier` by `system` with open
rules and has no MR slice (checked against `hapi-config/np.core-1.0.0.tgz`), so
this validates without an IG change.

## A6. Data flows

**F1. CDRS rows**
```
CDRS adapter ── POST /transform/cdrs [up to ~50 rows] ──► OpenHIM ──► Transform (cdrs app)
   schema check per row, then map, then NP Core validation
   each unique Patient ──► Identity ──► JeMPI, health_ids, HAPI Patient
   Encounters (subject = Patient?identifier=<health-id system>|<id>) ──► HAPI batch [hospital token]
◄── result per row
```

**F2. FHIR Bundle with Patients**
```
Hospital EMR ── POST /fhir (batch Bundle) ──► OpenHIM ──► Transform (FHIR Bundle pipeline, no mapping)
   validation, then each Patient entry ──► Identity
   references rewritten to Health ID, clinical entries ──► HAPI batch [hospital token]
◄── batch-response Bundle
```

**F3. Single Patient**
```
Hospital EMR ── POST/PUT /fhir/Patient ──► OpenHIM ──► Identity ──► JeMPI, health_ids, HAPI
◄── 201 Patient + Location
```

**F4. Clinical write or read**
```
Hospital or lab ── /fhir/<type> ──► OpenHIM ──► HAPI (interceptors)
```

**F5. Direct Patient write that bypasses identity**
```
any client ── Patient write reaching HAPI ──► HAPI interceptor ──✗ 403
```

**F6. Admin merge**
```
Admin portal UI ──► BFF (session; own token + DPoP; X-Admin-User from session)
  ──► OpenHIM /admin ──► Identity
        lock task row, JeMPI merge, HAPI survivor + retired Patient (If-Match),
        move clinical records, move once more after retiring
```

Bulk input uses `batch` Bundles, so one bad row fails alone and the adapter
retries only failed rows. Expected load is about 50 rows per request; no async
import job is planned.

---

# Part B. Defects and where each is fixed

## 1. Concurrent merges of the same review task

**Problem.** `claimOpenTask` (`services/admin-mediator/src/db/reviewRepo.ts`)
runs `UPDATE review_tasks SET updated_at = now() WHERE id = $1 AND status IN
('OPEN','MERGE_PARTIAL')`. It never changes `status`, so a second concurrent
call matches the row again and also succeeds. Two administrators can both run
an irreversible merge, or merge and dismiss the same pair. The project's own
test `only one simultaneous claimant may own an open review task` fails against
a real PostgreSQL.

**Fixed in:** identity mediator (review module moved from admin-mediator).

1. Replace `claimOpenTask` with `withTaskLock(id, fn)`: `BEGIN`, `SELECT ...
   FOR UPDATE NOWAIT` on an `OPEN` or `MERGE_PARTIAL` task (`55P03` means
   another request holds it, return `null`), run `fn` with the same client,
   `COMMIT`; `ROLLBACK` on error. A crash releases the lock with the
   connection.
2. `resolveTask` uses the locked client, so the status change commits with the
   lock.
3. Merge and dismiss run inside `withTaskLock`. `null` gives `409 task already
   resolved (<status>)`, or `409 task is being resolved by another
   administrator` while the status is still open.
4. Test: two concurrent callers, exactly one gets the task. Run the repository
   tests in CI with a PostgreSQL service container so the test cannot skip.

## 2. Health ID collision merges two people

**Problem.** `mintUniqueHealthId` accepts an unchecked candidate when the HAPI
search errors or after 5 collisions, and the conditional `PUT
Patient?identifier=<Health ID>` then overwrites the other person's Patient.
The random source is `Math.random()`.

**Fixed in:** identity mediator, by the `health_ids` table (A4). Uniqueness is
a database constraint, allocation fails closed, and the HAPI-search check and
the golden-UID ownership guard are not carried over. Tests: forced conflict
retries; 5 conflicts give `502` and no JeMPI or HAPI write; two concurrent
registrations of one golden UID get the same ID.

## 3. Clinical records attached to the wrong patient

**Problem.** Conditional `subject` references are resolved with `_count=1`
(first hit wins), and every hospital shares one MRN system.

**Fixed in:**

- HAPI, natively: a conditional reference that matches more than one Patient
  is rejected. Confirm the status code (`412`) in the end-to-end tests.
- MRN per hospital (A5). The identity mediator writes the scoped system and
  `type: MR`; the CDRS app builds it from the caller's NHFR code.
- HAPI interceptor: a conditional reference using the bare `hospital-mrn`
  system is rejected with `400` (clients must use the scoped system or the
  Health ID). No silent rewriting.
- Migration script (identity mediator, one-off): rewrite every bare
  `hospital-mrn` identifier using its `assigner` Organization's NHFR code
  (fallback: the `source-facility` tag), add `type: MR`, PUT with `If-Match`.
  Run after a backup.

## 4. Lost updates on the Patient record

**Problem.** The Patient is read, merged and written without a version check;
a failed read is logged and the write goes ahead.

**Fixed in:** identity mediator. A failed read fails the request. An existing
Patient is written with `PUT /Patient/<id>` and `If-Match`; HAPI's `412`
becomes `409 Patient was changed concurrently; resend the request`.

## 5. Records written to a retired Patient after a merge

**Problem.** Clients that hold the losing Patient's id keep writing to it,
records written during a merge are left behind, and the merge writes without a
version check.

**Fixed in:**

- HAPI interceptor: a literal `Patient/<id>` reference to a Patient with
  `active = false` and a `replaced-by` link is rewritten to the survivor
  before storage.
- Identity mediator merge: survivor and loser written with `If-Match` (a `412`
  leaves the task `MERGE_PARTIAL` for retry); after the loser is retired, the
  clinical-record move runs once more.

## 6. A hospital can write as another facility

**Problem.** `managingOrganization`, `serviceProvider` and the Encounter
identifier namespace pass through unchecked; any hospital can create an
Organization with another hospital's NHFR code; an update by id can take over
another hospital's resource.

**Fixed in:** HAPI interceptor (clinical resources) and identity mediator
(Patient), using the caller from the verified token.

- Create: stamp the facility tag and set `serviceProvider` to the caller's
  Organization; an Encounter identifier in another facility's NHFR namespace
  gives `403`.
- Update: the stored resource's facility tag must equal the caller, otherwise
  `403`. Patient is shared and only written by identity, which adds MRNs and
  never removes another hospital's.
- Organization and Practitioner: no client scope or channel allows writes.
- Caller Organization lookup (`Organization?identifier=<NHFR system>|<caller>`)
  cached for 5 minutes; none or several gives `422`.

## 7. Unscoped national reads

**Problem.** Any hospital can page through every Patient, Encounter,
Observation, DocumentReference and Binary in the country.

**Fixed in:** HAPI interceptor and HAPI configuration.

| Request | Rule |
| --- | --- |
| `GET /fhir/<type>/<id>` | Allowed (scope permitting) |
| `Patient` search | Needs `identifier` or `_id` |
| Clinical search | Needs `patient` or `subject` |
| `Organization`, `Practitioner` search | Needs `identifier` or `name` |
| `Binary` search | Refused; read by id only |
| Parameter names with `.` or `:` (chains, modifiers) | Refused |
| `_include` / `_revinclude` with `*` | Refused |
| `_count` | Capped at 100 (`max_page_size` in `application.yaml`) |

A refused search gives `400` `OperationOutcome`, `code: not-supported`.

## 8. Any hospital can overwrite any Practitioner

**Problem.** `mergePractitioners` returns `{ ...existing, ...incoming }`.

**Fixed by removal.** Practitioners are registered only by the government
health workforce registry (NHWR); hospitals and labs never create or change
them, so they get read-only Practitioner scopes. Practitioner records come
into HAPI from NHWR through the onboarding path only. The merge code is
deleted with `fhir-mediator`.

## 9. Merge attribution and the portal's Basic authentication

**Problem.** `resolved_by` comes from `X-Admin-User` with an `'unknown'`
fallback and no validation. The portal BFF calls OpenHIM with Basic
authentication, which the platform does not accept for `admin-portal`.

**Fixed in:** identity mediator and `admin_portal`.

1. Merge and dismiss require `X-Admin-User` matching `^[A-Za-z0-9._@-]{1,128}$`,
   otherwise `400`. No fallback.
2. `np-admin-clients` is granted only to `admin-portal`; `onboard-client.sh`
   refuses it for other clients unless `--allow-admin-role` is passed.
3. Portal BFF uses private-key JWT plus DPoP (same flow as the hospital
   scripts, `node:crypto`), caches the token until 30 s before expiry, sends a
   fresh proof with `ath` on every call. Remove `OPENHIM_CLIENT_PASSWORD`.
4. The BFF sets `X-Admin-User` from the verified session only.
5. Verify scan, detail, merge and dismiss end to end.

## 10. DPoP is not enforced for every token

**Problem.** OpenHIM checks a DPoP proof only for tokens with `cnf.jkt`; a
client without DPoP binding gets Bearer tokens that OpenHIM accepts.

**Fixed in:** Keycloak (`single_stack/keycloak/realm-export.json` and the
running realm).

1. Client profile `dpop-required` with executor `dpop-bind-enforcer`
   (`auto-configure: true`), client policy `dpop-for-all-clients` with
   condition `any-client`. Check the names in the Keycloak 26.7 admin console.
2. Apply the policy to the running realm (`--import-realm` does not overwrite
   an existing realm).
3. Remove `demo-client` and the `demo` user.
4. Test: a token request without a proof is refused; a DPoP-bound token with a
   proof works.
5. Optional: OpenHIM rejects tokens without `cnf.jkt` when
   `authentication_jwt_dpopPublicBaseUrl` is set.

## 11. Default and over-privileged credentials

**Problem.** Keycloak runs `start-dev` with `admin/admin` and publishes its
admin console; PostgreSQL `admin/admin` is hard-coded; mediators log in to
OpenHIM as `root@openhim.org`; OpenHIM Core runs with `NODE_ENV=development`;
OpenHIM API 8080, router 5000 and Console 9000 are published on all
interfaces.

**Fixed in:** `single_stack`.

1. Root `.env` requires `HAPI_DB_PASSWORD`, `KEYCLOAK_DB_PASSWORD`,
   `KEYCLOAK_ADMIN_PASSWORD`, `IDENTITY_DB_PASSWORD` (no defaults;
   `.env.example` lists them empty).
2. `hapi-db`: `POSTGRES_PASSWORD: ${HAPI_DB_PASSWORD:?set in .env}`; an
   idempotent `hapi-db/init/10-roles.sh` creates role and database `keycloak`
   and `identity` (on existing volumes: rename `admin_review`, change owner,
   grant existing tables) and revokes `CONNECT` on `hapi` from `PUBLIC`.
3. `fhir`: `SPRING_DATASOURCE_PASSWORD: ${HAPI_DB_PASSWORD}`; no password in
   `application.yaml`.
4. Identity mediator connects as role `identity`. Mediators register with
   OpenHIM as `mediators@openhim.local` (role limited to registration,
   heartbeats and channel create/update; check permission names in the
   OpenHIM 8 Console). `onboard-client.sh` prompts for the root password.
5. Keycloak: `start --import-realm` on PostgreSQL (`KC_DB*`), bootstrap admin
   password from `.env`, `KC_PROXY_HEADERS: xforwarded`, `KC_FEATURES: dpop`.
   Export the realm from the dev store, import into the new one, then drop the
   `keycloak-data` volume. Backups also dump the `keycloak` database.
6. `Caddyfile`: `keycloak.{$DOMAIN}` answers `404` for `/admin` and
   `/admin/*`; operators use an SSH tunnel to `127.0.0.1:8083`.
7. `openhim-core`: `NODE_ENV: "production"`; keep `basic` in
   `api_authenticationTypes` for `onboard-client.sh` (API on loopback).
8. Ports: `127.0.0.1:8080:8080` (API), `127.0.0.1:9000:80` (Console),
   `127.0.0.1:5000:5000` (plain HTTP router) unless something outside the host
   needs it. Caddy reaches them on the Docker network.

## 12. Unauthenticated routes around OpenHIM

**Problem.** HAPI port 8081 is published on all interfaces with no
authentication. JeMPI is reached over plain HTTP with no authentication,
across hosts.

**Fixed in:** `single_stack` and the hosts.

1. `fhir` ports: `127.0.0.1:8081:8080`.
2. JeMPI over WireGuard: one peer each (for example `10.60.0.1` platform,
   `10.60.0.2` JeMPI); JeMPI accepts TCP 50000 only on `wg0` from
   `10.60.0.1`; `JEMPI_BASE_URL=http://10.60.0.2:50000/JeMPI` in the identity
   mediator env; confirm from inside the container.
3. The HAPI interceptor rejects any request without a valid token, so a
   request that reaches HAPI without passing OpenHIM still fails.

## 13. Permissions do not follow the caller across mediators (new)

**Problem.** OpenHIM checks the role only on the hop the client calls. A
mediator that forwards the request writes to HAPI with full access, so a
client's rights depend on which route it used.

**Fixed in:** Keycloak scopes (A3), OpenHIM `forwardAuthHeader`, HAPI
interceptor module, identity and transform mediators.

1. Every mediator forwards the client's original `Authorization` header on
   writes made for that client.
2. HAPI interceptor verifies the token (Keycloak JWKS, `exp`, `aud`) on every
   request and checks the SMART scope for each request and each Bundle entry.
   Missing scope gives `403`.
3. Patient create and update are accepted only from the identity mediator's
   client. The identity mediator itself checks the caller's `Patient.c`/`u`
   scope.
4. DPoP is checked once, at OpenHIM. Inside the network the token signature
   and expiry are checked. Token exchange (RFC 8693) can be added later if the
   audit must record the mediator acting for the client.

---

# Part C. Implementation order

1. **Platform hardening** (`single_stack`, `keycloak`): items 10, 11, 12.
   Independent of the restructure.
2. **Identity mediator** (`services/identity-mediator`): identity code from
   `fhir-mediator/src/modules/patient`, review and merge from
   `admin-mediator`, `health_ids` table and allocation, Patient upsert with
   `If-Match`, MRN scoping, `/fhir/Patient` and `/admin/*` handlers. Items 1,
   2, 4, 5 (merge part), 9 (mediator part), 3 (MRN part). Health ID backfill
   and MRN migration scripts.
3. **HAPI interceptor module** (`hapi-interceptors/`, Java, Maven): token
   verification, scope checks per request and per Bundle entry, Patient-write
   lock, facility stamping and ownership, read rules, retired-Patient
   redirect, bare-MRN rejection. Items 3, 5, 6, 7, 13. Pin the HAPI image
   version (today `hapiproject/hapi:latest`) and load the jar through the
   image's extra-classes path and `custom-interceptor-classes`; confirm both
   for the pinned version.
4. **Transform mediator**: CDRS app (mapping moved from
   `fhir-intake-mediator`), FHIR Bundle pipeline app (no mapping), identity
   step, `batch` delivery to HAPI with the client's token, results per row.
5. **Channels and Keycloak**: channel table from A2 registered by the
   mediators that own them, client scopes from A3, portal BFF authentication
   (item 9).
6. **Cutover**: back up, run the Health ID backfill and the MRN migration,
   switch channels, remove `fhir-mediator`, `fhir-intake-mediator` and
   `admin-mediator` from compose and CI, run the end-to-end suite.

---

# Part D. Handover document changes

The documents in `openhim-tor-docs` change to describe the target
architecture, from real results only:

- `02_architecture.md`: components, channel table, flows F1 to F6.
- `04_deployment.md`: new services and images, secrets, ports, Keycloak on
  PostgreSQL, WireGuard, interceptor module, cutover steps.
- `05_software.md` and `07_test.md`: unit-test counts (identity mediator
  passing against PostgreSQL, including the lock test), interceptor tests,
  re-run `run_e2e.py` with cases for items 1, 2, 3, 5, 6, 7, 10 and 13, and
  record the new evidence files.
- `01_api.md`: new routes (`/fhir`, `/transform/cdrs`, `/admin`), re-record
  the evidence excerpts with the scoped MRN system.
- `08_health_id.md`: issuing through the `health_ids` table.
- `03_functions.md`: F-record statuses only after the re-run.
- Image tags and the cited source commit change to the new commit.
- Rebuild the Word and PDF files (`_source/build.js`, then `finalize.py`).

---

# Part E. Future work (not in this restructure)

- Public Health ID lookup: a person finds their Health ID from their own
  details, through the identity mediator. Needs its own authentication and
  rate limiting design.
- Consent or purpose-of-use for cross-facility reads.
- NHWR practitioner feed: an OpenHIM channel (and a mediator if NHWR's format
  needs mapping, as a transform app) through which NHWR sends new and changed
  Practitioner records to HAPI, with its own NHWR client and
  `system/Practitioner.cu` scope. Until then, Practitioners are loaded through
  onboarding.
