#!/usr/bin/env bash
# Phase 3 smoke test: fire one curl per resource type directly at the mediator
# (bypassing OpenHIM) with a known-good payload. Each should return 201 + the
# HAPI resource body. Run the mediator (`npm run dev`) and HAPI first.
set -euo pipefail

BASE="${MEDIATOR_BASE:-http://localhost:4000}"
NHID="http://mohp.gov.np/fhir/NamingSystem/nepal-health-id"

echo "== Patient =="
curl -sS -X POST "$BASE/fhir/Patient" \
  -H 'Content-Type: application/fhir+json' \
  -d "{
    \"resourceType\": \"Patient\",
    \"identifier\": [{ \"system\": \"$NHID\", \"value\": \"747128126\" }],
    \"name\": [{ \"use\": \"official\", \"family\": \"SHRESTHA\", \"given\": [\"KAMANA\"] }],
    \"gender\": \"female\",
    \"birthDate\": \"2001-06-25\"
  }" | jq '.response.status // .status'

echo "== Organization =="
curl -sS -X POST "$BASE/fhir/Organization" \
  -H 'Content-Type: application/fhir+json' \
  -d '{
    "resourceType": "Organization",
    "identifier": [{ "value": "3130400221" }],
    "name": "Test Health Post"
  }' | jq '.response.status // .status'

echo "== Encounter (conditional subject) =="
curl -sS -X POST "$BASE/fhir/Encounter" \
  -H 'Content-Type: application/fhir+json' \
  -d "{
    \"resourceType\": \"Encounter\",
    \"status\": \"finished\",
    \"class\": { \"system\": \"http://terminology.hl7.org/CodeSystem/v3-ActCode\", \"code\": \"AMB\" },
    \"subject\": { \"reference\": \"Patient?identifier=$NHID|747128126\" }
  }" | jq '.response.status // .status'

echo "== Practitioner =="
curl -sS -X POST "$BASE/fhir/Practitioner" \
  -H 'Content-Type: application/fhir+json' \
  -d '{
    "resourceType": "Practitioner",
    "identifier": [{ "system": "http://mohp.gov.np/fhir/NamingSystem/nepal-medical-council", "value": "NMC-12345" }],
    "name": [{ "family": "Adhikari", "given": ["Ramesh"] }]
  }' | jq '.response.status // .status'

echo "Done."
