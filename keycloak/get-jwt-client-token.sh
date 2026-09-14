#!/usr/bin/env bash
# Get an access token for a private_key_jwt (client-jwt) client: builds a
# client_assertion JWT signed with the client's own private key (from
# create-jwt-client.sh), then does the client_credentials grant.
#
# Usage: ./keycloak/get-jwt-client-token.sh openhim-client
set -euo pipefail

CLIENT_ID="${1:?usage: get-jwt-client-token.sh <client-id>}"
REALM=openhie
KC_URL="${KEYCLOAK_URL:-http://localhost:8083}"
TOKEN_EP="$KC_URL/realms/$REALM/protocol/openid-connect/token"
PRIV="$(dirname "$0")/keys/${CLIENT_ID}.key.pem"

[ -f "$PRIV" ] || { echo "No key at $PRIV — run create-jwt-client.sh first" >&2; exit 1; }

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

HEADER=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)
NOW=$(date +%s)
EXP=$((NOW + 60))
JTI=$(openssl rand -hex 16)
PAYLOAD=$(printf '{"iss":"%s","sub":"%s","aud":"%s","jti":"%s","exp":%d,"iat":%d}' \
  "$CLIENT_ID" "$CLIENT_ID" "$TOKEN_EP" "$JTI" "$EXP" "$NOW" | b64url)

SIGNING_INPUT="$HEADER.$PAYLOAD"
SIGNATURE=$(printf '%s' "$SIGNING_INPUT" | openssl dgst -sha256 -sign "$PRIV" | b64url)
ASSERTION="$SIGNING_INPUT.$SIGNATURE"

# DPoP proof for the token endpoint; Keycloak binds the issued token to this key
# (cnf.jkt). Harmless for clients created with DPOP=false. Resource requests need a
# fresh proof per call: node keycloak/dpop-proof.mjs <key> GET <url> <access_token>
DPOP_PROOF=$(node "$(dirname "$0")/dpop-proof.mjs" "$PRIV" POST "$TOKEN_EP")

curl -s -X POST "$TOKEN_EP" \
  -H "DPoP: $DPOP_PROOF" \
  -d grant_type=client_credentials \
  -d client_id="$CLIENT_ID" \
  -d client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer \
  -d client_assertion="$ASSERTION" | jq -r .access_token
