#!/usr/bin/env bash
# VPS bootstrap: install prerequisites, fetch the repo, seed .env files, and
# print the remaining manual steps. Stops BEFORE `docker compose up` — the
# compose file and .env files must be edited for the VPS hostname first
# (SETUP.md §3). Re-runnable.
#
# Usage (copy this one file to the VPS, or curl it, then):
#   VPS_IP=203.0.113.10 ./deploy-vps.sh               # temporary HTTP test
#   DOMAIN=hie.example.org ./deploy-vps.sh             # domain + HTTPS profile
#
# Overrides: REPO_URL, BRANCH, DEST
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/ETech-Nepal/openhim.git}"
BRANCH="${BRANCH:-main}"
DEST="${DEST:-/opt/openhie}"
DOMAIN="${DOMAIN:-}"
VPS_IP="${VPS_IP:-}"

if [ -n "$DOMAIN" ] && [ -n "$VPS_IP" ]; then
  echo "Set either DOMAIN or VPS_IP, not both." >&2
  exit 2
fi

if [ -z "$DOMAIN" ] && [ -z "$VPS_IP" ]; then
  echo "Set VPS_IP=<public-vps-ip> for the test profile, or DOMAIN=<domain> for HTTPS." >&2
  exit 2
fi

# ── 1. Prerequisites ─────────────────────────────────────────────────────────
pkgs=()
command -v docker  >/dev/null                || pkgs+=(docker.io)
docker compose version >/dev/null 2>&1       || pkgs+=(docker-compose-v2)
command -v git     >/dev/null                || pkgs+=(git)
command -v jq      >/dev/null                || pkgs+=(jq)
command -v curl    >/dev/null                || pkgs+=(curl)
command -v openssl >/dev/null                || pkgs+=(openssl)
command -v wg      >/dev/null                || pkgs+=(wireguard)

if [ ${#pkgs[@]} -gt 0 ]; then
  echo "== Installing: ${pkgs[*]} =="
  sudo apt-get update -qq
  sudo apt-get install -y "${pkgs[@]}"
  sudo systemctl enable --now docker
  sudo usermod -aG docker "$USER" || true
  echo "   (log out/in for docker group to take effect, or run the rest with sudo)"
else
  echo "== Prerequisites present =="
fi

# ── 2. Repo ──────────────────────────────────────────────────────────────────
if [ -d "$DEST/.git" ]; then
  echo "== Updating $DEST =="
  git -C "$DEST" pull --ff-only
else
  echo "== Cloning $REPO_URL ($BRANCH) -> $DEST =="
  sudo mkdir -p "$DEST"
  sudo chown "$USER:$(id -gn)" "$DEST"
  git clone -b "$BRANCH" "$REPO_URL" "$DEST"
fi
cd "$DEST"

if [ ! -d fhir-intake-mediator ]; then
  echo "!! WARNING: fhir-intake-mediator/ not in branch '$BRANCH'."
  echo "!! The FHIR Intake mediator, onboard-hospital.sh and Model B changes are"
  echo "!! not committed yet. Push a deploy branch first, then re-run with BRANCH=<it>."
fi

# ── 3. .env files ────────────────────────────────────────────────────────────
for d in mediator admin-mediator patient-portal-mediator fhir-intake-mediator; do
  [ -d "$d" ] || continue
  if [ -f "$d/.env" ]; then
    echo "keep  $d/.env"
  else
    cp "$d/.env.example" "$d/.env"
    echo "made  $d/.env   <- EDIT before starting"
  fi
done

# realm public key is injected by SETUP §5; give the bind mount a real file so
# openhim-core can start (JWT auth just fails until §5 runs).
[ -f openhim-config/realm-public.pem ] || { touch openhim-config/realm-public.pem; echo "made  openhim-config/realm-public.pem (placeholder)"; }

# root .env for docker compose variable substitution (Caddy DOMAIN / VPS_IP)
if [ -n "$DOMAIN" ] && ! grep -qs '^DOMAIN=' .env 2>/dev/null; then
  echo "DOMAIN=$DOMAIN" >> .env
  echo "made  .env       DOMAIN=$DOMAIN"
fi

if [ -n "$VPS_IP" ]; then
  if ! grep -qs '^VPS_IP=' .env 2>/dev/null; then
    echo "VPS_IP=$VPS_IP" >> .env
    echo "made  .env       VPS_IP=$VPS_IP"
  fi
  if ! grep -qs '^KEYCLOAK_PUBLIC_URL=' .env 2>/dev/null; then
    echo "KEYCLOAK_PUBLIC_URL=http://$VPS_IP" >> .env
    echo "made  .env       KEYCLOAK_PUBLIC_URL=http://$VPS_IP"
  fi
  if ! grep -qs '^KEYCLOAK_ISSUER=' .env 2>/dev/null; then
    echo "KEYCLOAK_ISSUER=http://$VPS_IP/realms/openhie" >> .env
    echo "made  .env       KEYCLOAK_ISSUER=http://$VPS_IP/realms/openhie"
  fi
fi

# ── 4. Remaining manual steps ────────────────────────────────────────────────
D="${DOMAIN:-<domain>}"
if [ -n "$VPS_IP" ]; then
  cat <<EOF

────────────────────────────────────────────────────────────────────────────
Raw-IP test profile (HTTP only — trusted network / WireGuard clients only):

  Keycloak URL / issuer:  http://$VPS_IP
  Keycloak container port: 127.0.0.1:8083 (not public)

  1. Open only the required firewall ports:
       80/tcp   Keycloak via Caddy
       5000/tcp OpenHIM transaction API
       8080/tcp OpenHIM API (admin network only)
       9000/tcp OpenHIM Console (admin network only)
       <wg-port>/udp WireGuard, if this VPS accepts WireGuard peers

     Do not expose 5001, 8081, 8083, 5432, 27017, or mediator ports.

  2. Start:
       docker compose --profile vps-ip up -d --build
       docker compose ps

  3. Bring up WireGuard and verify JeMPI (SETUP.md §3), then complete:
       SETUP.md §2 root password -> §4 realm -> §5 realm public key
       -> §6 onboard-hospital.

  Every Keycloak client must use http://$VPS_IP as KEYCLOAK_URL.
  Replace this profile with the DOMAIN / HTTPS profile before real use.
────────────────────────────────────────────────────────────────────────────
EOF
else
  cat <<EOF

────────────────────────────────────────────────────────────────────────────
Edit these, THEN start  (SETUP.md §3):

 1. docker-compose.yml  keycloak:
      environment:
        KC_HOSTNAME: https://keycloak.$D
        KC_HOSTNAME_STRICT: "false"
        KC_PROXY_HEADERS: xforwarded
      ports:  keep  127.0.0.1:8083:8080  (loopback only, onboarding scripts)

 2. docker-compose.yml  openhim-core:
      authentication_jwt_issuer: "https://keycloak.$D/realms/openhie"
      ports:  remove 8080 / 5000 / 5001 host maps      (Caddy fronts them)

 3. docker-compose.yml  openhim-console + mediators:  remove 9000 / 40xx host maps.
    Confirm the console image points its API at  https://api.$D
    (organsushi/medisha-him — may be baked in; rebuild or env if so).

 4. Caddyfile (repo root) reads \$DOMAIN from ./.env  ($D).
    DNS A records -> this VPS:  keycloak.$D  openhim.$D  api.$D  console.$D

 5. Every  */.env :  KEYCLOAK_URL=https://keycloak.$D

 6. docker compose --profile vps up -d && docker compose ps
    (--profile vps also starts Caddy)

 7. SETUP §5 root password + propagate  ->  §6 realm  ->  §7 extract-realm-pubkey.sh
    ->  §8 JeMPI (wg peer / public-IP fallback)  ->  §9 onboard-hospital.sh
────────────────────────────────────────────────────────────────────────────
EOF
fi
