#!/usr/bin/env bash
# Phase 6 end-to-end: obtain a Keycloak JWT, then POST the sample bundle through
# OpenHIM (transaction port 5000) which forwards to this mediator. Expect a
# transaction-response Bundle and orchestrations visible in the OpenHIM console.
set -euo pipefail

KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8088}"
REALM="${KEYCLOAK_REALM:-openhie}"
CLIENT_ID="${KEYCLOAK_CLIENT_ID:?set KEYCLOAK_CLIENT_ID}"
USERNAME="${KEYCLOAK_USERNAME:?set KEYCLOAK_USERNAME}"
PASSWORD="${KEYCLOAK_PASSWORD:?set KEYCLOAK_PASSWORD}"
OPENHIM_URL="${OPENHIM_URL:-https://localhost:5000}"

echo "== Fetching JWT from Keycloak =="
TOKEN=$(curl -s -X POST "$KEYCLOAK_URL/realms/$REALM/protocol/openid-connect/token" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=password' \
  -d "client_id=$CLIENT_ID" \
  -d "username=$USERNAME" \
  -d "password=$PASSWORD" \
  | jq -r '.access_token')

if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  echo "Failed to obtain token" >&2
  exit 1
fi
echo "Token: $(echo "$TOKEN" | cut -c1-40)..."

echo "== POST sample bundle through OpenHIM =="
curl -k -sS -X POST "$OPENHIM_URL/fhir" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/fhir+json' \
  -d @"$(dirname "$0")/sample-bundle.json" | jq '.'
