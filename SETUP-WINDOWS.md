# OpenHIM on Windows — Setup, Auth & Deployment

Every step below is written the same way: **the commands to run**, then **why**
they are needed, then **what can go wrong** and how it looks when it does.

---

## 0. Prereqs

### 0a. Install the tools

Run in an **Administrator** PowerShell. `winget` ships with Windows 11.

```powershell
winget install --id Git.Git              -e --source winget   # Git for Windows
winget install --id Docker.DockerDesktop -e --source winget   # Docker Desktop (WSL2 backend)
winget install --id Microsoft.PowerShell -e --source winget   # PowerShell 7 (pwsh)
```

Optional, only for the extras noted later:

```powershell
winget install --id OpenJS.NodeJS.LTS    -e --source winget   # for keycloak/token-server.mjs (§8)
winget install --id Python.Python.3.12   -e --source winget   # for the CDRS dump script (§9a)
winget install --id GitHub.cli           -e --source winget   # easiest GitHub auth (§0b)
```

Then launch **Docker Desktop** once and let it finish starting (whale icon
steady in the tray), close the terminal, reopen **PowerShell 7** (`pwsh`), and
verify:

```powershell
git --version
docker version
docker compose version
$PSVersionTable.PSVersion        # 7.1 or newer
```

**Why.** Docker Desktop has to run at least once to initialise its engine —
Settings → General → **Use the WSL 2 based engine** must be on, and Settings →
Resources → WSL Integration → enable your distro if you use one. The terminal
must be reopened as `pwsh`, not Windows PowerShell 5.1, because every `.ps1`
script here declares `#Requires -Version 7.1`.

Not needed on Windows: `jq`, `openssl`, `wg` / `wg-quick`. `curl.exe` is already
part of Windows 10/11 — in `pwsh` the bare name `curl` resolves to it, but the
examples below spell out `curl.exe` so they also work in Windows PowerShell.

**What can go wrong.**

| Symptom | Cause / fix |
|---|---|
| `docker: error during connect` | Docker Desktop is not running, or the WSL2 engine is off |
| `#Requires -Version 7.1` | you are in Windows PowerShell 5.1 — open `pwsh` |
| *execution of scripts is disabled* | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or always invoke as `pwsh -File .\script.ps1` |
| `curl` behaves oddly (`Invoke-WebRequest` flags) | you are in Windows PowerShell, where `curl` is an alias — use `curl.exe` |

### 0b. GitHub access

```powershell
gh auth login          # GitHub.com -> HTTPS -> login with a browser

# confirm access BEFORE cloning
git ls-remote https://github.com/ETech-Nepal/openhim.git | Select-Object -First 1
```

**Why.** The repo is private under the **ETech-Nepal** organisation, so an org
owner must first add your GitHub account as a **collaborator with at least Read
access** on `ETech-Nepal/openhim`, and you must accept the invitation email (or
<https://github.com/ETech-Nepal/openhim/invitations>). `git ls-remote` proves
both the invite and the credential before you spend time on a clone.

Alternatives to `gh auth login`: a **Personal Access Token** (classic, `repo`
scope) used as the password at the git prompt — Git Credential Manager caches it
in Windows Credential Manager — or an SSH key (`ssh-keygen -t ed25519`, add the
`.pub` to GitHub, then clone the `git@github.com:` URL).

**What can go wrong.** `remote: Repository not found` from `ls-remote` means the
invite is not accepted or the credential is wrong. It is not a clone problem and
retrying the clone will not fix it.

### 0c. Clone the repo

**Repository:** <https://github.com/ETech-Nepal/openhim>

```powershell
cd C:\GitHub                                              # or wherever you keep code
git clone https://github.com/ETech-Nepal/openhim.git
cd openhim
```

**Why.** Every command from here on runs from this directory (the repo root) —
the Compose file, the bind-mount paths and the `.\keycloak\*.ps1` invocations all
assume it.

**What can go wrong.**

- Keep the path short and free of spaces. Docker Desktop bind-mounts several
  paths from this tree (`openhim-config`, `hapi-config`, `jempi-config`); a path
  with spaces or a OneDrive-synced folder causes mount failures.
- Git for Windows converts line endings on checkout. The `.ps1` scripts do not
  care, but if you ever run the `.sh` twins through WSL and get
  `bad interpreter: /bin/bash^M`, re-clone with
  `git clone --config core.autocrlf=input`.

---

## 1. Configuration files

None of this is in git, so a fresh clone has none of it. Create it all **before**
the first `docker compose up` (§2).

### 1a. Mediator `.env` files

```powershell
Copy-Item services\fhir-mediator\.env.example                services\fhir-mediator\.env
Copy-Item admin-mediator\.env.example          admin-mediator\.env
Copy-Item patient-portal-mediator\.env.example patient-portal-mediator\.env
Copy-Item services\fhir-intake-mediator\.env.example    services\fhir-intake-mediator\.env
```

**Leave them exactly as shipped.** Every default is correct for a local Docker
run, and each value you do have to edit is written at the step that produces it —
none of them can be filled in yet:

| Variable | Written at |
|---|---|
| `OPENHIM_PASSWORD` (all four) | §3c, using the root password you set in §3b |
| `JEMPI_BASE_URL` (`mediator`, `admin-mediator`) | §4 |
| `FACILITY_REGISTRY_JSON` (`mediator`) | §7, and only as the fallback |
| `PORTAL_PATIENT_SHARED_SECRET` (`patient-portal-mediator`) | only if you run the patient-portal BFF — see [`.env` reference](#env-reference) |

**Why.** Four services read a `.env` that is **not** in git, so a fresh clone has
none of them and the containers start with no configuration at all.

**What can go wrong.** Until §3c fills in `OPENHIM_PASSWORD` the mediators
crash-loop — expected (§2), and nothing before §3b can fix it.

> `.env` is in `.gitignore`. Never commit one — they hold the OpenHIM root
> password.

### 1c. Root `.env` — VPS only, skip it locally

Nothing to run here for a local install: **do not create a root `.env`.**

**Why.** There is a fifth `.env`, in the repo root, read by `docker-compose.yml`
itself (`DOMAIN`, `VPS_IP`, `KEYCLOAK_PUBLIC_URL`, `KEYCLOAK_ISSUER`). It exists
to drive the Caddy profiles on a VPS and is covered in §10b. Locally every one of
those variables already has a `localhost` default baked into `docker-compose.yml`.

**What can go wrong.** A half-filled root `.env` points Keycloak and OpenHIM at
an issuer your tokens do not carry, and every call to the transaction port 401s.

---

## 2. Containers

```powershell
docker compose up -d
docker compose ps
```

Running: `hapi-db`, `mongo-db`, `openhim-core`, `openhim-console`, `fhir`,
`keycloak`, `mediator`, `admin-mediator`, `patient-portal-mediator`,
`fhir-intake-mediator`.

**Why.** `caddy` / `caddy-ip` are **not** in that list, and should not be: both
sit behind Compose profiles (`vps` / `vps-ip`) and start only when you name one,
which is a VPS deployment (§10). Locally you talk to the host ports directly.

**What can go wrong.**

- The first run pulls several GB of images — slow, not stuck.
- Mediators crash-loop until steps 3 and 6 are done. That is expected.
- If some other container exits immediately, read its log before anything else:

```powershell
docker compose logs --tail 50 mediator
```

> **Never `docker compose down`** (wipes Keycloak's H2 store and with it the
> realm). Use `docker compose stop` / `docker compose start`. When you *intend*
> to wipe and rebuild, that is §11, not an accident.

---

## 3. OpenHIM first login

### 3a. Accept the self-signed cert

1. Open <https://localhost:8080/heartbeat> in Edge/Chrome, click **Advanced →
   Continue**.
2. From the CLI, use `-k`:

```powershell
curl.exe -k https://localhost:8080/heartbeat
# PowerShell-native:
Invoke-RestMethod https://localhost:8080/heartbeat -SkipCertificateCheck
```

**Why.** OpenHIM Core's API port is HTTPS with a self-signed certificate. The
browser refuses it until you accept it once, and CLI tools refuse it until told
to skip verification.

**What can go wrong.** Without the browser exception the Console's calls fail
**silently** — it looks like a broken login or an empty database rather than a
certificate problem.

### 3b. Root password

1. Console <http://localhost:9000>, log in `root@openhim.org` /
   `openhim-password`.
2. Set a new password. **Record it** — §3c needs it in four files.

**Why.** `openhim-password` is the shipped default and is public knowledge; the
mediators authenticate to Core as `root`, so this password becomes their
credential in §3c.

**What can go wrong.** Lose it and the mediators cannot be configured — you would
have to reset Core's Mongo database (§11) to get back to a known password.

### 3c. Propagate to mediators

```powershell
foreach ($d in 'services/fhir-mediator','admin-mediator','patient-portal-mediator','services/fhir-intake-mediator') {
  (Get-Content "$d\.env") -replace '^OPENHIM_PASSWORD=.*', 'OPENHIM_PASSWORD=<your-password>' |
    Set-Content "$d\.env"
}

docker compose up -d --force-recreate mediator admin-mediator patient-portal-mediator fhir-intake-mediator
```

Console → **Mediators**: all four green.

**Why.** All four mediators register themselves with Core using
`OPENHIM_PASSWORD`; blank or stale, they cannot log in and keep restarting. The
force-recreate is what makes the new value reach the containers.

**What can go wrong.**

| Symptom | Cause |
|---|---|
| a mediator missing under **Mediators** | its `OPENHIM_PASSWORD` ≠ the §3b root password |
| the change appears to be ignored | you used `docker compose restart`, which does **not** reload `.env` — it must be `up -d --force-recreate` |

---

## 4. JeMPI connectivity — WireGuard is no longer required

Check the API is reachable, point both mediators at it, then apply:

```powershell
curl.exe http://202.51.71.81:50000/JeMPI/countRecords
# {"goldenRecords":85,"interactions":85}
```

```powershell
$JEMPI = 'http://202.51.71.81:50000/JeMPI'
foreach ($f in '.\services\fhir-mediator\.env', '.\admin-mediator\.env') {
  $c = Get-Content -Raw -LiteralPath $f
  $c = if ($c -match '(?m)^JEMPI_BASE_URL=') { $c -replace '(?m)^JEMPI_BASE_URL=.*$', "JEMPI_BASE_URL=$JEMPI" }
       else { $c.TrimEnd() + "`nJEMPI_BASE_URL=$JEMPI" }
  # WriteAllText, not Set-Content: Set-Content would rewrite the whole file CRLF
  [IO.File]::WriteAllText((Resolve-Path $f), (($c.TrimEnd() -replace "`r`n", "`n") + "`n"), [Text.UTF8Encoding]::new($false))
  "{0} -> {1}" -f (Split-Path $f -Parent | Split-Path -Leaf), (Select-String -Path $f -Pattern '^JEMPI_BASE_URL=').Line
}
```

Expected output:

```
mediator -> JEMPI_BASE_URL=http://202.51.71.81:50000/JeMPI
admin-mediator -> JEMPI_BASE_URL=http://202.51.71.81:50000/JeMPI
```

```powershell
docker compose up -d --force-recreate mediator admin-mediator

# the containers must agree — this is what actually takes effect
docker exec mediator sh -c 'echo $JEMPI_BASE_URL'
docker exec admin-mediator sh -c 'echo $JEMPI_BASE_URL'

docker exec mediator wget -qO- http://202.51.71.81:50000/JeMPI/countRecords   # from inside the container
```

**Why.** JeMPI runs on the VPS `202.51.71.81` and **port `50000` is now forwarded
on that host**, so the API is reachable straight over the public internet — no
tunnel, nothing extra to install on Windows. The `.env` block above is written to
be idempotent: it sets the key whether it is stale, absent, or already correct,
and writes LF-only UTF-8 so the file stays readable to the container.

Both the host check and the container check must return the JSON. A container
reaches a public IP through Docker's NAT with no extra rules — the Linux
`iptables MASQUERADE` workaround from the tunnel era does not apply.

**What can go wrong.**

- Setting only one of the two files. `services\fhir-mediator\.env` **and**
  `admin-mediator\.env` both need `JEMPI_BASE_URL`; missing one is the usual
  cause of the `502` in §8.
- Using `restart` instead of `--force-recreate` — the container keeps the old
  value, which is why the `docker exec ... echo` checks are there.
- A stale `10.8.0.1` value from the tunnel era produces
  `502 JeMPI register failed: timeout`.

> `:50000` is the open API (no Keycloak in front). `:50001` is the
> Keycloak-protected port; production will move to it later. Because `:50000` is
> now publicly exposed rather than tunnel-only, treat it as untrusted transport:
> restrict it to known source IPs on the JeMPI VPS firewall.

### 4a. WireGuard fallback (kept for reference)

- **Windows:** install the official client
  (`winget install --id WireGuard.WireGuard -e`), then **Add Tunnel → Import
  from file** with the `wg0.conf` you were issued and **Activate**. Ensure the
  peer's `AllowedIPs` includes `10.8.0.0/24`.
- **Linux host / VPS:**

```bash
sudo wg-quick up wg0                                          # config at /etc/wireguard/wg0.conf
curl http://10.8.0.1:50000/JeMPI/countRecords                 # from host
docker exec mediator wget -qO- http://10.8.0.1:50000/JeMPI/countRecords   # from a container

# host works but container hangs:
sudo iptables -t nat -A POSTROUTING -s 172.16.0.0/12 -o wg0 -j MASQUERADE
sudo sysctl -w net.ipv4.ip_forward=1
```

**Why.** Still valid if the port forward is withdrawn, or if you must reach
`:50001` or other VPS-internal services. The tunnel address for JeMPI was
`10.8.0.1`; if you go back to the tunnel, set
`JEMPI_BASE_URL=http://10.8.0.1:50000/JeMPI` and force-recreate the two mediators
again.

**What can go wrong.** Docker Desktop containers route through the Windows host,
so no extra rules are needed — but if a container still cannot reach `10.8.0.1`,
restart Docker Desktop after activating the tunnel so the WSL network picks up
the route. On Linux, a host that works while the container hangs is the missing
`MASQUERADE` rule above.

---

## 5. Keycloak realm

Check whether the realm already exists:

```powershell
(Invoke-RestMethod http://localhost:8083/realms/openhie/.well-known/openid-configuration).issuer
```

If it prints `http://localhost:8083/realms/openhie`, the realm exists — skip the
next command and continue at **§7**. Otherwise create it:

```powershell
pwsh -File .\keycloak\setup.ps1
```

(or by hand: Admin Console <http://localhost:8083>, bootstrap admin
`admin` / `admin` → realm dropdown → **Create realm** → name `openhie` →
**Create**).

**Why.** `setup.ps1` also creates `demo-client` + user `demo`/`demo123` and
prints the demo user's `sub`. A password-grant demo token, no `jq` needed:

```powershell
(Invoke-RestMethod -Method Post -Uri 'http://localhost:8083/realms/openhie/protocol/openid-connect/token' `
   -Body @{ grant_type='password'; client_id='demo-client'; username='demo'; password='demo123' }).access_token
```


---

## 6. Realm keys into OpenHIM

Nothing to run. OpenHIM fetches the realm's RS256 signing keys from the Keycloak
JWKS endpoint (`authentication_jwt_jwksUri`, default
`http://keycloak:8080/realms/openhie/protocol/openid-connect/certs` over the
docker network) and caches them; an unknown `kid` triggers a refetch, so a realm
rebuild or key rotation needs no restart and no file. The other settings are
already in `docker-compose.yml`: `authentication_jwt_algorithms` = `RS256`
(plain string), `authentication_jwt_audience` = `account`,
`authentication_jwt_issuer` = `http://localhost:8083/realms/openhie`.

If your realm is not `openhie`, set `KEYCLOAK_JWKS_URI` in the root `.env` to
the matching internal URL.

**What can go wrong.** Transaction-port errors and what they mean:

| Code | Meaning |
|---|---|
| 401 | token missing / bad signature / issuer or audience mismatch |
| 403 | Client mapped, but lacks a channel role |
| 404 | no channel matched the URL |

---

## 7. Per-hospital client

One command per hospital — NHFR code + name:

```powershell
pwsh -File .\keycloak\onboard-hospital.ps1 3130400221 "Bharatpur Hospital"
```

Just an Organization, no client:
`pwsh -File .\keycloak\create-org.ps1 <nhfr-id> "<name>"`.

Prereqs: §2, §3c, §6.

**Why.** The one command creates the Organization, keypair, Keycloak client +
`sub`-override mapper, and OpenHIM Client, then verifies the token `sub` — so the
same NHFR code identifies the hospital in all four systems:

| System | Value |
|---|---|
| FHIR | `Organization.identifier` = `<nhfr-id>`; `Organization.id` = server UUID |
| Keycloak | client `<nhfr-id>`, `private_key_jwt`, token `sub` = `<nhfr-id>` |
| OpenHIM | Client **ID** = `<nhfr-id>`, role `np-fhir-clients` |
| Mediator | `X-OpenHIM-ClientID` = `<nhfr-id>` → `GET Organization?identifier=nhfr\|<nhfr-id>` |

It is idempotent, so re-running is safe. Output gives the private-key path
(`keycloak\keys\<nhfr>.key.pem`) — hand it to the hospital over a secure channel,
then delete your copy. `keycloak/keys/` is gitignored.

Script overrides via environment: `KEYCLOAK_URL` (default
`http://localhost:8083`), `KEYCLOAK_ADMIN_USER` / `KEYCLOAK_ADMIN_PASSWORD`
(default `admin`/`admin`), plus `FHIR_BASE_URL` and `ACCESS_TOKEN` for
`create-org.ps1`.

**What can go wrong.**

- `sub` override rejected → `onboard-hospital.ps1` fails at 4/5. Fallback:
  OpenHIM `clientID` stays the Keycloak UUID; add
  `FACILITY_REGISTRY_JSON={"<uuid>":"<nhfr-id>"}` to `services\fhir-mediator\.env` +
  `docker compose up -d --force-recreate mediator`.
- NHFR system string mismatch: the deployed stack uses
  `http://mohp.gov.np/fhir/NamingSystem/nhfr` (NP Core's canonical is
  `https://nhfr.mohp.gov.np`).

---

## 8. Smoke test

```powershell
$TOKEN = & .\keycloak\get-jwt-client-token.ps1 3130400221

$body = @'
{"resourceType":"Patient","name":[{"family":"SHRESTHA","given":["KAMANA"]}],
 "gender":"female","birthDate":"2001-06-25",
 "telecom":[{"system":"phone","value":"9800000000"}]}
'@

Invoke-RestMethod -Method Post -Uri 'https://localhost:5000/fhir/Patient' `
  -SkipCertificateCheck `
  -Headers @{ Authorization = "Bearer $TOKEN" } `
  -ContentType 'application/fhir+json' -Body $body
```

`201` with a UUID `id` and `nepal-health-id` in `identifier` = the full chain
works. Console → **Transactions** → the request → **orchestrations**.

Postman: `node keycloak\token-server.mjs`, then
<http://localhost:4099/token/3130400221>.

**Why.** This exercises the whole chain in one call — Keycloak
`private_key_jwt` → OpenHIM auth and channel routing → mediator → HAPI FHIR →
JeMPI. A `201` here means §3 through §7 are all correct.

**What can go wrong — reading a failure.** On an error OpenHIM echoes **your
request body back** as the response body, and `Invoke-RestMethod` surfaces that
as the exception message — so a failed smoke test looks like it printed your own
Patient JSON back at you. That text tells you nothing; you need the status code
and the core log:

```powershell
try   { Invoke-WebRequest -Method Post -Uri 'https://localhost:5000/fhir/Patient' `
          -SkipCertificateCheck -Headers @{ Authorization = "Bearer $TOKEN" } `
          -ContentType 'application/fhir+json' -Body $body }
catch { "STATUS: $([int]$_.Exception.Response.StatusCode)"
        $_.ErrorDetails.Message }

docker compose logs --tail 40 openhim-core
```

Then read the status against the §6 table (401 auth / 403 role / 404 channel); a
`502` is usually `JEMPI_BASE_URL` (§4). Note `Invoke-WebRequest`'s `.Content`
comes back as a **byte array** for `application/fhir+json` — use
`Invoke-RestMethod`, which parses it into an object, once the call succeeds.

---

## 9. FHIR Intake mediator (`/ingest`)

`POST /ingest` sits in front of the orchestrator:

| `Content-Type` | Body | Action |
|---|---|---|
| `application/json` | one raw CDRS encounter row | validate → Patient + Encounter Bundle → forward |
| `application/fhir+json` | resource or `transaction`/`batch` Bundle | forward unmutated |
| other | — | `415` |

**Why.** It lets a hospital push raw CDRS rows without building FHIR itself, while
still going through the same OpenHIM auth and audit path. Channel
`NP FHIR Intake`, `^/ingest/?$`, `POST`, route `fhir-intake-mediator:4003`, role
`OPENHIM_CHANNEL_ROLE` in `services\fhir-intake-mediator\.env` (`np-fhir-clients` to reuse
§7 clients).

**What can go wrong.** Raw-row behaviour is strict by design: `403` if no
`X-OpenHIM-ClientID`; `GET Organization?identifier=nhfr|<nhfr-id>` → `422` if 0
or >1 match. It stamps `managingOrganization` / `serviceProvider` = the resolved
`Organization/<uuid>`, and inbound `X-NHFR-ID` / `organization_id` are ignored —
so a client cannot claim a different facility.

### 9a. Dump script

```powershell
cd FHIR_mediator
Copy-Item .env.example .env     # KEYCLOAK_CLIENT_ID=<nhfr-id>, PRIVATE_KEY_FILE, SQLITE_PATH

$env:DRY_RUN = '1'; python main.py    # preview
Remove-Item Env:\DRY_RUN
python main.py                        # raw rows
python main.py --FHIR                 # client-mapped Bundles
```

**Why.** Needs Python 3 (§0a) and the hospital's private key from §7. Progress is
bookmarked per `encounter_number`, so a re-run resumes rather than re-sends —
run `DRY_RUN` first to see what it would push.

**What can go wrong.** `PRIVATE_KEY_FILE` takes a Windows path — use forward
slashes or doubled backslashes (`C:/keys/3130400221.key.pem`); a single-backslash
path is read as escape sequences and the key fails to load.

### 9b. Smoke test

```powershell
$TOKEN = & .\keycloak\get-jwt-client-token.ps1 3130400221

$row = @'
{"hospital_patient_number":"2405078","encounter_number":"SMOKE-1",
 "first_name":"CHANDRIKA","last_name":"KANDEL","sex":"Female",
 "department_type":"C","department_id":"22","department_name":"Family Medicine",
 "visit_date_ad_time":"2026-07-28 00:02:00.000"}
'@

Invoke-RestMethod -Method Post -Uri 'https://localhost:5000/ingest' `
  -SkipCertificateCheck `
  -Headers @{ Authorization = "Bearer $TOKEN" } `
  -ContentType 'application/json' -Body $row
```

`201`. A second POST of the same `encounter_number` must not create a duplicate.

**What can go wrong.** `404` = the `NP FHIR Intake` channel is missing (check
`fhir-intake-mediator` registered in the Console); `403` = set
`OPENHIM_CHANNEL_ROLE=np-fhir-clients` on `fhir-intake-mediator`; `422` = no
Organization carries that NHFR identifier, so run `create-org.ps1` (§7).

---

## 10. Deploy on a VPS — Caddy

Steps 1–9 assume everything is on `localhost`. On a VPS, `docker-compose.yml`
ships **Caddy** as the public front door: it terminates TLS, obtains and renews
Let's Encrypt certificates automatically, and reverse-proxies to Keycloak,
OpenHIM Core and the Console over the internal Docker network.

Two Compose profiles, and Caddy starts only when one of them is named:

| Profile | Service | Front door | Use |
|---|---|---|---|
| `vps` | `caddy` | `:80` + `:443`, real HTTPS on subdomains of `$DOMAIN` | the real deployment |
| `vps-ip` | `caddy-ip` | `:80`, **plain HTTP**, Keycloak only | short trusted-network test |
| *(none)* | — | direct host ports, as in §1–9 | local development |

Because both are profile-gated, a plain `docker compose up -d` (§2) never starts
Caddy — local behaviour is unchanged, and **nothing in `docker-compose.yml` needs
editing** for either profile except the Console env in 10e. Everything else is
driven by a **root `.env`** (10b).

> The stack itself normally runs on a Linux VPS. Every Compose command below is
> identical under `bash`; the `pwsh -File .\keycloak\*.ps1` calls become their
> `./keycloak/*.sh` twins.

### 10a. DNS first

Create an **A record for each of the four names**, pointing at the VPS public IP,
then confirm they resolve:

```powershell
Resolve-DnsName keycloak.example.org, openhim.example.org, api.example.org, console.example.org
```

With `$DOMAIN` = `example.org`, `Caddyfile` serves:

| Public URL | Proxies to | For |
|---|---|---|
| `https://keycloak.example.org` | `keycloak:8080` | token endpoint + admin console |
| `https://openhim.example.org` | `openhim-core:5001` | **client traffic** — `/fhir`, `/ingest` |
| `https://api.example.org` | `openhim-core:8080` (self-signed, skipped inside) | Core API, used by the Console |
| `https://console.example.org` | `openhim-console:80` | OpenHIM Console UI |

**Why.** Caddy requests certificates on boot over HTTP-01, so the names must
already resolve to this host. Note that `openhim.example.org` fronts port
**5001**, the plain-HTTP transaction port (loopback-bound in Compose): Caddy is
what puts TLS in front of it, so clients get a real certificate and no longer
need `-k` / `-SkipCertificateCheck`. The self-signed `:5000` stays as it is for
local and fallback use.

**What can go wrong.** A name that does not resolve yet fails ACME, and repeated
failures hit **Let's Encrypt rate limits** for those names — which can lock you
out of issuance for hours. Get DNS right before the first start.

### 10b. Root `.env`

Create `.env` **in the repo root** (next to `docker-compose.yml`). It is
gitignored — never commit it.

```
DOMAIN=example.org
KEYCLOAK_PUBLIC_URL=https://keycloak.example.org
KEYCLOAK_ISSUER=https://keycloak.example.org/realms/openhie
```

**Why.**

- `DOMAIN` must be the **bare zone** — no scheme, no subdomain, no trailing dot.
  `Caddyfile` builds `keycloak.{$DOMAIN}` and the rest from it.
- `KEYCLOAK_PUBLIC_URL` becomes Keycloak's `KC_HOSTNAME`, so it is the `iss` of
  every token minted.
- `KEYCLOAK_ISSUER` becomes OpenHIM's `authentication_jwt_issuer`.

`KC_PROXY_HEADERS: xforwarded` is already set on the `keycloak` service, so it
trusts Caddy's `X-Forwarded-*` headers and builds `https://` URLs. Both variables
default to `http://localhost:8083…` when unset, which is why §1–9 work untouched.

**What can go wrong.** The last two must be identical apart from the
`/realms/openhie` suffix, and clients must request tokens from that same host.
Any mismatch and every request 401s at the transaction port.

### 10c. Change the secrets before the first public start

- `KC_BOOTSTRAP_ADMIN_PASSWORD` in `docker-compose.yml` (ships as `admin`).
- OpenHIM root password (§3b) → propagate to all four `*/.env` (§3c).
- Production: `hapi-db` and `mongo-db` credentials too.

**Why.** Caddy publishes the Keycloak **admin console** at
`https://keycloak.<domain>` and the OpenHIM **Core API** at `https://api.<domain>`.
Both are reachable from the internet the moment the profile starts.

**What can go wrong.** Starting the profile with shipped defaults exposes an
`admin`/`admin` Keycloak console to the public internet — assume compromise and
rebuild if it happened.

### 10d. Start the profile

```powershell
docker compose --profile vps up -d
docker compose ps
docker compose logs -f caddy       # watch certificate issuance
```

Successful issuance logs `certificate obtained successfully` once per name.

Every later Compose command that should keep Caddy running needs the flag too:

```powershell
docker compose --profile vps stop
docker compose --profile vps start
docker compose --profile vps up -d --force-recreate keycloak openhim-core
```

**Why.** Certificates live in the `caddy-data` volume and survive `stop` /
`start` and container recreation — they are lost only to `docker compose down -v`
(§11).

**What can go wrong.** `caddy` missing from `docker compose ps` means you omitted
`--profile vps`. A Caddy container that exits immediately means `DOMAIN` is unset
in the **root** `.env` (10b). ACME failures in the log mean DNS or `:80` (10a,
10g).

### 10e. Point the Console at the public API

Set this on the live `openhim-console` service for the `vps` profile, then
recreate it:

```yaml
    environment:
      OPENHIM_CONSOLE_PROTOCOL: "https"
      OPENHIM_CORE_MEDIATOR_HOSTNAME: "api.example.org"
      OPENHIM_MEDIATOR_API_PORT: "443"
```

```powershell
docker compose --profile vps up -d --force-recreate openhim-console
```

**Why.** The Console is a browser app: it calls the Core API **from the user's
browser**, not over the Docker network, so it has to be told the public API
address. `docker-compose.yml` carries a commented block with this shape.

**What can go wrong.** Left at the defaults, the Console loads at
`https://console.example.org` but every API call fails — which looks like a login
problem rather than a config problem.

### 10f. Realm and onboarding on the VPS

After changing the root `.env`, recreate the dependants **on the VPS**:

```powershell
docker compose --profile vps up -d --force-recreate keycloak openhim-core
docker compose restart mediator admin-mediator patient-portal-mediator fhir-intake-mediator
```

From an admin machine **outside** the VPS, point the scripts at the public host:

```powershell
$env:KEYCLOAK_URL = 'https://keycloak.example.org'
pwsh -File .\keycloak\onboard-hospital.ps1 3130400221 "Bharatpur Hospital"
```

**Why.** Keycloak's `8083` stays bound to `127.0.0.1`, so the onboarding scripts
keep working unchanged on the VPS itself against `http://localhost:8083` — §5
and §7 as written. Only the *advertised* URLs change:

```powershell
(Invoke-RestMethod http://localhost:8083/realms/openhie/.well-known/openid-configuration).issuer
# https://keycloak.example.org/realms/openhie   <- public issuer, even over loopback
```

That is correct: with `KC_HOSTNAME` set, Keycloak advertises and stamps the
public issuer no matter which interface the request arrived on.

**What can go wrong.** That issuer must match `KEYCLOAK_ISSUER` exactly, and the
realm key must be re-extracted after the change — otherwise every token 401s even
though Keycloak issues it happily.

### 10g. Firewall

With the `vps` profile, only Caddy needs to be reachable:

| Port | Protocol | Purpose | Access |
|---|---|---|---|
| `22` | TCP | SSH | admin IP / VPN only |
| `80` | TCP | ACME HTTP-01 + redirect to HTTPS | public (required) |
| `443` | TCP | Caddy — all four subdomains | public |

**Close everything else at the host firewall.**

**Why.** Compose still publishes `5000` (transaction), `8080` (Core API) and
`9000` (Console) on *all* interfaces, and Caddy does not take them away. The host
firewall is the only thing keeping them off the internet; their TLS-terminated
equivalents are `openhim.`, `api.` and `console.<domain>` on 443.

**What can go wrong.** Already loopback-only in Compose, so they need no rule:
`5001`, `8081`, `8083`. Never publish `5432`, `27017`, or the mediator ports.
JeMPI `50000` is published on the *JeMPI* VPS (§4) — restrict it there to the
OpenHIM host's IP rather than leaving it open to the world.

### 10h. Client traffic through Caddy

```powershell
$env:KEYCLOAK_URL = 'https://keycloak.example.org'
$TOKEN = & .\keycloak\get-jwt-client-token.ps1 3130400221

$body = @'
{"resourceType":"Patient","name":[{"family":"SHRESTHA","given":["KAMANA"]}],
 "gender":"female","birthDate":"2001-06-25"}
'@

Invoke-RestMethod -Method Post -Uri 'https://openhim.example.org/fhir/Patient' `
  -Headers @{ Authorization = "Bearer $TOKEN" } `
  -ContentType 'application/fhir+json' -Body $body
```

**Why.** Tokens and transactions both go to the public names, and — unlike §8 —
no certificate-skipping flag is needed, because Caddy serves a real certificate.
`/ingest` (§9) is the same host: `https://openhim.example.org/ingest`.

**What can go wrong.** On each hospital box, `FHIR_mediator/.env` must also be
updated: `KEYCLOAK_URL=https://keycloak.example.org` plus that base URL.
Otherwise clients keep minting `localhost`-issuer tokens that the VPS rejects.

### 10i. Raw-IP test profile (`vps-ip`)

Root `.env`:

```
VPS_IP=203.0.113.10
KEYCLOAK_PUBLIC_URL=http://203.0.113.10
KEYCLOAK_ISSUER=http://203.0.113.10/realms/openhie
```

```powershell
docker compose --profile vps-ip up -d
```

**Why.** For a short test on a trusted network or over WireGuard, before DNS
exists. `caddy-ip` puts Keycloak on `http://<vps-ip>`. Only Keycloak is fronted
here: OpenHIM keeps its direct ports, so transaction tests still go to
`https://<vps-ip>:5000` with the self-signed cert (`-SkipCertificateCheck`), and
`5000` / `9000` must be opened to the test clients — admin IPs only.

**What can go wrong.** This is **plain HTTP**, so credentials and tokens are
unprotected — do not use it with real credentials or patient data. Run **one**
profile at a time: both Caddy services claim port 80, so starting both gives
`address already in use`. Move to the `vps` profile (10a–10h) before anything
real touches the stack.

### 10j. JeMPI and Keycloak persistence

- **JeMPI:** with the `:50000` port forward (§4) the VPS reaches
  `http://202.51.71.81:50000/JeMPI` directly — nothing to set up. Only the
  tunnel fallback needs §4a on the VPS (`wg-quick up wg0`, `ip_forward`, the
  `MASQUERADE` rule).
- **Never `docker compose down`** — same rule as local: it wipes Keycloak's H2
  realm, and `-v` additionally destroys Caddy's certificates. Use
  `--profile vps stop` / `start`. A VPS you depend on should run Keycloak on
  `KC_DB: postgres` (and drop `--import-realm`) so this stops being fragile;
  `start-dev` is testing-grade only.

---

## 11. Starting over (full reset)

```powershell
docker compose down -v --rmi all      # containers + volumes + images
```

Then run, in order: **§2** → **§3b** and **§3c** (root password is back to
`openhim-password`, so it must be reset and re-propagated) → **§5** →
**§7** per hospital → **§8** to verify.

**Why.** This is the one time `down` is correct: deliberate destruction, not the
accidental `down` §2 warns about. `-v` drops the Keycloak H2 store, the OpenHIM
Mongo database (clients, channels, transactions) and the HAPI Postgres data;
`--rmi all` forces a re-pull.

What survives on disk versus what you must redo:

| Item | After the wipe |
|---|---|
| `keycloak\keys\*.pem` | **survives** — `create-jwt-client.ps1` reuses an existing keypair and re-registers its public key, so hospitals keep the private key you already issued |
| `*/.env` | **survives**, but `OPENHIM_PASSWORD` is now wrong — the root password resets to `openhim-password` |
| Keycloak realm, clients, mappers | gone — re-run §5, then §7 per hospital |
| OpenHIM clients, channels, transactions | gone — §7 recreates the clients |
| HAPI Patients / Encounters / Organizations | gone — §7 recreates the Organizations |
| JeMPI golden records | **untouched** — JeMPI is on the remote VPS, not in this stack |
| Caddy certificates (`caddy-data`, VPS only) | gone — Caddy re-requests them on the next `--profile vps up`, so make sure DNS still resolves (§10a) before repeating a wipe; Let's Encrypt rate-limits repeated issuance for the same names |

**What can go wrong.**

>
> JeMPI keeps the golden records from your earlier runs, so a "fresh" stack will
> still match against previously registered patients. To confirm what is there:
> `curl.exe http://202.51.71.81:50000/JeMPI/countRecords`.

---

## `.env` reference

Anything not listed here is Docker-internal and should stay as shipped —
`OPENHIM_API_URL`, `HAPI_FHIR_BASE_URL`, `MEDIATOR_ROUTE_HOST`, the
`OPENHIM_CHANNEL_ROLE` values, the admin-mediator scoring thresholds.

| File | Variable | Set it to | Step |
|---|---|---|---|
| all four | `OPENHIM_PASSWORD` | the OpenHIM root password from §3b — **blank in the examples**, mediators crash-loop until it is filled | §3c |
| `services\fhir-mediator\.env` | `JEMPI_BASE_URL` | `http://202.51.71.81:50000/JeMPI` | §4 |
| `admin-mediator\.env` | `JEMPI_BASE_URL` | `http://202.51.71.81:50000/JeMPI` — missing here is the usual cause of the §8 `502` | §4 |
| `services\fhir-mediator\.env` | `FACILITY_REGISTRY_JSON` | `{"<keycloak-uuid>":"<nhfr-id>"}`, only when the `sub` override fails | §7 |
| `patient-portal-mediator\.env` | `PORTAL_PATIENT_SHARED_SECRET` | only if you run the patient-portal BFF — must equal its `SESSION_JWT_SECRET` | — |

`mediator` and `fhir-intake-mediator` both bind to `np-fhir-clients` — the role
`onboard-hospital.ps1` grants (§7). Changing one without the other is what
produces a `403` at the channel.

A `.env` edit takes effect only on `docker compose up -d --force-recreate <svc>`;
`restart` does not re-read the file.

## Quick reference

| Task | Command (PowerShell 7) |
|---|---|
| Clone | `git clone https://github.com/ETech-Nepal/openhim.git` |
| Create the `.env` files | `Copy-Item <svc>\.env.example <svc>\.env` (§1a) |
| Bring the stack up | `docker compose up -d` |
| Bring it up on a VPS, behind Caddy | `docker compose --profile vps up -d` (§10) |
| Raw-IP test front door (HTTP) | `docker compose --profile vps-ip up -d` (§10i) |
| Watch certificate issuance | `docker compose logs -f caddy` |
| Full reset | `docker compose down -v --rmi all` (§11) |
| Reload a changed `.env` | `docker compose up -d --force-recreate <svc>` |
| Create the realm | `pwsh -File .\keycloak\setup.ps1` |
| Create/update an Organization | `pwsh -File .\keycloak\create-org.ps1 <nhfr-id> "<name>"` |
| Onboard a hospital | `pwsh -File .\keycloak\onboard-hospital.ps1 <nhfr-id> "<name>"` |
| Hospital token | `.\keycloak\get-jwt-client-token.ps1 <nhfr-id>` |
| Postman token helper | `node keycloak\token-server.mjs` (`:4099`) |
| Check JeMPI | `curl.exe http://202.51.71.81:50000/JeMPI/countRecords` |
| JeMPI tunnel (only if needed) | WireGuard client → Activate `wg0` (§4a) |
| Push data | `cd FHIR_mediator; python main.py` (`--FHIR` for bundles) |

`keycloak\_common.ps1` holds the shared helpers (admin login, REST wrapper,
PEM/base64url, JWT claim reader) and is dot-sourced by the others — never run it
directly.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Repository not found` on clone | GitHub invite not accepted / wrong credential (§0b) |
| `.ps1` won't run — *execution of scripts is disabled* | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or invoke as `pwsh -File .\script.ps1` |
| `#Requires -Version 7.1` error | you are in Windows PowerShell 5.1 — open `pwsh` |
| `docker: error during connect` | Docker Desktop not running / WSL2 engine off (§0a) |
| Console calls fail, network error | accept the cert — <https://localhost:8080/heartbeat> (3a) |
| Mediator missing under **Mediators** | `OPENHIM_PASSWORD` ≠ root password (3c) |
| Mediator crash-loops on boot | `.env` missing or `OPENHIM_PASSWORD` blank (§1) |
| `.env` change ignored | used `restart`, not `up -d --force-recreate` |
| a failed call "returns" your own request JSON | that is OpenHIM's error body, not a diagnosis — get the status code + `docker compose logs openhim-core` (§8) |
| `JWT could not be verified` / `Public key not found in JWKS cache` | core cannot reach `KEYCLOAK_JWKS_URI` (realm name wrong, or Keycloak down) — `docker compose logs openhim-core` (§6) |
| 401 at `:5000` fresh token | issuer mismatch — `iss` must equal `authentication_jwt_issuer` (`http://localhost:8083/realms/openhie` locally; on a VPS, `KEYCLOAK_PUBLIC_URL` / `KEYCLOAK_ISSUER` in the root `.env`, §10b) |
| `caddy` missing from `docker compose ps` | the profile flag was omitted — `docker compose --profile vps up -d` (§10d) |
| Caddy logs ACME / `obtain certificate` failures | the name does not resolve to this host yet, or `:80` is blocked — fix DNS and the firewall (§10a, §10g) |
| Caddy container exits immediately on a VPS | `DOMAIN` (or `VPS_IP` for `vps-ip`) is unset in the **root** `.env` (§10b) |
| `address already in use` on `:80` starting Caddy | both profiles were started — run only `vps` **or** `vps-ip` (§10i) |
| Console loads at `console.<domain>` but every action fails | Console still pointed at the default API host — set the `openhim-console` env (§10e) |
| 403 at `:5000` | Client lacks role — re-run `onboard-hospital.ps1` (§7) |
| 404 at `:5000/ingest` | `NP FHIR Intake` channel missing — check `fhir-intake-mediator` |
| 403 at `:5000/ingest` | set `OPENHIM_CHANNEL_ROLE=np-fhir-clients` on `fhir-intake-mediator` |
| 422 at `:5000/ingest` | no Organization with NHFR identifier `<nhfr-id>` — `create-org.ps1` (§7) |
| `onboard-hospital.ps1` fails at 4/5 | Keycloak won't override `sub` — `FACILITY_REGISTRY_JSON` fallback (§7) |
| `502` + `JeMPI register failed: timeout` | `JEMPI_BASE_URL` still `10.8.0.1` — switch to `202.51.71.81:50000` and force-recreate (§4) |
| Keycloak realm gone after a stop | `docker compose down` was used — use `stop` / `start` |
