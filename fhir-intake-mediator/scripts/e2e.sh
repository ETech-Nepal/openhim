#!/usr/bin/env bash
# End-to-end check for the FHIR Intake mediator: replays raw CDRS fixtures through
# a running OpenHIM stack and verifies HAPI state. Read-only against HAPI except
# for the writes the mediator itself performs.
set -euo pipefail

need() { [ -n "${!1:-}" ] || { echo "missing required env var: $1" >&2; exit 2; }; }
need OPENHIM_TRANSACTION_URL
need ACCESS_TOKEN
need TEST_NHFR_ID
need HAPI_FHIR_URL

command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }

ENC_SYS="http://mohp.gov.np/fhir/NamingSystem/encounter-number"
NHFR_SYS="http://mohp.gov.np/fhir/NamingSystem/nhfr"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# ── Fixtures (derived from the approved encounter-table schema) ────────────────
row() {
  # row <encounter_number> <department_type> [imis_id] [dob]
  local enc="$1" dep="$2" imis="${3:-771929535}" dob="${4:-1986-07-28}"
  jq -n --arg enc "$enc" --arg dep "$dep" --arg imis "$imis" --arg dob "$dob" '{
    imis_id: $imis,
    hospital_patient_number: "2405078",
    encounter_number: $enc,
    first_name: "CHANDRIKA",
    last_name: "KANDEL",
    sex: "Female",
    dob: $dob,
    phone_number: "9864437500",
    department_type: $dep,
    department_id: "22",
    department_name: "Family Medicine",
    visit_date_ad_time: "2026-07-28 00:02:00.000"
  }'
}

stamp="$(date +%s)"
declare -A FIXTURES
FIXTURES["valid-bima"]="$(row "e2e-${stamp}-1" C)"
FIXTURES["sentinels"]="$(row "e2e-${stamp}-2" C 0 None)"
FIXTURES["class-C"]="$(row "e2e-${stamp}-3c" C)"
FIXTURES["class-E"]="$(row "e2e-${stamp}-3e" E)"
FIXTURES["class-N"]="$(row "e2e-${stamp}-3n" N)"
FIXTURES["forged-nhfr"]="$(row "e2e-${stamp}-4" C)"

post() {
  # post <fixture-file>. -k: OpenHIM's :5000 transaction port is self-signed.
  curl -sS -k --fail-with-body \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -H "X-NHFR-ID: forged-value" \
    --data-binary @"$1" \
    "${OPENHIM_TRANSACTION_URL%/}/ingest"
}

hapi_get() {
  curl -sS -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "Accept: application/fhir+json" "$@"
}

# Facility identity: the token `sub` (== X-OpenHIM-ClientID) is the NHFR code.
# The mediator resolves it to Organization/<uuid> by an identifier search; do the
# same here to learn the id the Encounters' serviceProvider must point at.
b64pad() { local s="$1"; case $((${#s} % 4)) in 2) s="$s==";; 3) s="$s=";; esac; printf '%s' "$s" | tr '_-' '/+'; }
token_sub="$(b64pad "$(printf '%s' "$ACCESS_TOKEN" | cut -d. -f2)" | base64 -d 2>/dev/null | jq -r '.sub // empty')"
[ -n "$token_sub" ] || { echo "could not read 'sub' from ACCESS_TOKEN" >&2; exit 1; }
[ "$token_sub" = "$TEST_NHFR_ID" ] \
  || { echo "token sub '$token_sub' != TEST_NHFR_ID '$TEST_NHFR_ID'" >&2; exit 1; }

org_bundle="$(hapi_get "${HAPI_FHIR_URL%/}/Organization?identifier=$(printf '%s' "${NHFR_SYS}|${TEST_NHFR_ID}" | jq -sRr @uri)&_count=2")"
org_count="$(jq '[.entry[]?.resource | select(.resourceType=="Organization")] | length' <<<"$org_bundle")"
[ "$org_count" = "1" ] || { echo "expected exactly 1 Organization for NHFR $TEST_NHFR_ID, got $org_count" >&2; exit 1; }
org_id="$(jq -r '.entry[0].resource.id' <<<"$org_bundle")"
echo "facility: NHFR $TEST_NHFR_ID -> Organization/$org_id"

check_encounter() {
  # check_encounter <encounter_number>
  local enc="$1" q total ref
  q="${HAPI_FHIR_URL%/}/Encounter?identifier=$(printf '%s' "${ENC_SYS}|${enc}" | jq -sRr @uri)"
  for _ in 1 2; do
    total="$(hapi_get "$q" | jq '.total // 0')"
  done
  [ "$total" = "1" ] || { echo "  FAIL $enc: expected total==1, got $total" >&2; return 1; }
  ref="$(hapi_get "$q" | jq -r '.entry[0].resource.serviceProvider.reference')"
  [ "$ref" = "Organization/$org_id" ] || { echo "  FAIL $enc: serviceProvider $ref != Organization/$org_id" >&2; return 1; }
  echo "  OK   $enc -> one Encounter, serviceProvider Organization/$org_id"
}

fail=0

for name in valid-bima sentinels class-C class-E class-N forged-nhfr; do
  f="$tmp/$name.json"
  printf '%s' "${FIXTURES[$name]}" >"$f"
  enc="$(jq -r '.encounter_number' "$f")"
  echo "== $name ($enc)"
  post "$f" >/dev/null && echo "  posted OK" || { echo "  FAIL post" >&2; fail=1; continue; }
  # replay: same fixture again must not create a duplicate
  post "$f" >/dev/null || { echo "  FAIL replay post" >&2; fail=1; continue; }
  check_encounter "$enc" || fail=1
done

if [ "$fail" -ne 0 ]; then
  echo "e2e: FAILURES above" >&2
  exit 1
fi
echo "e2e: all fixtures passed; replay left no duplicates; forged X-NHFR-ID had no effect"
