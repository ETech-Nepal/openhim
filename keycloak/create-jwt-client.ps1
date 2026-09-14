#Requires -Version 7.1
<#
.SYNOPSIS
  Windows port of keycloak/create-jwt-client.sh (no openssl / kcadm.sh needed).

.DESCRIPTION
  Create a Keycloak client that authenticates via private_key_jwt (client-jwt) -
  machine-to-machine, no password. Generates an RSA keypair with .NET, registers
  the public half on the Keycloak client, and prints the service-account sub to
  register as an OpenHIM Client (see services/fhir-mediator/src/scripts/create-hip-client.ts).

  Keys land in keycloak\keys\ in the same PEM formats the bash script produces,
  so the two are interchangeable.

  Usage: pwsh -File .\keycloak\create-jwt-client.ps1 openhim-client
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)][string]$ClientId,
    [string]$Realm = 'openhie'
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\_common.ps1"

$keyDir = Join-Path $PSScriptRoot 'keys'
New-Item -ItemType Directory -Force -Path $keyDir | Out-Null

# Admin session tokens are short-lived; re-login every run instead of assuming
# a still-valid session from an earlier setup.ps1/create-jwt-client.ps1 call.
Connect-Keycloak

$priv = Join-Path $keyDir "$ClientId.key.pem"
$pub  = Join-Path $keyDir "$ClientId.pub.pem"

if (-not (Test-Path -LiteralPath $priv)) {
    Write-Host '== Generating RSA keypair (2048) =='
    $rsa = [System.Security.Cryptography.RSA]::Create(2048)
    Write-TextFileLf -Path $priv -Text (ConvertTo-Pem -Label 'RSA PRIVATE KEY' -Base64 ([Convert]::ToBase64String($rsa.ExportRSAPrivateKey())))
    Write-TextFileLf -Path $pub  -Text (ConvertTo-Pem -Label 'PUBLIC KEY'      -Base64 ([Convert]::ToBase64String($rsa.ExportSubjectPublicKeyInfo())))
} else {
    Write-Host "== Reusing existing keypair at $priv =="
    $rsa = Import-RsaPrivateKeyPem -Path $priv
    if (-not (Test-Path -LiteralPath $pub)) {
        Write-TextFileLf -Path $pub -Text (ConvertTo-Pem -Label 'PUBLIC KEY' -Base64 ([Convert]::ToBase64String($rsa.ExportSubjectPublicKeyInfo())))
    }
}

# Keycloak wants the public key as base64 DER (no PEM headers/newlines).
$pubDerB64 = [Convert]::ToBase64String($rsa.ExportSubjectPublicKeyInfo())

$jwtAttrs = @{
    'jwt.credential.public.key'        = $pubDerB64
    'token.endpoint.auth.signing.alg'  = 'RS256'
    'use.jwks.url'                     = 'false'
}

Write-Host "== Client: $ClientId (client-jwt / private_key_jwt) =="
$client = Get-KcClient -Realm $Realm -ClientId $ClientId
if (-not $client) {
    Invoke-Kc -Method Post -Path "/admin/realms/$Realm/clients" -Body @{
        clientId                = $ClientId
        publicClient            = $false
        standardFlowEnabled     = $false
        serviceAccountsEnabled  = $true
        clientAuthenticatorType = 'client-jwt'
        attributes              = $jwtAttrs
    } | Out-Null
    $client = Get-KcClient -Realm $Realm -ClientId $ClientId
    if (-not $client) { throw "Keycloak client $ClientId was not created" }
} else {
    Write-Host '  already exists - updating public key attribute'
    # Send back the full existing representation with the JWT attributes merged in,
    # so nothing else on the client is dropped by the update.
    $attrs = @{}
    if ($client.PSObject.Properties.Name -contains 'attributes' -and $client.attributes) {
        foreach ($p in $client.attributes.PSObject.Properties) { $attrs[$p.Name] = $p.Value }
    }
    foreach ($k in $jwtAttrs.Keys) { $attrs[$k] = $jwtAttrs[$k] }
    $client | Add-Member -NotePropertyName attributes -NotePropertyValue $attrs -Force
    Invoke-Kc -Method Put -Path "/admin/realms/$Realm/clients/$($client.id)" -Body $client | Out-Null
}

$sub = (Invoke-Kc -Path "/admin/realms/$Realm/clients/$($client.id)/service-account-user").id

Write-Host ''
Write-Host "Private key (keep this, don't commit): $priv"
Write-Host "Service-account sub (register as OpenHIM clientID): $sub"
Write-Host ''
Write-Host 'Register with OpenHIM:'
Write-Host "  docker exec -e HIP_CLIENT_SUB=$sub -e HIP_CLIENT_NAME=`"$ClientId`" mediator node dist/scripts/create-hip-client.js"
Write-Host ''
Write-Host 'Get a token:'
Write-Host "  pwsh -File .\keycloak\get-jwt-client-token.ps1 $ClientId"
