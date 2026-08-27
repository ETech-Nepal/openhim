#!/usr/bin/env bash
# Create (or update) a facility Organization in HAPI.
#
# The NHFR code is the facility's business identity (Organization.identifier) and
# the value used as the OpenHIM clientID / Keycloak token sub. Organization.id
# stays a server-assigned UUID. This does a conditional update keyed on the NHFR
# identifier, so it is idempotent and enforces one Organization per NHFR code
# (HAPI returns 412 if two already match).
#
# Organizations are reference data: no JeMPI, no Health ID, no mediator — this
# talks straight to HAPI. Set FHIR_BASE_URL + ACCESS_TOKEN to go through OpenHIM.
#
# Usage:  ./keycloak/create-org.sh <nhfr-id> "<facility name>"
#   e.g.  ./keycloak/create-org.sh 3130400221 "Bharatpur Hospital"
set -euo pipefail

NHFR="${1:?usage: create-org.sh <nhfr-id> \"<facility name>\"}"
NAME="${2:?usage: create-org.sh <nhfr-id> \"<facility name>\"}"
FHIR="${FHIR_BASE_URL:-http://localhost:8081/fhir}"
NHFR_SYS="http://mohp.gov.np/fhir/NamingSystem/nhfr"

curl -sS -k -X PUT "${FHIR%/}/Organization?identifier=${NHFR_SYS}|${NHFR}" \
  -H 'Content-Type: application/fhir+json' \
  ${ACCESS_TOKEN:+-H "Authorization: Bearer ${ACCESS_TOKEN}"} \
  -d "{
    \"resourceType\": \"Organization\",
    \"identifier\": [{
      \"use\": \"official\",
      \"type\": {\"coding\": [{\"system\": \"http://terminology.hl7.org/CodeSystem/v2-0203\", \"code\": \"FI\"}]},
      \"system\": \"${NHFR_SYS}\",
      \"value\": \"${NHFR}\"
    }],
    \"active\": true,
    \"name\": \"${NAME}\"
  }" | jq .
