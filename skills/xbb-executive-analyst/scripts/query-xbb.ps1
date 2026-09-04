[CmdletBinding()]
param(
    [string[]]$Month,

    [string[]]$Domains = @('all'),

    [string]$Company,

    [string]$Person,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath,

    [string]$ProgressPath,

    [switch]$ForceRefresh
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$maximumMonths = 120
$minimumMonth = '1900-01'
$performanceDataStartMonth = '2026-01'

function Get-ShanghaiMonth {
    $zone = [TimeZoneInfo]::FindSystemTimeZoneById('China Standard Time')
    return [TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::UtcNow, $zone).ToString('yyyy-MM')
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

function Write-ProgressEvent(
    [string]$Stage,
    [string]$SelectedMonth,
    [int]$Index = 0,
    [int]$Completed = 0,
    [int]$Total = 0,
    [string]$Source
) {
    if ([string]::IsNullOrWhiteSpace($script:resolvedProgress)) { return }
    $event = [ordered]@{ stage = $Stage }
    if (-not [string]::IsNullOrWhiteSpace($SelectedMonth)) { $event['month'] = $SelectedMonth }
    if ($Index -gt 0) { $event['index'] = $Index }
    if ($Completed -ge 0) { $event['completed'] = $Completed }
    if ($Total -gt 0) { $event['total'] = $Total }
    if (-not [string]::IsNullOrWhiteSpace($Source)) { $event['source'] = $Source }
    $line = ($event | ConvertTo-Json -Compress) + [Environment]::NewLine
    [IO.File]::AppendAllText($script:resolvedProgress, $line, [Text.UTF8Encoding]::new($false))
}

$skillRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$projectRoot = Split-Path -Parent (Split-Path -Parent $skillRoot)
$sharedXbbRoot = Join-Path $projectRoot 'shared\xbb'
$exporter = Join-Path $sharedXbbRoot 'export-live-data.ps1'
$builder = Join-Path $sharedXbbRoot 'build-fact-pack.js'
$aggregator = Join-Path $sharedXbbRoot 'aggregate-multi-period.js'
$nodePath = (Get-Command node -ErrorAction Stop).Source
$resolvedOutput = [IO.Path]::GetFullPath($OutputPath)
$script:resolvedProgress = if ([string]::IsNullOrWhiteSpace($ProgressPath)) { $null } else { [IO.Path]::GetFullPath($ProgressPath) }
if ($script:resolvedProgress -and $script:resolvedProgress.Equals($resolvedOutput, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'ProgressPath 不能与 OutputPath 相同。'
}
if ($script:resolvedProgress) { Write-AtomicText -Path $script:resolvedProgress -Text '' }

foreach ($requiredFile in @($exporter, $builder, $aggregator)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Required Skill file is missing: $requiredFile"
    }
}

$months = @($Month | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
if ($months.Count -eq 0) { $months = @(Get-ShanghaiMonth) }
$months = @($months | ForEach-Object { $_.Split(',') } | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -Unique)
$currentShanghaiMonth = Get-ShanghaiMonth
if ($months.Count -gt $maximumMonths) { throw "At most $maximumMonths months may be queried in one invocation." }
foreach ($value in $months) {
    if ($value -notmatch '^\d{4}-(0[1-9]|1[0-2])$') { throw "月份格式必须为 YYYY-MM：$value" }
    if ($value -lt $minimumMonth) { throw "月份不得早于 $minimumMonth：$value" }
    if ($value -gt $currentShanghaiMonth) { throw "月份不得晚于当前上海月份 $currentShanghaiMonth：$value" }
}

$domainList = @($Domains | ForEach-Object { ([string]$_).Split(',') } | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -Unique)
if ($domainList.Count -eq 0) { $domainList = @('all') }
$allowedDomains = @('all', 'performance', 'product-sales', 'courses', 'delivery', 'opportunities')
$invalidDomains = @($domainList | Where-Object { $_ -notin $allowedDomains })
if ($invalidDomains.Count -gt 0) { throw "不支持的数据域：$($invalidDomains -join ', ')" }
if ($domainList -contains 'all' -and $domainList.Count -ne 1) { throw 'all 不能与其他数据域同时使用。' }
$requiresOrderData = $domainList -contains 'all' -or $domainList -contains 'performance' -or $domainList -contains 'product-sales'
if ($requiresOrderData -and @($months | Where-Object { $_ -lt $performanceDataStartMonth }).Count -gt 0) {
    throw "业绩订单和 OPP 订单的已确认数据范围从 $performanceDataStartMonth 开始。"
}
$domainArgument = $domainList -join ','

$xbbCredentialPath = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Codex\xbb-openapi\credentials.json'
if (-not [IO.File]::Exists($xbbCredentialPath)) { throw "销帮帮凭据文件不存在：$xbbCredentialPath" }
$xbbCredentialIdentity = Get-Content -LiteralPath $xbbCredentialPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace([string]$xbbCredentialIdentity.baseUrl) -or [string]::IsNullOrWhiteSpace([string]$xbbCredentialIdentity.corpid)) {
    throw '销帮帮凭据缺少 baseUrl 或 corpid，无法隔离查询缓存。'
}
$tenantMaterial = ([string]$xbbCredentialIdentity.baseUrl).TrimEnd('/').ToLowerInvariant() + "`n" + ([string]$xbbCredentialIdentity.corpid)
$tenantHasher = [Security.Cryptography.SHA256]::Create()
try {
    $tenantFingerprint = (($tenantHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($tenantMaterial)) | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 20)
} finally {
    $tenantHasher.Dispose()
    $tenantMaterial = $null
    $xbbCredentialIdentity = $null
}

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
    Write-ProgressEvent -Stage 'run_started' -Completed 0 -Total $months.Count
    $monthIndex = 0
    foreach ($selectedMonth in $months) {
        $monthIndex += 1
        Write-ProgressEvent -Stage 'month_started' -SelectedMonth $selectedMonth -Index $monthIndex -Completed ($monthIndex - 1) -Total $months.Count
        $sourcePath = Join-Path $runDir "source-$selectedMonth.json"
        $factPath = Join-Path $runDir "facts-$selectedMonth.json"
        $cacheDomainKey = (($domainList | Sort-Object) -join '-') -replace '[^a-z-]', ''
        $cachePath = Join-Path $cacheRoot "source-v6-$tenantFingerprint-$cacheDomainKey-$selectedMonth.dpapi"
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
            $exportMessages = @(& $exporter -Month $selectedMonth -Domains $domainList -OutputPath $sourcePath)
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

        $readSource = if ($cacheHit) { 'encrypted-cache' } else { 'live' }
        Write-ProgressEvent -Stage 'source_ready' -SelectedMonth $selectedMonth -Index $monthIndex -Completed ($monthIndex - 1) -Total $months.Count -Source $readSource

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
        $readModes += [pscustomobject]@{ month = $selectedMonth; source = $readSource }
        [IO.File]::Delete($sourcePath)
        [IO.File]::Delete($factPath)
        Write-ProgressEvent -Stage 'month_completed' -SelectedMonth $selectedMonth -Index $monthIndex -Completed $monthIndex -Total $months.Count -Source $readSource
    }

    if ($periods.Count -eq 1) {
        $payload = $periods[0]
    } else {
        Write-ProgressEvent -Stage 'aggregate_started' -Completed $months.Count -Total $months.Count
        $aggregateInputPath = Join-Path $runDir 'aggregate-input.json'
        $aggregateOutputPath = Join-Path $runDir 'aggregate-output.json'
        $aggregateInput = [ordered]@{
            scope = [ordered]@{ months = $months; domains = $domainList; company = $Company; person = $Person }
            periods = @($periods)
        }
        Write-AtomicText -Path $aggregateInputPath -Text (($aggregateInput | ConvertTo-Json -Depth 100 -Compress) + [Environment]::NewLine)
        $aggregateMessages = @(& $nodePath $aggregator '--input' $aggregateInputPath '--output' $aggregateOutputPath 2>&1)
        if ($LASTEXITCODE -ne 0 -or -not [IO.File]::Exists($aggregateOutputPath)) {
            throw "Multi-period fact aggregation failed. $($aggregateMessages -join ' ')"
        }
        $payload = Get-Content -LiteralPath $aggregateOutputPath -Raw -Encoding UTF8 | ConvertFrom-Json
        Write-ProgressEvent -Stage 'aggregate_completed' -Completed $months.Count -Total $months.Count
    }

    $json = $payload | ConvertTo-Json -Depth 100 -Compress
    Write-AtomicText -Path $resolvedOutput -Text ($json + [Environment]::NewLine)
    Write-ProgressEvent -Stage 'output_ready' -Completed $months.Count -Total $months.Count
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
