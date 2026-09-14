# FHIR Gateway mediator

Front door for `/fhir`. Authentication in the mediator, authorization in OpenHIM channels.

**Mediator** (`src/app.ts`), per request except `/fhir/metadata`:

1. Verify `Authorization: Bearer|DPoP <jwt>` against `KEYCLOAK_ISSUER` JWKS (`iss`, `aud`, `exp`).
2. If the token carries `cnf.jkt`, require and verify a `DPoP` proof (RFC 9449): signature,
   thumbprint = `cnf.jkt`, `htm`, `htu` = `PUBLIC_BASE_URL` + path, `ath`, `iat` ±5 min, `jti` replay.
3. Proxy to `HAPI_BASE_URL`, `Authorization`/`DPoP` stripped.

**Channels** (`src/channels.ts`, self-registered on boot, mirrored in
`openhim-config/hapi-channels.json`): one channel per OpenHIM client role and verb, all
routing here. Edit `ROLE_ACCESS` to change what a role may create or read. No channel
matches `PUT`/`PATCH`/`DELETE` or `POST /fhir` (transaction bundles), so OpenHIM rejects them.

| OpenHIM client role | create | read |
| --- | --- | --- |
| `ehr` | Patient, Encounter, Observation, Condition, Procedure, DiagnosticReport | same |
| `patient` | none | Patient, Encounter, Observation |

Not implemented: per-patient compartment scoping for `patient`.

```bash
cp .env.example .env   # set OPENHIM_PASSWORD, KEYCLOAK_ISSUER, PUBLIC_BASE_URL
npm test
```

Disable the old "HAPI FHIR read"/"HAPI FHIR write" channels in OpenHIM; they share the URL
pattern and would otherwise bypass this mediator.

## `UPSTREAM_ROLE_HEADER=true` (hie-fhir-server style HAPI)

When HAPI itself enforces roles from an `X-Role` header, set this and the mediator behaves
like `hie-gateway`: one broad `/fhir` channel for `OPENHIM_CHANNEL_ROLES`, and the token's
`realm_access.roles` mapped through `ROLE_MAPPINGS` (`hip=ehr,hiu=patient`) into `X-Role`.
A token with no mapped role gets 403. A client-supplied `X-Role` is always dropped.
