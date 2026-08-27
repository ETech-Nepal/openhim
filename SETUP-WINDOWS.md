# Auth & Bring-up Setup — Windows

Steps and commands only. Everything runs in **PowerShell 7 (`pwsh`)** from the
repo root. `<like-this>` = placeholder.

> This is the Windows edition of `keycloak/SETUP.md`. Every `.sh` script in this
> repo has a `.ps1` twin that does the same job through the Keycloak Admin REST
> API and .NET crypto — no `jq`, `openssl`, `python3`, `fold` or `base64`
> needed. Keys and PEMs are written in identical formats, so a client created on
> Windows works on Linux and vice versa.

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

Then:

1. Launch **Docker Desktop** once and let it finish starting (whale icon steady
   in the tray). Settings → General → **Use the WSL 2 based engine** must be on.
   Settings → Resources → WSL Integration → enable your distro if you use one.
2. Close the terminal and reopen **PowerShell 7** (`pwsh`), not Windows
   PowerShell 5.1 — the `.ps1` scripts declare `#Requires -Version 7.1`.
3. Verify:

```powershell
git --version
docker version
docker compose version
$PSVersionTable.PSVersion        # 7.1 or newer
```

Not needed on Windows: `jq`, `openssl`, `wg` / `wg-quick`. `curl.exe` is already
part of Windows 10/11 — in `pwsh` the bare name `curl` resolves to it, but the
examples below spell out `curl.exe` so they also work in Windows PowerShell.

### 0b. GitHub access

The repo is private under the **ETech-Nepal** organisation. Before cloning:

1. Ask an ETech-Nepal org owner to add your GitHub account as a **collaborator
   with at least Read access** on `ETech-Nepal/openhim`.
2. Accept the invitation email (or
   <https://github.com/ETech-Nepal/openhim/invitations>).
3. Authenticate git. Easiest is the GitHub CLI:

```powershell
gh auth login          # GitHub.com -> HTTPS -> login with a browser
```

   Alternatives: a **Personal Access Token** (classic, `repo` scope) used as the
   password at the git prompt — Git Credential Manager caches it in Windows
   Credential Manager — or an SSH key (`ssh-keygen -t ed25519`, add the `.pub`
   to GitHub, then clone the `git@github.com:` URL).

4. Confirm access **before** cloning:

```powershell
git ls-remote https://github.com/ETech-Nepal/openhim.git | Select-Object -First 1
```

   `remote: Repository not found` here means the invite is not accepted or the
   credential is wrong — fix that first, it is not a clone problem.

### 0c. Clone the repo

**Repository:** <https://github.com/ETech-Nepal/openhim>

```powershell
cd C:\GitHub                                              # or wherever you keep code
git clone https://github.com/ETech-Nepal/openhim.git
cd openhim
```

Every command from here on runs from this directory (the repo root).

> Keep the path short and free of spaces. Docker Desktop bind-mounts several
> paths from this tree (`openhim-config`, `hapi-config`, `jempi-config`); a path
> with spaces or a OneDrive-synced folder causes mount failures.
>
> Git for Windows converts line endings on checkout. The `.ps1` scripts do not
> care, but if you ever run the `.sh` twins through WSL and get
> `bad interpreter: /bin/bash^M`, re-clone with
> `git clone --config core.autocrlf=input`.

---

## 1. Configuration files

None of this is in git, so a fresh clone has none of it. Create it all **before**
the first `docker compose up` (§2).

### 1a. Mediator `.env` files

Four services read a `.env` that is **not** in git. Create each from its
example:

```powershell
Copy-Item mediator\.env.example                mediator\.env
Copy-Item admin-mediator\.env.example          admin-mediator\.env
Copy-Item patient-portal-mediator\.env.example patient-portal-mediator\.env
Copy-Item fhir-intake-mediator\.env.example    fhir-intake-mediator\.env
```

The defaults are correct for a local Docker run. Only these need your input:

| File | Variable | Set it to |
|---|---|---|
| all four | `OPENHIM_PASSWORD` | the OpenHIM root password from §3b — **blank in the examples**, mediators crash-loop until it is filled |
| `mediator\.env` | `JEMPI_BASE_URL` | `http://202.51.71.81:50000/JeMPI` (§4) |
| `admin-mediator\.env` | `JEMPI_BASE_URL` | `http://202.51.71.81:50000/JeMPI` (§4) |
| `patient-portal-mediator\.env` | `PORTAL_PATIENT_SHARED_SECRET` | only if you run the patient-portal BFF — must equal its `SESSION_JWT_SECRET` |
| `mediator\.env` | `FACILITY_REGISTRY_JSON` | only as the §7 fallback |

Everything else — `OPENHIM_API_URL`, `HAPI_FHIR_BASE_URL`, `MEDIATOR_ROUTE_HOST`,
the `OPENHIM_CHANNEL_ROLE` values, the admin-mediator scoring thresholds — is
Docker-internal and should stay as shipped.

Roles that matter later: `mediator` and `fhir-intake-mediator` both bind to
`np-fhir-clients`, which is the role `onboard-hospital.ps1` grants (§7).

> `.env` is in `.gitignore`. Never commit one — they hold the OpenHIM root
> password.

Leave `OPENHIM_PASSWORD` **blank for now** — you set the root password in §3b and
fill it into all four files in §3c. Until then the mediators crash-loop, which is
expected (§2).

### 1b. Pre-create `openhim-config\realm-public.pem` — do not skip

`docker-compose.yml` bind-mounts `./openhim-config/realm-public.pem` into
`openhim-core`. `*.pem` is gitignored and `openhim-config/` has **no tracked
files**, so after a fresh clone that path does not exist — and Docker creates a
missing bind-mount target as a **directory**. The entrypoint then runs `cat` on
a directory, gets nothing, `authentication_jwt_secretOrPublicKey` ends up empty,
and every token fails with:

```
JWT could not be verified: secret or public key must be provided
```

On a fresh clone this is guaranteed, not bad luck. Create the file first — §6
overwrites it with the real key:

```powershell
New-Item -ItemType Directory -Force openhim-config | Out-Null
if (-not (Test-Path openhim-config\realm-public.pem)) {
  New-Item -ItemType File openhim-config\realm-public.pem | Out-Null
}
```

The `Test-Path` guard matters: `New-Item -ItemType File -Force` would **truncate
an existing key**. Confirm it is a file, not a directory — `Mode` must not begin
with `d`:

```powershell
Get-Item openhim-config\realm-public.pem | Select-Object Mode, Length, Name
```

### 1c. Root `.env` — VPS only, skip it locally

There is a fifth `.env`, in the repo root, read by `docker-compose.yml` itself
(`DOMAIN`, `VPS_IP`, `KEYCLOAK_PUBLIC_URL`, `KEYCLOAK_ISSUER`). It exists to
drive the Caddy profiles on a VPS and is covered in §10b. For a local run,
**do not create it** — every variable has a `localhost` default baked into
`docker-compose.yml`, and a half-filled root `.env` will point Keycloak and
OpenHIM at an issuer your tokens do not carry.

---

## 2. Containers

```powershell
docker compose up -d
docker compose ps
```

Running: `hapi-db`, `mongo-db`, `openhim-core`, `openhim-console`, `fhir`,
`keycloak`, `mediator`, `admin-mediator`, `patient-portal-mediator`,
`fhir-intake-mediator`.

`caddy` / `caddy-ip` are **not** in that list, and should not be: both sit behind
Compose profiles (`vps` / `vps-ip`) and start only when you name one, which is a
VPS deployment (§10). Locally you talk to the host ports directly.

> **Never `docker compose down`** (wipes Keycloak's H2 store and with it the
> realm). Use `docker compose stop` / `docker compose start`.
> Mediators crash-loop until steps 3 and 6 are done — that is expected.
> When you *intend* to wipe and rebuild, that is §11, not an accident.

The first run pulls several GB of images. If a container exits immediately, read
its log before anything else:

```powershell
docker compose logs --tail 50 mediator
```

---

## 3. OpenHIM first login

### 3a. Accept the self-signed cert

1. Open <https://localhost:8080/heartbeat> in Edge/Chrome, click **Advanced →
   Continue**. Without this the Console's browser calls fail silently.
2. From the CLI you need `-k`: `curl.exe -k https://localhost:8080/heartbeat`
   (PowerShell-native:
   `Invoke-RestMethod https://localhost:8080/heartbeat -SkipCertificateCheck`).

### 3b. Root password

1. Console <http://localhost:9000>, log in `root@openhim.org` /
   `openhim-password`.
2. Set a new password. **Record it** — §3c needs it in four files.

### 3c. Propagate to mediators

Set `OPENHIM_PASSWORD` to the password you recorded in §3b, in all four `.env`
files (`mediator`, `admin-mediator`, `patient-portal-mediator`,
`fhir-intake-mediator`):

```powershell
foreach ($d in 'mediator','admin-mediator','patient-portal-mediator','fhir-intake-mediator') {
  (Get-Content "$d\.env") -replace '^OPENHIM_PASSWORD=.*', 'OPENHIM_PASSWORD=<your-password>' |
    Set-Content "$d\.env"
}
```

Then force-recreate so the containers pick up the new value:

```powershell
docker compose up -d --force-recreate mediator admin-mediator patient-portal-mediator fhir-intake-mediator
```

> `docker compose restart` does **not** reload `.env` — use
> `up -d --force-recreate`.

Console → **Mediators**: all four green.

---

## 4. JeMPI connectivity — WireGuard is no longer required

JeMPI runs on the VPS `202.51.71.81`. **Port `50000` is now forwarded on that
host**, so the API is reachable straight over the public internet — no tunnel,
nothing extra to install on Windows:

```powershell
curl.exe http://202.51.71.81:50000/JeMPI/countRecords
# {"goldenRecords":85,"interactions":85}
```

Point both mediators at it (§1):

```
JEMPI_BASE_URL=http://202.51.71.81:50000/JeMPI
```

in `mediator\.env` **and** `admin-mediator\.env`, then:

```powershell
docker compose up -d --force-recreate mediator admin-mediator
docker exec mediator wget -qO- http://202.51.71.81:50000/JeMPI/countRecords   # from inside the container
```

Both the host check and the container check must return the JSON. A container
reaches a public IP through Docker's NAT with no extra rules — the Linux
`iptables MASQUERADE` workaround from the tunnel era does not apply.

> `:50000` is the open API (no Keycloak in front). `:50001` is the
> Keycloak-protected port; production will move to it later. Because `:50000` is
> now publicly exposed rather than tunnel-only, treat it as untrusted transport:
> restrict it to known source IPs on the JeMPI VPS firewall.

### 4a. WireGuard fallback (kept for reference)

Still valid if the port forward is withdrawn, or if you must reach `:50001` or
other VPS-internal services. The tunnel address for JeMPI was `10.8.0.1`.

- **Windows:** install the official client
  (`winget install --id WireGuard.WireGuard -e`), then **Add Tunnel → Import
  from file** with the `wg0.conf` you were issued and **Activate**. Ensure the
  peer's `AllowedIPs` includes `10.8.0.0/24`. Docker Desktop containers route
  through the Windows host, so no extra rules are needed; if a container still
  cannot reach `10.8.0.1`, restart Docker Desktop after activating the tunnel so
  the WSL network picks up the route.
- **Linux host / VPS:**

```bash
sudo wg-quick up wg0                                          # config at /etc/wireguard/wg0.conf
curl http://10.8.0.1:50000/JeMPI/countRecords                 # from host
docker exec mediator wget -qO- http://10.8.0.1:50000/JeMPI/countRecords   # from a container

# host works but container hangs:
sudo iptables -t nat -A POSTROUTING -s 172.16.0.0/12 -o wg0 -j MASQUERADE
sudo sysctl -w net.ipv4.ip_forward=1
```

If you go back to the tunnel, set `JEMPI_BASE_URL=http://10.8.0.1:50000/JeMPI`
and force-recreate the two mediators again.

---

## 5. Keycloak realm

Admin Console <http://localhost:8083>, bootstrap admin `admin` / `admin`.

```powershell
(Invoke-RestMethod http://localhost:8083/realms/openhie/.well-known/openid-configuration).issuer
```

If it prints `http://localhost:8083/realms/openhie`, the realm exists — go to
§7. Otherwise:

```powershell
pwsh -File .\keycloak\setup.ps1
```

(or by hand: realm dropdown → **Create realm** → name `openhie` → **Create**).

`setup.ps1` also creates `demo-client` + user `demo`/`demo123` and prints the
demo user's `sub`. A password-grant demo token, no `jq` needed:

```powershell
(Invoke-RestMethod -Method Post -Uri 'http://localhost:8083/realms/openhie/protocol/openid-connect/token' `
   -Body @{ grant_type='password'; client_id='demo-client'; username='demo'; password='demo123' }).access_token
```

---

## 6. Realm key into OpenHIM

```powershell
pwsh -File .\keycloak\extract-realm-pubkey.ps1
docker compose up -d --force-recreate openhim-core
docker compose restart mediator admin-mediator patient-portal-mediator fhir-intake-mediator
```

> A realm rebuild rotates Keycloak's RSA key → re-run this or every token fails
> `JWT could not be verified`.

OpenHIM env (already in `docker-compose.yml`): `authentication_jwt_algorithms`
= `RS256` (plain string), `authentication_jwt_audience` = `account`,
`authentication_jwt_issuer` = `http://localhost:8083/realms/openhie`.

Transaction-port errors:

| Code | Meaning |
|---|---|
| 401 | token missing / bad signature / issuer or audience mismatch |
| 403 | Client mapped, but lacks a channel role |
| 404 | no channel matched the URL |

> **Windows gotcha.** If Docker Desktop started the stack before
> `realm-public.pem` existed, it created an empty **directory** at
> `openhim-config\realm-public.pem` (§1b) and no key can be written there.
> Recover with:
>
> ```powershell
> docker compose stop openhim-core
> Remove-Item -Recurse -Force .\openhim-config\realm-public.pem
> pwsh -File .\keycloak\extract-realm-pubkey.ps1
> docker compose up -d --force-recreate openhim-core
> docker compose restart mediator admin-mediator patient-portal-mediator fhir-intake-mediator
> ```
>
> Doing §1b before the first `docker compose up` avoids this entirely.

---

## 7. Per-hospital client

One command per hospital — NHFR code + name. Creates the Organization, keypair,
Keycloak client + `sub`-override mapper, and OpenHIM Client; verifies the token
`sub`:

```powershell
pwsh -File .\keycloak\onboard-hospital.ps1 3130400221 "Bharatpur Hospital"
```

Idempotent. Output gives the private-key path (`keycloak\keys\<nhfr>.key.pem`) —
hand it to the hospital over a secure channel, then delete your copy.
`keycloak/keys/` is gitignored.

| System | Value |
|---|---|
| FHIR | `Organization.identifier` = `<nhfr-id>`; `Organization.id` = server UUID |
| Keycloak | client `<nhfr-id>`, `private_key_jwt`, token `sub` = `<nhfr-id>` |
| OpenHIM | Client **ID** = `<nhfr-id>`, role `np-fhir-clients` |
| Mediator | `X-OpenHIM-ClientID` = `<nhfr-id>` → `GET Organization?identifier=nhfr\|<nhfr-id>` |

Prereqs: §2, §3c, §6.

Just an Organization, no client:
`pwsh -File .\keycloak\create-org.ps1 <nhfr-id> "<name>"`.

> NHFR system string: deployed stack uses
> `http://mohp.gov.np/fhir/NamingSystem/nhfr` (NP Core's canonical is
> `https://nhfr.mohp.gov.np`).

> `sub` override rejected → `onboard-hospital.ps1` fails at 4/5. Fallback:
> OpenHIM `clientID` stays the Keycloak UUID; add
> `FACILITY_REGISTRY_JSON={"<uuid>":"<nhfr-id>"}` to `mediator\.env` +
> `docker compose up -d --force-recreate mediator`.

Script overrides via environment: `KEYCLOAK_URL` (default
`http://localhost:8083`), `KEYCLOAK_ADMIN_USER` / `KEYCLOAK_ADMIN_PASSWORD`
(default `admin`/`admin`), plus `FHIR_BASE_URL` and `ACCESS_TOKEN` for
`create-org.ps1`.

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

> **Reading a failure.** On an error OpenHIM echoes **your request body back** as
> the response body, and `Invoke-RestMethod` surfaces that as the exception
> message — so a failed smoke test looks like it printed your own Patient JSON
> back at you. That text tells you nothing; you need the status code and the
> core log. Wrap the call to get both:
>
> ```powershell
> try   { Invoke-WebRequest -Method Post -Uri 'https://localhost:5000/fhir/Patient' `
>           -SkipCertificateCheck -Headers @{ Authorization = "Bearer $TOKEN" } `
>           -ContentType 'application/fhir+json' -Body $body }
> catch { "STATUS: $([int]$_.Exception.Response.StatusCode)"
>         $_.ErrorDetails.Message }
>
> docker compose logs --tail 40 openhim-core
> ```
>
> Then read the status against the §6 table (401 auth / 403 role / 404 channel).
> Note `Invoke-WebRequest`'s `.Content` comes back as a **byte array** for
> `application/fhir+json` — use `Invoke-RestMethod`, which parses it into an
> object, once the call succeeds.

Postman: `node keycloak\token-server.mjs`, then
<http://localhost:4099/token/3130400221>.

---

## 9. FHIR Intake mediator (`/ingest`)

`POST /ingest` in front of the orchestrator:

| `Content-Type` | Body | Action |
|---|---|---|
| `application/json` | one raw CDRS encounter row | validate → Patient + Encounter Bundle → forward |
| `application/fhir+json` | resource or `transaction`/`batch` Bundle | forward unmutated |
| other | — | `415` |

Channel `NP FHIR Intake`, `^/ingest/?$`, `POST`, route
`fhir-intake-mediator:4003`, role `OPENHIM_CHANNEL_ROLE` in
`fhir-intake-mediator\.env` (`np-fhir-clients` to reuse §7 clients).

Raw-row behaviour: `403` if no `X-OpenHIM-ClientID`;
`GET Organization?identifier=nhfr|<nhfr-id>` → `422` if 0 or >1 match; stamps
`managingOrganization` / `serviceProvider` = the resolved `Organization/<uuid>`.
Inbound `X-NHFR-ID` / `organization_id` ignored.

### 9a. Dump script

Needs Python 3 (§0a) and the hospital's private key from §7.

```powershell
cd FHIR_mediator
Copy-Item .env.example .env     # KEYCLOAK_CLIENT_ID=<nhfr-id>, PRIVATE_KEY_FILE, SQLITE_PATH

$env:DRY_RUN = '1'; python main.py    # preview
Remove-Item Env:\DRY_RUN
python main.py                        # raw rows
python main.py --FHIR                 # client-mapped Bundles
```

`PRIVATE_KEY_FILE` takes a Windows path — use forward slashes or doubled
backslashes (`C:/keys/3130400221.key.pem`). Progress is bookmarked per
`encounter_number`, so a re-run resumes rather than re-sends.

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

With `$DOMAIN` = `example.org`, `Caddyfile` serves four names:

| Public URL | Proxies to | For |
|---|---|---|
| `https://keycloak.example.org` | `keycloak:8080` | token endpoint + admin console |
| `https://openhim.example.org` | `openhim-core:5001` | **client traffic** — `/fhir`, `/ingest` |
| `https://api.example.org` | `openhim-core:8080` (self-signed, skipped inside) | Core API, used by the Console |
| `https://console.example.org` | `openhim-console:80` | OpenHIM Console UI |

Create an **A record for each of the four**, pointing at the VPS public IP, and
let them resolve **before** the first start. Caddy requests certificates on boot
over HTTP-01; a name that does not resolve yet fails ACME, and repeated failures
hit Let's Encrypt rate limits. Check from anywhere:

```powershell
Resolve-DnsName keycloak.example.org, openhim.example.org, api.example.org, console.example.org
```

Note that `openhim.example.org` fronts port **5001**, the plain-HTTP transaction
port (loopback-bound in Compose). Caddy is what puts TLS in front of it, so
clients get a real certificate and no longer need `-k` /
`-SkipCertificateCheck`. The self-signed `:5000` stays as it is for local and
fallback use.

### 10b. Root `.env`

Create `.env` **in the repo root** (next to `docker-compose.yml`). It is
gitignored — never commit it.

```
DOMAIN=example.org
KEYCLOAK_PUBLIC_URL=https://keycloak.example.org
KEYCLOAK_ISSUER=https://keycloak.example.org/realms/openhie
```

- `DOMAIN` must be the **bare zone** — no scheme, no subdomain, no trailing dot.
  `Caddyfile` builds `keycloak.{$DOMAIN}` and the rest from it.
- `KEYCLOAK_PUBLIC_URL` becomes Keycloak's `KC_HOSTNAME`, so it is the `iss` of
  every token minted.
- `KEYCLOAK_ISSUER` becomes OpenHIM's `authentication_jwt_issuer`.

The last two must be identical apart from the `/realms/openhie` suffix, and
clients must request tokens from that same host. Any mismatch and every request
401s at the transaction port. Both variables default to `http://localhost:8083…`
when unset, which is why §1–9 work untouched.

`KC_PROXY_HEADERS: xforwarded` is already set on the `keycloak` service, so it
trusts Caddy's `X-Forwarded-*` headers and builds `https://` URLs.

### 10c. Change the secrets before the first public start

Caddy publishes the Keycloak **admin console** at `https://keycloak.<domain>`
and the OpenHIM **Core API** at `https://api.<domain>`. Both are reachable from
the internet the moment the profile starts, so do this first:

- `KC_BOOTSTRAP_ADMIN_PASSWORD` in `docker-compose.yml` (ships as `admin`).
- OpenHIM root password (§3b) → propagate to all four `*/.env` (§3c).
- Production: `hapi-db` and `mongo-db` credentials too.

### 10d. Start the profile

```powershell
docker compose --profile vps up -d
docker compose ps
docker compose logs -f caddy       # watch certificate issuance
```

Successful issuance logs `certificate obtained successfully` once per name.
`caddy` must appear in `docker compose ps`; if it is missing you omitted
`--profile vps`.

Certificates live in the `caddy-data` volume and survive `stop` / `start` and
container recreation — they are lost only to `docker compose down -v` (§11).

Every later Compose command that should keep Caddy running needs the flag too:

```powershell
docker compose --profile vps stop
docker compose --profile vps start
docker compose --profile vps up -d --force-recreate keycloak openhim-core
```

### 10e. Point the Console at the public API

The Console is a browser app: it calls the Core API **from the user's browser**,
not over the Docker network, so it has to be told the public API address.
`docker-compose.yml` carries a commented `openhim-console` block with the shape
— set it on the live service for the `vps` profile:

```yaml
    environment:
      OPENHIM_CONSOLE_PROTOCOL: "https"
      OPENHIM_CORE_MEDIATOR_HOSTNAME: "api.example.org"
      OPENHIM_MEDIATOR_API_PORT: "443"
```

Then `docker compose --profile vps up -d --force-recreate openhim-console`. Left
at the defaults, the Console loads at `https://console.example.org` but every
API call fails — which looks like a login problem rather than a config problem.

### 10f. Realm, key and onboarding on the VPS

Keycloak's `8083` stays bound to `127.0.0.1`, so the onboarding scripts keep
working **unchanged on the VPS itself** against `http://localhost:8083` — §5, §6
and §7 as written. Only the *advertised* URLs change:

```powershell
(Invoke-RestMethod http://localhost:8083/realms/openhie/.well-known/openid-configuration).issuer
# https://keycloak.example.org/realms/openhie   <- public issuer, even over loopback
```

That is correct: with `KC_HOSTNAME` set, Keycloak advertises and stamps the
public issuer no matter which interface the request arrived on. It must match
`KEYCLOAK_ISSUER` exactly.

After changing `.env`, re-extract the realm key and recreate the dependants:

```powershell
docker compose --profile vps up -d --force-recreate keycloak openhim-core
pwsh -File .\keycloak\extract-realm-pubkey.ps1
docker compose --profile vps up -d --force-recreate openhim-core
docker compose restart mediator admin-mediator patient-portal-mediator fhir-intake-mediator
```

From an admin machine **outside** the VPS, point the scripts at the public host:

```powershell
$env:KEYCLOAK_URL = 'https://keycloak.example.org'
pwsh -File .\keycloak\onboard-hospital.ps1 3130400221 "Bharatpur Hospital"
```

### 10g. Firewall

With the `vps` profile, only Caddy needs to be reachable:

| Port | Protocol | Purpose | Access |
|---|---|---|---|
| `22` | TCP | SSH | admin IP / VPN only |
| `80` | TCP | ACME HTTP-01 + redirect to HTTPS | public (required) |
| `443` | TCP | Caddy — all four subdomains | public |

**Close everything else at the host firewall.** This matters: Compose still
publishes `5000` (transaction), `8080` (Core API) and `9000` (Console) on *all*
interfaces, and Caddy does not take them away. The host firewall is the only
thing keeping them off the internet; their TLS-terminated equivalents are
`openhim.`, `api.` and `console.<domain>` on 443.

Already loopback-only in Compose, so they need no rule: `5001`, `8081`, `8083`.
Never publish `5432`, `27017`, or the mediator ports.

JeMPI `50000` is published on the *JeMPI* VPS (§4) — restrict it there to the
OpenHIM host's IP rather than leaving it open to the world.

### 10h. Client traffic through Caddy

Tokens and transactions both go to the public names, and — unlike §8 — no
certificate-skipping flag is needed:

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

`/ingest` (§9) is the same host: `https://openhim.example.org/ingest`. On each
hospital box, `FHIR_mediator/.env` gets
`KEYCLOAK_URL=https://keycloak.example.org` plus that base URL.

### 10i. Raw-IP test profile (`vps-ip`)

For a short test on a trusted network or over WireGuard, before DNS exists.
`caddy-ip` puts Keycloak on `http://<vps-ip>` — **plain HTTP**, so credentials
and tokens are unprotected. Do not use it with real credentials or patient data.

Root `.env`:

```
VPS_IP=203.0.113.10
KEYCLOAK_PUBLIC_URL=http://203.0.113.10
KEYCLOAK_ISSUER=http://203.0.113.10/realms/openhie
```

```powershell
docker compose --profile vps-ip up -d
```

Only Keycloak is fronted here. OpenHIM keeps its direct ports, so transaction
tests still go to `https://<vps-ip>:5000` with the self-signed cert
(`-SkipCertificateCheck`), and `5000` / `9000` must be opened to the test clients
— admin IPs only. Run **one** profile at a time: both Caddy services claim
port 80.

Move to the `vps` profile (10a–10h) before anything real touches the stack.

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

To wipe everything and rebuild — fresh images, empty databases, new realm:

```powershell
docker compose down -v --rmi all      # containers + volumes + images
```

This is the one time `down` is correct: deliberate destruction, not the
accidental `down` §2 warns about. `-v` drops the Keycloak H2 store, the OpenHIM
Mongo database (clients, channels, transactions) and the HAPI Postgres data;
`--rmi all` forces a re-pull.

What survives on disk versus what you must redo:

| Item | After the wipe |
|---|---|
| `keycloak\keys\*.pem` | **survives** — `create-jwt-client.ps1` reuses an existing keypair and re-registers its public key, so hospitals keep the private key you already issued |
| `*/.env` | **survives**, but `OPENHIM_PASSWORD` is now wrong — the root password resets to `openhim-password` |
| `openhim-config\realm-public.pem` | survives as a **stale** key — the new realm has a new RSA keypair, so §6 is mandatory |
| Keycloak realm, clients, mappers | gone — re-run §5, then §7 per hospital |
| OpenHIM clients, channels, transactions | gone — §7 recreates the clients |
| HAPI Patients / Encounters / Organizations | gone — §7 recreates the Organizations |
| JeMPI golden records | **untouched** — JeMPI is on the remote VPS, not in this stack |
| Caddy certificates (`caddy-data`, VPS only) | gone — Caddy re-requests them on the next `--profile vps up`, so make sure DNS still resolves (§10a) before repeating a wipe; Let's Encrypt rate-limits repeated issuance for the same names |

Then run, in order: **§2** → **§3b** and **§3c** (root password is back to
`openhim-password`, so it must be reset and re-propagated) → **§5** → **§6** →
**§7** per hospital → **§8** to verify.

> Only if you also deleted `openhim-config\` do you need **§1b** again — a plain
> `down -v` leaves that host file in place, so the directory trap does not
> re-fire. Deleting the folder without recreating the file puts you straight back
> into it.
>
> JeMPI keeps the golden records from your earlier runs, so a "fresh" stack will
> still match against previously registered patients. To confirm what is there:
> `curl.exe http://202.51.71.81:50000/JeMPI/countRecords`.

---

## Quick reference

| Task | Command (PowerShell 7) |
|---|---|
| Clone | `git clone https://github.com/ETech-Nepal/openhim.git` |
| Create the `.env` files | `Copy-Item <svc>\.env.example <svc>\.env` (§1a) |
| Pre-create the key file | `New-Item -ItemType File openhim-config\realm-public.pem` (§1b) |
| Bring the stack up | `docker compose up -d` |
| Bring it up on a VPS, behind Caddy | `docker compose --profile vps up -d` (§10) |
| Raw-IP test front door (HTTP) | `docker compose --profile vps-ip up -d` (§10i) |
| Watch certificate issuance | `docker compose logs -f caddy` |
| Full reset | `docker compose down -v --rmi all` (§11) |
| Reload a changed `.env` | `docker compose up -d --force-recreate <svc>` |
| Create the realm | `pwsh -File .\keycloak\setup.ps1` |
| Create/update an Organization | `pwsh -File .\keycloak\create-org.ps1 <nhfr-id> "<name>"` |
| Re-extract realm key | `pwsh -File .\keycloak\extract-realm-pubkey.ps1` |
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
| `JWT could not be verified: secret or public key must be provided` | OpenHIM has **no** key loaded — `realm-public.pem` is empty or a directory, see the next row |
| `realm-public.pem` is a directory | Docker created it as a mount target before §1b ran — recovery block in §6 |
| everything 401s right after a rebuild | new realm = new RSA key, and `realm-public.pem` is stale — re-run §6 (§11) |
| `JWT could not be verified` (other) | `realm-public.pem` stale — re-run §6 |
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
