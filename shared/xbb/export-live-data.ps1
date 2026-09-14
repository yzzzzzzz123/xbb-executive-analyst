[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d{4}-(0[1-9]|1[0-2])$')]
    [string]$Month,

    [string]$Date,

    [string[]]$Domains = @('all'),

    [string[]]$Metrics,
    [string]$Company,
    [string]$Person,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath,

    # Operational-only process fencing token. It is never persisted in the
    # exported business payload and has no effect on query semantics.
    [ValidatePattern('^[a-f0-9]{64}$')]
    [string]$IsolationToken
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$sharedXbbRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$extractor = Join-Path $sharedXbbRoot 'export-live-data.js'
$credentialRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Codex\xbb-openapi'
$credentialPath = Join-Path $credentialRoot 'credentials.json'

foreach ($requiredFile in @($extractor, $credentialPath)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Required live-data file is missing: $requiredFile"
    }
}

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
$credential = Get-Content -LiteralPath $credentialPath -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($field in @('baseUrl', 'corpid', 'apiTokenDpapi')) {
    if ([string]::IsNullOrWhiteSpace([string]$credential.$field)) {
        throw "Saved credential field is missing: $field"
    }
}

$secureToken = ConvertTo-SecureString ([string]$credential.apiTokenDpapi)
$tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
try {
    $apiToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
}
if ([string]::IsNullOrWhiteSpace($apiToken)) {
    throw 'The saved API token could not be decrypted for the current Windows user.'
}

$previousBase = $env:XBB_API_BASE
$previousCorp = $env:XBB_CORPID
$previousToken = $env:XBB_API_TOKEN
try {
    $env:XBB_API_BASE = [string]$credential.baseUrl
    $env:XBB_CORPID = [string]$credential.corpid
    $env:XBB_API_TOKEN = $apiToken
    $extractorArguments = @($extractor, '--output', $resolvedOutput, '--request-stdin')
    if (-not [string]::IsNullOrWhiteSpace($IsolationToken)) {
        $extractorArguments += @('--isolation-token', $IsolationToken)
    }
    $extractScope = [ordered]@{ month = $Month; domains = @($Domains) }
    if (-not [string]::IsNullOrWhiteSpace($Date)) { $extractScope['date'] = $Date }
    if (@($Metrics).Count -gt 0) { $extractScope['metrics'] = @($Metrics) }
    if (-not [string]::IsNullOrWhiteSpace($Company)) { $extractScope['company'] = $Company }
    if (-not [string]::IsNullOrWhiteSpace($Person)) { $extractScope['person'] = $Person }
    $extractRequest = $extractScope | ConvertTo-Json -Depth 4 -Compress
    $previousOutputEncoding = $OutputEncoding
    try {
        $OutputEncoding = [Text.UTF8Encoding]::new($false)
        $extractRequest | & node @extractorArguments
    } finally {
        $OutputEncoding = $previousOutputEncoding
        $extractRequest = $null
    }
    if ($LASTEXITCODE -ne 0) {
        throw "Live XBB data export failed with exit code $LASTEXITCODE."
    }
} finally {
    if ($null -eq $previousBase) { Remove-Item Env:XBB_API_BASE -ErrorAction SilentlyContinue } else { $env:XBB_API_BASE = $previousBase }
    if ($null -eq $previousCorp) { Remove-Item Env:XBB_CORPID -ErrorAction SilentlyContinue } else { $env:XBB_CORPID = $previousCorp }
    if ($null -eq $previousToken) { Remove-Item Env:XBB_API_TOKEN -ErrorAction SilentlyContinue } else { $env:XBB_API_TOKEN = $previousToken }
    $apiToken = $null
    $secureToken = $null
    $tokenPointer = [IntPtr]::Zero
}
