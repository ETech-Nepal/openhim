# Demo Runbook: Single-Patient Insert, End to End

Walks through bringing up the stack from cold, provisioning auth, and running a
single-patient insert through the real flow: Keycloak → OpenHIM → mediator →
JeMPI → HAPI FHIR.

---

## 0. Prereqs

- Docker + Docker Compose v2
- `jq`, `curl`, `openssl` on the host
- JeMPI reachable over the WireGuard tunnel (`10.8.0.1:50000`) — confirm with
  `curl http://10.8.0.1:50000/JeMPI/countRecords` before starting. If it hangs
  on writes but reads work, the JeMPI **linker** is stuck — see
  `~/JeMPI/devops/linux/docker/d-stack-3-reboot.sh` on the JeMPI host (restarts
  services without a full image rebuild; note it also resets JeMPI's data store).

---

## ⚠️ Do NOT run `docker compose down` before the demo

Confirmed by a full dry run: `docker compose down` (even though it keeps the
named volumes) can silently wipe Keycloak's realm — its embedded H2 database
doesn't survive an ungraceful stop cleanly, and Keycloak just boots a fresh
empty DB with no error. A plain `docker compose restart keycloak` or
`up -d --force-recreate keycloak` is safe (tested, data survives both); `down`
is not. If you must fully stop the stack, use `docker compose stop` /
`docker compose start` instead of `down` / `up`.

**Safety net in place:** `keycloak/realm-export.json` + `--import-realm` on
the `keycloak` service auto-creates the `openhie` realm with a baseline
`demo-client`/`demo`/`demo123` on any boot where the realm is missing — so
even a full wipe leaves *something* working immediately, no manual step. It's
a no-op (`Import skipped`) whenever the realm already exists, so it never
disturbs a live setup. Confirmed both paths in an isolated test container
before applying.

It does **not** cover the hospital clients — `hospital-1/2/3` and
`openhim-client` each carry a real generated RSA keypair that can't be
pre-baked into a static file. If the realm does get wiped, still re-run
steps 3-3b below for those: every hospital client, its keypair, and the
`FACILITY_REGISTRY_JSON` mapping in `services/fhir-mediator/.env` need recreating (the subs
change every time the realm is rebuilt). Budget 5 minutes for this if it
happens right before you go on stage.

**Also note:** after editing `services/fhir-mediator/.env` (e.g. updating
`FACILITY_REGISTRY_JSON`), `docker compose restart mediator` is **not
enough** — `restart` doesn't reload `env_file`. Use
`docker compose up -d --force-recreate mediator`.

---

## 1. Start the OpenHIE stack

```bash
cd openhie
docker compose up -d
docker compose ps
```

Expect healthy/running: `hapi-db`, `mongo-db`, `openhim-core`, `openhim-console`,
`fhir` (HAPI), `keycloak`, `mediator`, `admin-mediator`, `patient-portal-mediator`.

`fhir` can show `unhealthy` for the first ~30-60s while HAPI boots — that's normal,
give it a minute.

---

## 2. Confirm mediator self-registration

Mediators register themselves with OpenHIM on startup — no manual step needed,
just confirm it happened:

- OpenHIM Console → **http://localhost:9000** (login `root@openhim.org` / your
  configured password)
- **Mediators** tab → `NP FHIR MPI Orchestrator` should show as heartbeating (green)
- **Channels** tab → `NP FHIR Orchestrator` channel exists, `urlPattern: ^/fhir(/.*)?$`

If a mediator's channel is missing/stale: it upserts on every restart
(`docker compose restart mediator`) — see `services/fhir-mediator/src/openhim/registration.ts` `syncChannels()`.

---

## 3. Keycloak — issue the JWTs OpenHIM trusts

**First time only** (skip if `keycloak-data` volume already has the realm — check
`docker exec keycloak /opt/keycloak/bin/kcadm.sh get realms/openhie ...` or just
try step 3a and see if it says "already exists"):

```bash
./keycloak/setup.sh                      # creates realm `openhie`, demo-client, demo user
```

OpenHIM fetches the realm's RS256 signing keys from the Keycloak JWKS endpoint
(`authentication_jwt_jwksUri`, default
`http://keycloak:8080/realms/openhie/protocol/openid-connect/certs` over the
docker network) and caches them; an unknown `kid` triggers a refetch, so a realm
rebuild or key rotation needs no restart and no file. If your realm is not
`openhie`, set `KEYCLOAK_JWKS_URI` in the root `.env`.

### 3a. Provision a hospital client (machine-to-machine, no password)

Each hospital gets its own Keycloak client + RSA keypair, authenticated via
`private_key_jwt` — this is what a real hospital EMR uses, not the demo
username/password client.

```bash
./keycloak/create-jwt-client.sh hospital-1
```

This prints a **service-account sub** (a UUID) — that's what OpenHIM needs as
the Client ID:

```bash
docker exec -e HIP_CLIENT_SUB=<sub-from-above> -e HIP_CLIENT_NAME="hospital-1" \
  mediator node dist/scripts/create-hip-client.js
```

Repeat per hospital (`hospital-2`, `hospital-3`, ...). Each hospital's private key
lands in `keycloak/keys/<hospital-id>.key.pem` — gitignored, hand off securely,
don't keep long-term copies once it's theirs.

### 3b. Facility lock (hospital can't claim to be another hospital)

Map each hospital's sub → its facility code in `services/fhir-mediator/.env`:

```
FACILITY_REGISTRY_JSON={"<sub>":"hospital-1", "<sub2>":"hospital-2", ...}
```

Then `docker compose restart mediator`. This makes the mediator stamp every
Patient's `source-facility` from **who actually authenticated**
(`X-OpenHIM-ClientID`, set by OpenHIM server-side — not forgeable) rather than
trusting whatever `managingOrganization` the hospital puts in its own payload.

---

## 4. Get a token

```bash
TOKEN=$(./keycloak/get-jwt-client-token.sh hospital-1)
```

This builds and signs a client assertion with `hospital-1`'s private key, exchanges
it at Keycloak's token endpoint (`http://localhost:8083/realms/openhie/protocol/openid-connect/token`)
via `grant_type=client_credentials`, and returns the access token — the same
token a real hospital's system would attach as `Authorization: Bearer <token>`
on every request to OpenHIM.

---

## 5. Insert a patient

```bash
curl -k -sS -X POST https://localhost:5000/fhir/Patient \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/fhir+json' \
  -d '{
    "resourceType":"Patient",
    "name":[{"use":"official","family":"SHRESTHA","given":["KAMANA"]}],
    "gender":"female","birthDate":"2001-06-25",
    "telecom":[{"system":"phone","value":"9800000000"}],
    "address":[{"city":"Bharatpur"}]
  }' | jq .
```

### What just happened (the flow)

```
Hospital  --Bearer JWT-->  OpenHIM (verify sig, map sub->Client, route by channel)
                              |
                              v
                          mediator (patientHandler)
                              |
                    resolvePatientIdentity()
                              |
              +---------------+----------------+
              |                                 |
      mint/reuse Health ID              POST JeMPI /crRegister
      (Damm-checked, unique)            (dedup: new person or match?)
              |                                 |
              +---------------+----------------+
                              |
                stamp identifiers + provenance
                              |
                  read-merge existing HAPI record
                              |
                  PUT HAPI /Patient/{healthId}   <- idempotent upsert
                              |
                              v
                        response to hospital
```

### Health ID — what it is and what it's for

`Patient.id` in the response, e.g. `61173077335` (`services/fhir-mediator/src/modules/patient/healthId.ts`):

- **10 random digits**, first digit 1-9. Deliberately opaque — encodes *nothing*
  about the patient (no DOB, no gender, no facility baked in). Privacy by design:
  losing/leaking the number alone tells you nothing.
- **+1 Damm check digit** — computed via a 10×10 anti-symmetric quasigroup table.
  Catches every single-digit typo and every adjacent-digit transposition (e.g.
  `07`→`70`) *without a database lookup* — a mistyped ID is rejected instantly,
  client-side. Chosen over Luhn specifically because Luhn misses twin-digit swaps.
- **Uniqueness**: candidate is checked via a direct `GET /Patient/{candidate}`
  against HAPI (race-safe — a read, not a search), retried up to 5x on collision
  (vanishingly rare across a 10-digit space).
- **Reuse on re-registration**: if the same person registers again, JeMPI already
  has their Health ID stored as its `auxId` — the mediator reads it back and
  reuses it, rather than minting a new one.

Show it standalone:

```bash
docker exec mediator node -e "
import('./src/fhir/healthId.js').then(m => {
  const id = m.generateHealthId();
  console.log(id, '| Damm-valid:', m.isValidHealthId(id));
});"
```

### The second identifier — JeMPI golden UID

Also in `identifier[]`. This is JeMPI's own internal identity handle, used to
detect "this is the same person" across every record ever submitted for them.
Health ID is the human-facing card number; golden UID is the machine-side dedup
key behind it. Mapped 1:1, kept as two separate identifier systems on purpose —
see [[jempi-identity-pivot]].

---

## 6. Show the orchestration trail (the real mechanism, not a slide)

OpenHIM Console → **Transactions** → click the one just sent → **orchestrations**
panel shows, in order:

1. `JeMPI register` (POST `/crRegister`)
2. `HAPI read Patient by Health ID` (GET, checks for an existing record to merge)
3. `PUT HAPI Patient` (the actual write)

This *is* the flow diagram, live, on real data.

---

## 7. Prove dedup

Re-POST the **exact same** demographics (same name/dob/phone/gender), optionally
from a different hospital token:

```bash
TOKEN2=$(./keycloak/get-jwt-client-token.sh hospital-2)
curl -k -sS -X POST https://localhost:5000/fhir/Patient \
  -H "Authorization: Bearer $TOKEN2" -H 'Content-Type: application/fhir+json' \
  -d '{ ...same demographics... }' | jq '{id, identifier}'
```

Response comes back with the **same** Health ID and golden UID — no duplicate
created. Orchestrations show `crRegister` → `409/exists` → `crCandidates` lookup,
not a fresh mint.

---

## 8. Prove the facility lock

POST as `hospital-1` but claim to be `hospital-2` in the payload:

```bash
TOKEN=$(./keycloak/get-jwt-client-token.sh hospital-1)
curl -k -sS -X POST https://localhost:5000/fhir/Patient \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/fhir+json' \
  -d '{
    "resourceType":"Patient",
    "name":[{"use":"official","family":"IMPERSONATE","given":["TEST"]}],
    "gender":"male","birthDate":"1985-03-03",
    "managingOrganization":{"identifier":{"value":"hospital-2"}}
  }' | jq '.meta.tag'
```

`source-facility` tag comes back `hospital-1` regardless of what the payload
claimed — the system trusts who authenticated (`X-OpenHIM-ClientID`, set by
OpenHIM server-side), not what the request body says.

---

## 9. Read-back

```bash
curl -k -sS https://localhost:5000/fhir/Patient/{healthId} \
  -H "Authorization: Bearer $TOKEN" | jq .
```

Same record, persisted in HAPI. Orchestrations for this one show only a HAPI
passthrough — no JeMPI call, because identity was already resolved at write time.
Reads bypass JeMPI entirely; by read-time the Health ID *is* the HAPI resource id.

### ⚠️ Known quirk: `meta.tag` accumulates across facilities on dedup

Found during dry run: when JeMPI dedups the *same person* submitted by two
*different* hospitals (step 7), HAPI's default PUT behavior **unions**
`meta.tag` entries rather than replacing them — so the merged record ends up
with **two** `source-facility` tags (one per hospital that ever wrote it),
not just the latest. `services/fhir-mediator/src/fhir/provenance.ts` already dedupes by
system on the object it sends; the duplication happens server-side in HAPI's
merge, after that. Cosmetic/provenance-hygiene issue, not a security hole —
the facility *lock* itself still works correctly on every individual write
(confirmed: each write is stamped with the real authenticated facility, never
a spoofed one). If someone asks "why does this record show two facilities?"
during the demo, that's why. Not fixed yet — flag, don't block on it.

---

## Reference: credentials/scripts created this setup

| What | Where |
|---|---|
| Keycloak realm/client/user setup | `keycloak/setup.sh` |
| New hospital client (keypair + Keycloak client) | `keycloak/create-jwt-client.sh <id>` |
| Get a token for a private_key_jwt client | `keycloak/get-jwt-client-token.sh <id>` |
| Register a Keycloak sub as an OpenHIM Client | `services/fhir-mediator/src/scripts/create-hip-client.ts` |
| Private keys (gitignored) | `keycloak/keys/*.key.pem` |
| Demo human user (password grant) | `demo` / `demo123` on client `demo-client` |
