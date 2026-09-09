[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$MarkerDirectory,

    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,

    [ValidatePattern('^[a-f0-9]{64}$')]
    [string]$IsolationToken,

    [switch]$ConfirmationOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:isolationSchemaVersion = '2.0'
$script:isolationService = 'xbb-executive-analyst-runner'
$script:isolationTokenPattern = '^[a-f0-9]{64}$'
$script:recoveryScriptPath = [IO.Path]::GetFullPath($MyInvocation.MyCommand.Path)
$script:processHandleScriptPath = Join-Path (Split-Path -Parent $script:recoveryScriptPath) 'windows-process-handle.ps1'
if (-not [IO.File]::Exists($script:processHandleScriptPath)) { throw 'Verified Windows process-handle helper is missing.' }
. $script:processHandleScriptPath

function Test-FullyQualifiedWindowsPath([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
    return [regex]::IsMatch($Value, '^(?:[A-Za-z]:\\|\\\\[^\\/]+\\[^\\/]+(?:\\|$))')
}

function Test-CanonicalWindowsPath([string]$Value, [switch]$Directory) {
    if (-not (Test-FullyQualifiedWindowsPath $Value)) { return $false }
    try {
        $full = [IO.Path]::GetFullPath($Value)
        $input = $Value
        if ($Directory) {
            $full = $full.TrimEnd('\')
            $input = $input.TrimEnd('\')
        }
        return $full.Equals($input, [StringComparison]::OrdinalIgnoreCase)
    } catch {
        return $false
    }
}

function ConvertTo-RunnerProcessCreationIdentity($Value) {
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
            AtMs = [DateTimeOffset]::new($utc).ToUnixTimeMilliseconds()
            Token = $utc.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
        }
    } catch {
        return $null
    }
}

function Test-CanonicalArgumentPath([string]$Value, [string]$ExpectedPath) {
    if ([string]::IsNullOrWhiteSpace($Value) -or [string]::IsNullOrWhiteSpace($ExpectedPath)) { return $false }
    try {
        return [IO.Path]::GetFullPath($Value).Equals([IO.Path]::GetFullPath($ExpectedPath), [StringComparison]::OrdinalIgnoreCase)
    } catch {
        return $false
    }
}

function Get-ExactFlagValue([string[]]$Arguments, [string]$Flag) {
    $matches = @()
    for ($index = 0; $index -lt $Arguments.Count; $index += 1) {
        if ([string]$Arguments[$index] -ieq $Flag) { $matches += $index }
    }
    if ($matches.Count -ne 1 -or $matches[0] + 1 -ge $Arguments.Count) { return $null }
    return [string]$Arguments[$matches[0] + 1]
}

function ConvertTo-StrictRunnerCommandIdentity($Observation, $Marker) {
    try { $arguments = @(ConvertFrom-XbbWindowsCommandLine ([string]$Observation.CommandLine)) } catch { return $null }
    $name = [string]$Observation.Name
    if ($name -iin @('powershell.exe', 'pwsh.exe')) {
        try {
            $invocation = ConvertTo-XbbStrictPowerShellInvocation `
                -CommandLine ([string]$Observation.CommandLine) `
                -ExpectedExecutablePath ([string]$Observation.ExecutablePath) `
                -ExpectedProcessName $name `
                -ExpectedScriptPath ([string]$Marker.QueryScriptPath) `
                -AllowedValueParameters @('-OutputPath', '-ProgressPath', '-IsolationToken', '-IsolationMarkerPath') `
                -RequiredValueParameters @('-OutputPath', '-IsolationToken', '-IsolationMarkerPath') `
                -AllowedSwitchParameters @('-RequestFromStdin') `
                -RequiredSwitchParameters @('-RequestFromStdin')
        } catch { return $null }
        $outputPath = [string]$invocation.Values['-OutputPath']
        $progressPath = [string]$invocation.Values['-ProgressPath']
        if ([string]$invocation.Values['-IsolationToken'] -cne [string]$Marker.Token -or
            -not (Test-CanonicalArgumentPath ([string]$invocation.Values['-IsolationMarkerPath']) ([string]$Marker.Path)) -or
            -not (Test-CanonicalWindowsPath $outputPath) -or
            -not [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($outputPath)).Equals([string]$Marker.GatewayWorkDirectory, [StringComparison]::OrdinalIgnoreCase) -or
            [IO.Path]::GetFileName($outputPath) -cne 'fact-pack.json' -or
            (-not [string]::IsNullOrWhiteSpace($progressPath) -and
                (-not (Test-CanonicalWindowsPath $progressPath) -or
                 -not [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($progressPath)).Equals([string]$Marker.GatewayWorkDirectory, [StringComparison]::OrdinalIgnoreCase) -or
                 [IO.Path]::GetFileName($progressPath) -cne 'progress.jsonl'))) { return $null }
        return [pscustomobject]@{ Kind = 'query'; ScriptPath = [IO.Path]::GetFullPath([string]$Marker.QueryScriptPath) }
    }
    if ($arguments.Count -lt 2 -or
        -not (Test-XbbPowerShellExecutableArgument $arguments[0] $Observation.ExecutablePath $Observation.Name)) { return $null }
    if (-not (Test-CanonicalWindowsPath $arguments[1])) { return $null }
    $matchingChildren = @($Marker.ChildScriptPaths | Where-Object { Test-CanonicalArgumentPath $arguments[1] $_ })
    $tokenValue = Get-ExactFlagValue $arguments '--isolation-token'
    if ($matchingChildren.Count -ne 1 -or [string]$tokenValue -cne [string]$Marker.Token) { return $null }
    return [pscustomobject]@{ Kind = 'child'; ScriptPath = [IO.Path]::GetFullPath($arguments[1]) }
}

function Read-RunnerIsolationMarker([string]$MarkerPath) {
    $resolved = [IO.Path]::GetFullPath($MarkerPath)
    $fileToken = [IO.Path]::GetFileNameWithoutExtension($resolved)
    if ($fileToken -cnotmatch $script:isolationTokenPattern -or [IO.Path]::GetExtension($resolved) -cne '.json') {
        throw 'Invalid runner isolation marker filename.'
    }
    $marker = Get-Content -LiteralPath $resolved -Raw -Encoding UTF8 | ConvertFrom-Json
    $expectedProperties = @('childScriptPaths', 'createdAtMs', 'gatewayWorkDirectory', 'projectRoot', 'queryScriptPath', 'rootProcess', 'runRoot', 'schemaVersion', 'service', 'token')
    $actualProperties = @($marker.PSObject.Properties.Name | Sort-Object)
    if (($actualProperties -join "`n") -cne ($expectedProperties -join "`n") -or
        [string]$marker.schemaVersion -cne $script:isolationSchemaVersion -or
        [string]$marker.service -cne $script:isolationService -or
        [string]$marker.token -cne $fileToken -or
        -not (Test-CanonicalWindowsPath ([string]$marker.projectRoot) -Directory) -or
        -not (Test-CanonicalWindowsPath ([string]$marker.queryScriptPath)) -or
        -not (Test-CanonicalWindowsPath ([string]$marker.gatewayWorkDirectory) -Directory) -or
        ($null -ne $marker.runRoot -and -not (Test-CanonicalWindowsPath ([string]$marker.runRoot) -Directory))) {
        throw 'Invalid runner isolation marker contract.'
    }
    try { $createdAtMs = [int64]$marker.createdAtMs } catch { throw 'Invalid runner isolation marker timestamp.' }
    if ($createdAtMs -le 0) { throw 'Invalid runner isolation marker timestamp.' }

    $projectRoot = [string]$marker.projectRoot
    $expectedQuery = Join-Path $projectRoot 'skills\xbb-executive-analyst\scripts\query-xbb.ps1'
    $expectedChildren = @(
        (Join-Path $projectRoot 'shared\xbb\export-live-data.js'),
        (Join-Path $projectRoot 'shared\xbb\build-fact-pack.js'),
        (Join-Path $projectRoot 'shared\xbb\aggregate-multi-period.js')
    )
    $actualChildren = @($marker.childScriptPaths)
    if (-not ([IO.Path]::GetFullPath([string]$marker.queryScriptPath).Equals([IO.Path]::GetFullPath($expectedQuery), [StringComparison]::OrdinalIgnoreCase)) -or
        $actualChildren.Count -ne $expectedChildren.Count) {
        throw 'Invalid runner isolation script layout.'
    }
    for ($index = 0; $index -lt $expectedChildren.Count; $index += 1) {
        if (-not (Test-CanonicalWindowsPath ([string]$actualChildren[$index]) ) -or
            -not ([IO.Path]::GetFullPath([string]$actualChildren[$index]).Equals([IO.Path]::GetFullPath($expectedChildren[$index]), [StringComparison]::OrdinalIgnoreCase))) {
            throw 'Invalid runner isolation child-script layout.'
        }
    }
    $gatewayWorkDirectory = [IO.Path]::GetFullPath([string]$marker.gatewayWorkDirectory).TrimEnd('\')
    $gatewayWorkRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) 'Codex\xbb-executive-analyst\bot-runs')).TrimEnd('\')
    if (-not [IO.Path]::GetDirectoryName($gatewayWorkDirectory).Equals($gatewayWorkRoot, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($gatewayWorkDirectory) -cnotmatch '^request-[A-Za-z0-9_-]{6,64}$') {
        throw 'Invalid runner isolation gateway-work layout.'
    }

    $rootProcess = $null
    if ($null -ne $marker.rootProcess) {
        $rootProperties = @($marker.rootProcess.PSObject.Properties.Name | Sort-Object)
        $expectedRootProperties = @('createdAtMs', 'creationToken', 'executablePath', 'pid')
        try {
            $rootPid = [int]$marker.rootProcess.pid
            $rootCreatedAtMs = [int64]$marker.rootProcess.createdAtMs
        } catch {
            throw 'Invalid bound runner root numeric identity.'
        }
        $rootExecutable = [string]$marker.rootProcess.executablePath
        $rootCreationToken = [string]$marker.rootProcess.creationToken
        if (($rootProperties -join "`n") -cne ($expectedRootProperties -join "`n") -or
            $rootPid -le 0 -or $rootCreatedAtMs -le 0 -or
            $rootCreationToken -cnotmatch '^\d{10,20}$' -or
            -not (Test-CanonicalWindowsPath $rootExecutable) -or
            [IO.Path]::GetFileName($rootExecutable) -inotmatch '^(?:powershell|pwsh)\.exe$') {
            throw 'Invalid bound runner root identity.'
        }
        $rootProcess = [pscustomobject]@{
            ProcessId = $rootPid
            CreatedAtMs = $rootCreatedAtMs
            CreationToken = $rootCreationToken
            ExecutablePath = [IO.Path]::GetFullPath($rootExecutable)
        }
    }
    return [pscustomobject]@{
        Token = $fileToken
        Path = $resolved
        CreatedAtMs = $createdAtMs
        ProjectRoot = $projectRoot
        QueryScriptPath = [string]$marker.queryScriptPath
        ChildScriptPaths = $actualChildren
        RunRoot = if ($null -eq $marker.runRoot) { $null } else { [string]$marker.runRoot }
        GatewayWorkDirectory = $gatewayWorkDirectory
        RootProcess = $rootProcess
    }
}

function ConvertTo-RecoverySentinel($Process, [string]$ExpectedScriptPath) {
    if ($null -eq $Process) { throw 'Recovery sentinel process is unavailable.' }
    try { $processId = [int]$Process.ProcessId } catch { $processId = 0 }
    $name = [string]$Process.Name
    $executablePath = [string]$Process.ExecutablePath
    $commandLine = [string]$Process.CommandLine
    $creation = ConvertTo-RunnerProcessCreationIdentity $Process.CreationDate
    if ($processId -le 0 -or $name -inotmatch '^(?:powershell|pwsh)\.exe$' -or
        -not (Test-CanonicalWindowsPath $executablePath) -or
        -not [IO.Path]::GetFileName($executablePath).Equals($name, [StringComparison]::OrdinalIgnoreCase) -or
        [string]::IsNullOrWhiteSpace($commandLine) -or
        $null -eq $creation) {
        throw 'Recovery sentinel identity is invalid.'
    }
    try {
        $invocation = ConvertTo-XbbStrictPowerShellInvocation `
            -CommandLine $commandLine `
            -ExpectedExecutablePath $executablePath `
            -ExpectedProcessName $name `
            -ExpectedScriptPath $ExpectedScriptPath `
            -AllowedValueParameters @('-MarkerDirectory', '-ProjectRoot', '-IsolationToken') `
            -RequiredValueParameters @('-MarkerDirectory', '-ProjectRoot') `
            -AllowedSwitchParameters @('-ConfirmationOnly')
    } catch { throw 'Recovery sentinel command identity is invalid.' }
    $sentinelMarkerDirectory = [string]$invocation.Values['-MarkerDirectory']
    $sentinelProjectRoot = [string]$invocation.Values['-ProjectRoot']
    $sentinelToken = [string]$invocation.Values['-IsolationToken']
    if (-not (Test-CanonicalWindowsPath $sentinelMarkerDirectory -Directory) -or
        -not (Test-CanonicalWindowsPath $sentinelProjectRoot -Directory) -or
        (-not [string]::IsNullOrWhiteSpace($sentinelToken) -and $sentinelToken -cnotmatch $script:isolationTokenPattern) -or
        ($invocation.Switches.ContainsKey('-ConfirmationOnly') -and [string]::IsNullOrWhiteSpace($sentinelToken))) {
        throw 'Recovery sentinel script parameters are invalid.'
    }
    return [pscustomobject]@{
        ProcessId = $processId
        CreationToken = [string]$creation.Token
        ExecutablePath = [IO.Path]::GetFullPath($executablePath)
        CommandLine = $commandLine
    }
}

function Get-HealthyRunnerProcessSnapshot([scriptblock]$ProcessProvider, $SnapshotSentinel) {
    $processes = @(& $ProcessProvider)
    if ($processes.Count -eq 0) { throw 'CIM runner snapshot is empty.' }
    $sentinelRows = @($processes | Where-Object { [int]$_.ProcessId -eq [int]$SnapshotSentinel.ProcessId })
    if ($sentinelRows.Count -ne 1) { throw 'CIM runner snapshot omitted the recovery sentinel.' }
    $observed = ConvertTo-RecoverySentinel $sentinelRows[0] $script:recoveryScriptPath
    if ([string]$observed.CreationToken -cne [string]$SnapshotSentinel.CreationToken -or
        -not [string]$observed.ExecutablePath.Equals([string]$SnapshotSentinel.ExecutablePath, [StringComparison]::OrdinalIgnoreCase) -or
        [string]$observed.CommandLine -cne [string]$SnapshotSentinel.CommandLine) {
        throw 'CIM runner snapshot sentinel changed identity.'
    }
    return @($processes | Where-Object { [int]$_.ProcessId -ne [int]$SnapshotSentinel.ProcessId })
}

function ConvertTo-RunnerCimObservation($Process) {
    if ($null -eq $Process) { throw 'Runner CIM observation is unavailable.' }
    try {
        $processId = [int]$Process.ProcessId
        $parentProcessId = [int]$Process.ParentProcessId
    } catch {
        throw 'Runner CIM PID observation is invalid.'
    }
    $name = [string]$Process.Name
    $executablePath = [string]$Process.ExecutablePath
    $commandLine = [string]$Process.CommandLine
    $creation = ConvertTo-RunnerProcessCreationIdentity $Process.CreationDate
    if ($processId -le 0 -or $parentProcessId -lt 0 -or
        $name -inotmatch '^(?:powershell|pwsh|node|nodew)\.exe$' -or
        -not (Test-CanonicalWindowsPath $executablePath) -or
        -not [IO.Path]::GetFileName($executablePath).Equals($name, [StringComparison]::OrdinalIgnoreCase) -or
        [string]::IsNullOrWhiteSpace($commandLine) -or $null -eq $creation) {
        throw 'Runner CIM process observation is indeterminate.'
    }
    return [pscustomobject]@{
        ProcessId = $processId
        ParentProcessId = $parentProcessId
        Name = $name
        CreationToken = [string]$creation.Token
        CreatedAtMs = [int64]$creation.AtMs
        ExecutablePath = [IO.Path]::GetFullPath($executablePath)
        CommandLine = $commandLine
    }
}

function Test-SameRunnerCimObservation($Left, $Right) {
    return $null -ne $Left -and $null -ne $Right -and
        [int]$Left.ProcessId -eq [int]$Right.ProcessId -and
        [int]$Left.ParentProcessId -eq [int]$Right.ParentProcessId -and
        [string]$Left.Name -ieq [string]$Right.Name -and
        [string]$Left.CreationToken -ceq [string]$Right.CreationToken -and
        [string]$Left.ExecutablePath -ieq [string]$Right.ExecutablePath -and
        [string]$Left.CommandLine -ceq [string]$Right.CommandLine
}

function ConvertTo-RunnerIsolationProcessProbe($Process, $Marker, [int64]$NowAtMs) {
    if ($null -eq $Process) { return [pscustomobject]@{ State = 'indeterminate'; Candidate = $null } }
    $name = [string]$Process.Name
    if ($name -inotmatch '^(?:powershell|pwsh|node|nodew)\.exe$') {
        return [pscustomobject]@{ State = 'indeterminate'; Candidate = $null }
    }
    try { $observation = ConvertTo-RunnerCimObservation $Process } catch {
        return [pscustomobject]@{ State = 'indeterminate'; Candidate = $null }
    }
    $tokenPattern = '(?i)(?<![a-f0-9])' + [regex]::Escape($Marker.Token) + '(?![a-f0-9])'
    if (-not [regex]::IsMatch($observation.CommandLine, $tokenPattern)) {
        return [pscustomobject]@{ State = 'missing'; Candidate = $null }
    }
    $commandIdentity = ConvertTo-StrictRunnerCommandIdentity $observation $Marker
    if ($null -eq $commandIdentity) {
        # Time is only an auxiliary signal for a token-bearing non-match. It
        # must never hide an exact token + fixed-entry-script process when the
        # wall clock has moved backwards or CIM reports a skewed timestamp.
        if ($observation.CreatedAtMs -lt ($Marker.CreatedAtMs - 5000)) {
            return [pscustomobject]@{ State = 'missing'; Candidate = $null }
        }
        return [pscustomobject]@{ State = 'indeterminate'; Candidate = $null }
    }
    return [pscustomobject]@{
        State = 'alive'
        Candidate = [pscustomobject]@{
            ProcessId = $observation.ProcessId
            ParentProcessId = $observation.ParentProcessId
            Name = $observation.Name
            CreationToken = $observation.CreationToken
            CreatedAtMs = $observation.CreatedAtMs
            ExecutablePath = $observation.ExecutablePath
            CommandLine = $observation.CommandLine
        }
    }
}

function Get-VerifiedRunnerProcessSnapshot(
    [scriptblock]$ProcessProvider,
    [scriptblock]$RootProcessProvider,
    $SnapshotSentinel,
    $Marker,
    [int64]$NowAtMs
) {
    $wide = @(Get-HealthyRunnerProcessSnapshot $ProcessProvider $SnapshotSentinel)
    if ($null -eq $Marker.RootProcess) { return $wide }
    if ($null -eq $RootProcessProvider) { throw 'Bound runner root requires an independent directed CIM provider.' }
    $targeted = @(& $RootProcessProvider ([int]$Marker.RootProcess.ProcessId))
    if ($targeted.Count -gt 1) { throw 'Directed runner-root CIM query returned multiple rows.' }
    $wideRootRows = @($wide | Where-Object { [int]$_.ProcessId -eq [int]$Marker.RootProcess.ProcessId })
    if ($targeted.Count -eq 0) {
        if ($wideRootRows.Count -ne 0) { throw 'Wide and directed runner-root CIM snapshots disagree.' }
        return $wide
    }
    if ($wideRootRows.Count -ne 1) { throw 'Wide CIM snapshot omitted the directed runner root.' }
    $targetObservation = ConvertTo-RunnerCimObservation $targeted[0]
    $wideObservation = ConvertTo-RunnerCimObservation $wideRootRows[0]
    if (-not (Test-SameRunnerCimObservation $targetObservation $wideObservation)) {
        throw 'Wide and directed runner-root identities disagree.'
    }
    $rootIdentityMatches = [int]$targetObservation.ProcessId -eq [int]$Marker.RootProcess.ProcessId -and
        [string]$targetObservation.CreationToken -ceq [string]$Marker.RootProcess.CreationToken -and
        [string]$targetObservation.ExecutablePath -ieq [string]$Marker.RootProcess.ExecutablePath
    $probe = ConvertTo-RunnerIsolationProcessProbe $targeted[0] $Marker $NowAtMs
    if ($rootIdentityMatches) {
        if ($probe.State -ne 'alive' -or -not (Test-SameProcessIdentity $probe.Candidate $Marker.RootProcess)) {
            throw 'Bound runner root command identity changed.'
        }
    } elseif ($probe.State -ne 'missing') {
        throw 'Reused runner-root PID has a suspicious token or unreadable identity.'
    }
    return $wide
}

function Get-RunnerIsolationCandidates([object[]]$Processes, $Marker, [int64]$NowAtMs) {
    $candidates = @()
    foreach ($process in $Processes) {
        $probe = ConvertTo-RunnerIsolationProcessProbe $process $Marker $NowAtMs
        if ($probe.State -eq 'indeterminate') { throw 'A runner-window process identity is indeterminate.' }
        if ($probe.State -eq 'alive') { $candidates += $probe.Candidate }
    }
    return @($candidates)
}

function Test-SameProcessIdentity($Left, $Right) {
    return $null -ne $Left -and $null -ne $Right -and
        [int]$Left.ProcessId -eq [int]$Right.ProcessId -and
        [string]$Left.CreationToken -ceq [string]$Right.CreationToken -and
        [string]$Left.ExecutablePath -ieq [string]$Right.ExecutablePath
}

function Remove-RunnerIsolationRunDirectories($Marker) {
    if ([string]::IsNullOrWhiteSpace([string]$Marker.RunRoot) -or -not [IO.Directory]::Exists([string]$Marker.RunRoot)) { return 0 }
    $runRoot = [IO.Path]::GetFullPath([string]$Marker.RunRoot).TrimEnd('\')
    $namePattern = '^run-' + [regex]::Escape([string]$Marker.Token) + '-\d+-\d{17}-[a-f0-9]{8}$'
    $removed = 0
    foreach ($directory in @(Get-ChildItem -LiteralPath $runRoot -Directory -ErrorAction Stop)) {
        $candidate = [IO.Path]::GetFullPath($directory.FullName)
        if (-not [IO.Path]::GetDirectoryName($candidate).Equals($runRoot, [StringComparison]::OrdinalIgnoreCase) -or
            [IO.Path]::GetFileName($candidate) -cnotmatch $namePattern) { continue }
        if (($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'Runner isolation run directory is a reparse point.'
        }
        [IO.Directory]::Delete($candidate, $true)
        $removed += 1
    }
    return $removed
}

function Remove-RunnerIsolationGatewayWorkDirectory($Marker) {
    $candidate = [IO.Path]::GetFullPath([string]$Marker.GatewayWorkDirectory).TrimEnd('\')
    $gatewayWorkRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) 'Codex\xbb-executive-analyst\bot-runs')).TrimEnd('\')
    if (-not [IO.Path]::GetDirectoryName($candidate).Equals($gatewayWorkRoot, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($candidate) -cnotmatch '^request-[A-Za-z0-9_-]{6,64}$') {
        throw 'Runner isolation gateway-work directory failed its cleanup boundary check.'
    }
    if (-not [IO.Directory]::Exists($candidate)) { return 0 }
    $directory = Get-Item -LiteralPath $candidate -ErrorAction Stop
    if (($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Runner isolation gateway-work directory is a reparse point.'
    }
    [IO.Directory]::Delete($candidate, $true)
    if ([IO.Directory]::Exists($candidate)) { throw 'Runner isolation gateway-work directory still exists after cleanup.' }
    return 1
}

function Remove-RunnerIsolationMarkerAtomically([string]$MarkerPath, [string]$ExpectedToken, [scriptblock]$DeleteFile) {
    if (-not [IO.File]::Exists($MarkerPath)) { throw 'Runner isolation marker disappeared before cleanup.' }
    $verified = Read-RunnerIsolationMarker $MarkerPath
    if ([string]$verified.Token -cne $ExpectedToken) { throw 'Runner isolation marker changed before cleanup.' }
    if ($null -eq $DeleteFile) { $DeleteFile = { param([string]$Path) [IO.File]::Delete($Path) } }
    & $DeleteFile $MarkerPath
    if ([IO.File]::Exists($MarkerPath)) { throw 'Runner isolation marker still exists after cleanup.' }
}

function Invoke-RunnerIsolationRecovery(
    [string]$MarkerDirectory,
    [string]$ProjectRoot,
    [scriptblock]$ProcessProvider,
    [scriptblock]$RootProcessProvider,
    [object]$SnapshotSentinel,
    [scriptblock]$HandleBinder,
    [scriptblock]$TreeKiller,
    [scriptblock]$HandleTerminator,
    [scriptblock]$HandleDisposer,
    [scriptblock]$VerificationDelay,
    [scriptblock]$NowProvider,
    [string]$IsolationToken,
    [switch]$ConfirmationOnly,
    [scriptblock]$RunDirectoryRemover,
    [scriptblock]$GatewayWorkDirectoryRemover,
    [scriptblock]$MarkerRemover
) {
    $resolvedDirectory = [IO.Path]::GetFullPath($MarkerDirectory)
    $resolvedProjectRoot = [IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\')
    if (-not [IO.Directory]::Exists($resolvedProjectRoot)) { throw 'Runner isolation recovery project directory does not exist.' }
    [IO.Directory]::CreateDirectory($resolvedDirectory) | Out-Null
    if ($null -eq $ProcessProvider) {
        $selfRows = @(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $PID" -ErrorAction Stop)
        if ($selfRows.Count -ne 1) { throw 'Recovery sentinel CIM lookup failed.' }
        $SnapshotSentinel = ConvertTo-RecoverySentinel $selfRows[0] $script:recoveryScriptPath
        $ProcessProvider = {
            @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'powershell.exe' OR Name = 'pwsh.exe' OR Name = 'node.exe' OR Name = 'nodew.exe'" -ErrorAction Stop)
        }
        $RootProcessProvider = {
            param([int]$RootProcessId)
            @(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $RootProcessId" -ErrorAction Stop)
        }
    } elseif ($null -eq $SnapshotSentinel) {
        throw 'Injected process snapshots require an explicit recovery sentinel.'
    }
    if ($null -eq $HandleBinder) {
        $HandleBinder = { param($Identity) Open-XbbVerifiedProcessHandle $Identity }
    }
    if ($null -eq $TreeKiller) {
        # Backward-compatible hook for injected tests. Production deliberately
        # declines PID-based tree killing: a tree enumerator can discover and kill a
        # post-snapshot descendant whose identity was never handle-verified.
        $TreeKiller = { param($BoundCandidate) return $false }
    }
    if ($null -eq $HandleTerminator) {
        $HandleTerminator = { param($BoundCandidate) [bool]$BoundCandidate.Handle.TerminateAndWait(1, 5000) }
    }
    if ($null -eq $HandleDisposer) { $HandleDisposer = { param($Handle) $Handle.Dispose() } }
    if ($null -eq $VerificationDelay) { $VerificationDelay = { Start-Sleep -Milliseconds 100 } }
    if ($null -eq $NowProvider) { $NowProvider = { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } }
    if ($null -eq $RunDirectoryRemover) { $RunDirectoryRemover = { param($Value) Remove-RunnerIsolationRunDirectories $Value } }
    if ($null -eq $GatewayWorkDirectoryRemover) { $GatewayWorkDirectoryRemover = { param($Value) Remove-RunnerIsolationGatewayWorkDirectory $Value } }
    if ($null -eq $MarkerRemover) { $MarkerRemover = { param([string]$Path, [string]$Token) Remove-RunnerIsolationMarkerAtomically $Path $Token } }
    try { $nowAtMs = [int64](& $NowProvider) } catch { throw 'Invalid runner isolation recovery clock.' }
    if ($nowAtMs -le 0) { throw 'Invalid runner isolation recovery clock.' }

    if (-not [string]::IsNullOrWhiteSpace($IsolationToken)) {
        if ($IsolationToken -cnotmatch $script:isolationTokenPattern) { throw 'Invalid runner isolation recovery token.' }
        $specificMarkerPath = Join-Path $resolvedDirectory "$IsolationToken.json"
        if (-not [IO.File]::Exists($specificMarkerPath)) { throw 'Requested runner isolation marker does not exist.' }
        $markerFiles = @(Get-Item -LiteralPath $specificMarkerPath -ErrorAction Stop)
    } else {
        if ($ConfirmationOnly) { throw 'ConfirmationOnly requires one explicit runner isolation token.' }
        $markerFiles = @(Get-ChildItem -LiteralPath $resolvedDirectory -File -Filter '*.json' -ErrorAction Stop | Sort-Object Name)
    }

    $markersRecovered = 0
    $runDirectoriesRemoved = 0
    $terminatedPids = [Collections.Generic.HashSet[int]]::new()
    foreach ($markerFile in $markerFiles) {
        $marker = Read-RunnerIsolationMarker $markerFile.FullName
        if ($marker.CreatedAtMs -gt ($nowAtMs + 5000)) { throw 'Runner isolation marker timestamp is in the future.' }
        for ($terminationRound = 0; $terminationRound -lt 32; $terminationRound += 1) {
            $snapshot = Get-VerifiedRunnerProcessSnapshot $ProcessProvider $RootProcessProvider $SnapshotSentinel $marker $nowAtMs
            $candidates = @(Get-RunnerIsolationCandidates $snapshot $marker $nowAtMs)
            if ($candidates.Count -eq 0) { break }
            if (@($candidates | Group-Object ProcessId | Where-Object { $_.Count -ne 1 }).Count -ne 0) {
                throw 'Runner candidate snapshot contains duplicate process identities.'
            }

            # Acquire and verify every native process-object handle before the
            # first termination. Keeping all handles open prevents PID reuse;
            # every actually terminated member is therefore the process object
            # observed in this exact snapshot. A later snapshot catches children
            # created between observation and root termination.
            $boundCandidates = @()
            try {
                foreach ($candidate in $candidates) {
                    $handle = & $HandleBinder $candidate
                    if ($null -eq $handle) { throw 'Verified runner process handle was not returned.' }
                    $boundCandidate = [pscustomobject]@{ Identity = $candidate; Handle = $handle }
                    $boundCandidates += $boundCandidate
                    $candidateTicks = [int64]$candidate.CreationToken
                    $handleTicks = [int64]$handle.CreationToken
                    if ([int]$handle.ProcessId -ne [int]$candidate.ProcessId -or
                        ($handleTicks - ($handleTicks % 10)) -ne ($candidateTicks - ($candidateTicks % 10)) -or
                        -not ([string]$handle.ExecutablePath).Equals([string]$candidate.ExecutablePath, [StringComparison]::OrdinalIgnoreCase)) {
                        throw 'Native runner process handle does not match its CIM identity.'
                    }
                }
                $orderedCandidates = @($boundCandidates | Sort-Object `
                    @{ Expression = { if ($_.Identity.Name -imatch '^(?:powershell|pwsh)\.exe$') { 0 } else { 1 } } }, `
                    @{ Expression = { [int64]$_.Identity.CreatedAtMs } })
                foreach ($boundCandidate in $orderedCandidates) {
                    $treeConfirmed = [bool](& $TreeKiller $boundCandidate)
                    if (-not $treeConfirmed) {
                        $handleConfirmed = [bool](& $HandleTerminator $boundCandidate)
                        if (-not $handleConfirmed) { throw 'Handle-bound runner process did not confirm termination.' }
                    }
                    [void]$terminatedPids.Add([int]$boundCandidate.Identity.ProcessId)
                }
            } finally {
                foreach ($boundCandidate in $boundCandidates) {
                    & $HandleDisposer $boundCandidate.Handle
                }
            }
        }

        $firstZeroSnapshot = Get-VerifiedRunnerProcessSnapshot $ProcessProvider $RootProcessProvider $SnapshotSentinel $marker $nowAtMs
        $finalCandidates = @(Get-RunnerIsolationCandidates $firstZeroSnapshot $marker $nowAtMs)
        if ($finalCandidates.Count -ne 0) { throw 'Strict runner process remains after isolation recovery.' }
        & $VerificationDelay
        $secondZeroSnapshot = Get-VerifiedRunnerProcessSnapshot $ProcessProvider $RootProcessProvider $SnapshotSentinel $marker $nowAtMs
        $finalCandidates = @(Get-RunnerIsolationCandidates $secondZeroSnapshot $marker $nowAtMs)
        if ($finalCandidates.Count -ne 0) { throw 'Strict runner process reappeared during isolation verification.' }
        if (-not $ConfirmationOnly) {
            $runDirectoriesRemoved += [int](& $RunDirectoryRemover $marker)
            [void](& $GatewayWorkDirectoryRemover $marker)
            & $MarkerRemover $marker.Path $marker.Token
            $markersRecovered += 1
        }
    }
    return [ordered]@{
        success = $true
        markersRecovered = $markersRecovered
        processesTerminated = $terminatedPids.Count
        runDirectoriesRemoved = $runDirectoriesRemoved
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    $result = Invoke-RunnerIsolationRecovery -MarkerDirectory $MarkerDirectory -ProjectRoot $ProjectRoot -IsolationToken $IsolationToken -ConfirmationOnly:$ConfirmationOnly
    Write-Output ($result | ConvertTo-Json -Compress)
}
