# Identity Mediator

Owns patient identity for the platform. Every Patient write goes through it; nothing
else may write a Patient to HAPI (the HAPI interceptor module refuses Patient writes
from any other client). It:

* registers patients: JeMPI match or create, Health ID issuing, HAPI Patient upsert;
* finds duplicate patients and resolves them in **both JeMPI and HAPI FHIR**.

Port 4002. OpenHIM channels:

| Channel | urlPattern | Methods | Roles |
| --- | --- | --- | --- |
| `NP Patient Identity` (priority 1) | `^/fhir/Patient(/[^/]+)?$` | POST, PUT | `OPENHIM_PATIENT_ROLES` (hospital, laboratory) |
| `NP Patient Admin Review` | `^/admin/.*$` | GET, POST | `np-admin-clients` |

Both routes forward the client's token (`forwardAuthHeader`). The mediator verifies it
against the realm's JWKS: the caller's facility is the token's client (its NHFR code),
and Patient writes need the SMART scope `system/Patient.c` or `.u`. `/admin` accepts
only `ADMIN_CLIENT_IDS` (the admin portal). The admin UI lives in `../../admin_portal`.

## Registering a patient

`POST /fhir/Patient` (or `PUT /fhir/Patient/<id>`; the id is ignored, a Patient is
found by its Health ID). The response is the stored Patient with `201` (created) or
`200` (updated) and a `Location` header.

1. **MRNs.** An identifier with the bare `hospital-mrn` system becomes the caller's
   namespace, `http://mohp.gov.np/fhir/NamingSystem/hospital-mrn/<NHFR>`, with type
   `v2-0203#MR` and the caller's Organization as `assigner`. Another facility's
   namespace is refused (`403`).
2. **Health ID hint.** A Health ID sent by the client must be one this register issued
   (`422` otherwise) and must belong to the person JeMPI matches (`409` otherwise).
   A retired one answers `409` with its replacement.
3. **Health ID.** A fresh random ID (two letters, six digits, Damm check digit;
   `crypto.randomInt`) is reserved in `health_ids` and sent to JeMPI as the auxId.
   JeMPI links to an existing golden record or creates one. An existing golden keeps
   its ID and the reservation is released; a new golden binds the reservation.
4. **HAPI.** An existing Patient is updated with `PUT /Patient/<id>` and
   `If-Match`; other facilities' MRNs are kept and the first registering facility stays
   `managingOrganization`. A new Patient is created with `If-None-Exist` on the Health
   ID. A concurrent change answers `409` (resend). A failed HAPI read fails the request.

### The Health ID register

`health_ids` in the `identity` database is the only issuer of Health IDs:

| Column | |
| --- | --- |
| `health_id` | primary key: one ID can never go to two people |
| `golden_uid` | unique: one ID per JeMPI golden record |
| `status` | `reserved` (registration in flight), `active`, `retired` |
| `replaced_by` | on a retired ID, the survivor's ID after a merge |

Allocation retries five times on a collision, then fails with `502` before anything is
registered. Retired IDs are never reissued.

**Before go-live on a stack that already has Patients**, load the existing IDs:

    docker compose exec identity-mediator node dist/scripts/backfill-health-ids.js

and rewrite MRNs stored with the shared system (dry run first, after a backup):

    docker compose exec identity-mediator node dist/scripts/migrate-mrn-systems.js
    docker compose exec identity-mediator node dist/scripts/migrate-mrn-systems.js --apply

## Why the review queue exists

JeMPI has a review queue and a `/notifications` API of its own. **It is permanently
empty for this deployment**, and an admin UI built over it would show nothing.

The write-side mediator registers patients with **`POST /crRegister`**, which is a
synchronous, deterministic *find-or-create*. It never runs probabilistic linking, never
scores, and never emits a notification. So the `LINKER_MATCH_THRESHOLD` 0.65–0.75 "hold
band" that is supposed to feed the review queue is never reached. (Verified: 24 golden
records / 24 interactions — nothing had ever linked — and `POST /notifications` returned
`count: 0` for every state.) Those thresholds are read by `JeMPI_Linker` on the async
Kafka path only.

JeMPI's only documented route onto that async path is `POST /upload` with a 1-row CSV.
Going that way was **rejected**: it would destroy the synchronous `goldenUID` that the
write path depends on to mint the Health ID and PUT to HAPI in one request.

So this service owns the queue instead. Three findings make that work, all verified live:

1. **`/relink` does not validate `notificationId`.** A UUID we generate is accepted and
   the merge is performed. We can therefore raise review tasks ourselves and still
   execute real merges in JeMPI — no Kafka, no JeMPI redeploy.
2. **`/customSearch/golden` with `distance` finds near-misses.** `crCandidates` cannot:
   it is driven by the *deterministic* rules, so even at `candidateThreshold: 0.3` it
   returns only exact matches.
3. **`/calculateScores` is 404 here.** We score ourselves.

## How it works

    scan → /customSearch/golden ($or mirroring the configured probabilistic
           blocking rule) → score each pair → queue anything >= REVIEW_LOW

    merge → JeMPI /relink (move loser's interactions to survivor)
          → HAPI reconcile (move clinical records, retire loser)

### Scoring

Fellegi-Sunter, using the **real m/u probabilities from the deployed JeMPI link config**
(`jempi-config/config-reference-link-dp.json`, mounted read-only at `/config`). Weights
are not invented here; change that file and this follows.

Per field: agree → `log2(m/u)`, disagree → `log2((1-m)/(1-u))`, normalised min-max over
the fields that were actually comparable, so the hold band means something regardless of
how sparse a record is.

Two rules that matter more than they look:

* **Blank on either side is skipped, not scored as disagreement.** Most records have an
  empty `national_id`; counting that against every pair would sink real duplicates.
* **The placeholder phone (`9800000000`) counts as blank.** `phone_number` has
  `u = 4e-07`, so an agreement is worth ~21 bits — more than every other field combined.
  Two strangers sharing the placeholder would otherwise score as a near-certain match.

**`EXACT_MATCH_FIELDS` is a deliberate deviation from the JeMPI config.** That config
specifies Jaro-Winkler for *every* field, which is right for names and wrong for dates
and identifiers. `dob` `19900101` vs `19900102` scores JW 0.95 — over the 0.92 agreement
level — so it would count as a full **+14-bit agreement** and present twins as a
near-certain duplicate. `national_id` is worse: one digit apart scores 0.97 and
agreement is worth +22 bits, enough to saturate the score on its own. Dates and ID
numbers have no edit-distance semantics for identity, so they are compared exactly. This
makes us stricter than stock JeMPI — the correct direction, because we ship merge
**without split**, so a wrong merge is effectively irreversible.

### What a merge does

**JeMPI first, then HAPI.** JeMPI is the identity source of truth: if HAPI then fails we
are in a knowable, retryable state (`MERGE_PARTIAL`) with identity already correct. The
reverse order would leave JeMPI handing out a golden UID that HAPI had already retired.
Every HAPI step is idempotent, so retrying a partial merge is safe.

The task row is locked (`SELECT ... FOR UPDATE NOWAIT`) for the whole merge or dismiss:
a second administrator gets `409` at once, and a crash releases the lock with the
connection. Merge and dismiss require `X-Admin-User` (set by the admin portal BFF from
its verified session) and record it as `resolved_by`. Every HAPI write carries
`If-Match` on the version just read, so a record changed meanwhile fails the step
(`MERGE_PARTIAL`, retry) instead of being overwritten.

* JeMPI: each of the loser's interactions is relinked onto the survivor's golden record.
  **When the last interaction leaves, JeMPI deletes the losing golden**, and its `auxId`
  — that person's Health ID — goes with it. Health IDs are therefore read *before*
  relinking; afterwards there is no way to learn which one to retire.
* HAPI: clinical records (`MERGE_REFERENCING_TYPES`) are repointed to the survivor;
  the loser's **foreign** identifiers (other facilities' MRNs) are copied over; the
  loser is set `active: false` with a `replaced-by` link, and the survivor gets
  `replaces`. The clinical-record move runs once more after the loser is retired, to
  catch records written during the merge. The loser's Health ID becomes `retired` in
  `health_ids`, forwarding to the survivor's.
* The retired Patient resource is **kept, never deleted**. Since JeMPI dropped the
  losing golden and its Health ID, that inactive record is the only thing left that can
  resolve the old Health ID; deleting it would permanently break every existing
  reference. `replaced-by` is the FHIR-standard forward.
* `nepal-health-id` and `jempi-golden-uid` are deliberately **not** copied to the
  survivor — that would give it two Health IDs (breaking the 1:1 with its resource id
  that the write path relies on) and a dangling pointer to a deleted golden.

## Endpoints

| Method | Path | |
|---|---|---|
| GET  | `/admin/review/tasks?status=OPEN` | queue + counts + thresholds |
| GET  | `/admin/review/tasks/:id` | pair detail: scored evidence + HAPI context |
| POST | `/admin/review/tasks/:id/merge` | `{ survivorUid }` — same person |
| POST | `/admin/review/tasks/:id/dismiss` | `{ reason }` — not the same person |
| POST | `/admin/review/scan` | sweep for duplicates |
| GET  | `/admin/review/golden/:gid/audit` | JeMPI audit trail |

Task states: `OPEN` → `MERGED` / `DISMISSED`, or `MERGE_PARTIAL` when JeMPI succeeded
and HAPI did not. Dismissed and merged pairs are never re-raised by a later scan.

## Setup

The `identity` role and database are created by `single_stack/hapi-db/init/10-roles.sh`;
the mediator creates its tables at boot. It writes to HAPI with its own Keycloak client
(`IDENTITY_CLIENT_ID`, private key at `IDENTITY_CLIENT_KEY_PATH`, DPoP-bound), onboarded
like any other client. The admin portal is onboarded as client `admin-portal` with role
`np-admin-clients`.

## Tests

The repository tests need a disposable PostgreSQL:

    docker run -d --rm --name identity-test-db -p 127.0.0.1:55439:5432 \
      -e POSTGRES_USER=identity -e POSTGRES_PASSWORD=synthetic-identity -e POSTGRES_DB=identity \
      postgres:16-alpine
    TEST_IDENTITY_DB_PORT=55439 npm test

## Notes

* **JeMPI's own admin UI at `http://10.8.0.1:3000` writes straight to JeMPI** and would
  bypass this service's HAPI reconciliation entirely — a merge made there leaves HAPI
  split. Lock it down.
* Replies must carry `Content-Type: application/json+openhim` or OpenHIM will not unwrap
  the envelope and callers silently receive the raw wrapper.
* `node --watch` does not reliably pick up edits through the Docker bind mount here.
  Restart the container when verifying a change.
