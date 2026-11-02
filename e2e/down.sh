#!/usr/bin/env bash
# Removes the e2e stack and its volumes.
set -euo pipefail
cd "${1:?usage: down.sh <scratch-dir>}"
COMPOSE_PROJECT_NAME=np-e2e COMPOSE_FILE=docker-compose.yml:docker-compose.e2e.yml docker compose down -v
