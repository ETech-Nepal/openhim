# Auth & Bring-up Setup (Windows)

Local / single-host bring-up on Windows 10/11. PowerShell for everyday
commands; the `keycloak/*.sh` scripts are Bash — run those from **Git Bash**
(ships with Git for Windows) or WSL. `<like-this>` = placeholder.

> In PowerShell `curl` is an alias for `Invoke-WebRequest`. Use **`curl.exe`**
> everywhere below — the real curl, bundled with Windows 10 1803+.

---

## 0. Prerequisites

Install:

- **Docker Desktop** (WSL 2 backend) — <https://docs.docker.com/desktop/install/windows-install/>
  (verify: `docker compose version`)
- **Git for Windows** — <https://git-scm.com/download/win> (gives you Git Bash)
- **WireGuard for Windows** — <https://www.wireguard.com/install/>
  (only for §3 Option B)
- **Python 3** — Microsoft Store or <https://www.python.org/downloads/windows/>
  (the Store build registers `python3`, which `onboard-hospital.sh` needs)
- **jq** — `winget install jqlang.jq`, then reopen the shell (Git Bash has no `jq`)

The `keycloak/*.sh` scripts need `bash`, `docker`, `openssl`, `curl`, `jq`,
`python3` all on PATH — Git Bash provides all but `jq` and `python3`. The repo's
`.gitattributes` keeps the scripts LF so they run under Git Bash unmodified; if
you see `$'\r': command not found`, your checkout converted them to CRLF — run
`git config core.autocrlf false` and re-checkout.

Get the code (PowerShell):

```powershell
git clone https://github.com/ETech-Nepal/openhim.git openhie
cd openhie
'mediator','admin-mediator','patient-portal-mediator','fhir-intake-mediator' |
  ForEach-Object { Copy-Item "$_\.env.example" "$_\.env" }
```

The examples are preconfigured for the compose network. The only value you must
edit for bring-up is `OPENHIM_PASSWORD` in all four — done in §2c, once you have
the password from §2b.

---

## 1. Containers

```powershell
docker compose up -d
docker compose ps
```

Running: `hapi-db`, `mongo-db`, `openhim-core`, `openhim-console`, `fhir`,
`keycloak`, `mediator`, `admin-mediator`, `patient-portal-mediator`,
`fhir-intake-mediator`.

> **Never `docker compose down`** (wipes Keycloak's H2). Use
> `docker compose stop` / `docker compose start`. Mediators crash-loop until
> steps 2 and 5 are done.

---

## 2. OpenHIM first login

### 2a. Accept the self-signed cert

1. Open <https://localhost:8080/heartbeat> in a browser, click through the warning.
2. CLI needs `-k`: `curl.exe -k https://localhost:8080/heartbeat`

### 2b. Root password

1. Console <http://localhost:9000>, log in `root@openhim.org` / `openhim-password`.
2. Set a new password. Record it.

### 2c. Propagate to mediators

Edit `OPENHIM_PASSWORD` in `mediator\.env`, `services\admin-mediator\.env`,
`services\patient-portal-mediator\.env`, `fhir-intake-mediator\.env` (Notepad or
`notepad mediator\.env`), then:

```powershell
docker compose up -d --force-recreate mediator admin-mediator patient-portal-mediator fhir-intake-mediator
```

> `restart` does **not** reload `.env` — use `up -d --force-recreate`.

Console → **Mediators**: all four green.

---

## 3. Reach JeMPI

The mediator talks to JeMPI at `JEMPI_BASE_URL` in `mediator\.env`. Pick one.
After changing it: `docker compose up -d --force-recreate mediator`.

### Option A — JeMPI public IP (recommended on Windows)

```ini
# mediator\.env
JEMPI_BASE_URL=http://202.51.71.81:50000/JeMPI
```

Check: `curl.exe http://202.51.71.81:50000/JeMPI/countRecords`

No tunnel, no routing fixes. Traffic crosses the public internet unencrypted
(JeMPI has no TLS/auth of its own) — test data only; use Option B for real
patient data.

### Option B — WireGuard tunnel

Keeps the default `JEMPI_BASE_URL=http://10.8.0.1:50000/JeMPI`.

1. Open **WireGuard** → *Add Tunnel* → *Import from file* → pick `wg0.conf`.
2. Ensure the config's `AllowedIPs` includes `10.8.0.0/24`.
3. Click **Activate**.
4. From host: `curl.exe http://10.8.0.1:50000/JeMPI/countRecords`
5. From a container:
   `docker exec mediator wget -qO- http://10.8.0.1:50000/JeMPI/countRecords`

If the host reaches JeMPI but the container does not, Docker Desktop's WSL 2
network is not routing to the Windows WireGuard adapter. Simplest fix: use
Option A. (Advanced: run WireGuard **inside** WSL, or add a static route in the
WSL distro.)

---

## 4. Keycloak realm

Admin Console <http://localhost:8083>, bootstrap admin `admin` / `admin`.

```powershell
curl.exe -fsS http://localhost:8083/realms/openhie/.well-known/openid-configuration
```

If the JSON's `issuer` is `http://localhost:8083/realms/openhie`, the realm
exists — go to §6. Otherwise:

- Realm dropdown → **Create realm** → name `openhie` → **Create**
- Or, from Git Bash: `./keycloak/setup.sh`

---

## 5. Realm keys into OpenHIM

Nothing to run. OpenHIM fetches the realm's RS256 signing keys from the Keycloak JWKS endpoint
(`authentication_jwt_jwksUri`, default
`http://keycloak:8080/realms/openhie/protocol/openid-connect/certs` over the
docker network) and caches them; an unknown `kid` triggers a refetch, so a realm
rebuild or key rotation needs no restart and no file. If your realm is not
`openhie`, set `KEYCLOAK_JWKS_URI` in the root `.env`.

OpenHIM env (already in `docker-compose.yml`): `authentication_jwt_algorithms`
= `RS256`, `authentication_jwt_audience` = `account`,
`authentication_jwt_issuer` = `http://localhost:8083/realms/openhie`.

Transaction-port errors:

| Code | Meaning |
|---|---|
| 401 | token missing / bad signature / issuer or audience mismatch |
| 403 | Client mapped, but lacks a channel role |
| 404 | no channel matched the URL |

---

## 6. Per-hospital client

Git Bash. One command per hospital — NHFR code + name. Creates the
Organization, keypair, Keycloak client + `sub`-override mapper, and OpenHIM
Client; verifies the token `sub`:

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
> `FACILITY_REGISTRY_JSON={"<uuid>":"<nhfr-id>"}` to `mediator\.env` +
> `docker compose up -d --force-recreate mediator`.

---

## 7. Smoke test

Git Bash (handles `$(...)` and multi-line JSON):

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
role `OPENHIM_CHANNEL_ROLE` in `fhir-intake-mediator\.env` (`np-fhir-clients` to
reuse §6 clients).

Raw-row behaviour: `403` if no `X-OpenHIM-ClientID`;
`GET Organization?identifier=nhfr|<nhfr-id>` → `422` if 0 or >1 match; stamps
`managingOrganization` / `serviceProvider` = the resolved `Organization/<uuid>`.
Inbound `X-NHFR-ID` / `organization_id` ignored.

### 8a. Dump script (PowerShell)

```powershell
cd FHIR_mediator
py -m venv venv
venv\Scripts\python -m pip install -r requirements.txt
Copy-Item .env.example .env
#   KEYCLOAK_CLIENT_ID=<nhfr-id>   PRIVATE_KEY_FILE=<the .pem from §6>
#   SQLITE_PATH=<path to that hospital's cdrs_sync.db>

$env:DRY_RUN=1; venv\Scripts\python main.py     # preview
Remove-Item Env:\DRY_RUN
venv\Scripts\python main.py                     # raw rows
venv\Scripts\python main.py --FHIR              # client-mapped Bundles
venv\Scripts\python main.py --all               # also patients with no insurance number
```

Progress bookmarked per `encounter_number`.

### 8b. Smoke test

Git Bash:

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

## Quick reference

| Task | Command | Shell |
|---|---|---|
| Create the realm | `./keycloak/setup.sh` | Git Bash |
| Create/update an Organization | `./keycloak/create-org.sh <nhfr-id> "<name>"` | Git Bash |
| Onboard a hospital | `./keycloak/onboard-hospital.sh <nhfr-id> "<name>"` | Git Bash |
| Hospital token | `./keycloak/get-jwt-client-token.sh <nhfr-id>` | Git Bash |
| Postman token helper | `node keycloak/token-server.mjs` (`:4099`) | any |
| Recreate a mediator | `docker compose up -d --force-recreate mediator` | PowerShell |
| Push data | `cd FHIR_mediator; venv\Scripts\python main.py` (`--FHIR`, `--all`) | PowerShell |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `curl` returns an HTML object / weird errors | you hit `Invoke-WebRequest` — use `curl.exe` |
| `./keycloak/*.sh` "not recognized" | run it from **Git Bash**, not PowerShell |
| Console calls fail, network error | accept the cert — <https://localhost:8080/heartbeat> (2a) |
| Mediator missing under **Mediators** | `OPENHIM_PASSWORD` ≠ root password (2c) |
| `.env` change ignored | used `restart`, not `up -d --force-recreate` |
| `JWT could not be verified` / `Public key not found in JWKS cache` | core cannot reach `KEYCLOAK_JWKS_URI` — `docker compose logs openhim-core` (§5) |
| 401 at `:5000` fresh token | issuer mismatch — `iss` must be `http://localhost:8083/realms/openhie` |
| 403 at `:5000` | Client lacks role — re-run `onboard-hospital.sh` (§6) |
| 404 at `:5000/ingest` | `NP FHIR Intake` channel missing — check `fhir-intake-mediator` |
| 403 at `:5000/ingest` | set `OPENHIM_CHANNEL_ROLE=np-fhir-clients` on `fhir-intake-mediator` |
| 422 at `:5000/ingest` | no Organization with NHFR identifier `<nhfr-id>` — `create-org.sh` (§6) |
| container can't reach `10.8.0.1`, host can | WSL 2 not routing to the WireGuard adapter — use §3 Option A |
| Keycloak realm gone after a stop | `docker compose down` was used — use `stop` / `start` |
