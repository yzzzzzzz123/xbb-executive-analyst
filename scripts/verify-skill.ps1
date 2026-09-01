[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$skillRoot = Join-Path $projectRoot 'skills\xbb-executive-analyst'
$codexRoot = if ([string]::IsNullOrWhiteSpace([string]$env:CODEX_HOME)) { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex' } else { [IO.Path]::GetFullPath($env:CODEX_HOME) }
$validator = Join-Path $codexRoot 'skills\.system\skill-creator\scripts\quick_validate.py'
$nodePath = (Get-Command node -ErrorAction Stop).Source
$pyPath = (Get-Command py -ErrorAction Stop).Source

foreach ($file in @(
    (Join-Path $skillRoot 'SKILL.md'),
    (Join-Path $skillRoot 'scripts\query-xbb.ps1'),
    (Join-Path $projectRoot 'shared\xbb\export-live-data.js'),
    (Join-Path $projectRoot 'shared\xbb\build-fact-pack.js'),
    (Join-Path $projectRoot 'shared\xbb\render-chart.js'),
    (Join-Path $projectRoot 'shared\wecom\server.js'),
    (Join-Path $projectRoot 'tests\verify-facts.js'),
    (Join-Path $projectRoot 'tests\verify-wecom-callback.js'),
    $validator
)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Required verification file is missing: $file" }
}

$javascriptFiles = @(
    Get-ChildItem -LiteralPath (Join-Path $projectRoot 'shared') -Filter '*.js' -File -Recurse
    Get-ChildItem -LiteralPath (Join-Path $projectRoot 'tests') -Filter '*.js' -File -Recurse
)
foreach ($file in $javascriptFiles) {
    & $nodePath --check $file.FullName
    if ($LASTEXITCODE -ne 0) { throw "Node syntax check failed: $($file.FullName)" }
}

$powershellFiles = @(
    Get-ChildItem -LiteralPath (Join-Path $projectRoot 'scripts') -Filter '*.ps1' -File -Recurse
    Get-ChildItem -LiteralPath (Join-Path $projectRoot 'shared') -Filter '*.ps1' -File -Recurse
    Get-ChildItem -LiteralPath (Join-Path $skillRoot 'scripts') -Filter '*.ps1' -File -Recurse
)
foreach ($file in $powershellFiles) {
    $parseTokens = $null
    $parseErrors = $null
    [void][Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$parseTokens, [ref]$parseErrors)
    if (@($parseErrors).Count -gt 0) { throw "PowerShell syntax check failed: $($file.FullName) - $($parseErrors -join '; ')" }
}

Push-Location $projectRoot
try {
    & npm.cmd test
    if ($LASTEXITCODE -ne 0) { throw 'Project tests failed.' }
} finally {
    Pop-Location
}

$previousPythonUtf8 = $env:PYTHONUTF8
try {
    $env:PYTHONUTF8 = '1'
    & $pyPath -3 $validator $skillRoot
    if ($LASTEXITCODE -ne 0) { throw 'Skill quick validation failed.' }
} finally {
    if ($null -eq $previousPythonUtf8) { Remove-Item Env:PYTHONUTF8 -ErrorAction SilentlyContinue } else { $env:PYTHONUTF8 = $previousPythonUtf8 }
}

$htmlFiles = @(
    Get-ChildItem -LiteralPath $skillRoot -Filter '*.html' -File -Recurse -ErrorAction SilentlyContinue
    Get-ChildItem -LiteralPath (Join-Path $projectRoot 'shared') -Filter '*.html' -File -Recurse -ErrorAction SilentlyContinue
)
if ($htmlFiles.Count -ne 0) { throw "HTML is forbidden in the formal Skill/runtime: $($htmlFiles.FullName -join ', ')" }

$forbiddenRuntime = & rg -n --glob '!node_modules/**' --glob '!test-results/**' --glob '!verify-skill.ps1' 'serve-published|publish-codex-analysis|xbb-visual-shell|销帮帮经营分析-老板驾驶舱Demo' $projectRoot 2>$null
if ($LASTEXITCODE -eq 0 -and $forbiddenRuntime) { throw "Legacy Demo runtime remains: $($forbiddenRuntime -join [Environment]::NewLine)" }
if ($LASTEXITCODE -notin @(0, 1)) { throw 'Legacy runtime scan failed.' }

Write-Output ([ordered]@{
    success = $true
    skill = 'xbb-executive-analyst'
    htmlFiles = 0
    projectTests = 'passed'
    quickValidate = 'passed'
    javascriptFiles = $javascriptFiles.Count
    powershellFiles = $powershellFiles.Count
} | ConvertTo-Json -Compress)
