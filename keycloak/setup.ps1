#Requires -Version 7.1
<#
.SYNOPSIS
  Windows port of keycloak/setup.sh.

.DESCRIPTION
  Idempotently provisions the `openhie` Keycloak realm + a demo client/user for
  password-grant JWTs against OpenHIM's transaction ports (5000/5001).

  Run AFTER `docker compose up -d keycloak`:
    pwsh -File .\keycloak\setup.ps1

  Then:
    1. .\keycloak\extract-realm-pubkey.ps1   (writes openhim-config/realm-public.pem)
    2. docker compose up -d --force-recreate openhim-core
       (this changes openhim-core's IP - restart the other mediators after:
        docker compose restart mediator admin-mediator patient-portal-mediator)
    3. Register the demo user's sub as an OpenHIM Client (role np-fhir-clients):
         docker exec -e HIP_CLIENT_SUB=<sub printed below> -e HIP_CLIENT_NAME="Demo Client" `
           mediator node scripts/create-hip-client.js
#>
[CmdletBinding()]
param(
    [string]$Realm = 'openhie',
    [string]$DemoClientId = 'demo-client',
    [string]$DemoUser = 'demo',
    [string]$DemoPassword = 'demo123'
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\_common.ps1"

Write-Host '== Waiting for Keycloak =='
Wait-Keycloak

Write-Host '== Logging in as bootstrap admin =='
Connect-Keycloak

Write-Host "== Realm: $Realm =="
if (-not (Get-KcRealm -Realm $Realm)) {
    Invoke-Kc -Method Post -Path '/admin/realms' -Body @{ realm = $Realm; enabled = $true } | Out-Null
} else {
    Write-Host '  already exists'
}

Write-Host "== Client: $DemoClientId (password grant, for curl demos) =="
if (-not (Get-KcClient -Realm $Realm -ClientId $DemoClientId)) {
    Invoke-Kc -Method Post -Path "/admin/realms/$Realm/clients" -Body @{
        clientId                  = $DemoClientId
        publicClient              = $true
        standardFlowEnabled       = $false
        directAccessGrantsEnabled = $true
    } | Out-Null
} else {
    Write-Host '  already exists'
}

Write-Host "== User: $DemoUser =="
$user = Get-KcUser -Realm $Realm -Username $DemoUser
if (-not $user) {
    Invoke-Kc -Method Post -Path "/admin/realms/$Realm/users" -Body @{ username = $DemoUser; enabled = $true } | Out-Null
    $user = Get-KcUser -Realm $Realm -Username $DemoUser
}
$demoUserSub = $user.id

Invoke-Kc -Method Put -Path "/admin/realms/$Realm/users/$demoUserSub/reset-password" -Body @{
    type = 'password'; value = $DemoPassword; temporary = $false
} | Out-Null

# Realm's default User Profile requires email/firstName/lastName. Missing them
# (or a lingering requiredAction) makes the password grant fail with
# "Account is not fully set up" even though the credential itself is fine.
Invoke-Kc -Method Put -Path "/admin/realms/$Realm/users/$demoUserSub" -Body @{
    requiredActions = @()
    emailVerified   = $true
    email           = 'demo@example.com'
    firstName       = 'Demo'
    lastName        = 'User'
} | Out-Null

Write-Host ''
Write-Host "Done. Demo user sub (register this as the OpenHIM clientID): $demoUserSub"
Write-Host ''
Write-Host 'Get a token with:'
Write-Host "  (Invoke-RestMethod -Method Post -Uri '$script:KcUrl/realms/$Realm/protocol/openid-connect/token' ``"
Write-Host "     -Body @{ grant_type='password'; client_id='$DemoClientId'; username='$DemoUser'; password='$DemoPassword' }).access_token"
