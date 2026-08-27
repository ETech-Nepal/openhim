#!/usr/bin/env bash
# One command per hospital. Give it the NHFR code (and optionally a name) and it
# does §4d + §6a–§6e of SETUP.md:
#
#   - HAPI Organization           (identifier = NHFR code, id = server UUID)
#   - RSA keypair                 keycloak/keys/<nhfr>.key.pem  (+ .pub.pem)
#   - Keycloak client <nhfr>      private_key_jwt, public key registered
#   - protocol mapper sub-as-nhfr forces the token `sub` claim to the NHFR code
#   - OpenHIM Client              clientID = <nhfr>, role np-fhir-clients
#
# Idempotent — safe to re-run. Prereqs: containers up (§1), OpenHIM password
# propagated (§2c), realm key extracted (§5b).
#
# Usage:  ./keycloak/onboard-hospital.sh <nhfr-id> ["Facility Name"]
#   e.g.  ./keycloak/onboard-hospital.sh 3130400221 "Bharatpur Hospital"
set -euo pipefail

NHFR="${1:?usage: onboard-hospital.sh <nhfr-id> [\"Facility Name\"]}"
NAME="${2:-Hospital $NHFR}"
REALM=openhie
HERE="$(cd "$(dirname "$0")" && pwd)"
KC="docker exec keycloak /opt/keycloak/bin/kcadm.sh"

jwt_sub() {  # read the `sub` claim from a JWT on stdin (base64url, padded)
  python3 -c 'import base64,json,sys; p=sys.stdin.read().strip().split(".")[1]; p+="="*(-len(p)%4); print(json.loads(base64.urlsafe_b64decode(p)).get("sub",""))'
}

echo "== 1/5  HAPI Organization =="
"$HERE/create-org.sh" "$NHFR" "$NAME" >/dev/null
echo "   Organization identifier nhfr|$NHFR  ($NAME)"

echo "== 2/5  keypair + Keycloak client + public key =="
"$HERE/create-jwt-client.sh" "$NHFR" >/dev/null

$KC config credentials --server http://localhost:8080 --realm master \
  --user admin --password admin >/dev/null
CLIENT_UUID=$($KC get clients -r $REALM -q clientId="$NHFR" --fields id --format csv --noquotes)
[ -n "$CLIENT_UUID" ] || { echo "Keycloak client $NHFR was not created" >&2; exit 1; }

echo "== 3/5  protocol mapper  sub -> $NHFR =="
OLD=$($KC get "clients/$CLIENT_UUID/protocol-mappers/models" -r $REALM \
        --fields id,name --format csv --noquotes 2>/dev/null \
      | awk -F, '$2=="sub-as-nhfr"{print $1}')
[ -n "$OLD" ] && $KC delete "clients/$CLIENT_UUID/protocol-mappers/models/$OLD" -r $REALM
$KC create "clients/$CLIENT_UUID/protocol-mappers/models" -r $REALM \
  -s name=sub-as-nhfr \
  -s protocol=openid-connect \
  -s protocolMapper=oidc-hardcoded-claim-mapper \
  -s 'config."claim.name"=sub' \
  -s "config.\"claim.value\"=$NHFR" \
  -s 'config."jsonType.label"=String' \
  -s 'config."access.token.claim"=true' \
  -s 'config."id.token.claim"=false' \
  -s 'config."userinfo.token.claim"=false' >/dev/null

echo "== 4/5  verify token sub =="
SUB=$("$HERE/get-jwt-client-token.sh" "$NHFR" | jwt_sub)
[ "$SUB" = "$NHFR" ] || { echo "   FAIL: token sub is '$SUB', expected '$NHFR'" >&2; exit 1; }
echo "   token sub = $SUB"

echo "== 5/5  OpenHIM Client =="
docker exec -e HIP_CLIENT_SUB="$NHFR" -e HIP_CLIENT_NAME="$NAME" \
  mediator node scripts/create-hip-client.js

cat <<EOF

done — hospital $NHFR ($NAME)
  private key : keycloak/keys/$NHFR.key.pem      (hand to the hospital, then delete)
  token       : ./keycloak/get-jwt-client-token.sh $NHFR
  smoke test  : SETUP.md §7b / §8d
EOF
