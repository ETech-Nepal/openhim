# Keycloak setup

Issues the RS256 JWTs OpenHIM verifies on its transaction ports (5000/5001).
Now runs as the `keycloak` service in the root `docker-compose.yml` with a
persistent volume (`keycloak-data`) — the earlier bare `docker run` setup lost
its realm every time the container was recreated.

## First-time setup

```bash
docker compose up -d keycloak
./keycloak/setup.sh                    # creates realm `openhie` + demo-client + demo user
```

Then register the demo user's sub (printed by `setup.sh`) as an OpenHIM Client:

```bash
docker exec -e HIP_CLIENT_SUB=<sub> -e HIP_CLIENT_NAME="Demo Client" \
  mediator node dist/scripts/create-hip-client.js
```

## Get a demo token

```bash
curl -s -X POST http://localhost:8083/realms/openhie/protocol/openid-connect/token \
  -d grant_type=password -d client_id=demo-client \
  -d username=demo -d password=demo123 | jq -r .access_token
```

Use it as `Authorization: Bearer <token>` against `https://localhost:5000/fhir/...`.

## Notes

- Keycloak 26 has no `/auth` prefix.
- Bootstrap admin: `admin` / `admin` (env vars on the `keycloak` service — change
  before anything but local dev).
- Bound to `127.0.0.1:8083` only, matching `authentication_jwt_issuer` in
  `docker-compose.yml`. Don't change the port without updating that too.
- OpenHIM pulls the realm signing keys from the JWKS endpoint
  (`authentication_jwt_jwksUri`) and refetches on an unknown `kid`, so wiping and
  rebuilding the realm needs no OpenHIM restart.
- `OPENHIM_CHANNEL_ROLE` the mediator binds its channel to is `np-fhir-clients`
  (see `services/fhir-mediator/.env`) — any OpenHIM Client backing a Keycloak subject needs
  that role to pass the channel's `allow` check.
- For the CDRS dump script's `health-information-provider` client
  (private_key_jwt / client-jwt auth, no password), see
  [[cdrs-dump-script]] and `services/fhir-mediator/src/scripts/create-hip-client.ts` — that
  client isn't created by `setup.sh` since it needs a real RSA keypair
  generated and registered by hand.

## Windows (PowerShell)

The `.sh` scripts need `jq`, `openssl`, `python3`, `fold` and `base64`, none of
which ship with Windows. Each has a `.ps1` twin that does the same thing with
the Keycloak Admin REST API and .NET crypto — no extra tooling, only PowerShell
7.1+ (`pwsh`) and Docker Desktop. The two are interchangeable: keys and PEMs are
written in the same formats, so a client created by one works with the other.

| bash | PowerShell |
| --- | --- |
| `./keycloak/setup.sh` | `pwsh -File .\keycloak\setup.ps1` |
| `./keycloak/create-org.sh <nhfr> "<name>"` | `pwsh -File .\keycloak\create-org.ps1 <nhfr> "<name>"` |
| `./keycloak/create-jwt-client.sh <client-id>` | `pwsh -File .\keycloak\create-jwt-client.ps1 <client-id>` |
| `./keycloak/get-jwt-client-token.sh <client-id>` | `pwsh -File .\keycloak\get-jwt-client-token.ps1 <client-id>` |
| `./keycloak/onboard-hospital.sh <nhfr> ["Name"]` | `pwsh -File .\keycloak\onboard-hospital.ps1 <nhfr> ["Name"]` |

`_common.ps1` holds the shared helpers (admin login, REST wrapper, PEM/base64url,
JWT claim reader) and is dot-sourced by the others — don't run it directly.

Demo token without `jq`:

```powershell
(Invoke-RestMethod -Method Post -Uri 'http://localhost:8083/realms/openhie/protocol/openid-connect/token' `
   -Body @{ grant_type='password'; client_id='demo-client'; username='demo'; password='demo123' }).access_token
```

Overrides via environment: `KEYCLOAK_URL` (default `http://localhost:8083`),
`KEYCLOAK_ADMIN_USER` / `KEYCLOAK_ADMIN_PASSWORD` (default `admin`/`admin`),
plus `FHIR_BASE_URL` and `ACCESS_TOKEN` for `create-org.ps1`.
