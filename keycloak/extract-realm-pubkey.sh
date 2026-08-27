#!/usr/bin/env bash
# Regenerate openhim-config/realm-public.pem from the running Keycloak realm's
# public key. Run this once after keycloak/setup.sh (or any time the realm is
# recreated) — openhim-core's JWT verification reads this file at boot, not
# Keycloak live, so it must be refreshed whenever the realm's keypair changes.
set -euo pipefail
REALM="${1:-openhie}"

KEY=$(curl -fsS "http://localhost:8083/realms/$REALM" | jq -r .public_key)

{
  echo "-----BEGIN PUBLIC KEY-----"
  echo "$KEY" | fold -w64
  echo "-----END PUBLIC KEY-----"
} > "$(dirname "$0")/../openhim-config/realm-public.pem"

echo "Wrote openhim-config/realm-public.pem for realm $REALM"
echo "Now: docker compose up -d --force-recreate openhim-core"
echo "Then: docker compose restart mediator admin-mediator patient-portal-mediator"
