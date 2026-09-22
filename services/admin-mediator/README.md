# Admin Review Mediator

Finds duplicate patients, and resolves them in **both JeMPI and HAPI FHIR**.

OpenHIM channel `NP Patient Admin Review` (`^/admin/.*$`, role `np-admin-clients`),
port 4002. The admin UI lives in `../../admin_portal`.

## Why this exists

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

* JeMPI: each of the loser's interactions is relinked onto the survivor's golden record.
  **When the last interaction leaves, JeMPI deletes the losing golden**, and its `auxId`
  — that person's Health ID — goes with it. Health IDs are therefore read *before*
  relinking; afterwards there is no way to learn which one to retire.
* HAPI: clinical records (`MERGE_REFERENCING_TYPES`) are repointed to the survivor;
  the loser's **foreign** identifiers (other facilities' MRNs) are copied over; the
  loser is set `active: false` with a `replaced-by` link, and the survivor gets
  `replaces`.
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

    docker compose up -d --build admin-mediator
    docker exec -e ADMIN_CLIENT_PASSWORD=<secret> admin-mediator \
      node scripts/create-admin-client.js

The review queue lives in its own `admin_review` database on the existing `hapi-db`
container, created at boot (the container's volume already exists, so initdb hooks
never re-run).

## Notes

* **JeMPI's own admin UI at `http://10.8.0.1:3000` writes straight to JeMPI** and would
  bypass this service's HAPI reconciliation entirely — a merge made there leaves HAPI
  split. Lock it down.
* Replies must carry `Content-Type: application/json+openhim` or OpenHIM will not unwrap
  the envelope and callers silently receive the raw wrapper.
* `node --watch` does not reliably pick up edits through the Docker bind mount here.
  Restart the container when verifying a change.
