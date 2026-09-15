#!/bin/sh
set -eu

java -jar /app/validator_cli.jar server 8081 -version 4.0.1 -ig "$FHIR_VALIDATOR_IG" &

until curl -s -o /dev/null -X POST http://127.0.0.1:8081/validateResource -d '{}'; do
  sleep 1
done

exec node dist/index.js
