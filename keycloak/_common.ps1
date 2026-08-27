#Requires -Version 7.1
# Shared helpers for the Windows (PowerShell) ports of the keycloak/*.sh scripts.
# Dot-source this, don't run it:  . "$PSScriptRoot\_common.ps1"
#
# The bash scripts shell out to jq / openssl / python3 / fold / base64 and to
# `docker exec keycloak kcadm.sh`. None of those are on a stock Windows box, so
# these helpers talk to the Keycloak Admin REST API over the published host port
# and do all crypto with .NET (System.Security.Cryptography).

Set-StrictMode -Version Latest

# Host port for Keycloak — docker-compose publishes 127.0.0.1:8083 -> 8080.
$script:KcUrl   = ($(if ($env:KEYCLOAK_URL) { $env:KEYCLOAK_URL } else { 'http://localhost:8083' })).TrimEnd('/')
$script:KcUser  = if ($env:KEYCLOAK_ADMIN_USER) { $env:KEYCLOAK_ADMIN_USER } else { 'admin' }
$script:KcPass  = if ($env:KEYCLOAK_ADMIN_PASSWORD) { $env:KEYCLOAK_ADMIN_PASSWORD } else { 'admin' }
$script:KcToken = $null

function Wait-Keycloak {
    param([int]$TimeoutSeconds = 180)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ($true) {
        try {
            Invoke-RestMethod -Method Get -Uri "$script:KcUrl/realms/master" -TimeoutSec 5 | Out-Null
            return
        } catch {
            if ((Get-Date) -gt $deadline) {
                throw "Keycloak did not become reachable at $script:KcUrl within ${TimeoutSeconds}s"
            }
            Start-Sleep -Seconds 2
        }
    }
}

# Admin sessions are short-lived; every script calls this on each run rather
# than assuming a session left over from an earlier one.
function Connect-Keycloak {
    $body = @{
        grant_type = 'password'
        client_id  = 'admin-cli'
        username   = $script:KcUser
        password   = $script:KcPass
    }
    try {
        $script:KcToken = (Invoke-RestMethod -Method Post -ContentType 'application/x-www-form-urlencoded' `
            -Uri "$script:KcUrl/realms/master/protocol/openid-connect/token" -Body $body).access_token
    } catch {
        throw "Keycloak admin login failed at $script:KcUrl as '$script:KcUser': $(Get-HttpErrorText $_)"
    }
}

function Get-HttpErrorText($ErrorRecord) {
    if ($ErrorRecord.ErrorDetails -and $ErrorRecord.ErrorDetails.Message) { return $ErrorRecord.ErrorDetails.Message }
    return $ErrorRecord.Exception.Message
}

# Admin REST call. $Path is relative to the server root, e.g. /admin/realms/openhie.
# -AllowNotFound turns a 404 into $null (used for "does this exist?" probes).
function Invoke-Kc {
    param(
        [string]$Method = 'GET',
        [Parameter(Mandatory)][string]$Path,
        $Body,
        [switch]$AllowNotFound
    )
    if (-not $script:KcToken) { Connect-Keycloak }
    $params = @{
        Method                  = $Method
        Uri                     = "$script:KcUrl$Path"
        Headers                 = @{ Authorization = "Bearer $script:KcToken" }
        MaximumRedirection      = 0
        SkipHttpErrorCheck      = $false
    }
    if ($null -ne $Body) {
        $params.ContentType = 'application/json'
        $params.Body        = ($Body | ConvertTo-Json -Depth 20 -Compress)
    }
    try {
        return Invoke-RestMethod @params
    } catch {
        $status = $null
        if ($_.Exception.PSObject.Properties.Name -contains 'Response' -and $_.Exception.Response) {
            $status = [int]$_.Exception.Response.StatusCode
        }
        if ($AllowNotFound -and $status -eq 404) { return $null }
        throw "$Method $Path failed ($status): $(Get-HttpErrorText $_)"
    }
}

function Get-KcRealm {
    param([Parameter(Mandatory)][string]$Realm)
    Invoke-Kc -Path "/admin/realms/$Realm" -AllowNotFound
}

function Get-KcClient {
    param([Parameter(Mandatory)][string]$Realm, [Parameter(Mandatory)][string]$ClientId)
    $hits = Invoke-Kc -Path "/admin/realms/$Realm/clients?clientId=$([uri]::EscapeDataString($ClientId))"
    if ($hits) { return @($hits)[0] }
    return $null
}

function Get-KcUser {
    param([Parameter(Mandatory)][string]$Realm, [Parameter(Mandatory)][string]$Username)
    $hits = Invoke-Kc -Path "/admin/realms/$Realm/users?exact=true&username=$([uri]::EscapeDataString($Username))"
    if ($hits) { return @($hits)[0] }
    return $null
}

# ---- crypto / encoding helpers (replace openssl, base64 -w0, fold, python3) ----

function ConvertTo-Base64Url {
    param([Parameter(Mandatory)][byte[]]$Bytes)
    [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function ConvertFrom-Base64Url {
    param([Parameter(Mandatory)][string]$Text)
    $s = $Text.Replace('-', '+').Replace('_', '/')
    switch ($s.Length % 4) { 2 { $s += '==' } 3 { $s += '=' } }
    [Convert]::FromBase64String($s)
}

# base64 wrapped at 64 columns between PEM armour — same shape as `openssl ... -out`.
function ConvertTo-Pem {
    param([Parameter(Mandatory)][string]$Label, [Parameter(Mandatory)][string]$Base64)
    $lines = for ($i = 0; $i -lt $Base64.Length; $i += 64) {
        $Base64.Substring($i, [Math]::Min(64, $Base64.Length - $i))
    }
    (@("-----BEGIN $Label-----") + $lines + @("-----END $Label-----", '')) -join "`n"
}

# Always LF + no BOM: these PEMs are read by openssl/node inside Linux containers.
function Write-TextFileLf {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Text)
    [IO.File]::WriteAllText($Path, ($Text -replace "`r`n", "`n"), [Text.UTF8Encoding]::new($false))
}

function Import-RsaPrivateKeyPem {
    param([Parameter(Mandatory)][string]$Path)
    $rsa = [System.Security.Cryptography.RSA]::Create()
    # ImportFromPem handles both PKCS#1 (openssl genrsa) and PKCS#8 (openssl 3 default).
    $rsa.ImportFromPem((Get-Content -Raw -Path $Path))
    $rsa
}

# Read the `sub` claim out of a JWT (replaces the python3 one-liner).
function Get-JwtClaim {
    param([Parameter(Mandatory)][string]$Jwt, [string]$Claim = 'sub')
    $payload = $Jwt.Trim().Split('.')[1]
    $json = [Text.Encoding]::UTF8.GetString((ConvertFrom-Base64Url $payload)) | ConvertFrom-Json
    if ($json.PSObject.Properties.Name -contains $Claim) { return $json.$Claim }
    return $null
}
