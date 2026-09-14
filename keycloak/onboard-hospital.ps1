#Requires -Version 7.1
<#
.SYNOPSIS
  Windows port of keycloak/onboard-hospital.sh (no jq / openssl / python3 needed).

.DESCRIPTION
  One command per hospital. Give it the NHFR code (and optionally a name) and it
  does section 4d + 6a-6e of SETUP.md:

    - HAPI Organization           (identifier = NHFR code, id = server UUID)
    - RSA keypair                 keycloak\keys\<nhfr>.key.pem  (+ .pub.pem)
    - Keycloak client <nhfr>      private_key_jwt, public key registered
    - protocol mapper sub-as-nhfr forces the token `sub` claim to the NHFR code
    - OpenHIM Client              clientID = <nhfr>, role np-fhir-clients

  Idempotent - safe to re-run. Prereqs: containers up (1), OpenHIM password
  propagated (2c), realm key extracted (5b).

  Usage:  pwsh -File .\keycloak\onboard-hospital.ps1 <nhfr-id> ["Facility Name"]
    e.g.  pwsh -File .\keycloak\onboard-hospital.ps1 3130400221 "Bharatpur Hospital"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)][string]$Nhfr,
    [Parameter(Position = 1)][string]$Name,
    [string]$Realm = 'openhie'
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\_common.ps1"

if (-not $Name) { $Name = "Hospital $Nhfr" }

Write-Host '== 1/5  HAPI Organization =='
& "$PSScriptRoot\create-org.ps1" $Nhfr $Name | Out-Null
Write-Host "   Organization identifier nhfr|$Nhfr  ($Name)"

Write-Host '== 2/5  keypair + Keycloak client + public key =='
& "$PSScriptRoot\create-jwt-client.ps1" $Nhfr -Realm $Realm | Out-Null

Connect-Keycloak
$client = Get-KcClient -Realm $Realm -ClientId $Nhfr
if (-not $client) { throw "Keycloak client $Nhfr was not created" }

Write-Host "== 3/5  protocol mapper  sub -> $Nhfr =="
$mappers = Invoke-Kc -Path "/admin/realms/$Realm/clients/$($client.id)/protocol-mappers/models"
foreach ($m in @($mappers | Where-Object { $_.name -eq 'sub-as-nhfr' })) {
    Invoke-Kc -Method Delete -Path "/admin/realms/$Realm/clients/$($client.id)/protocol-mappers/models/$($m.id)" | Out-Null
}
Invoke-Kc -Method Post -Path "/admin/realms/$Realm/clients/$($client.id)/protocol-mappers/models" -Body @{
    name           = 'sub-as-nhfr'
    protocol       = 'openid-connect'
    protocolMapper = 'oidc-hardcoded-claim-mapper'
    config         = @{
        'claim.name'            = 'sub'
        'claim.value'           = $Nhfr
        'jsonType.label'        = 'String'
        'access.token.claim'    = 'true'
        'id.token.claim'        = 'false'
        'userinfo.token.claim'  = 'false'
    }
} | Out-Null

Write-Host '== 4/5  verify token sub =='
$token = (& "$PSScriptRoot\get-jwt-client-token.ps1" $Nhfr -Realm $Realm | Select-Object -Last 1)
$sub = Get-JwtClaim -Jwt "$token" -Claim 'sub'
if ($sub -ne $Nhfr) { throw "   FAIL: token sub is '$sub', expected '$Nhfr'" }
Write-Host "   token sub = $sub"

Write-Host '== 5/5  OpenHIM Client =='
docker exec -e "HIP_CLIENT_SUB=$Nhfr" -e "HIP_CLIENT_NAME=$Name" mediator node dist/scripts/create-hip-client.js
if ($LASTEXITCODE -ne 0) { throw "create-hip-client.js failed (exit $LASTEXITCODE)" }

Write-Host ''
Write-Host "done - hospital $Nhfr ($Name)"
Write-Host "  private key : keycloak\keys\$Nhfr.key.pem      (hand to the hospital, then delete)"
Write-Host "  token       : pwsh -File .\keycloak\get-jwt-client-token.ps1 $Nhfr"
Write-Host '  smoke test  : SETUP.md 7b / 8d'
