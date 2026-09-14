#!/usr/bin/env bash
# Create a Keycloak client that authenticates via private_key_jwt (client-jwt) —
# machine-to-machine, no password. Generates an RSA keypair, registers the
# public half on the Keycloak client, and prints the service-account sub to
# register as an OpenHIM Client (see services/fhir-mediator/src/scripts/create-hip-client.ts).
#
# Usage: ./keycloak/create-jwt-client.sh openhim-client
#   JWKS_URL=https://hospital.example/.well-known/jwks.json  -- trust the hospital's own
#     published key set instead of importing a key (they rotate keys themselves, no
#     private key is ever generated here). Without it a local keypair is generated.
#   DPOP=false  -- issue plain bearer tokens instead of DPoP-bound ones (default true).
set -euo pipefail

CLIENT_ID="${1:?usage: create-jwt-client.sh <client-id>}"
JWKS_URL="${JWKS_URL:-}"
DPOP="${DPOP:-true}"
REALM=openhie
KC="docker exec keycloak /opt/keycloak/bin/kcadm.sh"
KEYDIR="$(dirname "$0")/keys"
mkdir -p "$KEYDIR"

# Admin session tokens are short-lived; re-login every run instead of assuming
# a still-valid session from an earlier setup.sh/create-jwt-client.sh call.
$KC config credentials --server http://localhost:8080 --realm master --user admin --password admin >/dev/null

PRIV="$KEYDIR/${CLIENT_ID}.key.pem"
PUB="$KEYDIR/${CLIENT_ID}.pub.pem"

if [ -n "$JWKS_URL" ]; then
  echo "== Using participant JWKS URL: $JWKS_URL (no local key) =="
  KEY_ATTRS=(-s "attributes.\"use.jwks.url\"=true" -s "attributes.\"jwks.url\"=$JWKS_URL")
elif [ ! -f "$PRIV" ]; then
  echo "== Generating RSA keypair (2048) =="
  openssl genrsa -out "$PRIV" 2048 2>/dev/null
  openssl rsa -in "$PRIV" -pubout -out "$PUB" 2>/dev/null
else
  echo "== Reusing existing keypair at $PRIV =="
fi

if [ -z "$JWKS_URL" ]; then
  # Keycloak wants the public key as base64 DER (no PEM headers/newlines).
  PUB_DER_B64=$(openssl rsa -in "$PRIV" -pubout -outform DER 2>/dev/null | base64 -w0)
  KEY_ATTRS=(-s "attributes.\"use.jwks.url\"=false" -s "attributes.\"jwt.credential.public.key\"=$PUB_DER_B64")
fi
KEY_ATTRS+=(-s "attributes.\"token.endpoint.auth.signing.alg\"=RS256" -s "attributes.\"dpop.bound.access.tokens\"=$DPOP")

echo "== Client: $CLIENT_ID (client-jwt / private_key_jwt) =="
EXISTING_UUID=$($KC get clients -r $REALM -q clientId=$CLIENT_ID --fields id --format csv --noquotes)
if [ -z "$EXISTING_UUID" ]; then
  $KC create clients -r $REALM \
    -s clientId=$CLIENT_ID \
    -s publicClient=false \
    -s standardFlowEnabled=false \
    -s serviceAccountsEnabled=true \
    -s clientAuthenticatorType=client-jwt \
    "${KEY_ATTRS[@]}"
  EXISTING_UUID=$($KC get clients -r $REALM -q clientId=$CLIENT_ID --fields id --format csv --noquotes)
else
  echo "  already exists — updating key/DPoP attributes"
  $KC update clients/$EXISTING_UUID -r $REALM "${KEY_ATTRS[@]}"
fi

SUB=$($KC get clients/$EXISTING_UUID/service-account-user -r $REALM --fields id --format csv --noquotes)

echo ""
[ -n "$JWKS_URL" ] || echo "Private key (keep this, don't commit): $PRIV"
echo "Service-account sub (register as OpenHIM clientID): $SUB"
echo ""
echo "Register with OpenHIM:"
echo "  docker exec -e HIP_CLIENT_SUB=$SUB -e HIP_CLIENT_NAME=\"$CLIENT_ID\" mediator node dist/scripts/create-hip-client.js"
echo ""
echo "Get a token:"
echo "  ./keycloak/get-jwt-client-token.sh $CLIENT_ID"
