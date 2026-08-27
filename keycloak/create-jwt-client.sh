#!/usr/bin/env bash
# Create a Keycloak client that authenticates via private_key_jwt (client-jwt) —
# machine-to-machine, no password. Generates an RSA keypair, registers the
# public half on the Keycloak client, and prints the service-account sub to
# register as an OpenHIM Client (see mediator/scripts/create-hip-client.js).
#
# Usage: ./keycloak/create-jwt-client.sh openhim-client
set -euo pipefail

CLIENT_ID="${1:?usage: create-jwt-client.sh <client-id>}"
REALM=openhie
KC="docker exec keycloak /opt/keycloak/bin/kcadm.sh"
KEYDIR="$(dirname "$0")/keys"
mkdir -p "$KEYDIR"

# Admin session tokens are short-lived; re-login every run instead of assuming
# a still-valid session from an earlier setup.sh/create-jwt-client.sh call.
$KC config credentials --server http://localhost:8080 --realm master --user admin --password admin >/dev/null

PRIV="$KEYDIR/${CLIENT_ID}.key.pem"
PUB="$KEYDIR/${CLIENT_ID}.pub.pem"

if [ ! -f "$PRIV" ]; then
  echo "== Generating RSA keypair (2048) =="
  openssl genrsa -out "$PRIV" 2048 2>/dev/null
  openssl rsa -in "$PRIV" -pubout -out "$PUB" 2>/dev/null
else
  echo "== Reusing existing keypair at $PRIV =="
fi

# Keycloak wants the public key as base64 DER (no PEM headers/newlines).
PUB_DER_B64=$(openssl rsa -in "$PRIV" -pubout -outform DER 2>/dev/null | base64 -w0)

echo "== Client: $CLIENT_ID (client-jwt / private_key_jwt) =="
EXISTING_UUID=$($KC get clients -r $REALM -q clientId=$CLIENT_ID --fields id --format csv --noquotes)
if [ -z "$EXISTING_UUID" ]; then
  $KC create clients -r $REALM \
    -s clientId=$CLIENT_ID \
    -s publicClient=false \
    -s standardFlowEnabled=false \
    -s serviceAccountsEnabled=true \
    -s clientAuthenticatorType=client-jwt \
    -s "attributes.\"jwt.credential.public.key\"=$PUB_DER_B64" \
    -s "attributes.\"token.endpoint.auth.signing.alg\"=RS256" \
    -s "attributes.\"use.jwks.url\"=false"
  EXISTING_UUID=$($KC get clients -r $REALM -q clientId=$CLIENT_ID --fields id --format csv --noquotes)
else
  echo "  already exists — updating public key attribute"
  $KC update clients/$EXISTING_UUID -r $REALM \
    -s "attributes.\"jwt.credential.public.key\"=$PUB_DER_B64" \
    -s "attributes.\"token.endpoint.auth.signing.alg\"=RS256" \
    -s "attributes.\"use.jwks.url\"=false"
fi

SUB=$($KC get clients/$EXISTING_UUID/service-account-user -r $REALM --fields id --format csv --noquotes)

echo ""
echo "Private key (keep this, don't commit): $PRIV"
echo "Service-account sub (register as OpenHIM clientID): $SUB"
echo ""
echo "Register with OpenHIM:"
echo "  docker exec -e HIP_CLIENT_SUB=$SUB -e HIP_CLIENT_NAME=\"$CLIENT_ID\" mediator node scripts/create-hip-client.js"
echo ""
echo "Get a token:"
echo "  ./keycloak/get-jwt-client-token.sh $CLIENT_ID"
