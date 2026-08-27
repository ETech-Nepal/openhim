# JeMPI configuration (Nepal deployment)

This folder holds the JeMPI linker configuration we run on the VPS
(`202.51.71.81`, reached from the laptop over WireGuard at
`http://10.8.0.1:50000/JeMPI`). JeMPI itself is **not** in this repo's
docker-compose — it is deployed separately. This is the source of truth for the
config files you copy onto that host.

## TL;DR — what actually needed changing

After inspecting the live instance (`GET /JeMPI/configuration`, `GET /JeMPI/countRecords`):

- The database is **empty** (0 golden records, 0 interactions) — safe to change config now.
- **National ID is already optional.** JeMPI skips any rule clause whose field is
  blank on the incoming record, so a patient with no national ID still links via
  name/dob/phone. Nothing was "requiring" national ID.
- The **link threshold is an environment variable on the linker service**
  (`LINKER_MATCH_THRESHOLD` / `LINKER_MATCH_THRESHOLD_MARGIN`), **not** a value in
  this config file. The `linkThreshold: 0.0` you see in `GET /configuration` is a
  cosmetic default in the normalized output — it is NOT the decision threshold.

So the setup is two independent things: (1) the **rules** in this file, and
(2) the **threshold env vars** on the linker.

## 1. Rules (this file: `config-reference-link-dp.json`)

Changes vs the stock `config-reference-link-dp.json`:

| | Stock | Here | Why |
|---|---|---|---|
| Deterministic | `eq(national_id)`, `eq(name)+eq(phone)` | `eq(national_id)`, `eq(given_name)+eq(family_name)+eq(dob)+eq(phone_number)+eq(gender)` | **`eq(name)+eq(phone)` is unsafe here:** phone is very often the placeholder `9800000000`, so two different people with a common name would falsely auto-merge on a fake phone match. Requiring dob+gender too makes the exact-match key safe. National ID stays a standalone key. |
| Probabilistic blocking | name+name, name+**city**, family+**city**, phone, nid | name+name, name+**dob**, family+**dob**, phone, nid | City is unreliable; DOB is reliable, so it's a better blocking key for candidate retrieval |

Notes:
- The probabilistic `text` is only the **candidate-retrieval (blocking) query**.
  Scoring still runs over *all* demographic fields (incl. city, gender) using the
  `linkMetaData` m/u weights — those are unchanged.
- **On the placeholder phone in the deterministic clause:** including `eq(phone_number)`
  is safe even though it's usually the placeholder. When both records carry the
  placeholder, `eq(phone_number)` is trivially true and the clause effectively reduces
  to name+dob+gender (which is what protects you). When phones genuinely differ, it
  correctly blocks the deterministic link and lets probabilistic scoring decide. The only
  trade-off: the same person entered once with a real phone and once with the placeholder
  won't match deterministically — they fall through to probabilistic (which still links
  them on name+dob+gender+city).
- **Schema/index change — NOT just a rules change.** `dob` was previously scoring-only
  (no Dgraph index). Using it in `eq(dob)` (deterministic) and `match(dob,3)` (blocking)
  requires an index, so `dob` now has `indexGoldenRecord`/`indexInteraction`
  `@index(exact,trigram)`. Adding an index changes the **Dgraph schema**, so a plain
  linker restart is **not** enough — the schema must be regenerated (see Deploy below).
  The DB is empty (0/0), so this is low-risk.

## 2. Threshold (env vars on the linker service)

The decision logic (JeMPI `LinkerDWH`) uses a single `LINKER_MATCH_THRESHOLD`
`T` and margin `M`:

```
score >= T + M        -> auto-link (confident)
T     <= score < T+M  -> auto-link, but raise ABOVE_THRESHOLD review notification
T-M   <= score < T    -> NOT linked (new golden record) + BELOW_THRESHOLD review
score <  T - M        -> new golden record, no notification
```

To match the agreed policy (auto-link ≥ 0.75, hold 0.65–0.75 for human review),
set on the **linker** service:

```
LINKER_MATCH_THRESHOLD=0.75
LINKER_MATCH_THRESHOLD_MARGIN=0.10
```

In the stock deployment these live in the linker service's environment in
`devops/linux/docker/conf/stack/docker-stack-low-1.yml` (the stock values are
`0.65` / `0.1`). Edit there (or wherever your stack injects linker env) and
redeploy the linker.

> ⚠️ Confirm the *operative* value on your running instance — it's whatever env
> the linker actually started with, which may differ from the stock file if it
> was customised. You can't read it from `GET /configuration`; check the linker
> container's environment on the VPS.

## Deploy (on the VPS)

The DB is empty, so this is low-risk. **This config adds a Dgraph index to `dob`, so
the schema must be regenerated — a linker restart alone will NOT apply the new index**
(and `eq(dob)`/`match(dob,3)` would fail against Dgraph). From the JeMPI `data-config`
directory:

```bash
# 1. Put this file in place (back up the original first)
cp config-reference-link-dp.json config-reference-link-dp.json.bak
# ...copy this repo's jempi-config/config-reference-link-dp.json over it...

# 2. Make sure config.json points at it (it already does by default):
./use.sh config-reference-link-dp.json     # recreates config.json + config-api.json symlinks

# 3. Set the linker threshold env (see section 2).

# 4. Regenerate the Dgraph schema so the new dob index is created, then restart
#    services. Because the DB is empty, the clean path is to tear down the JeMPI
#    stack and bring it back up so the bootstrapper re-applies the schema from
#    config-api.json. Exact commands depend on how you deploy; for the docker-stack
#    deployment this is roughly:
#      docker stack rm <stack> && (wait for teardown) && ./deploy... up again
#    A plain `docker service update --force <stack>_linker` is NOT sufficient here
#    because it does not re-run the Dgraph schema bootstrap.
```

> ⚠️ If your stack has a dedicated schema/bootstrapper step (rather than doing it on
> API startup), re-run that step after `use.sh` instead of a full teardown. The key
> requirement is that Dgraph's schema is re-applied so `dob` gets its new index.

## Verify

```bash
# Over the WireGuard tunnel from the laptop (or directly on the VPS):
BASE=http://10.8.0.1:50000/JeMPI

# Rules took effect: expect 2 deterministic clauses (national_id, and the strict
# name+dob+phone+gender clause) and dob (not city) in the probabilistic blocking:
curl -s $BASE/configuration | jq '.rules.link'

# dob index took effect: dob should now report indexGoldenRecord/indexInteraction:
curl -s $BASE/configuration | jq '.demographicFields[] | select(.fieldName=="dob")'

# Register a patient WITHOUT a national ID — should still create a golden record:
curl -s -X POST $BASE/crRegister -H 'Content-Type: application/json' -d '{
  "candidateThreshold": 0.9,
  "sourceId": { "facility": "TEST-FAC", "patient": "" },
  "uniqueInteractionData": { "auxId": "t1", "auxDateCreated": "2026-07-14T00:00:00.000Z" },
  "demographicData": { "givenName": "KAMANA", "familyName": "SHRESTHA",
    "gender": "female", "dob": "20010625", "city": "Kathmandu",
    "phoneNumber": "9800000000", "nationalId": "" }
}' | jq

# Deterministic-merge check: same name+dob+gender, SAME placeholder phone, no national
# ID -> should link to the same goldenUID via the strict clause. Then flip ONE field
# (e.g. dob) and confirm it does NOT deterministically merge:
curl -s $BASE/countRecords | jq
```
