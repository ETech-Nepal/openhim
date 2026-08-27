# Keycloak setup

Issues the RS256 JWTs OpenHIM verifies on its transaction ports (5000/5001).
Now runs as the `keycloak` service in the root `docker-compose.yml` with a
persistent volume (`keycloak-data`) — the earlier bare `docker run` setup lost
its realm every time the container was recreated.

## First-time setup

```bash
docker compose up -d keycloak
./keycloak/setup.sh                    # creates realm `openhie` + demo-client + demo user
./keycloak/extract-realm-pubkey.sh     # writes ../openhim-config/realm-public.pem
docker compose up -d --force-recreate openhim-core
docker compose restart mediator admin-mediator patient-portal-mediator
```

Then register the demo user's sub (printed by `setup.sh`) as an OpenHIM Client:

```bash
docker exec -e HIP_CLIENT_SUB=<sub> -e HIP_CLIENT_NAME="Demo Client" \
  mediator node scripts/create-hip-client.js
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
- Recreating the realm always changes its RSA keypair — re-run
  `extract-realm-pubkey.sh` + force-recreate `openhim-core` whenever you wipe
  and rebuild the realm.
- `OPENHIM_CHANNEL_ROLE` the mediator binds its channel to is `np-fhir-clients`
  (see `mediator/.env`) — any OpenHIM Client backing a Keycloak subject needs
  that role to pass the channel's `allow` check.
- For the CDRS dump script's `health-information-provider` client
  (private_key_jwt / client-jwt auth, no password), see
  [[cdrs-dump-script]] and `mediator/scripts/create-hip-client.js` — that
  client isn't created by `setup.sh` since it needs a real RSA keypair
  generated and registered by hand.
