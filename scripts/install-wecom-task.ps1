[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')]
    [string]$TaskName = 'Codex-XBB-Executive-Analyst-WeCom',
    [string]$ConfigPath = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Codex\xbb-executive-analyst\bot-config.json')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$taskPath = '\'
$server = [IO.Path]::GetFullPath((Join-Path $projectRoot 'shared\wecom\server.js'))
$watchdogScript = [IO.Path]::GetFullPath((Join-Path $projectRoot 'scripts\watchdog-wecom-task.ps1'))
$watchdogTaskName = "$TaskName-Watchdog"
$hiddenNodeInstaller = Join-Path $projectRoot 'scripts\install-hidden-node.ps1'
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$runtimeRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Codex\xbb-executive-analyst\bin'
$hiddenNodePath = Join-Path $runtimeRoot 'nodew.exe'
$hiddenNodeHashPath = Join-Path $runtimeRoot 'nodew.source.sha256'
$powerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$mainTaskDescription = '无控制台 Node + Codex App Server + xbb-executive-analyst Skill 企业微信智能 Agent（异常退出自动重启）'
$watchdogTaskDescription = '外部租约看门狗：检测机器人进程卡死并重启主计划任务'
$defaultConfigPath = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Codex\xbb-executive-analyst\bot-config.json'))
$configPath = [IO.Path]::GetFullPath($ConfigPath)
if (-not (Test-Path -LiteralPath $server -PathType Leaf)) { throw "服务入口不存在：$server" }
if (-not (Test-Path -LiteralPath $watchdogScript -PathType Leaf)) { throw "外部看门狗不存在：$watchdogScript" }
if (-not (Test-Path -LiteralPath $hiddenNodeInstaller -PathType Leaf)) { throw "无控制台 Node 安装器不存在：$hiddenNodeInstaller" }
if (-not (Test-Path -LiteralPath $powerShellPath -PathType Leaf)) { throw "Windows PowerShell 不存在：$powerShellPath" }
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw "机器人安全配置不存在，请先运行 configure-bot.ps1：$configPath" }
$storedConfig = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$defaultLeasePath = Join-Path ([IO.Path]::GetDirectoryName($configPath)) 'service-lease.json'
$leasePath = if ($storedConfig.PSObject.Properties.Name -contains 'serviceLeasePath' -and -not [string]::IsNullOrWhiteSpace([string]$storedConfig.serviceLeasePath)) {
    [IO.Path]::GetFullPath([string]$storedConfig.serviceLeasePath)
} else {
    [IO.Path]::GetFullPath($defaultLeasePath)
}
$defaultStatusLogPath = Join-Path ([IO.Path]::GetDirectoryName($configPath)) 'status.jsonl'
$statusLogPath = if ($storedConfig.PSObject.Properties.Name -contains 'statusLogPath' -and -not [string]::IsNullOrWhiteSpace([string]$storedConfig.statusLogPath)) {
    [IO.Path]::GetFullPath([string]$storedConfig.statusLogPath)
} else {
    [IO.Path]::GetFullPath($defaultStatusLogPath)
}
$newMainArguments = "`"$server`" --managed-config `"$configPath`""
$newMainMetadata = [pscustomobject][ordered]@{
    Executable = [IO.Path]::GetFullPath($hiddenNodePath)
    Arguments = $newMainArguments
    ConfigPath = $configPath
    LeasePath = ''
}

function Get-ExactTask([string]$Name) {
    # 枚举根路径可以把“确实不存在”表示为空，同时让 ScheduledTasks/CIM provider
    # 故障继续抛错；不能把 provider 故障误当成可安全覆盖的空槽位。
    $matches = @(Get-ScheduledTask -TaskPath $taskPath -ErrorAction Stop | Where-Object {
        ([string]$_.TaskName).Equals($Name, [StringComparison]::OrdinalIgnoreCase) -and
        ([string]$_.TaskPath).Equals($taskPath, [StringComparison]::OrdinalIgnoreCase)
    })
    if ($matches.Count -gt 1) { throw "检测到多个同名计划任务，拒绝继续：$Name" }
    if ($matches.Count -eq 0) { return $null }
    return $matches[0]
}

function Assert-OwnedTask($Task, [string]$Name) {
    $actions = @($Task.Actions)
    if ($actions.Count -ne 1) { throw "计划任务名称已被其他任务占用：$Name" }
    try { $actualExecutable = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables([string]$actions[0].Execute)) } catch {
        throw "计划任务执行文件无效，拒绝覆盖：$Name"
    }
    $argument = [string]$actions[0].Arguments
    $description = [string]$Task.Description
    if ($Name -eq $TaskName) {
        $expectedExecutable = [IO.Path]::GetFullPath($hiddenNodePath)
        $argumentPattern = '^' + [regex]::Escape("`"$server`"") + '(?: --managed-config "(?<configPath>[^\r\n"]+)")?$'
        $expectedDescription = $mainTaskDescription
    } else {
        $expectedExecutable = [IO.Path]::GetFullPath($powerShellPath)
        $argumentPrefix = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$watchdogScript`" -TaskName `"$TaskName`" -LeasePath `""
        $argumentPattern = '^' + [regex]::Escape($argumentPrefix) + '(?<leasePath>[^\r\n"]+)' + [regex]::Escape('" -StaleSeconds 180') + '$'
        $expectedDescription = $watchdogTaskDescription
    }
    $argumentMatch = [regex]::Match($argument, $argumentPattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    $managedPathGroup = if ($Name -eq $TaskName) { 'configPath' } else { 'leasePath' }
    $managedPathValid = $true
    if ($argumentMatch.Success -and $argumentMatch.Groups[$managedPathGroup].Success) {
        try {
            $managedPath = [string]$argumentMatch.Groups[$managedPathGroup].Value
            $managedPathValid = [IO.Path]::IsPathRooted($managedPath) -and -not [string]::IsNullOrWhiteSpace([IO.Path]::GetFullPath($managedPath))
        } catch { $managedPathValid = $false }
    }
    $owned = $actualExecutable.Equals($expectedExecutable, [StringComparison]::OrdinalIgnoreCase) -and
        $argumentMatch.Success -and $managedPathValid -and
        $description.Equals($expectedDescription, [StringComparison]::Ordinal)
    if (-not $owned) {
        throw "计划任务名称已被非本机器人任务占用，拒绝覆盖：$Name"
    }
    $ownedConfigPath = if ($Name -eq $TaskName -and $argumentMatch.Groups['configPath'].Success) {
        [IO.Path]::GetFullPath([string]$argumentMatch.Groups['configPath'].Value)
    } elseif ($Name -eq $TaskName) { $defaultConfigPath } else { '' }
    $ownedLeasePath = if ($Name -ne $TaskName) { [IO.Path]::GetFullPath([string]$argumentMatch.Groups['leasePath'].Value) } else { '' }
    return [pscustomobject][ordered]@{
        Executable = $actualExecutable
        Arguments = $argument
        ConfigPath = $ownedConfigPath
        LeasePath = $ownedLeasePath
    }
}

function Export-OwnedTaskBackup([string]$Name) {
    $task = Get-ExactTask $Name
    if ($null -eq $task) {
        return [pscustomobject][ordered]@{ Name = $Name; Exists = $false; WasEnabled = $false; WasRunning = $false; Xml = ''; Metadata = $null }
    }
    $metadata = Assert-OwnedTask $task $Name
    $xml = Export-ScheduledTask -TaskName $Name -TaskPath $taskPath -ErrorAction Stop
    if ([string]::IsNullOrWhiteSpace([string]$xml)) { throw "计划任务备份为空，拒绝升级：$Name" }
    return [pscustomobject][ordered]@{
        Name = $Name
        Exists = $true
        WasEnabled = [bool]$task.Settings.Enabled
        WasRunning = [string]$task.State -eq 'Running'
        Xml = [string]$xml
        Metadata = $metadata
    }
}

function Remove-ExistingTaskForUpgrade([string]$Name) {
    $task = Get-ExactTask $Name
    if ($null -eq $task) { return }
    [void](Assert-OwnedTask $task $Name)
    $wasRunning = [string]$task.State -eq 'Running'
    Disable-ScheduledTask -TaskName $Name -TaskPath $taskPath -ErrorAction Stop | Out-Null
    $currentTask = Get-ExactTask $Name
    if ($wasRunning -or ($null -ne $currentTask -and [string]$currentTask.State -eq 'Running')) {
        Stop-ScheduledTask -TaskName $Name -TaskPath $taskPath -ErrorAction Stop
    }
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(15)
    do {
        $currentTask = Get-ExactTask $Name
        if ($null -eq $currentTask -or [string]$currentTask.State -ne 'Running') { break }
        Start-Sleep -Milliseconds 250
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    $currentTask = Get-ExactTask $Name
    if ($null -ne $currentTask -and [string]$currentTask.State -eq 'Running') { throw "计划任务未能安全停止：$Name" }
    if ($null -eq $currentTask) { return }
    Unregister-ScheduledTask -TaskName $Name -TaskPath $taskPath -Confirm:$false -ErrorAction Stop
}

function Get-DisabledTaskXml([string]$Xml, [string]$Name) {
    try {
        [xml]$document = $Xml
        $enabled = $document.SelectSingleNode("/*[local-name()='Task']/*[local-name()='Settings']/*[local-name()='Enabled']")
        if ($null -eq $enabled) { throw 'Task XML has no Settings/Enabled element.' }
        $enabled.InnerText = 'false'
        return $document.OuterXml
    } catch { throw "无法把备份任务转换为安全禁用态，拒绝恢复：$Name" }
}

function Restore-TaskBackup($Backup) {
    if (-not $Backup.Exists) { return }
    if ($null -ne (Get-ExactTask ([string]$Backup.Name))) { throw "恢复旧计划任务前目标名称仍被占用：$($Backup.Name)" }
    $disabledXml = Get-DisabledTaskXml ([string]$Backup.Xml) ([string]$Backup.Name)
    Register-ScheduledTask -TaskName ([string]$Backup.Name) -TaskPath $taskPath -Xml $disabledXml -Force -ErrorAction Stop | Out-Null
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

function ConvertTo-ManagedProcessIdentity($Process, $Metadata, [string]$ExpectedCreationDate = '') {
    if ([string]::IsNullOrWhiteSpace([string]$Process.ExecutablePath)) {
        return [pscustomobject][ordered]@{ State = 'indeterminate'; Identity = $null }
    }
    try { $actualExecutable = [IO.Path]::GetFullPath([string]$Process.ExecutablePath) } catch {
        return [pscustomobject][ordered]@{ State = 'indeterminate'; Identity = $null }
    }
    if (-not $actualExecutable.Equals([string]$Metadata.Executable, [StringComparison]::OrdinalIgnoreCase)) {
        return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null }
    }
    $commandLine = [string]$Process.CommandLine
    if ([string]::IsNullOrWhiteSpace($commandLine)) { return [pscustomobject][ordered]@{ State = 'indeterminate'; Identity = $null } }
    $quotedPrefix = "`"$actualExecutable`" "
    $plainPrefix = "$actualExecutable "
    if ($commandLine.StartsWith($quotedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        $processArguments = $commandLine.Substring($quotedPrefix.Length)
    } elseif ($commandLine.StartsWith($plainPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        $processArguments = $commandLine.Substring($plainPrefix.Length)
    } else { return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null } }
    if (-not $processArguments.Equals([string]$Metadata.Arguments, [StringComparison]::OrdinalIgnoreCase)) {
        return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null }
    }
    $creationStamp = ConvertTo-ProcessCreationStamp $Process.CreationDate
    if ($null -eq $creationStamp) { return [pscustomobject][ordered]@{ State = 'indeterminate'; Identity = $null } }
    $creationDate = [string]$creationStamp.Token
    if (-not [string]::IsNullOrWhiteSpace($ExpectedCreationDate) -and $creationDate -ne $ExpectedCreationDate) {
        return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null }
    }
    $identity = [pscustomobject][ordered]@{ ProcessId = [int64]$Process.ProcessId; CreationDate = $creationDate; CreationAt = $creationStamp.At }
    return [pscustomobject][ordered]@{ State = 'alive'; Identity = $identity }
}

function Get-ManagedProcessProbe([int64]$ProcessId, $Metadata, [string]$ExpectedCreationDate = '') {
    if ($ProcessId -le 0 -or $ProcessId -gt [int]::MaxValue) { return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null } }
    try { $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop } catch {
        return [pscustomobject][ordered]@{ State = 'indeterminate'; Identity = $null }
    }
    if ($null -eq $process) { return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null } }
    return ConvertTo-ManagedProcessIdentity $process $Metadata $ExpectedCreationDate
}

function Find-ManagedProcessCandidates($Metadata) {
    if ($null -eq $Metadata) { return [pscustomobject][ordered]@{ State = 'none'; Identities = @() } }
    try { $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop) } catch {
        return [pscustomobject][ordered]@{ State = 'indeterminate'; Identities = @() }
    }
    $identities = [Collections.Generic.List[object]]::new()
    foreach ($process in $processes) {
        if (-not ([string]$process.Name).Equals([IO.Path]::GetFileName([string]$Metadata.Executable), [StringComparison]::OrdinalIgnoreCase)) { continue }
        $probe = ConvertTo-ManagedProcessIdentity $process $Metadata
        if ($probe.State -eq 'indeterminate') { return [pscustomobject][ordered]@{ State = 'indeterminate'; Identities = @() } }
        if ($probe.State -eq 'alive') { $identities.Add($probe.Identity) | Out-Null }
    }
    if ($identities.Count -eq 0) { return [pscustomobject][ordered]@{ State = 'none'; Identities = @() } }
    if ($identities.Count -eq 1) { return [pscustomobject][ordered]@{ State = 'unique'; Identities = @($identities[0]) } }
    return [pscustomobject][ordered]@{ State = 'multiple'; Identities = @($identities) }
}

function Wait-ManagedProcessExit($Identity, $Metadata, [int]$TimeoutSeconds) {
    if ($null -eq $Identity) { return [pscustomobject][ordered]@{ State = 'stopped' } }
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $probe = Get-ManagedProcessProbe ([int64]$Identity.ProcessId) $Metadata ([string]$Identity.CreationDate)
        if ($probe.State -eq 'indeterminate') { return [pscustomobject][ordered]@{ State = 'indeterminate' } }
        if ($probe.State -eq 'missing') { return [pscustomobject][ordered]@{ State = 'stopped' } }
        Start-Sleep -Milliseconds 250
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    return [pscustomobject][ordered]@{ State = 'timeout' }
}

function Stop-ManagedProcessIdentity($Identity, $Metadata) {
    if ($null -eq $Identity) { return }
    $probe = Get-ManagedProcessProbe ([int64]$Identity.ProcessId) $Metadata ([string]$Identity.CreationDate)
    if ($probe.State -eq 'indeterminate') { throw 'CIM 无法确认机器人进程身份；拒绝强制终止。' }
    if ($probe.State -eq 'alive') { Stop-Process -Id ([int]$Identity.ProcessId) -Force -ErrorAction Stop }
}

function Ensure-ManagedProcessesStopped($Metadata, $KnownIdentity = $null) {
    if ($null -eq $Metadata) { return }
    if ($null -ne $KnownIdentity) {
        $wait = Wait-ManagedProcessExit $KnownIdentity $Metadata 15
        if ($wait.State -eq 'indeterminate') { throw 'CIM 无法确认升级前机器人进程是否退出。' }
        if ($wait.State -eq 'timeout') {
            Stop-ManagedProcessIdentity $KnownIdentity $Metadata
            $wait = Wait-ManagedProcessExit $KnownIdentity $Metadata 5
            if ($wait.State -ne 'stopped') { throw '升级前机器人进程未能安全退出。' }
        }
    }
    $remaining = Find-ManagedProcessCandidates $Metadata
    if ($remaining.State -eq 'indeterminate') { throw 'CIM 无法确认机器人孤儿进程。' }
    if ($remaining.State -eq 'multiple') { throw '发现多个完整匹配的机器人进程；拒绝批量终止。' }
    if ($remaining.State -eq 'unique') {
        $identity = @($remaining.Identities)[0]
        Stop-ManagedProcessIdentity $identity $Metadata
        $wait = Wait-ManagedProcessExit $identity $Metadata 5
        if ($wait.State -ne 'stopped') { throw '唯一匹配的机器人孤儿进程未能安全退出。' }
    }
    $final = Find-ManagedProcessCandidates $Metadata
    if ($final.State -eq 'indeterminate') { throw 'CIM 无法完成机器人进程最终确认。' }
    if ($final.State -ne 'none') { throw '升级前仍存在完整匹配的机器人进程。' }
}

function Resolve-ManagedRuntimePaths($MainMetadata, $WatchdogMetadata = $null) {
    $managedConfig = [IO.Path]::GetFullPath([string]$MainMetadata.ConfigPath)
    if (-not [IO.File]::Exists($managedConfig)) { throw "旧机器人配置不存在，无法提供可验证回滚：$managedConfig" }
    $stored = Get-Content -LiteralPath $managedConfig -Raw -Encoding UTF8 | ConvertFrom-Json
    $parent = [IO.Path]::GetDirectoryName($managedConfig)
    $managedLease = if ($null -ne $WatchdogMetadata -and -not [string]::IsNullOrWhiteSpace([string]$WatchdogMetadata.LeasePath)) {
        [IO.Path]::GetFullPath([string]$WatchdogMetadata.LeasePath)
    } elseif ($stored.PSObject.Properties.Name -contains 'serviceLeasePath' -and -not [string]::IsNullOrWhiteSpace([string]$stored.serviceLeasePath)) {
        [IO.Path]::GetFullPath([string]$stored.serviceLeasePath)
    } else { [IO.Path]::GetFullPath((Join-Path $parent 'service-lease.json')) }
    $managedStatus = if ($stored.PSObject.Properties.Name -contains 'statusLogPath' -and -not [string]::IsNullOrWhiteSpace([string]$stored.statusLogPath)) {
        [IO.Path]::GetFullPath([string]$stored.statusLogPath)
    } else { [IO.Path]::GetFullPath((Join-Path $parent 'status.jsonl')) }
    return [pscustomobject][ordered]@{ LeasePath = $managedLease; StatusPath = $managedStatus }
}

function Get-ManagedLeaseHealth([string]$ManagedLeasePath, $Metadata, [DateTimeOffset]$NotBefore) {
    if (-not [IO.File]::Exists($ManagedLeasePath)) { return [pscustomobject][ordered]@{ State = 'unhealthy'; InstanceId = ''; StateSinceAt = $null } }
    try {
        $lease = Get-Content -LiteralPath $ManagedLeasePath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([string]$lease.schemaVersion -ne '1.0' -or [string]$lease.service -ne 'xbb-executive-analyst-wecom' -or [string]$lease.state -ne 'running') {
            return [pscustomobject][ordered]@{ State = 'unhealthy'; InstanceId = ''; StateSinceAt = $null }
        }
        if ([string]$lease.instanceId -notmatch '^[A-Za-z0-9-]{16,128}$') { return [pscustomobject][ordered]@{ State = 'unhealthy'; InstanceId = ''; StateSinceAt = $null } }
        $style = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
        $updatedAt = [DateTimeOffset]::Parse([string]$lease.updatedAt, [Globalization.CultureInfo]::InvariantCulture, $style)
        $stateSinceAt = [DateTimeOffset]::Parse([string]$lease.stateSinceAt, [Globalization.CultureInfo]::InvariantCulture, $style)
        $now = [DateTimeOffset]::UtcNow
        if ($updatedAt -lt $NotBefore -or $stateSinceAt -lt $NotBefore -or $updatedAt -gt $now.AddSeconds(60) -or ($now - $updatedAt).TotalSeconds -gt 180) {
            return [pscustomobject][ordered]@{ State = 'unhealthy'; InstanceId = ''; StateSinceAt = $null }
        }
        $probe = Get-ManagedProcessProbe ([int64]$lease.pid) $Metadata
        if ($probe.State -eq 'indeterminate') { return [pscustomobject][ordered]@{ State = 'indeterminate'; InstanceId = ''; StateSinceAt = $null } }
        if ($probe.State -ne 'alive') { return [pscustomobject][ordered]@{ State = 'unhealthy'; InstanceId = ''; StateSinceAt = $null } }
        if ($probe.Identity.CreationAt -lt $NotBefore -or $probe.Identity.CreationAt -gt $stateSinceAt.AddSeconds(2)) {
            return [pscustomobject][ordered]@{ State = 'unhealthy'; InstanceId = ''; StateSinceAt = $null }
        }
        return [pscustomobject][ordered]@{ State = 'healthy'; InstanceId = [string]$lease.instanceId; StateSinceAt = $stateSinceAt }
    } catch { return [pscustomobject][ordered]@{ State = 'unhealthy'; InstanceId = ''; StateSinceAt = $null } }
}

function Wait-ManagedRuntimeHealthy([string]$Name, [string]$ManagedLeasePath, [string]$ManagedStatusPath, $Metadata, [DateTimeOffset]$NotBefore, [int]$TimeoutSeconds) {
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try {
            $task = Get-ExactTask $Name
            $health = Get-ManagedLeaseHealth $ManagedLeasePath $Metadata $NotBefore
            if ($health.State -eq 'indeterminate') { return [pscustomobject][ordered]@{ State = 'indeterminate' } }
            if ($null -ne $task -and [string]$task.State -eq 'Running' -and $health.State -eq 'healthy' -and
                (Test-NewReadyStatus $ManagedStatusPath $health.StateSinceAt $health.InstanceId)) {
                return [pscustomobject][ordered]@{ State = 'healthy'; InstanceId = $health.InstanceId }
            }
        } catch { return [pscustomobject][ordered]@{ State = 'indeterminate' } }
        Start-Sleep -Milliseconds 500
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    return [pscustomobject][ordered]@{ State = 'timeout' }
}

function Read-LeaseState {
    if (-not [IO.File]::Exists($leasePath)) { return $null }
    try { return Get-Content -LiteralPath $leasePath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
}

function Test-ManagedProcess([int64]$ProcessId) {
    return (Get-ManagedProcessProbe $ProcessId $newMainMetadata).State -eq 'alive'
}

function Test-LaunchLease($Lease, [DateTimeOffset]$NotBefore, [string]$RequiredState = '') {
    if ($null -eq $Lease -or [string]$Lease.instanceId -notmatch '^[A-Za-z0-9-]{16,128}$') { return $false }
    if ([string]$Lease.state -notin @('starting', 'running')) { return $false }
    if (-not [string]::IsNullOrWhiteSpace($RequiredState) -and [string]$Lease.state -ne $RequiredState) { return $false }
    try {
        $updatedAt = [DateTimeOffset]::Parse([string]$Lease.updatedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal)
        $stateSinceAt = [DateTimeOffset]::Parse([string]$Lease.stateSinceAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal)
        $probe = Get-ManagedProcessProbe ([int64]$Lease.pid) $newMainMetadata
        return $updatedAt -ge $NotBefore -and $stateSinceAt -ge $NotBefore -and
            $probe.State -eq 'alive' -and $probe.Identity.CreationAt -ge $NotBefore -and
            $probe.Identity.CreationAt -le $stateSinceAt.AddSeconds(2)
    } catch { return $false }
}

function Test-NewReadyStatus([string]$ManagedStatusPath, [DateTimeOffset]$NotBefore, [string]$InstanceId) {
    if ([string]$InstanceId -notmatch '^[A-Za-z0-9-]{16,128}$' -or -not [IO.File]::Exists($ManagedStatusPath)) { return $false }
    $now = [DateTimeOffset]::UtcNow
    try { $lines = @(Get-Content -LiteralPath $ManagedStatusPath -Tail 200 -Encoding UTF8 -ErrorAction Stop) } catch { return $false }
    foreach ($line in $lines) {
        try {
            $entry = $line | ConvertFrom-Json
            if ([string]$entry.status -ne 'ready' -or [string]$entry.instanceId -cne $InstanceId) { continue }
            $at = [DateTimeOffset]::Parse([string]$entry.at, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal)
            if ($at -ge $NotBefore -and $at -le $now.AddSeconds(60)) { return $true }
        } catch {}
    }
    return $false
}

$maintenanceMutex = [Threading.Mutex]::new($false, "Local\Codex-XBB-WeCom-Maintenance-$TaskName")
$maintenanceMutexHeld = $false
try {
    try { $maintenanceMutexHeld = $maintenanceMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $maintenanceMutexHeld = $true }
    if (-not $maintenanceMutexHeld) { throw '另一个机器人安装、卸载或看门狗维护操作正在进行；未修改任何计划任务。' }
} catch {
    $maintenanceMutex.Dispose()
    throw
}

try {
$mainTaskBackup = Export-OwnedTaskBackup $TaskName
$watchdogTaskBackup = Export-OwnedTaskBackup $watchdogTaskName
$oldProcessIdentity = $null
$preexistingNewProcessIdentity = $null
$oldRuntimePaths = $null
$shouldRestoreRuntime = $false
$preflightIdentities = [Collections.Generic.List[object]]::new()
if ($mainTaskBackup.Exists) {
    $oldCandidates = Find-ManagedProcessCandidates $mainTaskBackup.Metadata
    if ($oldCandidates.State -eq 'indeterminate') { throw 'CIM 无法确认升级前机器人进程；未修改任何计划任务。' }
    if ($oldCandidates.State -eq 'multiple') { throw '升级前发现多个完整匹配的机器人进程；未修改任何计划任务。' }
    if ($oldCandidates.State -eq 'unique') {
        $oldProcessIdentity = @($oldCandidates.Identities)[0]
        $preflightIdentities.Add($oldProcessIdentity) | Out-Null
    }
    $shouldRestoreRuntime = $mainTaskBackup.WasRunning -or $oldCandidates.State -eq 'unique'
    $oldWatchdogMetadata = if ($watchdogTaskBackup.Exists) { $watchdogTaskBackup.Metadata } else { $null }
    $oldRuntimePaths = Resolve-ManagedRuntimePaths $mainTaskBackup.Metadata $oldWatchdogMetadata
}

# 即使主任务缺失，也可能残留 exact nodew+server 孤儿；仅允许唯一候选进入可控清理。
# 旧任务参数与本次新参数相同时已在上面枚举，不重复计数。
$oldUsesNewArguments = $mainTaskBackup.Exists -and
    ([string]$mainTaskBackup.Metadata.Executable).Equals([string]$newMainMetadata.Executable, [StringComparison]::OrdinalIgnoreCase) -and
    ([string]$mainTaskBackup.Metadata.Arguments).Equals([string]$newMainMetadata.Arguments, [StringComparison]::OrdinalIgnoreCase)
if (-not $oldUsesNewArguments) {
    $newCandidates = Find-ManagedProcessCandidates $newMainMetadata
    if ($newCandidates.State -eq 'indeterminate') { throw 'CIM 无法确认安装前机器人孤儿进程；未修改任何计划任务。' }
    if ($newCandidates.State -eq 'multiple') { throw '安装前发现多个完整匹配的机器人孤儿进程；未修改任何计划任务。' }
    if ($newCandidates.State -eq 'unique') {
        $preexistingNewProcessIdentity = @($newCandidates.Identities)[0]
        $preflightIdentities.Add($preexistingNewProcessIdentity) | Out-Null
    }
}
if ($preflightIdentities.Count -gt 1) { throw '安装前发现多个不同代际的机器人进程；未修改任何计划任务。' }

try {
    Remove-ExistingTaskForUpgrade $watchdogTaskName
    Remove-ExistingTaskForUpgrade $TaskName
    if ($mainTaskBackup.Exists) { Ensure-ManagedProcessesStopped $mainTaskBackup.Metadata $oldProcessIdentity }
    if (-not $oldUsesNewArguments) { Ensure-ManagedProcessesStopped $newMainMetadata $preexistingNewProcessIdentity }

    & $hiddenNodeInstaller -NodePath $nodePath -OutputPath $hiddenNodePath -HashPath $hiddenNodeHashPath | Out-Null
    [IO.File]::Delete((Join-Path $runtimeRoot 'xbb-wecom-hidden-launcher.exe'))
    [IO.File]::Delete((Join-Path $runtimeRoot 'xbb-wecom-hidden-launcher.sha256'))

    $action = New-ScheduledTaskAction -Execute $hiddenNodePath -Argument $newMainArguments -WorkingDirectory $projectRoot
    $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
    $recoveryTrigger = New-ScheduledTaskTrigger `
        -Once `
        -At (Get-Date).AddMinutes(1) `
        -RepetitionInterval (New-TimeSpan -Minutes 1) `
        -RepetitionDuration (New-TimeSpan -Days 3650)
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    $settings.IdleSettings.RestartOnIdle = $true
    $settings.Hidden = $true
    $task = New-ScheduledTask -Action $action -Trigger @($logonTrigger, $recoveryTrigger) -Principal $principal -Settings $settings -Description $mainTaskDescription
    Register-ScheduledTask -TaskName $TaskName -TaskPath $taskPath -InputObject $task -Force | Out-Null
    $watchdogArguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$watchdogScript`" -TaskName `"$TaskName`" -LeasePath `"$leasePath`" -StaleSeconds 180"
    $watchdogAction = New-ScheduledTaskAction -Execute $powerShellPath -Argument $watchdogArguments -WorkingDirectory $projectRoot
    $watchdogLogonTrigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
    $watchdogLogonTrigger.Delay = 'PT30S'
    $watchdogRecoveryTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
    $watchdogSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    $watchdogSettings.Hidden = $true
    $watchdogTask = New-ScheduledTask -Action $watchdogAction -Trigger @($watchdogLogonTrigger, $watchdogRecoveryTrigger) -Principal $principal -Settings $watchdogSettings -Description $watchdogTaskDescription
    Register-ScheduledTask -TaskName $watchdogTaskName -TaskPath $taskPath -InputObject $watchdogTask -Force | Out-Null
    $launchRequestedAt = [DateTimeOffset]::UtcNow.AddSeconds(-2)
    Start-ScheduledTask -TaskName $TaskName -TaskPath $taskPath -ErrorAction Stop
    $leaseObservedDeadline = [DateTimeOffset]::UtcNow.AddSeconds(15)
    do {
        $launchLease = Read-LeaseState
        if (Test-LaunchLease $launchLease $launchRequestedAt) { break }
        Start-Sleep -Milliseconds 250
    } while ([DateTimeOffset]::UtcNow -lt $leaseObservedDeadline)
    Start-ScheduledTask -TaskName $watchdogTaskName -TaskPath $taskPath -ErrorAction Stop

    $readyDeadline = [DateTimeOffset]::UtcNow.AddSeconds(120)
    $runtimeStarted = $false
    $authenticated = $false
    do {
        $mainTask = Get-ExactTask $TaskName
        $health = Get-ManagedLeaseHealth $leasePath $newMainMetadata $launchRequestedAt
        if ($health.State -eq 'indeterminate') { throw 'CIM 无法确认新机器人进程；安装器进入安全回滚。' }
        $runtimeStarted = $null -ne $mainTask -and [string]$mainTask.State -eq 'Running' -and $health.State -eq 'healthy'
        if ($runtimeStarted -and (Test-NewReadyStatus $statusLogPath $health.StateSinceAt $health.InstanceId)) {
            $authenticated = $true
            break
        }
        Start-Sleep -Milliseconds 500
    } while ([DateTimeOffset]::UtcNow -lt $readyDeadline)

    if (-not $runtimeStarted) { throw '机器人任务已安装，但 120 秒内没有形成有效 running 租约。' }
    if (-not $authenticated) { throw '机器人运行时已启动，但 120 秒内未通过企业微信认证。' }

    Write-Output ([ordered]@{ success = $true; taskName = $TaskName; watchdogTaskName = $watchdogTaskName; projectRoot = $projectRoot; started = $true; authenticated = $true; windowMode = 'direct-node-windows-gui-subsystem'; processTree = 'task-scheduler-direct-root+external-lease-watchdog'; recoveryMode = 'restart-on-failure+connection-watchdog+external-lease-watchdog'; recoveryAttempts = 3; recoveryIntervalMinutes = 1; leaseStaleSeconds = 180 } | ConvertTo-Json -Compress)
} catch {
    $installFailure = $_
    $rollbackErrors = [Collections.Generic.List[string]]::new()
    $rollbackProcessSafe = $true

    foreach ($name in @($watchdogTaskName, $TaskName)) {
        try { Remove-ExistingTaskForUpgrade $name } catch { $rollbackErrors.Add("清理半安装任务 $name 失败：$($_.Exception.Message)") | Out-Null }
    }
    try { Ensure-ManagedProcessesStopped $newMainMetadata } catch {
        $rollbackProcessSafe = $false
        $rollbackErrors.Add("清理新机器人进程失败：$($_.Exception.Message)") | Out-Null
    }
    if ($mainTaskBackup.Exists) {
        try { Ensure-ManagedProcessesStopped $mainTaskBackup.Metadata $oldProcessIdentity } catch {
            $rollbackProcessSafe = $false
            $rollbackErrors.Add("确认旧机器人进程退出失败：$($_.Exception.Message)") | Out-Null
        }
    }
    # 所有备份都以禁用态注册，因此从本时间点到显式 Enable 之前不会被
    # StartWhenAvailable/错过的周期触发器抢跑。
    $rollbackRequestedAt = [DateTimeOffset]::UtcNow.AddSeconds(-2)
    foreach ($backup in @($mainTaskBackup, $watchdogTaskBackup)) {
        try { Restore-TaskBackup $backup } catch { $rollbackErrors.Add("恢复旧计划任务 $($backup.Name) 失败：$($_.Exception.Message)") | Out-Null }
    }

    if (-not $rollbackProcessSafe) {
        # 主任务保持 fail-closed，避免与身份不确定的进程并行；不要禁用已恢复的外部
        # watchdog，它会在 CIM 恢复后重新做 exact process 检查并安全拉起主任务。
        if ($mainTaskBackup.Exists) {
            try { Disable-ScheduledTask -TaskName $TaskName -TaskPath $taskPath -ErrorAction Stop | Out-Null } catch {
                $rollbackErrors.Add("CIM 不确定时禁用恢复主任务失败：$($_.Exception.Message)") | Out-Null
            }
        }
        if ($mainTaskBackup.Exists -and $watchdogTaskBackup.Exists -and $watchdogTaskBackup.WasEnabled) {
            try { Enable-ScheduledTask -TaskName $watchdogTaskName -TaskPath $taskPath -ErrorAction Stop | Out-Null } catch {
                $rollbackErrors.Add("启用安全恢复看门狗失败：$($_.Exception.Message)") | Out-Null
            }
        }
    } else {
        foreach ($backup in @($mainTaskBackup, $watchdogTaskBackup)) {
            $temporarilyNeeded = $backup.Exists -and ($backup.WasRunning -or
                (([string]$backup.Name).Equals($TaskName, [StringComparison]::OrdinalIgnoreCase) -and $shouldRestoreRuntime))
            if (-not $backup.Exists -or (-not $backup.WasEnabled -and -not $temporarilyNeeded)) { continue }
            try { Enable-ScheduledTask -TaskName ([string]$backup.Name) -TaskPath $taskPath -ErrorAction Stop | Out-Null } catch {
                $rollbackErrors.Add("重新启用旧计划任务 $($backup.Name) 失败：$($_.Exception.Message)") | Out-Null
            }
        }
        foreach ($backup in @($mainTaskBackup, $watchdogTaskBackup)) {
            $shouldStart = $backup.Exists -and ($backup.WasRunning -or
                (([string]$backup.Name).Equals($TaskName, [StringComparison]::OrdinalIgnoreCase) -and $shouldRestoreRuntime))
            if (-not $shouldStart) { continue }
            try { Start-ScheduledTask -TaskName ([string]$backup.Name) -TaskPath $taskPath -ErrorAction Stop } catch {
                $rollbackErrors.Add("重新启动旧计划任务 $($backup.Name) 失败：$($_.Exception.Message)") | Out-Null
            }
        }
        if ($mainTaskBackup.Exists -and $shouldRestoreRuntime -and $null -ne $oldRuntimePaths) {
            try {
                $rollbackHealth = Wait-ManagedRuntimeHealthy $TaskName $oldRuntimePaths.LeasePath $oldRuntimePaths.StatusPath $mainTaskBackup.Metadata $rollbackRequestedAt 120
                if ($rollbackHealth.State -ne 'healthy') {
                    $rollbackErrors.Add("旧机器人任务已恢复但未通过运行与认证验活：$($rollbackHealth.State)") | Out-Null
                }
            } catch { $rollbackErrors.Add("旧机器人任务回滚验活异常：$($_.Exception.Message)") | Out-Null }
        }
        foreach ($backup in @($mainTaskBackup, $watchdogTaskBackup)) {
            if (-not $backup.Exists -or $backup.WasEnabled) { continue }
            try { Disable-ScheduledTask -TaskName ([string]$backup.Name) -TaskPath $taskPath -ErrorAction Stop | Out-Null } catch {
                $rollbackErrors.Add("恢复旧任务禁用状态 $($backup.Name) 失败：$($_.Exception.Message)") | Out-Null
            }
        }
    }

    $rollbackMessage = if ($rollbackErrors.Count -eq 0) {
        '已清理半安装任务并恢复原计划任务。'
    } else {
        "回滚未完整完成：$($rollbackErrors -join '；')"
    }
    throw [InvalidOperationException]::new("企业微信机器人计划任务安装升级失败。$rollbackMessage 原因：$($installFailure.Exception.Message)", $installFailure.Exception)
}
} finally {
    if ($maintenanceMutexHeld) { try { $maintenanceMutex.ReleaseMutex() } catch {} }
    $maintenanceMutex.Dispose()
}
