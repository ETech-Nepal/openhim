#Requires -Version 7.1
<#
.SYNOPSIS
  Windows port of keycloak/create-org.sh (no curl / jq needed).

.DESCRIPTION
  Create (or update) a facility Organization in HAPI.

  The NHFR code is the facility's business identity (Organization.identifier) and
  the value used as the OpenHIM clientID / Keycloak token sub. Organization.id
  stays a server-assigned UUID. This does a conditional update keyed on the NHFR
  identifier, so it is idempotent and enforces one Organization per NHFR code
  (HAPI returns 412 if two already match).

  Organizations are reference data: no JeMPI, no Health ID, no mediator - this
  talks straight to HAPI. Set FHIR_BASE_URL + ACCESS_TOKEN to go through OpenHIM.

  Usage:  pwsh -File .\keycloak\create-org.ps1 <nhfr-id> "<facility name>"
    e.g.  pwsh -File .\keycloak\create-org.ps1 3130400221 "Bharatpur Hospital"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)][string]$Nhfr,
    [Parameter(Mandatory, Position = 1)][string]$Name
)

$ErrorActionPreference = 'Stop'

$fhir    = ($(if ($env:FHIR_BASE_URL) { $env:FHIR_BASE_URL } else { 'http://localhost:8081/fhir' })).TrimEnd('/')
$nhfrSys = 'http://mohp.gov.np/fhir/NamingSystem/nhfr'

$org = @{
    resourceType = 'Organization'
    identifier   = @(@{
        use    = 'official'
        type   = @{ coding = @(@{ system = 'http://terminology.hl7.org/CodeSystem/v2-0203'; code = 'FI' }) }
        system = $nhfrSys
        value  = $Nhfr
    })
    active = $true
    name   = $Name
}

$headers = @{ Accept = 'application/fhir+json' }
if ($env:ACCESS_TOKEN) { $headers['Authorization'] = "Bearer $env:ACCESS_TOKEN" }

$uri = "$fhir/Organization?identifier=$([uri]::EscapeDataString("$nhfrSys|$Nhfr"))"

try {
    # -SkipCertificateCheck matches `curl -k` in the bash version (OpenHIM's self-signed cert).
    $resp = Invoke-WebRequest -Method Put -Uri $uri -Headers $headers -SkipCertificateCheck `
        -ContentType 'application/fhir+json' -Body ($org | ConvertTo-Json -Depth 10)
    $body = $resp.Content
} catch {
    $body = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
    try { $body | ConvertFrom-Json | ConvertTo-Json -Depth 30 } catch { $body }
    throw "PUT $uri failed"
}

try { $body | ConvertFrom-Json | ConvertTo-Json -Depth 30 } catch { $body }
