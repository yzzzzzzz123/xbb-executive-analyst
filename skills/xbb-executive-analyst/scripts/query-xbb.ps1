[CmdletBinding()]
param(
    [string[]]$Month,

    [string]$Date,

    [string[]]$Domains = @('all'),

    [string[]]$Metrics,

    [string]$Company,

    [string]$Person,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath,

    [string]$ProgressPath,

    [ValidatePattern('^[a-f0-9]{64}$')]
    [string]$IsolationToken,

    [string]$IsolationMarkerPath,

    # The service gateway supplies business scope over the already-created
    # process stdin so month/company/person values never appear in a process
    # command line. Direct/manual callers may continue using the legacy
    # parameters above.
    [switch]$RequestFromStdin,

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

function Test-CanonicalWindowsPath([string]$Value, [switch]$Directory) {
    if ([string]::IsNullOrWhiteSpace($Value) -or
        -not [regex]::IsMatch($Value, '^(?:[A-Za-z]:\\|\\\\[^\\/]+\\[^\\/]+(?:\\|$))')) { return $false }
    try {
        $full = [IO.Path]::GetFullPath($Value)
        $input = $Value
        if ($Directory) { $full = $full.TrimEnd('\'); $input = $input.TrimEnd('\') }
        return $full.Equals($input, [StringComparison]::OrdinalIgnoreCase)
    } catch {
        return $false
    }
}

function ConvertTo-ProcessCreationIdentity($Value) {
    try {
        $date = if ($Value -is [DateTime]) {
            [DateTime]$Value
        } elseif ([string]$Value -match '^\d{14}\.\d{6}[+-]\d{3}$') {
            [Management.ManagementDateTimeConverter]::ToDateTime([string]$Value)
        } else {
            [DateTime]::Parse([string]$Value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal)
        }
        $utc = $date.ToUniversalTime()
        return [pscustomobject]@{
            CreatedAtMs = [DateTimeOffset]::new($utc).ToUnixTimeMilliseconds()
            CreationToken = $utc.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
        }
    } catch {
        return $null
    }
}

function Bind-RunnerIsolationRoot(
    [string]$MarkerPath,
    [string]$Token,
    [string]$ExpectedProjectRoot,
    [string]$ExpectedQueryScript,
    [string[]]$ExpectedChildScripts,
    [string]$ExpectedOutputPath
) {
    $resolvedMarker = [IO.Path]::GetFullPath($MarkerPath)
    if ([IO.Path]::GetFileName($resolvedMarker) -cne "$Token.json" -or -not [IO.File]::Exists($resolvedMarker)) {
        throw 'Runner isolation marker path is invalid.'
    }
    $marker = Get-Content -LiteralPath $resolvedMarker -Raw -Encoding UTF8 | ConvertFrom-Json
    $expectedProperties = @('childScriptPaths', 'createdAtMs', 'gatewayWorkDirectory', 'projectRoot', 'queryScriptPath', 'rootProcess', 'runRoot', 'schemaVersion', 'service', 'token')
    $actualProperties = @($marker.PSObject.Properties.Name | Sort-Object)
    $markerChildren = @($marker.childScriptPaths)
    if (($actualProperties -join "`n") -cne ($expectedProperties -join "`n") -or
        [string]$marker.schemaVersion -cne '2.0' -or
        [string]$marker.service -cne 'xbb-executive-analyst-runner' -or
        [string]$marker.token -cne $Token -or
        -not (Test-CanonicalWindowsPath ([string]$marker.projectRoot) -Directory) -or
        -not (Test-CanonicalWindowsPath ([string]$marker.queryScriptPath)) -or
        -not (Test-CanonicalWindowsPath ([string]$marker.gatewayWorkDirectory) -Directory) -or
        -not (Test-CanonicalWindowsPath ([string]$marker.runRoot) -Directory) -or
        -not ([IO.Path]::GetFullPath([string]$marker.projectRoot).Equals([IO.Path]::GetFullPath($ExpectedProjectRoot), [StringComparison]::OrdinalIgnoreCase)) -or
        -not ([IO.Path]::GetFullPath([string]$marker.queryScriptPath).Equals([IO.Path]::GetFullPath($ExpectedQueryScript), [StringComparison]::OrdinalIgnoreCase)) -or
        $markerChildren.Count -ne $ExpectedChildScripts.Count) {
        throw 'Runner isolation marker contract is invalid.'
    }
    for ($index = 0; $index -lt $ExpectedChildScripts.Count; $index += 1) {
        if (-not (Test-CanonicalWindowsPath ([string]$markerChildren[$index])) -or
            -not ([IO.Path]::GetFullPath([string]$markerChildren[$index]).Equals([IO.Path]::GetFullPath($ExpectedChildScripts[$index]), [StringComparison]::OrdinalIgnoreCase))) {
            throw 'Runner isolation child-script layout is invalid.'
        }
    }
    if ($null -ne $marker.rootProcess) { throw 'Runner isolation root was already bound.' }

    $expectedRunRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) 'Codex\xbb-executive-analyst\runs')).TrimEnd('\')
    $gatewayWorkRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) 'Codex\xbb-executive-analyst\bot-runs')).TrimEnd('\')
    $gatewayWorkDirectory = [IO.Path]::GetFullPath([string]$marker.gatewayWorkDirectory).TrimEnd('\')
    if (-not [IO.Path]::GetFullPath([string]$marker.runRoot).TrimEnd('\').Equals($expectedRunRoot, [StringComparison]::OrdinalIgnoreCase) -or
        -not [IO.Path]::GetDirectoryName($gatewayWorkDirectory).Equals($gatewayWorkRoot, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($gatewayWorkDirectory) -cnotmatch '^request-[A-Za-z0-9_-]{6,64}$' -or
        -not [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($ExpectedOutputPath)).Equals($gatewayWorkDirectory, [StringComparison]::OrdinalIgnoreCase) -or
        -not [IO.Directory]::Exists($gatewayWorkDirectory)) {
        throw 'Runner isolation temporary-directory layout is invalid.'
    }

    $selfRows = @(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $PID" -ErrorAction Stop)
    if ($selfRows.Count -ne 1) { throw 'Runner root CIM identity is unavailable.' }
    $self = $selfRows[0]
    $name = [string]$self.Name
    $executablePath = [string]$self.ExecutablePath
    $commandLine = [string]$self.CommandLine
    $creation = ConvertTo-ProcessCreationIdentity $self.CreationDate
    $nowAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    try { $markerCreatedAtMs = [int64]$marker.createdAtMs } catch { throw 'Runner isolation marker timestamp is invalid.' }
    if ($markerCreatedAtMs -le 0 -or $markerCreatedAtMs -gt ($nowAtMs + 5000)) { throw 'Runner isolation marker timestamp is invalid.' }
    if ($name -inotmatch '^(?:powershell|pwsh)\.exe$' -or
        [string]::IsNullOrWhiteSpace($executablePath) -or -not [IO.Path]::IsPathRooted($executablePath) -or
        -not [IO.Path]::GetFileName($executablePath).Equals($name, [StringComparison]::OrdinalIgnoreCase) -or
        [string]::IsNullOrWhiteSpace($commandLine) -or
        $null -eq $creation -or $creation.CreatedAtMs -gt ($nowAtMs + 5000)) {
        throw 'Runner root process identity cannot be safely bound.'
    }
    try {
        $invocation = ConvertTo-XbbStrictPowerShellInvocation `
            -CommandLine $commandLine `
            -ExpectedExecutablePath $executablePath `
            -ExpectedProcessName $name `
            -ExpectedScriptPath $ExpectedQueryScript `
            -AllowedValueParameters @('-OutputPath', '-ProgressPath', '-IsolationToken', '-IsolationMarkerPath') `
            -RequiredValueParameters @('-OutputPath', '-IsolationToken', '-IsolationMarkerPath') `
            -AllowedSwitchParameters @('-RequestFromStdin') `
            -RequiredSwitchParameters @('-RequestFromStdin')
    } catch { throw 'Runner root command line cannot be safely verified.' }
    $progressArgument = [string]$invocation.Values['-ProgressPath']
    if ([string]$invocation.Values['-IsolationToken'] -cne $Token -or
        -not (Test-XbbCanonicalCommandPath ([string]$invocation.Values['-IsolationMarkerPath']) $resolvedMarker) -or
        -not (Test-XbbCanonicalCommandPath ([string]$invocation.Values['-OutputPath']) $ExpectedOutputPath) -or
        (-not [string]::IsNullOrWhiteSpace($progressArgument) -and
            (-not (Test-CanonicalWindowsPath $progressArgument) -or
             -not [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($progressArgument)).Equals($gatewayWorkDirectory, [StringComparison]::OrdinalIgnoreCase) -or
             [IO.Path]::GetFileName($progressArgument) -cne 'progress.jsonl'))) {
        throw 'Runner root command identity cannot be safely bound.'
    }
    $marker.rootProcess = [ordered]@{
        pid = [int]$PID
        creationToken = [string]$creation.CreationToken
        createdAtMs = [int64]$creation.CreatedAtMs
        executablePath = [IO.Path]::GetFullPath($executablePath)
    }
    Write-AtomicText -Path $resolvedMarker -Text (($marker | ConvertTo-Json -Depth 10 -Compress) + [Environment]::NewLine)
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
$processHandleHelper = Join-Path $projectRoot 'scripts\windows-process-handle.ps1'
$nodePath = (Get-Command node -ErrorAction Stop).Source
$resolvedOutput = [IO.Path]::GetFullPath($OutputPath)
$script:resolvedProgress = if ([string]::IsNullOrWhiteSpace($ProgressPath)) { $null } else { [IO.Path]::GetFullPath($ProgressPath) }
if ($script:resolvedProgress -and $script:resolvedProgress.Equals($resolvedOutput, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'ProgressPath 不能与 OutputPath 相同。'
}
if ($script:resolvedProgress) { Write-AtomicText -Path $script:resolvedProgress -Text '' }

foreach ($requiredFile in @($exporter, $builder, $aggregator, $processHandleHelper)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Required Skill file is missing: $requiredFile"
    }
}
. $processHandleHelper

if ([string]::IsNullOrWhiteSpace($IsolationToken) -ne [string]::IsNullOrWhiteSpace($IsolationMarkerPath)) {
    throw 'IsolationToken and IsolationMarkerPath must be supplied together.'
}
if (-not [string]::IsNullOrWhiteSpace($IsolationToken)) {
    Bind-RunnerIsolationRoot -MarkerPath $IsolationMarkerPath -Token $IsolationToken -ExpectedProjectRoot $projectRoot `
        -ExpectedQueryScript $MyInvocation.MyCommand.Path -ExpectedChildScripts @(
            (Join-Path $sharedXbbRoot 'export-live-data.js'),
            $builder,
            $aggregator
        ) -ExpectedOutputPath $resolvedOutput
}

if ($RequestFromStdin) {
    foreach ($businessParameter in @('Month', 'Date', 'Domains', 'Metrics', 'Company', 'Person', 'ForceRefresh')) {
        if ($PSBoundParameters.ContainsKey($businessParameter)) {
            throw 'RequestFromStdin cannot be combined with business-scope command-line parameters.'
        }
    }
    # Node writes UTF-8 to this pipe. Console.In inherits the Windows console
    # code page (often GBK), which silently corrupts Chinese entity names.
    $requestReader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false, $true), $false, 1024, $true)
    try { $requestText = $requestReader.ReadToEnd() } finally { $requestReader.Dispose() }
    if ([string]::IsNullOrWhiteSpace($requestText) -or
        [Text.UTF8Encoding]::new($false).GetByteCount($requestText) -gt 8192) {
        throw 'Runner stdin request is missing or exceeds the safe size limit.'
    }
    try { $request = $requestText | ConvertFrom-Json } catch { throw 'Runner stdin request is not valid JSON.' }
    $expectedRequestProperties = @('company', 'domains', 'forceRefresh', 'months', 'person')
    if ($request.PSObject.Properties.Name -contains 'date') {
        $expectedRequestProperties = @($expectedRequestProperties + 'date' | Sort-Object)
        if ($request.date -isnot [string] -or $request.date -notmatch '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$') { throw 'Date must be a canonical YYYY-MM-DD string.' }
        $Date = [string]$request.date
    }
    if ($request.PSObject.Properties.Name -contains 'metrics') {
        $expectedRequestProperties = @($expectedRequestProperties + 'metrics' | Sort-Object)
        if ($request.metrics -isnot [Array] -or @($request.metrics).Count -eq 0) { throw 'Metrics must be a nonempty array.' }
        $Metrics = @($request.metrics | ForEach-Object { [string]$_ })
    }
    $actualRequestProperties = @($request.PSObject.Properties.Name | Sort-Object)
    if (($actualRequestProperties -join "`n") -cne ($expectedRequestProperties -join "`n") -or
        $request.months -is [string] -or $request.domains -is [string] -or
        $null -eq $request.months -or $null -eq $request.domains -or
        $request.forceRefresh -isnot [bool] -or
        ($null -ne $request.company -and $request.company -isnot [string]) -or
        ($null -ne $request.person -and $request.person -isnot [string])) {
        throw 'Runner stdin request does not match the exact scope schema.'
    }
    $Month = @($request.months | ForEach-Object { [string]$_ })
    $Domains = @($request.domains | ForEach-Object { [string]$_ })
    $Company = if ($null -eq $request.company) { $null } else { [string]$request.company }
    $Person = if ($null -eq $request.person) { $null } else { [string]$request.person }
    $ForceRefresh = [bool]$request.forceRefresh
    $request = $null
    $requestText = $null
}

if (-not [string]::IsNullOrWhiteSpace($Date)) {
    try { $queryDay = [DateTime]::ParseExact($Date, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture) }
    catch { throw '单日日期必须是有效的 YYYY-MM-DD 自然日。' }
    $queryZone = [TimeZoneInfo]::FindSystemTimeZoneById('China Standard Time')
    $currentShanghaiDate = [TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::UtcNow, $queryZone).ToString('yyyy-MM-dd')
    if ($Date -gt $currentShanghaiDate) { throw '不能查询晚于当前上海日期的单日。' }
}
$months = @($Month | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
if ($months.Count -eq 0) { $months = @(if ([string]::IsNullOrWhiteSpace($Date)) { Get-ShanghaiMonth } else { $Date.Substring(0, 7) }) }
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
if (-not [string]::IsNullOrWhiteSpace($Date)) {
    if ($domainList.Count -ne 1 -or $domainList[0] -ne 'performance') { throw '单日查询当前仅支持业绩，不能改查整月或其他数据域。' }
    if ($months.Count -ne 1 -or $months[0] -ne $Date.Substring(0, 7)) { throw '单日查询的月份必须且只能是该日期所属月份。' }
}
$requiresOrderData = $domainList -contains 'all' -or $domainList -contains 'performance' -or $domainList -contains 'product-sales'
if ($requiresOrderData -and @($months | Where-Object { $_ -lt $performanceDataStartMonth }).Count -gt 0) {
    throw "业绩订单和 OPP 订单的已确认数据范围从 $performanceDataStartMonth 开始。"
}
$metricList = @($Metrics | ForEach-Object { ([string]$_).Split(',') } | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Sort-Object -Unique)
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
$isolationRunPrefix = if ([string]::IsNullOrWhiteSpace($IsolationToken)) { 'run' } else { "run-$IsolationToken" }
$runId = "$isolationRunPrefix-$PID-$([DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff'))-$([Guid]::NewGuid().ToString('N').Substring(0,8))"
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
        # Child-process argv may contain only opaque temporary paths. In
        # particular, never encode the selected month in a source/output name.
        $periodFileToken = [Guid]::NewGuid().ToString('N')
        $sourcePath = Join-Path $runDir "source-$periodFileToken.json"
        $factPath = Join-Path $runDir "facts-$periodFileToken.json"
        $cacheDomainKey = (($domainList | Sort-Object) -join '-') -replace '[^a-z-]', ''
        $demandMaterial = [ordered]@{ domains = @($domainList | Sort-Object); date = $Date; metrics = @($metricList); company = $Company; person = $Person } | ConvertTo-Json -Compress
        $demandHasher = [Security.Cryptography.SHA256]::Create()
        try { $demandKey = (($demandHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($demandMaterial)) | ForEach-Object { $_.ToString('x2') }) -join '') } finally { $demandHasher.Dispose() }
        $cachePath = Join-Path $cacheRoot "source-v7-$tenantFingerprint-$demandKey-$selectedMonth.dpapi"
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
            $exportArguments = @{
                Month = $selectedMonth
                Date = $Date
                Domains = $domainList
                Metrics = $metricList
                Company = $Company
                Person = $Person
                OutputPath = $sourcePath
            }
            if (-not [string]::IsNullOrWhiteSpace($IsolationToken)) { $exportArguments['IsolationToken'] = $IsolationToken }
            $exportMessages = @(& $exporter @exportArguments)
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

        $arguments = @($builder, '--source', $sourcePath, '--output', $factPath, '--request-stdin')
        if (-not [string]::IsNullOrWhiteSpace($IsolationToken)) { $arguments += @('--isolation-token', $IsolationToken) }
        $builderScope = [ordered]@{
            domains = @($domainList)
            company = if ([string]::IsNullOrWhiteSpace($Company)) { $null } else { $Company }
            person = if ([string]::IsNullOrWhiteSpace($Person)) { $null } else { $Person }
        }
        if (-not [string]::IsNullOrWhiteSpace($Date)) { $builderScope['date'] = $Date }
        $builderRequest = $builderScope | ConvertTo-Json -Depth 4 -Compress
        $previousOutputEncoding = $OutputEncoding
        try {
            $OutputEncoding = [Text.UTF8Encoding]::new($false)
            $builderOutput = @($builderRequest | & $nodePath @arguments 2>&1)
        } finally {
            $OutputEncoding = $previousOutputEncoding
            $builderRequest = $null
        }
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
        $aggregateArguments = @($aggregator, '--input', $aggregateInputPath, '--output', $aggregateOutputPath)
        if (-not [string]::IsNullOrWhiteSpace($IsolationToken)) { $aggregateArguments += @('--isolation-token', $IsolationToken) }
        $aggregateMessages = @(& $nodePath @aggregateArguments 2>&1)
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
