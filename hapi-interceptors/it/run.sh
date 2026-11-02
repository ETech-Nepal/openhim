#!/usr/bin/env bash
# Integration test: the real HAPI image with this jar loaded, a disposable PostgreSQL,
# and a local JWKS server whose key mints the test tokens. Build the jar first
# (mvn package). Usage: it/run.sh
# it/application.yaml is single_stack/hapi-config/application.yaml with the test database
# host; keep the two in step.
set -euo pipefail
cd "$(dirname "$0")"
HERE="$PWD"
ROOT="$(cd ../.. && pwd)"
HAPI_IMAGE="${HAPI_IMAGE:-hapiproject/hapi:v8.12.0-1}"
NET=np-hapi-it
WORK="$(mktemp -d)"
cleanup() { docker rm -f np-it-db np-it-jwks np-it-fhir >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

cp mint.mjs it.mjs "$WORK/"
node "$WORK/mint.mjs" >/dev/null # creates key.pem and jwks.json
IG="$ROOT/hapi-config/np.core-1.0.0.tgz"

docker network create "$NET" >/dev/null
docker run -d --name np-it-db --network "$NET" -e POSTGRES_DB=hapi -e POSTGRES_USER=admin -e POSTGRES_PASSWORD=pw postgres:16-alpine >/dev/null
docker run -d --name np-it-jwks --network "$NET" -v "$WORK:/s:ro" node:24.22.1-alpine \
  node -e "require('http').createServer((q,r)=>{r.setHeader('Content-Type','application/json');r.end(require('fs').readFileSync('/s/jwks.json'))}).listen(80)" >/dev/null
sleep 5
docker run -d --name np-it-fhir --network "$NET" -p 127.0.0.1:${IT_PORT:-28081}:8080 \
  -e SPRING_DATASOURCE_PASSWORD=pw \
  -e NP_AUTH_ISSUER=http://issuer.test/realms/openhie \
  -e NP_AUTH_JWKS_URI=http://np-it-jwks/jwks.json \
  -e NP_IDENTITY_CLIENT_ID=identity-mediator \
  -v "$HERE/application.yaml:/app/config/application.yaml:ro" \
  -v "$IG:/app/config/np.core-1.0.0.tgz:ro" \
  -v "$HERE/../target:/app/extra-classes:ro" \
  "$HAPI_IMAGE" >/dev/null

for _ in $(seq 120); do
  curl -fsS -o /dev/null http://localhost:${IT_PORT:-28081}/fhir/metadata 2>/dev/null && break
  docker ps --filter name=np-it-fhir --format '{{.Status}}' | grep -q Up || { docker logs np-it-fhir | tail -50; exit 1; }
  sleep 5
done
docker logs np-it-fhir 2>&1 | grep 'NP access rules active' >/dev/null || { echo 'interceptor not loaded'; exit 1; }
FHIR_BASE="http://localhost:${IT_PORT:-28081}/fhir" node "$WORK/it.mjs"
