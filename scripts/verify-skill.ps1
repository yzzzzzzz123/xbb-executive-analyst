[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$mainSkillRoot = Join-Path $projectRoot 'skills\xbb-executive-analyst'
$chartSkillRoot = Join-Path $projectRoot 'skills\xbb-executive-chart'
$skillRoots = @($mainSkillRoot, $chartSkillRoot)
$codexRoot = if ([string]::IsNullOrWhiteSpace([string]$env:CODEX_HOME)) { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex' } else { [IO.Path]::GetFullPath($env:CODEX_HOME) }
$validator = Join-Path $codexRoot 'skills\.system\skill-creator\scripts\quick_validate.py'
$nodePath = (Get-Command node -ErrorAction Stop).Source
$pyPath = (Get-Command py -ErrorAction Stop).Source

function Find-ProjectTextMatch(
    [string]$Pattern,
    [string[]]$Roots,
    [string[]]$ExcludedFileNames = @()
) {
    $textExtensions = @('.js', '.cjs', '.mjs', '.ts', '.json', '.md', '.ps1', '.py', '.yml', '.yaml', '.toml', '.txt', '.html')
    $files = foreach ($root in $Roots) {
        if (Test-Path -LiteralPath $root -PathType Leaf) {
            Get-Item -LiteralPath $root
        } elseif (Test-Path -LiteralPath $root -PathType Container) {
            Get-ChildItem -LiteralPath $root -File -Recurse -ErrorAction Stop
        }
    }
    foreach ($file in $files) {
        if ($file.Name -in $ExcludedFileNames) { continue }
        if ([IO.Path]::GetExtension($file.Name).ToLowerInvariant() -notin $textExtensions) { continue }
        $fullName = [IO.Path]::GetFullPath($file.FullName)
        if ($fullName.IndexOf('\node_modules\', [StringComparison]::OrdinalIgnoreCase) -ge 0) { continue }
        if ($fullName.IndexOf('\test-results\', [StringComparison]::OrdinalIgnoreCase) -ge 0) { continue }
        if ($fullName.IndexOf('\.git\', [StringComparison]::OrdinalIgnoreCase) -ge 0) { continue }
        foreach ($match in @(Select-String -LiteralPath $fullName -Pattern $Pattern -AllMatches -ErrorAction Stop)) {
            Write-Output "$fullName`:$($match.LineNumber):$($match.Line.Trim())"
        }
    }
}

foreach ($file in @(
    (Join-Path $mainSkillRoot 'SKILL.md'),
    (Join-Path $mainSkillRoot 'scripts\query-xbb.ps1'),
    (Join-Path $chartSkillRoot 'SKILL.md'),
    (Join-Path $chartSkillRoot 'references\chart-contract.md'),
    (Join-Path $chartSkillRoot 'scripts\chart-contract.js'),
    (Join-Path $projectRoot 'shared\xbb\export-live-data.js'),
    (Join-Path $projectRoot 'shared\xbb\build-fact-pack.js'),
    (Join-Path $projectRoot 'shared\xbb\render-chart.js'),
    (Join-Path $projectRoot 'shared\wecom\server.js'),
    (Join-Path $projectRoot 'shared\codex\persistent-agent.js'),
    (Join-Path $projectRoot 'scripts\smoke-codex-app-server.js'),
    (Join-Path $projectRoot 'tests\verify-facts.js'),
    (Join-Path $projectRoot 'tests\verify-codex-app-server.js'),
    (Join-Path $projectRoot 'tests\verify-wecom-long-connection.js'),
    $validator
)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Required verification file is missing: $file" }
}

$javascriptFiles = @(
    Get-ChildItem -LiteralPath (Join-Path $projectRoot 'shared') -Filter '*.js' -File -Recurse
    Get-ChildItem -LiteralPath (Join-Path $projectRoot 'scripts') -Filter '*.js' -File -Recurse
    Get-ChildItem -LiteralPath (Join-Path $projectRoot 'skills') -Filter '*.js' -File -Recurse
    Get-ChildItem -LiteralPath (Join-Path $projectRoot 'tests') -Filter '*.js' -File -Recurse
)
foreach ($file in $javascriptFiles) {
    & $nodePath --check $file.FullName
    if ($LASTEXITCODE -ne 0) { throw "Node syntax check failed: $($file.FullName)" }
}

$powershellFiles = @(
    Get-ChildItem -LiteralPath (Join-Path $projectRoot 'scripts') -Filter '*.ps1' -File -Recurse
    Get-ChildItem -LiteralPath (Join-Path $projectRoot 'shared') -Filter '*.ps1' -File -Recurse
    Get-ChildItem -LiteralPath (Join-Path $projectRoot 'skills') -Filter '*.ps1' -File -Recurse
)
foreach ($file in $powershellFiles) {
    $parseTokens = $null
    $parseErrors = $null
    $source = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8
    [void][Management.Automation.Language.Parser]::ParseInput($source, $file.FullName, [ref]$parseTokens, [ref]$parseErrors)
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
    foreach ($skillRoot in $skillRoots) {
        & $pyPath -3 $validator $skillRoot
        if ($LASTEXITCODE -ne 0) { throw "Skill quick validation failed: $skillRoot" }
    }
} finally {
    if ($null -eq $previousPythonUtf8) { Remove-Item Env:PYTHONUTF8 -ErrorAction SilentlyContinue } else { $env:PYTHONUTF8 = $previousPythonUtf8 }
}

$htmlFiles = @(
    Get-ChildItem -LiteralPath (Join-Path $projectRoot 'skills') -Filter '*.html' -File -Recurse -ErrorAction SilentlyContinue
    Get-ChildItem -LiteralPath (Join-Path $projectRoot 'shared') -Filter '*.html' -File -Recurse -ErrorAction SilentlyContinue
)
if ($htmlFiles.Count -ne 0) { throw "HTML is forbidden in the formal Skill/runtime: $($htmlFiles.FullName -join ', ')" }

$forbiddenRuntime = @(Find-ProjectTextMatch -Pattern 'serve-published|publish-codex-analysis|xbb-visual-shell|销帮帮经营分析-老板驾驶舱Demo' -Roots @($projectRoot) -ExcludedFileNames @('verify-skill.ps1'))
if ($forbiddenRuntime.Count -gt 0) { throw "Legacy Demo runtime remains: $($forbiddenRuntime -join [Environment]::NewLine)" }

$legacyAgentFiles = @(Get-ChildItem -LiteralPath (Join-Path $projectRoot 'shared\agent') -File -ErrorAction SilentlyContinue)
if ($legacyAgentFiles.Count -ne 0) { throw "Legacy shared/agent files remain: $($legacyAgentFiles.FullName -join ', ')" }
$forbiddenModelLoop = @(Find-ProjectTextMatch -Pattern 'createCodexCliClient|createChatCompletionsClient|"exec",\s*"--ephemeral"|modelProvider\s*===\s*"chat-completions"' -Roots @((Join-Path $projectRoot 'shared'), (Join-Path $projectRoot 'package.json')))
if ($forbiddenModelLoop.Count -gt 0) { throw "Legacy model loop remains: $($forbiddenModelLoop -join [Environment]::NewLine)" }

Write-Output ([ordered]@{
    success = $true
    skills = @('xbb-executive-analyst', 'xbb-executive-chart')
    htmlFiles = 0
    projectTests = 'passed'
    quickValidate = 'passed'
    javascriptFiles = $javascriptFiles.Count
    powershellFiles = $powershellFiles.Count
} | ConvertTo-Json -Compress)
