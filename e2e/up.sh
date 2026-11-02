#!/usr/bin/env bash
# Brings up the single_stack deployment for a local end-to-end run, in a scratch copy
# so the real .env, env/*.env and keys/ are never touched, with shifted host ports (the
# 1xxxx range) and a JeMPI stub. Images: build them with the tag "e2e" first.
#   e2e/up.sh <scratch-dir>      then: e2e/down.sh <scratch-dir>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
STACK_SRC="${STACK_SRC:-$HERE/../../single_stack}"
WORK="${1:?usage: up.sh <scratch-dir>}"
rm -rf "$WORK"; mkdir -p "$WORK"
cp -r "$STACK_SRC"/. "$WORK"/
rm -rf "$WORK/.git" "$WORK/keys" "$WORK/.env" "$WORK"/env/*.env
cp "$HERE/jempi-stub.mjs" "$WORK/"
cd "$WORK"

export COMPOSE_PROJECT_NAME=np-e2e
export COMPOSE_FILE=docker-compose.yml:docker-compose.e2e.yml
export KEYCLOAK_URL=http://localhost:18083 OPENHIM_API=https://localhost:18080 HAPI_URL=http://localhost:18081
rnd() { openssl rand -hex 16; }
cat > .env <<ENV
KEYCLOAK_PUBLIC_URL=http://localhost:18083
KEYCLOAK_ISSUER=http://localhost:18083/realms/openhie
KEYCLOAK_JWKS_URI=http://keycloak:8080/realms/openhie/protocol/openid-connect/certs
PUBLIC_BASE_URL=https://localhost:15000
HAPI_DB_PASSWORD=$(rnd)
KEYCLOAK_DB_PASSWORD=$(rnd)
KEYCLOAK_ADMIN_PASSWORD=e2e-admin
IDENTITY_DB_PASSWORD=$(rnd)
OPENHIM_SESSION_KEY=$(rnd)
OPENHIE_IMAGE_TAG=e2e
ENV
sed -e 's#^OPENHIM_PASSWORD=.*#OPENHIM_PASSWORD=e2e-mediators#' -e 's#^JEMPI_BASE_URL=.*#JEMPI_BASE_URL=http://jempi:50000/JeMPI#' \
  env/identity-mediator.env.example > env/identity-mediator.env
sed -e 's#^OPENHIM_PASSWORD=.*#OPENHIM_PASSWORD=e2e-mediators#' env/transform-mediator.env.example > env/transform-mediator.env
cat > docker-compose.e2e.yml <<'YML'
services:
  jempi:
    image: node:24.22.1-alpine
    command: ["node", "/stub/jempi-stub.mjs"]
    volumes: ["./jempi-stub.mjs:/stub/jempi-stub.mjs:ro"]
    networks: [openhim]
  keycloak:
    container_name: np-e2e-keycloak
    ports: !override ["127.0.0.1:18083:8080"]
  openhim-core:
    container_name: np-e2e-openhim-core
    ports: !override ["127.0.0.1:18080:8080", "127.0.0.1:15000:5000"]
  openhim-console:
    container_name: np-e2e-openhim-console
    ports: !override ["127.0.0.1:19000:80"]
  fhir:
    container_name: np-e2e-fhir
    ports: !override ["127.0.0.1:18081:8080"]
  hapi-db: { container_name: np-e2e-hapi-db }
  mongo-db: { container_name: np-e2e-mongo-db }
  identity-mediator:
    container_name: np-e2e-identity-mediator
    environment: { NODE_ENV: development }
  transform-mediator: { container_name: np-e2e-transform-mediator }
YML

wait_for() { for _ in $(seq 120); do eval "$1" >/dev/null 2>&1 && return 0; sleep 5; done; echo "timed out: $1" >&2; exit 1; }
docker compose up -d hapi-db mongo-db keycloak openhim-core openhim-console fhir jempi
wait_for "curl -fsS $KEYCLOAK_URL/realms/openhie/.well-known/openid-configuration"
wait_for "curl -kfsS $OPENHIM_API/heartbeat"

printf 'admin\ne2e-admin\ne2e-client-admin\ne2e-client-admin\n' | scripts/create-realm-client-admin.sh
printf 'admin\ne2e-admin\n' | scripts/apply-realm-config.sh
printf 'openhim-password\n' | scripts/create-mediator-role.sh
SALT=$(rnd); HASH=$(printf '%s%s' "$SALT" e2e-mediators | sha512sum | cut -d' ' -f1)
curl -kfsS -u root@openhim.org:openhim-password -H 'Content-Type: application/json' -X POST "$OPENHIM_API/users" \
  -d "{\"firstname\":\"Mediators\",\"surname\":\"Service\",\"email\":\"mediators@openhim.local\",\"groups\":[\"mediator-registration\"],\"passwordAlgorithm\":\"sha512\",\"passwordSalt\":\"$SALT\",\"passwordHash\":\"$HASH\"}" >/dev/null || true

onboard() { printf 'hie-client-admin\ne2e-client-admin\nopenhim-password\n' | scripts/onboard-client.sh "$@"; }
onboard onboarding "Platform onboarding" onboarding
onboard identity-mediator "Identity mediator" identity-mediator
onboard admin-portal "Patient Admin Portal" admin-portal
wait_for "curl -fsS $HAPI_URL/fhir/metadata"
facility() { printf 'hie-client-admin\ne2e-client-admin\nopenhim-password\n' | scripts/onboard-facility.sh "$@"; }
facility 3130400221 "SYN Hospital A" hospital
facility 3130400222 "SYN Hospital B" hospital
facility 3130400299 "SYN Laboratory" laboratory
printf 'openhim-password\n' | scripts/apply-hapi-channels.sh

docker compose up -d identity-mediator transform-mediator
wait_for "curl -kfsS -u root@openhim.org:openhim-password $OPENHIM_API/channels | grep -q 'FHIR Middleware: fhir-bundle-v1'"
wait_for "curl -kfsS -u root@openhim.org:openhim-password $OPENHIM_API/channels | grep -q 'NP Patient Identity'"
echo "e2e stack up in $WORK (project np-e2e). OpenHIM https://localhost:15000, Keycloak $KEYCLOAK_URL"
