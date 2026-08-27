#Requires -Version 7.1
<#
.SYNOPSIS
  Windows port of keycloak/get-jwt-client-token.sh (no openssl / jq needed).

.DESCRIPTION
  Get an access token for a private_key_jwt (client-jwt) client: builds a
  client_assertion JWT signed with the client's own private key (from
  create-jwt-client.ps1 or create-jwt-client.sh), then does the
  client_credentials grant. Prints the access token on stdout.

  Usage: pwsh -File .\keycloak\get-jwt-client-token.ps1 openhim-client
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)][string]$ClientId,
    [string]$Realm = 'openhie'
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\_common.ps1"

$tokenEp = "$script:KcUrl/realms/$Realm/protocol/openid-connect/token"
$priv    = Join-Path $PSScriptRoot "keys\$ClientId.key.pem"

if (-not (Test-Path -LiteralPath $priv)) {
    throw "No key at $priv - run create-jwt-client.ps1 first"
}

$rsa = Import-RsaPrivateKeyPem -Path $priv

$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$header  = ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes('{"alg":"RS256","typ":"JWT"}'))
$payload = ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes((@{
    iss = $ClientId
    sub = $ClientId
    aud = $tokenEp
    jti = [guid]::NewGuid().ToString('N')
    exp = $now + 60
    iat = $now
} | ConvertTo-Json -Compress)))

$signingInput = "$header.$payload"
$signature = ConvertTo-Base64Url ($rsa.SignData(
    [Text.Encoding]::ASCII.GetBytes($signingInput),
    [System.Security.Cryptography.HashAlgorithmName]::SHA256,
    [System.Security.Cryptography.RSASignaturePadding]::Pkcs1))
$assertion = "$signingInput.$signature"

try {
    $resp = Invoke-RestMethod -Method Post -Uri $tokenEp -ContentType 'application/x-www-form-urlencoded' -Body @{
        grant_type            = 'client_credentials'
        client_id             = $ClientId
        client_assertion_type = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
        client_assertion      = $assertion
    }
} catch {
    throw "Token request failed: $(Get-HttpErrorText $_)"
}

$resp.access_token
