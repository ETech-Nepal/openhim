#Requires -Version 7.1
<#
.SYNOPSIS
  Windows port of keycloak/extract-realm-pubkey.sh (no jq / fold needed).

.DESCRIPTION
  Regenerate openhim-config/realm-public.pem from the running Keycloak realm's
  public key. Run this once after keycloak/setup.ps1 (or any time the realm is
  recreated) - openhim-core's JWT verification reads this file at boot, not
  Keycloak live, so it must be refreshed whenever the realm's keypair changes.

  Usage: pwsh -File .\keycloak\extract-realm-pubkey.ps1 [realm]
#>
[CmdletBinding()]
param([string]$Realm = 'openhie')

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\_common.ps1"

$key = (Invoke-RestMethod -Method Get -Uri "$script:KcUrl/realms/$Realm").public_key
if (-not $key) { throw "Realm '$Realm' returned no public_key at $script:KcUrl" }

$out = Join-Path (Split-Path -Parent $PSScriptRoot) 'openhim-config\realm-public.pem'

# Docker Desktop silently creates an empty DIRECTORY at a bind-mount source that
# does not exist yet, so a stack first started before this script ever ran leaves
# a directory where the .pem belongs. Say that, instead of "access is denied".
if (Test-Path -LiteralPath $out -PathType Container) {
    throw @"
$out is a directory, not a file.
Docker created it for the openhim-core bind mount before the .pem existed. Fix with:
  docker compose stop openhim-core
  Remove-Item -Recurse -Force '$out'
then re-run this script, and: docker compose up -d --force-recreate openhim-core
"@
}

Write-TextFileLf -Path $out -Text (ConvertTo-Pem -Label 'PUBLIC KEY' -Base64 $key)

Write-Host "Wrote openhim-config/realm-public.pem for realm $Realm"
Write-Host 'Now: docker compose up -d --force-recreate openhim-core'
Write-Host 'Then: docker compose restart mediator admin-mediator patient-portal-mediator'
