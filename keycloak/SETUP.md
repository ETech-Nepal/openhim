# Auth & Bring-up Setup

Local / single-host bring-up. Steps and commands only. Run from the repo root.
`<like-this>` = placeholder.

---

## 0. Prerequisites

Install these first:

- **Docker Engine + Compose v2** — <https://docs.docker.com/engine/install/>
  (verify: `docker compose version`)
- **Git** — <https://git-scm.com/downloads>
- CLI tools: `jq`, `curl`, `openssl`, `python3`, `wg` / `wg-quick`
  (Debian/Ubuntu: `sudo apt-get install -y jq curl openssl python3 wireguard`)
- WireGuard config for the JeMPI VPS (`10.8.0.1`, peer `202.51.71.81`)

Then get the code:

```bash
git clone https://github.com/ETech-Nepal/openhim.git openhie
cd openhie
for d in mediator admin-mediator patient-portal-mediator fhir-intake-mediator; do
  cp $d/.env.example $d/.env
done
```

The examples are preconfigured for the compose network. The only value you must
edit for bring-up is `OPENHIM_PASSWORD` in all four — done in §2c, once you have
the password from §2b.

---

## 1. Containers

```bash
docker compose up -d
docker compose ps
```

Running: `hapi-db`, `mongo-db`, `openhim-core`, `openhim-console`, `fhir`,
`keycloak`, `mediator`, `admin-mediator`, `patient-portal-mediator`,
`fhir-intake-mediator`.

> **Never `docker compose down`** (wipes Keycloak's H2). Use `stop` / `start`.
> Mediators crash-loop until steps 2 and 5 are done.

---

## 2. OpenHIM first login

### 2a. Accept the self-signed cert

1. Open <https://localhost:8080/heartbeat>, click through the warning.
2. CLI needs `-k`: `curl -k https://localhost:8080/heartbeat`

### 2b. Root password

1. Console <http://localhost:9000>, log in `root@openhim.org` / `openhim-password`.
2. Set a new password. Record it.

### 2c. Propagate to mediators

Set `OPENHIM_PASSWORD` in `services/fhir-mediator/.env`, `services/admin-mediator/.env`,
`services/patient-portal-mediator/.env`, `services/fhir-intake-mediator/.env`, then:

```bash
docker compose up -d --force-recreate mediator admin-mediator patient-portal-mediator fhir-intake-mediator
```

> `restart` does **not** reload `.env` — use `up -d --force-recreate`.

Console → **Mediators**: all four green.

---

## 3. Reach JeMPI

The mediator talks to JeMPI at `JEMPI_BASE_URL` in `services/fhir-mediator/.env`. Pick one.
After changing it: `docker compose up -d --force-recreate mediator`.

### Option A — JeMPI public IP (simplest)

```bash
# services/fhir-mediator/.env
JEMPI_BASE_URL=http://202.51.71.81:50000/JeMPI
```

Check: `curl http://202.51.71.81:50000/JeMPI/countRecords`

No tunnel. Traffic crosses the public internet unencrypted (JeMPI has no
TLS/auth of its own) — test data only; switch to Option B for real patient data.

### Option B — WireGuard tunnel

Keeps the default `JEMPI_BASE_URL=http://10.8.0.1:50000/JeMPI`.

```bash
sudo wg-quick up wg0                                    # config: /etc/wireguard/wg0.conf
curl http://10.8.0.1:50000/JeMPI/countRecords           # from host
docker exec mediator wget -qO- http://10.8.0.1:50000/JeMPI/countRecords
```

Host works but the container hangs — masquerade the docker subnet out `wg0`:

```bash
sudo iptables -t nat -A POSTROUTING -s 172.16.0.0/12 -o wg0 -j MASQUERADE
sudo sysctl -w net.ipv4.ip_forward=1
```

`wg0.conf` `AllowedIPs` must include `10.8.0.0/24`.

> You can also run the tunnel **and** point `JEMPI_BASE_URL` at the public IP
> `http://202.51.71.81:50000/JeMPI` — both reach the same JeMPI.

---

## 4. Keycloak realm

Admin Console <http://localhost:8083>, bootstrap admin `admin` / `admin`.

```bash
curl -fsS http://localhost:8083/realms/openhie/.well-known/openid-configuration | jq .issuer
```

If it returns a non-empty issuer URL, the realm exists — go to §6. In the
raw-IP profile (§9), that value is
`http://<public-vps-ip>/realms/openhie`, even though this check runs through
the VPS loopback port. Otherwise:

- Realm dropdown → **Create realm** → name `openhie` → **Create**
- Or `./keycloak/setup.sh`

---

## 5. Realm keys into OpenHIM

Nothing to run. OpenHIM fetches the realm's RS256 signing keys from the Keycloak JWKS endpoint
(`authentication_jwt_jwksUri`, default
`http://keycloak:8080/realms/openhie/protocol/openid-connect/certs` over the
docker network) and caches them; an unknown `kid` triggers a refetch, so a realm
rebuild or key rotation needs no restart and no file. If your realm is not
`openhie`, set `KEYCLOAK_JWKS_URI` in the root `.env`.

OpenHIM env (already in `docker-compose.yml`): `authentication_jwt_algorithms`
= `RS256` (plain string), `authentication_jwt_audience` = `account`,
`authentication_jwt_issuer` = `http://localhost:8083/realms/openhie`.

Transaction-port errors:

| Code | Meaning |
|---|---|
| 401 | token missing / bad signature / issuer or audience mismatch |
| 403 | Client mapped, but lacks a channel role |
| 404 | no channel matched the URL |

---

## 6. Per-hospital client

One command per hospital — NHFR code + name. Creates the Organization, keypair,
Keycloak client + `sub`-override mapper, and OpenHIM Client; verifies the token
`sub`:

```bash
./keycloak/onboard-hospital.sh 3130400221 "Bharatpur Hospital"
```

Idempotent. Output gives the private-key path — hand it to the hospital, delete
your copy.

| System | Value |
|---|---|
| FHIR | `Organization.identifier` = `<nhfr-id>`; `Organization.id` = server UUID |
| Keycloak | client `<nhfr-id>`, `private_key_jwt`, token `sub` = `<nhfr-id>` |
| OpenHIM | Client **ID** = `<nhfr-id>`, role `np-fhir-clients` |
| Mediator | `X-OpenHIM-ClientID` = `<nhfr-id>` → `GET Organization?identifier=nhfr\|<nhfr-id>` |

Prereqs: §1, §2c, §5.

Just an Organization, no client: `./keycloak/create-org.sh <nhfr-id> "<name>"`.

> NHFR system string: deployed stack uses `http://mohp.gov.np/fhir/NamingSystem/nhfr`
> (NP Core's canonical is `https://nhfr.mohp.gov.np`).

> `sub` override rejected → `onboard-hospital.sh` fails at 4/5. Fallback: OpenHIM
> `clientID` stays the Keycloak UUID; add
> `FACILITY_REGISTRY_JSON={"<uuid>":"<nhfr-id>"}` to `services/fhir-mediator/.env` +
> `docker compose up -d --force-recreate mediator`.

---

## 7. Smoke test

```bash
TOKEN=$(./keycloak/get-jwt-client-token.sh 3130400221)

curl -k -sS -X POST https://localhost:5000/fhir/Patient \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/fhir+json' \
  -d '{"resourceType":"Patient","name":[{"family":"SHRESTHA","given":["KAMANA"]}],
       "gender":"female","birthDate":"2001-06-25",
       "telecom":[{"system":"phone","value":"9800000000"}]}'
```

`201` with a UUID `id` and `nepal-health-id` in `identifier` = the full chain
works. Console → **Transactions** → the request → **orchestrations**.

Postman: `node keycloak/token-server.mjs`, then `http://localhost:4099/token/3130400221`.

---

## 8. FHIR Intake mediator (`/ingest`)

`POST /ingest` in front of the orchestrator:

| `Content-Type` | Body | Action |
|---|---|---|
| `application/json` | one raw CDRS encounter row | validate → Patient + Encounter Bundle → forward |
| `application/fhir+json` | resource or `transaction`/`batch` Bundle | forward unmutated |
| other | — | `415` |

Channel `NP FHIR Intake`, `^/ingest/?$`, `POST`, route `fhir-intake-mediator:4003`,
role `OPENHIM_CHANNEL_ROLE` in `services/fhir-intake-mediator/.env` (`np-fhir-clients` to
reuse §6 clients).

Raw-row behaviour: `403` if no `X-OpenHIM-ClientID`;
`GET Organization?identifier=nhfr|<nhfr-id>` → `422` if 0 or >1 match; stamps
`managingOrganization` / `serviceProvider` = the resolved `Organization/<uuid>`.
Inbound `X-NHFR-ID` / `organization_id` ignored.

### 8a. Dump script

```bash
cd FHIR_mediator
python3 -m venv venv && venv/bin/pip install -r requirements.txt
cp .env.example .env          # KEYCLOAK_CLIENT_ID=<nhfr-id>, PRIVATE_KEY_FILE, SQLITE_PATH

DRY_RUN=1 venv/bin/python main.py      # preview
venv/bin/python main.py                # raw rows
venv/bin/python main.py --FHIR         # client-mapped Bundles
venv/bin/python main.py --all          # also patients with no insurance number
```

Progress bookmarked per `encounter_number`.

### 8b. Smoke test

```bash
TOKEN=$(./keycloak/get-jwt-client-token.sh 3130400221)

curl -k -sS -X POST https://localhost:5000/ingest \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"hospital_patient_number":"2405078","encounter_number":"SMOKE-1",
       "first_name":"CHANDRIKA","last_name":"KANDEL","sex":"Female",
       "department_type":"C","department_id":"22","department_name":"Family Medicine",
       "visit_date_ad_time":"2026-07-28 00:02:00.000"}'
```

`201`. A second POST of the same `encounter_number` must not create a duplicate.

---

## 9. VPS raw-IP test profile

Use this only for a short test on a trusted network or through WireGuard. It
uses **plain HTTP** for Keycloak, so credentials and tokens are not protected
on an untrusted network. Use the domain/Caddy HTTPS profile before handling
real credentials or patient data.

Create root `.env` on the VPS:

```bash
VPS_IP=<public-vps-ip>
KEYCLOAK_PUBLIC_URL=http://<public-vps-ip>
KEYCLOAK_ISSUER=http://<public-vps-ip>/realms/openhie
```

Start the raw-IP profile:

```bash
docker compose --profile vps-ip up -d --build
docker compose ps
```

Keycloak is now reached at `http://<public-vps-ip>` through Caddy; the
container's `8083` remains bound to `127.0.0.1` for VPS-local onboarding
scripts. The configured Keycloak issuer and OpenHIM JWT issuer must both be
`http://<public-vps-ip>/realms/openhie`.

Open firewall access only as needed:

| Port | Protocol | Purpose | Access |
|---|---|---|---|
| `22` | TCP | SSH | admin IP/VPN only |
| `80` | TCP | Keycloak through Caddy | WireGuard/trusted test clients only |
| `5000` | TCP | OpenHIM transaction endpoint | approved test client IPs |
| `8080` | TCP | OpenHIM API | admin IP/VPN only |
| `9000` | TCP | OpenHIM Console | admin IP/VPN only |
| `<wg-port>` | UDP | WireGuard listener | WireGuard peers only |

`5001`, `8081`, and `8083` are loopback-only in Compose; do not add firewall
rules or broader port mappings for them. Do not publish `5432`, `27017`, or
mediator ports.

For a hospital client token command running outside the VPS, set the public
Keycloak address explicitly:

```bash
KEYCLOAK_URL=http://<public-vps-ip> ./keycloak/get-jwt-client-token.sh <nhfr-id>
```

Use the same public IP for transaction smoke tests (OpenHIM's transaction
port remains self-signed in this test profile):

```bash
TOKEN=$(KEYCLOAK_URL=http://<public-vps-ip> ./keycloak/get-jwt-client-token.sh <nhfr-id>)
curl -k -sS -X POST https://<public-vps-ip>:5000/fhir/Patient \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/fhir+json' \
  -d '{"resourceType":"Patient","name":[{"family":"TEST"}],"gender":"unknown"}'
```

Then continue with WireGuard/JeMPI in §3, OpenHIM password propagation in §2,
realm key extraction in §5, and hospital onboarding in §6.

---

## Quick reference

| Task | Command |
|---|---|
| Create the realm | `./keycloak/setup.sh` |
| Create/update an Organization | `./keycloak/create-org.sh <nhfr-id> "<name>"` |
| Onboard a hospital | `./keycloak/onboard-hospital.sh <nhfr-id> "<name>"` |
| Hospital token | `./keycloak/get-jwt-client-token.sh <nhfr-id>` |
| Postman token helper | `node keycloak/token-server.mjs` (`:4099`) |
| JeMPI tunnel up | `sudo wg-quick up wg0` |
| Push data | `cd FHIR_mediator && venv/bin/python main.py` (`--FHIR`, `--all`) |

## Troubleshooting

| Symptom | Fix |
|---|---|
| Console calls fail, network error | accept the cert — <https://localhost:8080/heartbeat> (2a) |
| Mediator missing under **Mediators** | `OPENHIM_PASSWORD` ≠ root password (2c) |
| `.env` change ignored | used `restart`, not `up -d --force-recreate` |
| `JWT could not be verified` / `Public key not found in JWKS cache` | core cannot reach `KEYCLOAK_JWKS_URI` — `docker compose logs openhim-core` (§5) |
| 401 at `:5000` fresh token | issuer mismatch — `iss` must exactly match `KEYCLOAK_ISSUER` (`http://localhost:8083/realms/openhie` locally; see §9 on a VPS) |
| 403 at `:5000` | Client lacks role — re-run `onboard-hospital.sh` (§6) |
| 404 at `:5000/ingest` | `NP FHIR Intake` channel missing — check `fhir-intake-mediator` |
| 403 at `:5000/ingest` | set `OPENHIM_CHANNEL_ROLE=np-fhir-clients` on `fhir-intake-mediator` |
| 422 at `:5000/ingest` | no Organization with NHFR identifier `<nhfr-id>` — `create-org.sh` (§6) |
| `onboard-hospital.sh` fails at 4/5 | Keycloak won't override `sub` — `FACILITY_REGISTRY_JSON` fallback (§6) |
| container can't reach `10.8.0.1`, host can | masquerade the docker subnet out `wg0` (§3) |
| Keycloak realm gone after a stop | `docker compose down` was used — use `stop`/`start` |
