[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')]
    [string]$TaskName = 'Codex-XBB-Executive-Analyst-WeCom'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$taskPath = '\'
$watchdogTaskName = "$TaskName-Watchdog"
$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$server = [IO.Path]::GetFullPath((Join-Path $projectRoot 'shared\wecom\server.js'))
$watchdogScript = [IO.Path]::GetFullPath((Join-Path $projectRoot 'scripts\watchdog-wecom-task.ps1'))
$runtimeRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Codex\xbb-executive-analyst\bin'
$hiddenNodePath = [IO.Path]::GetFullPath((Join-Path $runtimeRoot 'nodew.exe'))
$powerShellPath = [IO.Path]::GetFullPath((Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'))
$defaultConfigPath = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Codex\xbb-executive-analyst\bot-config.json'))
$mainTaskDescription = '无控制台 Node + Codex App Server + xbb-executive-analyst Skill 企业微信智能 Agent（异常退出自动重启）'
$watchdogTaskDescription = '外部租约看门狗：检测机器人进程卡死并重启主计划任务'
$mainArgumentPattern = '^' + [regex]::Escape("`"$server`"") + '(?: --managed-config "(?<configPath>[^\r\n"]+)")?$'
$watchdogArgumentPrefix = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$watchdogScript`" -TaskName `"$TaskName`" -LeasePath `""
$watchdogArgumentPattern = '^' + [regex]::Escape($watchdogArgumentPrefix) + '(?<leasePath>[^\r\n"]+)' + [regex]::Escape('" -StaleSeconds 180') + '$'

function Get-ExactTask([string]$Name) {
    $matches = @(Get-ScheduledTask -TaskPath $taskPath -ErrorAction Stop | Where-Object {
        ([string]$_.TaskName).Equals($Name, [StringComparison]::OrdinalIgnoreCase) -and
        ([string]$_.TaskPath).Equals($taskPath, [StringComparison]::OrdinalIgnoreCase)
    })
    if ($matches.Count -gt 1) { throw "检测到多个同名计划任务，拒绝继续：$Name" }
    if ($matches.Count -eq 0) { return $null }
    return $matches[0]
}

function Get-OwnedTaskMetadata($Task, [string]$Name) {
    $actions = @($Task.Actions)
    if ($actions.Count -ne 1) { throw "计划任务名称已被其他任务占用：$Name" }
    try { $actualExecutable = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables([string]$actions[0].Execute)) } catch {
        throw "计划任务执行文件无效，拒绝卸载：$Name"
    }
    $arguments = [string]$actions[0].Arguments
    $description = [string]$Task.Description
    if ($Name -eq $TaskName) {
        $match = [regex]::Match($arguments, $mainArgumentPattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
        $owned = $actualExecutable.Equals($hiddenNodePath, [StringComparison]::OrdinalIgnoreCase) -and
            $match.Success -and $description.Equals($mainTaskDescription, [StringComparison]::Ordinal)
        if (-not $owned) { throw "计划任务名称对应的不是本机器人，拒绝卸载：$Name" }
        $managedConfigPath = if ($match.Groups['configPath'].Success) {
            try {
                if (-not [IO.Path]::IsPathRooted($match.Groups['configPath'].Value)) { throw 'Path is not rooted.' }
                [IO.Path]::GetFullPath($match.Groups['configPath'].Value)
            } catch { throw "机器人主任务配置路径无效，拒绝卸载：$Name" }
        } else { $defaultConfigPath }
        return [pscustomobject][ordered]@{ Name = $Name; Kind = 'main'; Executable = $actualExecutable; Arguments = $arguments; ConfigPath = $managedConfigPath; LeasePath = '' }
    }

    $match = [regex]::Match($arguments, $watchdogArgumentPattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    $owned = $actualExecutable.Equals($powerShellPath, [StringComparison]::OrdinalIgnoreCase) -and
        $match.Success -and $description.Equals($watchdogTaskDescription, [StringComparison]::Ordinal)
    if (-not $owned) { throw "计划任务名称对应的不是本机器人，拒绝卸载：$Name" }
    try {
        if (-not [IO.Path]::IsPathRooted($match.Groups['leasePath'].Value)) { throw 'Path is not rooted.' }
        $managedLeasePath = [IO.Path]::GetFullPath($match.Groups['leasePath'].Value)
    } catch {
        throw "机器人看门狗租约路径无效，拒绝卸载：$Name"
    }
    return [pscustomobject][ordered]@{ Name = $Name; Kind = 'watchdog'; Executable = $actualExecutable; Arguments = $arguments; ConfigPath = ''; LeasePath = $managedLeasePath }
}

function Resolve-LeasePath([string]$ConfigPath) {
    $resolvedConfig = [IO.Path]::GetFullPath($ConfigPath)
    if ([IO.File]::Exists($resolvedConfig)) {
        try {
            $stored = Get-Content -LiteralPath $resolvedConfig -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($stored.PSObject.Properties.Name -contains 'serviceLeasePath' -and -not [string]::IsNullOrWhiteSpace([string]$stored.serviceLeasePath)) {
                return [IO.Path]::GetFullPath([string]$stored.serviceLeasePath)
            }
        } catch {}
    }
    return [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetDirectoryName($resolvedConfig)) 'service-lease.json'))
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

function ConvertTo-ManagedProcessProbe($Process, [string]$ExpectedArguments = '', [string]$ExpectedCreationDate = '', [bool]$AllowManagedPattern = $false) {
    if ([string]::IsNullOrWhiteSpace([string]$Process.ExecutablePath)) {
        return [pscustomobject][ordered]@{ State = 'indeterminate'; Identity = $null }
    }
    try { $actualExecutable = [IO.Path]::GetFullPath([string]$Process.ExecutablePath) } catch {
        return [pscustomobject][ordered]@{ State = 'indeterminate'; Identity = $null }
    }
    if (-not $actualExecutable.Equals($hiddenNodePath, [StringComparison]::OrdinalIgnoreCase)) {
        return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null }
    }

    $commandLine = [string]$Process.CommandLine
    if ([string]::IsNullOrWhiteSpace($commandLine)) { return [pscustomobject][ordered]@{ State = 'indeterminate'; Identity = $null } }
    $quotedPrefix = "`"$actualExecutable`" "
    $plainPrefix = "$actualExecutable "
    if ($commandLine.StartsWith($quotedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        $arguments = $commandLine.Substring($quotedPrefix.Length)
    } elseif ($commandLine.StartsWith($plainPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        $arguments = $commandLine.Substring($plainPrefix.Length)
    } else {
        return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null }
    }
    $argumentsMatch = if (-not [string]::IsNullOrWhiteSpace($ExpectedArguments)) {
        $arguments.Equals($ExpectedArguments, [StringComparison]::OrdinalIgnoreCase)
    } elseif ($AllowManagedPattern) {
        [regex]::IsMatch($arguments, $mainArgumentPattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    } else { $false }
    if (-not $argumentsMatch) { return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null } }

    $creationStamp = ConvertTo-ProcessCreationStamp $Process.CreationDate
    if ($null -eq $creationStamp) { return [pscustomobject][ordered]@{ State = 'indeterminate'; Identity = $null } }
    $creationDate = [string]$creationStamp.Token
    if (-not [string]::IsNullOrWhiteSpace($ExpectedCreationDate) -and $creationDate -ne $ExpectedCreationDate) {
        return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null }
    }
    $identity = [pscustomobject][ordered]@{ ProcessId = [int64]$Process.ProcessId; CreationDate = $creationDate; CreationAt = $creationStamp.At; Arguments = $arguments }
    return [pscustomobject][ordered]@{ State = 'alive'; Identity = $identity }
}

function Get-ManagedProcessProbe([int64]$ProcessId, [string]$ExpectedArguments = '', [string]$ExpectedCreationDate = '', [bool]$AllowManagedPattern = $false) {
    if ($ProcessId -le 0 -or $ProcessId -gt [int]::MaxValue) {
        return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null }
    }
    try { $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop } catch {
        return [pscustomobject][ordered]@{ State = 'indeterminate'; Identity = $null }
    }
    if ($null -eq $process) { return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null } }
    return ConvertTo-ManagedProcessProbe $process $ExpectedArguments $ExpectedCreationDate $AllowManagedPattern
}

function Find-ManagedProcessCandidates([string]$ExpectedArguments) {
    if ([string]::IsNullOrWhiteSpace($ExpectedArguments)) {
        return [pscustomobject][ordered]@{ State = 'none'; Identities = @() }
    }
    try { $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop) } catch {
        return [pscustomobject][ordered]@{ State = 'indeterminate'; Identities = @() }
    }
    $identities = [Collections.Generic.List[object]]::new()
    foreach ($process in $processes) {
        if (-not ([string]$process.Name).Equals([IO.Path]::GetFileName($hiddenNodePath), [StringComparison]::OrdinalIgnoreCase)) { continue }
        $probe = ConvertTo-ManagedProcessProbe $process $ExpectedArguments
        if ($probe.State -eq 'indeterminate') { return [pscustomobject][ordered]@{ State = 'indeterminate'; Identities = @() } }
        if ($probe.State -eq 'alive') { $identities.Add($probe.Identity) | Out-Null }
    }
    if ($identities.Count -eq 0) { return [pscustomobject][ordered]@{ State = 'none'; Identities = @() } }
    if ($identities.Count -eq 1) { return [pscustomobject][ordered]@{ State = 'unique'; Identities = @($identities[0]) } }
    return [pscustomobject][ordered]@{ State = 'multiple'; Identities = @($identities) }
}

function Read-LeaseProcess([string]$LeasePath, [string]$ExpectedArguments = '') {
    if ([string]::IsNullOrWhiteSpace($LeasePath) -or -not [IO.File]::Exists($LeasePath)) {
        return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null }
    }
    try {
        $lease = Get-Content -LiteralPath $LeasePath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([string]$lease.schemaVersion -ne '1.0' -or [string]$lease.service -ne 'xbb-executive-analyst-wecom') {
            return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null }
        }
        return Get-ManagedProcessProbe ([int64]$lease.pid) $ExpectedArguments '' ([string]::IsNullOrWhiteSpace($ExpectedArguments))
    } catch {
        return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null }
    }
}

function Wait-ManagedProcessExit($Identity, [int]$TimeoutSeconds) {
    if ($null -eq $Identity) { return [pscustomobject][ordered]@{ State = 'stopped' } }
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $probe = Get-ManagedProcessProbe ([int64]$Identity.ProcessId) ([string]$Identity.Arguments) ([string]$Identity.CreationDate)
        if ($probe.State -eq 'indeterminate') { return [pscustomobject][ordered]@{ State = 'indeterminate' } }
        if ($probe.State -eq 'missing') { return [pscustomobject][ordered]@{ State = 'stopped' } }
        Start-Sleep -Milliseconds 250
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    return [pscustomobject][ordered]@{ State = 'timeout' }
}

function Stop-ManagedProcessIdentity($Identity) {
    if ($null -eq $Identity) { return }
    $probe = Get-ManagedProcessProbe ([int64]$Identity.ProcessId) ([string]$Identity.Arguments) ([string]$Identity.CreationDate)
    if ($probe.State -eq 'indeterminate') { throw 'CIM 无法确认机器人进程身份；为避免误杀，拒绝强制终止。' }
    if ($probe.State -eq 'alive') { Stop-Process -Id ([int]$Identity.ProcessId) -Force -ErrorAction Stop }
}

function Remove-ExactTask([string]$Name) {
    $task = Get-ExactTask $Name
    if ($null -eq $task) { return $false }
    [void](Get-OwnedTaskMetadata $task $Name)
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
    if ($null -eq $currentTask) { return $true }
    Unregister-ScheduledTask -TaskName $Name -TaskPath $taskPath -Confirm:$false -ErrorAction Stop
    return $true
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
# 在任何删除前完成双任务归属校验，避免卸掉看门狗后才发现主任务是同名异物。
$mainTask = Get-ExactTask $TaskName
$watchdogTask = Get-ExactTask $watchdogTaskName
$mainMetadata = if ($null -ne $mainTask) { Get-OwnedTaskMetadata $mainTask $TaskName } else { $null }
$watchdogMetadata = if ($null -ne $watchdogTask) { Get-OwnedTaskMetadata $watchdogTask $watchdogTaskName } else { $null }

$leasePath = if ($null -ne $watchdogMetadata) {
    [string]$watchdogMetadata.LeasePath
} elseif ($null -ne $mainMetadata) {
    Resolve-LeasePath ([string]$mainMetadata.ConfigPath)
} else {
    Resolve-LeasePath $defaultConfigPath
}
$expectedProcessArguments = if ($null -ne $mainMetadata) { [string]$mainMetadata.Arguments } else { '' }
$leaseProbe = Read-LeaseProcess $leasePath $expectedProcessArguments
if ($leaseProbe.State -eq 'indeterminate') { throw 'CIM 无法确认租约进程身份；未修改任何计划任务。' }

# 删除任务前先解析唯一的完整参数进程；lease 缺失或 PID 已退出时仍可清理唯一 exact orphan，
# 但多个候选或 CIM 不确定都必须在任何卸载动作前停止。
$processIdentity = $null
if (-not [string]::IsNullOrWhiteSpace($expectedProcessArguments)) {
    $candidates = Find-ManagedProcessCandidates $expectedProcessArguments
    if ($candidates.State -eq 'indeterminate') { throw 'CIM 无法确认机器人进程；未修改任何计划任务。' }
    if ($candidates.State -eq 'multiple') { throw '发现多个完整匹配的机器人进程；拒绝猜测或批量终止。' }
    if ($candidates.State -eq 'unique') { $processIdentity = @($candidates.Identities)[0] }
    if ($leaseProbe.State -eq 'alive' -and $null -ne $processIdentity -and
        [int64]$leaseProbe.Identity.ProcessId -ne [int64]$processIdentity.ProcessId) {
        throw '租约与唯一完整匹配进程不一致；未修改任何计划任务。'
    }
    if ($null -eq $processIdentity -and $leaseProbe.State -eq 'alive') { $processIdentity = $leaseProbe.Identity }
} elseif ($leaseProbe.State -eq 'alive') {
    # 主任务已不存在时，只从严格匹配产品入口的有效 lease 得到完整参数，再按该参数枚举。
    $expectedProcessArguments = [string]$leaseProbe.Identity.Arguments
    $candidates = Find-ManagedProcessCandidates $expectedProcessArguments
    if ($candidates.State -eq 'indeterminate') { throw 'CIM 无法确认租约对应的机器人进程；未修改任何计划任务。' }
    if ($candidates.State -eq 'multiple') { throw '租约参数对应多个机器人进程；拒绝猜测或批量终止。' }
    if ($candidates.State -eq 'unique') { $processIdentity = @($candidates.Identities)[0] }
}

$watchdogRemoved = Remove-ExactTask $watchdogTaskName
$removed = Remove-ExactTask $TaskName
$forcedProcessStop = $false
if ($null -ne $processIdentity) {
    $wait = Wait-ManagedProcessExit $processIdentity 15
    if ($wait.State -eq 'indeterminate') { throw '任务已停止，但 CIM 无法确认机器人进程是否退出；拒绝强制终止。' }
    if ($wait.State -eq 'timeout') {
        Stop-ManagedProcessIdentity $processIdentity
        $forcedProcessStop = $true
        $wait = Wait-ManagedProcessExit $processIdentity 5
        if ($wait.State -ne 'stopped') { throw '计划任务已卸载，但严格匹配 PID 与创建时间的机器人进程仍未退出。' }
    }
}

if (-not [string]::IsNullOrWhiteSpace($expectedProcessArguments)) {
    $remaining = Find-ManagedProcessCandidates $expectedProcessArguments
    if ($remaining.State -eq 'indeterminate') { throw '计划任务已卸载，但 CIM 无法完成孤儿进程确认。' }
    if ($remaining.State -eq 'multiple') { throw '计划任务已卸载，但发现多个完整匹配的孤儿进程；拒绝批量终止。' }
    if ($remaining.State -eq 'unique') {
        $remainingIdentity = @($remaining.Identities)[0]
        Stop-ManagedProcessIdentity $remainingIdentity
        $forcedProcessStop = $true
        $wait = Wait-ManagedProcessExit $remainingIdentity 5
        if ($wait.State -ne 'stopped') { throw '计划任务已卸载，但唯一完整匹配的孤儿进程仍未退出。' }
    }
    $finalCandidates = Find-ManagedProcessCandidates $expectedProcessArguments
    if ($finalCandidates.State -eq 'indeterminate') { throw '计划任务已卸载，但 CIM 无法完成最终进程确认。' }
    if ($finalCandidates.State -ne 'none') { throw '计划任务已卸载，但完整匹配的机器人进程仍存在。' }
}

Write-Output ([ordered]@{ success = $true; taskName = $TaskName; removed = $removed; watchdogTaskName = $watchdogTaskName; watchdogRemoved = $watchdogRemoved; forcedProcessStop = $forcedProcessStop } | ConvertTo-Json -Compress)
} finally {
    if ($maintenanceMutexHeld) { try { $maintenanceMutex.ReleaseMutex() } catch {} }
    $maintenanceMutex.Dispose()
}
