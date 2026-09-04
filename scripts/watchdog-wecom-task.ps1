[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')]
    [string]$TaskName,
    [Parameter(Mandatory = $true)]
    [string]$LeasePath,
    [ValidateRange(60, 3600)]
    [int]$StaleSeconds = 180,
    [ValidateRange(60, 1800)]
    [int]$StartupGraceSeconds = 300
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$taskPath = '\'
$resolvedLease = [IO.Path]::GetFullPath($LeasePath)
$futureSkewSeconds = 60
$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$expectedServer = [IO.Path]::GetFullPath((Join-Path $projectRoot 'shared\wecom\server.js'))
$expectedNode = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Codex\xbb-executive-analyst\bin\nodew.exe'))
$expectedDescription = '无控制台 Node + Codex App Server + xbb-executive-analyst Skill 企业微信智能 Agent（异常退出自动重启）'
$mainArgumentPattern = '^' + [regex]::Escape("`"$expectedServer`"") + ' --managed-config "(?<configPath>[^\r\n"]+)"$'

function Get-ExactTask {
    Get-ScheduledTask -TaskName $TaskName -TaskPath $taskPath -ErrorAction Stop
}

function Assert-MainTaskOwnership($Task) {
    $actions = @($Task.Actions)
    if ($actions.Count -ne 1) { throw '计划任务名称已被非本机器人任务占用；看门狗拒绝操作。' }
    try { $actualExecutable = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables([string]$actions[0].Execute)) } catch {
        throw '机器人主任务执行文件无效；看门狗拒绝操作。'
    }
    $argument = [string]$actions[0].Arguments
    $argumentMatch = [regex]::Match($argument, $mainArgumentPattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    $configPathValid = $false
    if ($argumentMatch.Success) {
        try {
            $configPath = [string]$argumentMatch.Groups['configPath'].Value
            $configPathValid = [IO.Path]::IsPathRooted($configPath) -and -not [string]::IsNullOrWhiteSpace([IO.Path]::GetFullPath($configPath))
        } catch { $configPathValid = $false }
    }
    if (-not $actualExecutable.Equals($expectedNode, [StringComparison]::OrdinalIgnoreCase) -or
        -not $argumentMatch.Success -or -not $configPathValid -or
        -not ([string]$Task.Description).Equals($expectedDescription, [StringComparison]::Ordinal)) {
        throw '计划任务名称已被非本机器人任务占用；看门狗拒绝操作。'
    }
    return [pscustomobject][ordered]@{ Executable = $actualExecutable; Arguments = $argument }
}

function ConvertTo-ProcessCreationStamp($Value) {
    try {
        if ($null -eq $Value) { return $null }
        if ($Value -is [DateTimeOffset]) {
            $utc = ([DateTimeOffset]$Value).ToUniversalTime()
        } elseif ($Value -is [DateTime]) {
            $utc = [DateTimeOffset]::new(([DateTime]$Value).ToUniversalTime())
        } else {
            $text = ([string]$Value).Trim()
            if ([string]::IsNullOrWhiteSpace($text)) { return $null }
            if ($text -match '^\d{14}\.\d{6}[+-]\d{3}$') {
                $utc = [DateTimeOffset]::new([Management.ManagementDateTimeConverter]::ToDateTime($text).ToUniversalTime())
            } else {
                $style = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
                $utc = [DateTimeOffset]::Parse($text, [Globalization.CultureInfo]::InvariantCulture, $style).ToUniversalTime()
            }
        }
        return [pscustomobject][ordered]@{
            Token = $utc.UtcDateTime.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
            At = $utc
        }
    } catch { return $null }
}

function ConvertTo-OwnedProcessIdentity($Process, $OwnedTask, [string]$ExpectedCreationDate = '') {
    if ([string]::IsNullOrWhiteSpace([string]$Process.ExecutablePath)) {
        return [pscustomobject][ordered]@{ State = 'indeterminate'; Identity = $null }
    }
    try { $actualExecutable = [IO.Path]::GetFullPath([string]$Process.ExecutablePath) } catch {
        return [pscustomobject][ordered]@{ State = 'indeterminate'; Identity = $null }
    }
    if (-not $actualExecutable.Equals([string]$OwnedTask.Executable, [StringComparison]::OrdinalIgnoreCase)) {
        return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null }
    }
    $commandLine = [string]$Process.CommandLine
    if ([string]::IsNullOrWhiteSpace($commandLine)) {
        return [pscustomobject][ordered]@{ State = 'indeterminate'; Identity = $null }
    }
    $quotedPrefix = "`"$actualExecutable`" "
    $plainPrefix = "$actualExecutable "
    if ($commandLine.StartsWith($quotedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        $processArguments = $commandLine.Substring($quotedPrefix.Length)
    } elseif ($commandLine.StartsWith($plainPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        $processArguments = $commandLine.Substring($plainPrefix.Length)
    } else {
        return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null }
    }
    if (-not $processArguments.Equals([string]$OwnedTask.Arguments, [StringComparison]::OrdinalIgnoreCase)) {
        return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null }
    }
    $creationStamp = ConvertTo-ProcessCreationStamp $Process.CreationDate
    if ($null -eq $creationStamp) {
        return [pscustomobject][ordered]@{ State = 'indeterminate'; Identity = $null }
    }
    $creationDate = [string]$creationStamp.Token
    if (-not [string]::IsNullOrWhiteSpace($ExpectedCreationDate) -and $creationDate -ne $ExpectedCreationDate) {
        return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null }
    }
    $identity = [pscustomobject][ordered]@{ ProcessId = [int64]$Process.ProcessId; CreationDate = $creationDate; CreationAt = $creationStamp.At }
    return [pscustomobject][ordered]@{ State = 'alive'; Identity = $identity }
}

function Get-OwnedProcessProbe([int64]$ProcessId, $OwnedTask, [string]$ExpectedCreationDate = '') {
    if ($ProcessId -le 0 -or $ProcessId -gt [int]::MaxValue) {
        return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null }
    }
    try {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
    } catch {
        return [pscustomobject][ordered]@{ State = 'indeterminate'; Identity = $null }
    }
    if ($null -eq $process) { return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null } }
    return ConvertTo-OwnedProcessIdentity $process $OwnedTask $ExpectedCreationDate
}

function Find-OwnedProcessCandidates($OwnedTask) {
    try { $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop) } catch {
        return [pscustomobject][ordered]@{ State = 'indeterminate'; Identities = @() }
    }
    $identities = [Collections.Generic.List[object]]::new()
    foreach ($process in $processes) {
        if (-not ([string]$process.Name).Equals([IO.Path]::GetFileName([string]$OwnedTask.Executable), [StringComparison]::OrdinalIgnoreCase)) { continue }
        $probe = ConvertTo-OwnedProcessIdentity $process $OwnedTask
        if ($probe.State -eq 'indeterminate') {
            return [pscustomobject][ordered]@{ State = 'indeterminate'; Identities = @() }
        }
        if ($probe.State -eq 'alive') { $identities.Add($probe.Identity) | Out-Null }
    }
    if ($identities.Count -eq 0) { return [pscustomobject][ordered]@{ State = 'none'; Identities = @() } }
    if ($identities.Count -eq 1) { return [pscustomobject][ordered]@{ State = 'unique'; Identities = @($identities[0]) } }
    return [pscustomobject][ordered]@{ State = 'multiple'; Identities = @($identities) }
}

function Read-Lease($OwnedTask) {
    $result = [ordered]@{
        valid = $false
        state = 'missing'
        ageSeconds = [double]::PositiveInfinity
        stateAgeSeconds = [double]::PositiveInfinity
        pid = 0
        pidAlive = $false
        pidState = 'missing'
        processIdentity = $null
        instanceId = ''
        stateSinceAt = $null
    }
    if (-not [IO.File]::Exists($resolvedLease)) { return [pscustomobject]$result }
    try {
        $lease = Get-Content -LiteralPath $resolvedLease -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([string]$lease.schemaVersion -ne '1.0' -or [string]$lease.service -ne 'xbb-executive-analyst-wecom') { throw 'Lease schema mismatch.' }
        if ([string]$lease.state -notin @('starting', 'running', 'stopped')) { throw 'Lease state mismatch.' }
        if (-not ($lease.PSObject.Properties.Name -contains 'stateSinceAt')) { throw 'Lease state timestamp is missing.' }
        if ([string]$lease.instanceId -notmatch '^[A-Za-z0-9-]{16,128}$') { throw 'Lease instance ID is invalid.' }
        $style = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
        $updatedAt = [DateTimeOffset]::Parse([string]$lease.updatedAt, [Globalization.CultureInfo]::InvariantCulture, $style)
        $stateSinceAt = [DateTimeOffset]::Parse([string]$lease.stateSinceAt, [Globalization.CultureInfo]::InvariantCulture, $style)
        $now = [DateTimeOffset]::UtcNow
        if ($updatedAt -gt $now.AddSeconds($futureSkewSeconds) -or $stateSinceAt -gt $now.AddSeconds($futureSkewSeconds)) { throw 'Lease timestamp is in the future.' }
        $leasePid = [int64]$lease.pid
        $processProbe = Get-OwnedProcessProbe $leasePid $OwnedTask
        if ($processProbe.State -eq 'alive' -and $processProbe.Identity.CreationAt -gt $stateSinceAt.AddSeconds(2)) {
            # 同 PID/命令的新进程不能继承旧代际租约，否则 PID 复用会被误报健康。
            $processProbe = [pscustomobject][ordered]@{ State = 'missing'; Identity = $null }
        }
        $result.valid = $true
        $result.state = [string]$lease.state
        $result.ageSeconds = [Math]::Max(0, ($now - $updatedAt).TotalSeconds)
        $result.stateAgeSeconds = [Math]::Max(0, ($now - $stateSinceAt).TotalSeconds)
        $result.pid = $leasePid
        $result.pidAlive = $processProbe.State -eq 'alive'
        $result.pidState = [string]$processProbe.State
        $result.processIdentity = $processProbe.Identity
        $result.instanceId = [string]$lease.instanceId
        $result.stateSinceAt = $stateSinceAt
    } catch {
        $result.state = 'invalid'
    }
    return [pscustomobject]$result
}

function Write-StartingLease {
    $parent = [IO.Path]::GetDirectoryName($resolvedLease)
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    $now = [DateTimeOffset]::UtcNow
    $instanceId = "watchdog-$([Guid]::NewGuid().ToString('N'))"
    $payload = [ordered]@{
        schemaVersion = '1.0'
        service = 'xbb-executive-analyst-wecom'
        state = 'starting'
        pid = 0
        instanceId = $instanceId
        stateSinceAtMs = $now.ToUnixTimeMilliseconds()
        stateSinceAt = $now.ToString('o')
        updatedAtMs = $now.ToUnixTimeMilliseconds()
        updatedAt = $now.ToString('o')
    }
    $temporary = "$resolvedLease.tmp-watchdog-$PID-$([Guid]::NewGuid().ToString('N'))"
    $backup = "$resolvedLease.bak-watchdog-$PID-$([Guid]::NewGuid().ToString('N'))"
    [IO.File]::WriteAllText($temporary, (($payload | ConvertTo-Json -Compress) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
    try {
        if ([IO.File]::Exists($resolvedLease)) { [IO.File]::Replace($temporary, $resolvedLease, $backup) } else { [IO.File]::Move($temporary, $resolvedLease) }
    } finally {
        if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
        if ([IO.File]::Exists($backup)) { [IO.File]::Delete($backup) }
    }
    return $instanceId
}

function Wait-TaskStopped([int]$TimeoutSeconds, $Identity, $OwnedTask) {
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $probe = if ($null -eq $Identity) {
            [pscustomobject][ordered]@{ State = 'missing'; Identity = $null }
        } else {
            Get-OwnedProcessProbe ([int64]$Identity.ProcessId) $OwnedTask ([string]$Identity.CreationDate)
        }
        if ($probe.State -eq 'indeterminate') { return [pscustomobject][ordered]@{ State = 'indeterminate' } }
        if ([string](Get-ExactTask).State -ne 'Running' -and $probe.State -eq 'missing') {
            return [pscustomobject][ordered]@{ State = 'stopped' }
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    return [pscustomobject][ordered]@{ State = 'timeout' }
}

function Stop-UniqueOwnedProcess($Identity, $OwnedTask) {
    if ($null -eq $Identity) { return }
    $probe = Get-OwnedProcessProbe ([int64]$Identity.ProcessId) $OwnedTask ([string]$Identity.CreationDate)
    if ($probe.State -eq 'indeterminate') { throw 'CIM 无法确认机器人进程身份；为避免误杀，本轮拒绝重启。' }
    if ($probe.State -eq 'alive') { Stop-Process -Id ([int]$Identity.ProcessId) -Force -ErrorAction Stop }
}

$maintenanceMutex = [Threading.Mutex]::new($false, "Local\Codex-XBB-WeCom-Maintenance-$TaskName")
$maintenanceMutexHeld = $false
try {
    try { $maintenanceMutexHeld = $maintenanceMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $maintenanceMutexHeld = $true }
    if (-not $maintenanceMutexHeld) {
        Write-Output ([ordered]@{ success = $true; action = 'maintenance-active'; taskName = $TaskName } | ConvertTo-Json -Compress)
        $maintenanceMutex.Dispose()
        exit 0
    }
} catch {
    $maintenanceMutex.Dispose()
    throw
}

try {
$task = Get-ExactTask
$ownedTask = Assert-MainTaskOwnership $task
$lease = Read-Lease $ownedTask
$taskRunning = [string]$task.State -eq 'Running'
$heartbeatFresh = $lease.valid -and $lease.ageSeconds -le $StaleSeconds

if ($lease.pidState -eq 'indeterminate') {
    Write-Output ([ordered]@{ success = $false; action = 'health-indeterminate'; taskName = $TaskName; reason = 'cim-unavailable' } | ConvertTo-Json -Compress)
    exit 2
}

# 新登录或手工刚启动时，主进程可能尚未写出第一份 starting 租约；仅给固定短宽限，
# 不依赖会被每分钟 IgnoreNew 触发刷新的 LastRunTime。
if ($taskRunning -and $lease.state -in @('missing', 'invalid')) {
    Start-Sleep -Seconds 10
    $task = Get-ExactTask
    $ownedTask = Assert-MainTaskOwnership $task
    $lease = Read-Lease $ownedTask
    $taskRunning = [string]$task.State -eq 'Running'
    $heartbeatFresh = $lease.valid -and $lease.ageSeconds -le $StaleSeconds
    if ($lease.pidState -eq 'indeterminate') {
        Write-Output ([ordered]@{ success = $false; action = 'health-indeterminate'; taskName = $TaskName; reason = 'cim-unavailable' } | ConvertTo-Json -Compress)
        exit 2
    }
}

if ($taskRunning -and $heartbeatFresh -and $lease.pidAlive -and $lease.state -eq 'running') {
    Write-Output ([ordered]@{ success = $true; action = 'healthy'; taskName = $TaskName; leaseAgeSeconds = [Math]::Round($lease.ageSeconds, 1) } | ConvertTo-Json -Compress)
    exit 0
}

if ($taskRunning -and $heartbeatFresh -and $lease.pidAlive -and $lease.state -eq 'starting' -and $lease.stateAgeSeconds -le $StartupGraceSeconds) {
    Write-Output ([ordered]@{ success = $true; action = 'startup-grace'; taskName = $TaskName; startupAgeSeconds = [Math]::Round($lease.stateAgeSeconds, 1) } | ConvertTo-Json -Compress)
    exit 0
}

$candidates = Find-OwnedProcessCandidates $ownedTask
if ($candidates.State -eq 'indeterminate') {
    Write-Output ([ordered]@{ success = $false; action = 'health-indeterminate'; taskName = $TaskName; reason = 'cim-unavailable' } | ConvertTo-Json -Compress)
    exit 2
}
if ($candidates.State -eq 'multiple') {
    Write-Output ([ordered]@{ success = $false; action = 'ambiguous-orphans'; taskName = $TaskName; candidateCount = @($candidates.Identities).Count } | ConvertTo-Json -Compress)
    exit 3
}
$oldProcessIdentity = if ($candidates.State -eq 'unique') { @($candidates.Identities)[0] } else { $null }

Disable-ScheduledTask -TaskName $TaskName -TaskPath $taskPath -ErrorAction Stop | Out-Null
$oldInstanceId = [string]$lease.instanceId
$enableForRestart = $false
try {
    if ($taskRunning -or [string](Get-ExactTask).State -eq 'Running') {
        Stop-ScheduledTask -TaskName $TaskName -TaskPath $taskPath -ErrorAction Stop
    }
    # 任务可能已显示 Ready，但旧 nodew 因调度器状态漂移成为孤儿；仍必须在启动
    # 新代际前等待并仅终止经过完整可执行文件与参数校验的旧进程。
    $stopped = Wait-TaskStopped 15 $oldProcessIdentity $ownedTask
    if ($stopped.State -eq 'indeterminate') { throw 'CIM 无法确认旧机器人进程是否退出；主任务保持禁用，等待下轮安全恢复。' }
    if ($stopped.State -eq 'timeout') {
        Stop-UniqueOwnedProcess $oldProcessIdentity $ownedTask
        $stopped = Wait-TaskStopped 5 $oldProcessIdentity $ownedTask
        if ($stopped.State -eq 'indeterminate') { throw 'CIM 无法确认强制终止结果；主任务保持禁用，等待下轮安全恢复。' }
        if ($stopped.State -ne 'stopped') { throw '机器人主任务或旧租约进程未停止，拒绝并行启动第二实例。' }
    }

    # lease PID 可能为空或已复用；任务停止后再次枚举，只处理唯一且完整匹配的孤儿。
    $remaining = Find-OwnedProcessCandidates $ownedTask
    if ($remaining.State -eq 'indeterminate') { throw 'CIM 无法确认是否存在机器人孤儿进程；主任务保持禁用。' }
    if ($remaining.State -eq 'multiple') { throw '发现多个完整匹配的机器人孤儿进程；拒绝猜测或批量终止。' }
    if ($remaining.State -eq 'unique') {
        $remainingIdentity = @($remaining.Identities)[0]
        Stop-UniqueOwnedProcess $remainingIdentity $ownedTask
        $remainingStopped = Wait-TaskStopped 5 $remainingIdentity $ownedTask
        if ($remainingStopped.State -eq 'indeterminate') { throw 'CIM 无法确认孤儿进程终止结果；主任务保持禁用。' }
        if ($remainingStopped.State -ne 'stopped') { throw '唯一匹配的机器人孤儿进程未退出；拒绝启动第二实例。' }
    }
    $finalCandidates = Find-OwnedProcessCandidates $ownedTask
    if ($finalCandidates.State -eq 'indeterminate') { throw 'CIM 无法完成启动前最终进程确认；主任务保持禁用。' }
    if ($finalCandidates.State -ne 'none') { throw '启动前仍存在机器人进程；拒绝并行启动第二实例。' }

    # 只有旧任务和严格匹配进程都已确认退出、且重启标记落盘后才重新启用任务。
    $restartRequestedAt = [DateTimeOffset]::UtcNow
    $restartMarkerId = Write-StartingLease
    $enableForRestart = $true
} finally {
    if ($enableForRestart) {
        Enable-ScheduledTask -TaskName $TaskName -TaskPath $taskPath -ErrorAction Stop | Out-Null
    }
}

Start-ScheduledTask -TaskName $TaskName -TaskPath $taskPath -ErrorAction Stop
$readyDeadline = [DateTimeOffset]::UtcNow.AddSeconds(60)
$runtimeStarted = $false
do {
    Start-Sleep -Milliseconds 500
    $task = Get-ExactTask
    $ownedTask = Assert-MainTaskOwnership $task
    $lease = Read-Lease $ownedTask
    if ($lease.pidState -eq 'indeterminate') { throw 'CIM 无法确认新机器人进程身份；保留当前任务并等待下轮复查。' }
    $newGeneration = $lease.valid -and $lease.instanceId -ne $restartMarkerId -and $lease.instanceId -ne $oldInstanceId -and $null -ne $lease.stateSinceAt -and $lease.stateSinceAt -ge $restartRequestedAt
    if ([string]$task.State -eq 'Running' -and $newGeneration -and $lease.pidAlive -and $lease.state -eq 'running' -and $lease.ageSeconds -le $StaleSeconds) {
        $runtimeStarted = $true
        break
    }
} while ([DateTimeOffset]::UtcNow -lt $readyDeadline)

if (-not $runtimeStarted) { throw '机器人主任务已请求重启，但 60 秒内没有形成有效 running 租约。' }
Write-Output ([ordered]@{ success = $true; action = 'restarted'; taskName = $TaskName; leaseState = $lease.state; leaseAgeSeconds = [Math]::Round($lease.ageSeconds, 1); runtimeStarted = $true } | ConvertTo-Json -Compress)
} finally {
    if ($maintenanceMutexHeld) { try { $maintenanceMutex.ReleaseMutex() } catch {} }
    $maintenanceMutex.Dispose()
}
