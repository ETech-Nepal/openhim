#!/bin/sh
set -eu

java -jar /app/validator_cli.jar server 8081 -version 4.0.1 -ig "$FHIR_VALIDATOR_IG" &
validator=$!

# A validator that fails to load (for example tx.fhir.org unreachable) stops the
# container, so the restart policy tries again instead of waiting forever.
until curl -s -o /dev/null -X POST http://127.0.0.1:8081/validateResource -d '{}'; do
  kill -0 "$validator" 2>/dev/null || { echo "FHIR validator exited during startup" >&2; exit 1; }
  sleep 1
done

exec node dist/index.js
