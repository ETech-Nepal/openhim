#!/usr/bin/env bash
# Idempotently provision the `openhie` Keycloak realm + a demo client/user for
# password-grant JWTs against OpenHIM's transaction ports (5000/5001).
#
# Run AFTER `docker compose up -d keycloak`:
#   ./keycloak/setup.sh
#
# Then:
#   1. Register the demo user's sub as an OpenHIM Client (role np-fhir-clients):
#        docker exec -e HIP_CLIENT_SUB=<sub printed below> -e HIP_CLIENT_NAME="Demo Client" \
#          mediator node dist/scripts/create-hip-client.js
set -euo pipefail

KC="docker exec keycloak /opt/keycloak/bin/kcadm.sh"
REALM=openhie
DEMO_CLIENT_ID=demo-client
DEMO_USER=demo
DEMO_PASSWORD=demo123

echo "== Waiting for Keycloak =="
until curl -fsS http://localhost:8083/realms/master >/dev/null 2>&1; do sleep 2; done

echo "== Logging in as bootstrap admin =="
$KC config credentials --server http://localhost:8080 --realm master --user admin --password admin

echo "== Realm: $REALM =="
if ! $KC get realms/$REALM >/dev/null 2>&1; then
  $KC create realms -s realm=$REALM -s enabled=true
else
  echo "  already exists"
fi

echo "== Client: $DEMO_CLIENT_ID (password grant, for curl demos) =="
if [ -z "$($KC get clients -r $REALM -q clientId=$DEMO_CLIENT_ID --fields id --format csv --noquotes)" ]; then
  $KC create clients -r $REALM \
    -s clientId=$DEMO_CLIENT_ID \
    -s publicClient=true \
    -s standardFlowEnabled=false \
    -s directAccessGrantsEnabled=true
else
  echo "  already exists"
fi

echo "== User: $DEMO_USER =="
if [ -z "$($KC get users -r $REALM -q username=$DEMO_USER --fields id --format csv --noquotes)" ]; then
  $KC create users -r $REALM -s username=$DEMO_USER -s enabled=true
fi
$KC set-password -r $REALM --username $DEMO_USER --new-password $DEMO_PASSWORD

DEMO_USER_SUB=$($KC get users -r $REALM -q username=$DEMO_USER --fields id --format csv --noquotes)
# Realm's default User Profile requires email/firstName/lastName. Missing them
# (or a lingering requiredAction) makes the password grant fail with
# "Account is not fully set up" even though the credential itself is fine.
$KC update users/$DEMO_USER_SUB -r $REALM \
  -s 'requiredActions=[]' -s emailVerified=true \
  -s email=demo@example.com -s firstName=Demo -s lastName=User

echo ""
echo "Done. Demo user sub (register this as the OpenHIM clientID): $DEMO_USER_SUB"
echo ""
echo "Get a token with:"
echo "  curl -s -X POST http://localhost:8083/realms/$REALM/protocol/openid-connect/token \\"
echo "    -d grant_type=password -d client_id=$DEMO_CLIENT_ID \\"
echo "    -d username=$DEMO_USER -d password=$DEMO_PASSWORD | jq -r .access_token"
