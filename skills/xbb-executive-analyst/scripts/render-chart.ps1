[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SpecPath,

    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$skillRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$projectRoot = Split-Path -Parent (Split-Path -Parent $skillRoot)
$renderer = Join-Path $projectRoot 'shared\xbb\render-chart.js'
$nodePath = (Get-Command node -ErrorAction Stop).Source
$resolvedSpec = [IO.Path]::GetFullPath($SpecPath)

foreach ($requiredFile in @($renderer, $resolvedSpec)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Required chart file is missing: $requiredFile"
    }
}

$chartRoot = Join-Path ([IO.Path]::GetTempPath()) 'Codex\xbb-executive-analyst\charts'
[IO.Directory]::CreateDirectory($chartRoot) | Out-Null
$chartRootResolved = [IO.Path]::GetFullPath($chartRoot).TrimEnd('\')
foreach ($file in Get-ChildItem -LiteralPath $chartRootResolved -File -Filter '*.svg' -ErrorAction SilentlyContinue) {
    $candidate = [IO.Path]::GetFullPath($file.FullName)
    if ($candidate.StartsWith($chartRootResolved + '\', [StringComparison]::OrdinalIgnoreCase) -and ([DateTime]::UtcNow - $file.LastWriteTimeUtc).TotalHours -ge 24) {
        [IO.File]::Delete($candidate)
    }
}

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $bytes = [IO.File]::ReadAllBytes($resolvedSpec)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $hash = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant().Substring(0, 10)
    } finally {
        $sha.Dispose()
        $bytes = $null
    }
    $resolvedOutput = Join-Path $chartRootResolved "chart-$([DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))-$hash.svg"
} else {
    $resolvedOutput = [IO.Path]::GetFullPath($OutputPath)
}

if ([IO.Path]::GetExtension($resolvedOutput) -ne '.svg') {
    throw 'Chart output must use the .svg extension.'
}

$messages = @(& $nodePath $renderer --spec $resolvedSpec --output $resolvedOutput 2>&1)
if ($LASTEXITCODE -ne 0 -or -not [IO.File]::Exists($resolvedOutput)) {
    throw "SVG chart rendering failed. $($messages -join ' ')"
}

Write-Output ([ordered]@{
    success = $true
    output = $resolvedOutput
    bytes = ([IO.FileInfo]::new($resolvedOutput)).Length
    retentionHours = 24
} | ConvertTo-Json -Compress)
