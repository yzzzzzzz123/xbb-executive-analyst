[CmdletBinding()]
param(
    [string[]]$Month,

    [string[]]$Domains = @('all'),

    [string]$Company,

    [string]$Person,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath,

    [switch]$ForceRefresh
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-ShanghaiMonth {
    $zone = [TimeZoneInfo]::FindSystemTimeZoneById('China Standard Time')
    return [TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::UtcNow, $zone).ToString('yyyy-MM')
}

function Get-Sha256([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Write-AtomicBytes([string]$Path, [byte[]]$Bytes) {
    $resolved = [IO.Path]::GetFullPath($Path)
    $parent = [IO.Path]::GetDirectoryName($resolved)
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    $temporary = "$resolved.tmp-$PID-$([DateTime]::UtcNow.Ticks)"
    [IO.File]::WriteAllBytes($temporary, $Bytes)
    $backup = "$resolved.bak-$PID-$([DateTime]::UtcNow.Ticks)"
    try {
        if ([IO.File]::Exists($resolved)) {
            [IO.File]::Replace($temporary, $resolved, $backup)
        } else {
            [IO.File]::Move($temporary, $resolved)
        }
    } finally {
        if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
        if ([IO.File]::Exists($backup)) { [IO.File]::Delete($backup) }
    }
}

function Write-AtomicText([string]$Path, [string]$Text) {
    Write-AtomicBytes -Path $Path -Bytes ([Text.UTF8Encoding]::new($false).GetBytes($Text))
}

$skillRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$projectRoot = Split-Path -Parent (Split-Path -Parent $skillRoot)
$sharedXbbRoot = Join-Path $projectRoot 'shared\xbb'
$exporter = Join-Path $sharedXbbRoot 'export-live-data.ps1'
$builder = Join-Path $sharedXbbRoot 'build-fact-pack.js'
$nodePath = (Get-Command node -ErrorAction Stop).Source
$resolvedOutput = [IO.Path]::GetFullPath($OutputPath)

foreach ($requiredFile in @($exporter, $builder)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Required Skill file is missing: $requiredFile"
    }
}

$months = @($Month | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
if ($months.Count -eq 0) { $months = @(Get-ShanghaiMonth) }
$months = @($months | ForEach-Object { $_.Split(',') } | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -Unique)
if ($months.Count -gt 12) { throw 'At most 12 months may be queried in one invocation.' }
foreach ($value in $months) {
    if ($value -notmatch '^\d{4}-(0[1-9]|1[0-2])$') { throw "月份格式必须为 YYYY-MM：$value" }
}

$domainList = @($Domains | ForEach-Object { ([string]$_).Split(',') } | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -Unique)
if ($domainList.Count -eq 0) { $domainList = @('all') }
$domainArgument = $domainList -join ','

$localRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Codex\xbb-executive-analyst'
$cacheRoot = Join-Path $localRoot 'cache'
$runRoot = Join-Path ([IO.Path]::GetTempPath()) 'Codex\xbb-executive-analyst\runs'
[IO.Directory]::CreateDirectory($cacheRoot) | Out-Null
[IO.Directory]::CreateDirectory($runRoot) | Out-Null

$cacheRootResolved = [IO.Path]::GetFullPath($cacheRoot).TrimEnd('\')
foreach ($file in Get-ChildItem -LiteralPath $cacheRootResolved -File -Filter '*.dpapi' -ErrorAction SilentlyContinue) {
    $candidate = [IO.Path]::GetFullPath($file.FullName)
    if ($candidate.StartsWith($cacheRootResolved + '\', [StringComparison]::OrdinalIgnoreCase) -and ([DateTime]::UtcNow - $file.LastWriteTimeUtc).TotalHours -ge 24) {
        [IO.File]::Delete($candidate)
    }
}

[void][Reflection.Assembly]::LoadWithPartialName('System.Security')
$entropy = [Text.UTF8Encoding]::new($false).GetBytes('xbb-executive-analyst-cache-v1')
$runId = "run-$PID-$([DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff'))-$([Guid]::NewGuid().ToString('N').Substring(0,8))"
$runDir = Join-Path $runRoot $runId
[IO.Directory]::CreateDirectory($runDir) | Out-Null
$periods = @()
$readModes = @()

try {
    foreach ($selectedMonth in $months) {
        $sourcePath = Join-Path $runDir "source-$selectedMonth.json"
        $factPath = Join-Path $runDir "facts-$selectedMonth.json"
        $cachePath = Join-Path $cacheRoot "source-v3-$selectedMonth.dpapi"
        $cacheHit = $false

        if (-not $ForceRefresh -and [IO.File]::Exists($cachePath)) {
            $cacheItem = Get-Item -LiteralPath $cachePath
            if (([DateTime]::UtcNow - $cacheItem.LastWriteTimeUtc).TotalMinutes -lt 5) {
                try {
                    $protected = [IO.File]::ReadAllBytes($cachePath)
                    $plain = [Security.Cryptography.ProtectedData]::Unprotect(
                        $protected,
                        $entropy,
                        [Security.Cryptography.DataProtectionScope]::CurrentUser
                    )
                    [IO.File]::WriteAllBytes($sourcePath, $plain)
                    $cacheHit = $true
                } catch {
                    $cacheHit = $false
                    if ([IO.File]::Exists($sourcePath)) { [IO.File]::Delete($sourcePath) }
                    if ([IO.File]::Exists($cachePath)) { [IO.File]::Delete($cachePath) }
                } finally {
                    $plain = $null
                    $protected = $null
                }
            }
        }

        if (-not $cacheHit) {
            $exportMessages = @(& $exporter -Month $selectedMonth -OutputPath $sourcePath)
            if (-not [IO.File]::Exists($sourcePath)) {
                throw "Live XBB export did not create the source bundle for $selectedMonth. $($exportMessages -join ' ')"
            }
            $plain = [IO.File]::ReadAllBytes($sourcePath)
            try {
                $protected = [Security.Cryptography.ProtectedData]::Protect(
                    $plain,
                    $entropy,
                    [Security.Cryptography.DataProtectionScope]::CurrentUser
                )
                Write-AtomicBytes -Path $cachePath -Bytes $protected
            } finally {
                $plain = $null
                $protected = $null
            }
        }

        $arguments = @($builder, '--source', $sourcePath, '--output', $factPath, '--domains', $domainArgument)
        if (-not [string]::IsNullOrWhiteSpace($Company)) { $arguments += @('--company', $Company) }
        if (-not [string]::IsNullOrWhiteSpace($Person)) { $arguments += @('--person', $Person) }
        $builderOutput = @(& $nodePath @arguments 2>&1)
        if ($LASTEXITCODE -ne 0 -or -not [IO.File]::Exists($factPath)) {
            throw "Fact-pack build failed for $selectedMonth. $($builderOutput -join ' ')"
        }
        $period = Get-Content -LiteralPath $factPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $period | Add-Member -NotePropertyName cache -NotePropertyValue ([pscustomobject]@{
            source = if ($cacheHit) { 'encrypted-cache' } else { 'live' }
            ttlMinutes = 5
            cacheEncrypted = $true
        }) -Force
        $periods += $period
        $readModes += [pscustomobject]@{ month = $selectedMonth; source = if ($cacheHit) { 'encrypted-cache' } else { 'live' } }
        [IO.File]::Delete($sourcePath)
        [IO.File]::Delete($factPath)
    }

    if ($periods.Count -eq 1) {
        $payload = $periods[0]
    } else {
        $overallStatus = if (@($periods | Where-Object { $_.status -ne 'ready' }).Count -gt 0) { 'needs_disambiguation' } else { 'ready' }
        $payload = [ordered]@{
            schemaVersion = '1.0'
            skill = 'xbb-executive-analyst'
            mode = 'xbb-live-readonly-multi-period-fact-pack'
            status = $overallStatus
            scope = [ordered]@{ months = $months; domains = $domainList; company = $Company; person = $Person }
            periods = $periods
            limitations = @('跨月事实按各自然月独立取数和计算；不得把不同月份记录直接去重为单月指标。')
        }
        $canonical = $payload | ConvertTo-Json -Depth 100 -Compress
        $multiPeriodHash = Get-Sha256 -Bytes ([Text.UTF8Encoding]::new($false).GetBytes($canonical))
        $payload['integrity'] = [ordered]@{ algorithm = 'sha256'; factPackSha256 = $multiPeriodHash }
    }

    $json = $payload | ConvertTo-Json -Depth 100 -Compress
    Write-AtomicText -Path $resolvedOutput -Text ($json + [Environment]::NewLine)
    $resultStatus = if ($periods.Count -eq 1) { [string]$periods[0].status } else { [string]$payload.status }
    Write-Output ([ordered]@{
        success = $true
        status = $resultStatus
        months = $months
        domains = $domainList
        source = $readModes
        output = $resolvedOutput
        bytes = ([Text.UTF8Encoding]::new($false).GetByteCount($json))
    } | ConvertTo-Json -Depth 10 -Compress)
} finally {
    if ([IO.Directory]::Exists($runDir)) { [IO.Directory]::Delete($runDir, $true) }
    $entropy = $null
}
