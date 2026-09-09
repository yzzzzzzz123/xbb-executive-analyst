[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')]
    [string]$TaskName = 'Codex-XBB-Executive-Analyst-WeCom',
    [string]$ConfigPath = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Codex\xbb-executive-analyst\bot-config.json')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Test-FullyQualifiedWindowsPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    $driveAbsolute = $Path -match '^[A-Za-z]:[\\/]'
    $uncAbsolute = $Path -match '^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)'
    if (-not $driveAbsolute -and -not $uncAbsolute) { return $false }
    try { return -not [string]::IsNullOrWhiteSpace([IO.Path]::GetFullPath($Path)) } catch { return $false }
}

function Get-MaintenanceMutexName([string]$IgnoredTaskName = '') {
    return 'Global\Codex-XBB-WeCom-Maintenance'
}

function Get-TaskIdentityKey([string]$Name, [string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Name) -or [string]::IsNullOrWhiteSpace($Path) -or -not $Path.StartsWith('\')) {
        throw '计划任务身份字段无效。'
    }
    $prefix = if ($Path.EndsWith('\')) { $Path } else { "$Path\" }
    return ($prefix + $Name).ToLowerInvariant()
}

function Get-IndependentScheduledTaskSnapshot {
    $service = New-Object -ComObject 'Schedule.Service'
    $folders = [Collections.Generic.Queue[object]]::new()
    $snapshot = [Collections.Generic.List[object]]::new()
    try {
        $service.Connect()
        $folders.Enqueue($service.GetFolder('\'))
        while ($folders.Count -gt 0) {
            $folder = $folders.Dequeue()
            foreach ($registeredTask in @($folder.GetTasks(1))) {
                $definition = $registeredTask.Definition
                $actions = [Collections.Generic.List[object]]::new()
                for ($index = 1; $index -le [int]$definition.Actions.Count; $index += 1) {
                    $action = $definition.Actions.Item($index)
                    $actions.Add([pscustomobject]@{
                        ActionType = if ($action.PSObject.Properties.Name -contains 'Type') { [int]$action.Type } else { -1 }
                        Execute = if ($action.PSObject.Properties.Name -contains 'Path') { [string]$action.Path } else { '' }
                        Arguments = if ($action.PSObject.Properties.Name -contains 'Arguments') { [string]$action.Arguments } else { '' }
                        WorkingDirectory = if ($action.PSObject.Properties.Name -contains 'WorkingDirectory') { [string]$action.WorkingDirectory } else { '' }
                    }) | Out-Null
                }
                $fullTaskPath = [string]$registeredTask.Path
                $taskName = [string]$registeredTask.Name
                $taskFolderPath = $fullTaskPath.Substring(0, $fullTaskPath.Length - $taskName.Length)
                $snapshot.Add([pscustomobject]@{
                    TaskName = $taskName
                    TaskPath = $taskFolderPath
                    Actions = @($actions)
                    Description = [string]$definition.RegistrationInfo.Description
                }) | Out-Null
            }
            foreach ($childFolder in @($folder.GetFolders(0))) { $folders.Enqueue($childFolder) }
        }
        return @($snapshot)
    } finally {
        if ($null -ne $service -and [Runtime.InteropServices.Marshal]::IsComObject($service)) {
            [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($service)
        }
    }
}

function Test-IndependentScheduledTaskExists([string]$Name, [string]$Path) {
    $key = Get-TaskIdentityKey $Name $Path
    $matches = @(Get-IndependentScheduledTaskSnapshot | Where-Object { (Get-TaskIdentityKey ([string]$_.TaskName) ([string]$_.TaskPath)) -ceq $key })
    if ($matches.Count -gt 1) { throw "独立任务快照发现重复身份：$Path$Name" }
    return $matches.Count -eq 1
}

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$maintenanceScriptPath = [IO.Path]::GetFullPath($MyInvocation.MyCommand.Path)
$taskPath = '\'
$server = [IO.Path]::GetFullPath((Join-Path $projectRoot 'shared\wecom\server.js'))
$watchdogScript = [IO.Path]::GetFullPath((Join-Path $projectRoot 'scripts\watchdog-wecom-task.ps1'))
$watchdogLauncher = [IO.Path]::GetFullPath((Join-Path $projectRoot 'scripts\launch-wecom-watchdog.js'))
$runnerRecoveryScript = [IO.Path]::GetFullPath((Join-Path $projectRoot 'scripts\recover-runner-isolation.ps1'))
$processHandleScript = [IO.Path]::GetFullPath((Join-Path $projectRoot 'scripts\windows-process-handle.ps1'))
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
if (-not (Test-FullyQualifiedWindowsPath $ConfigPath)) { throw "机器人安全配置必须是 fully-qualified Windows 路径：$ConfigPath" }
$configPath = [IO.Path]::GetFullPath($ConfigPath)
if (-not (Test-Path -LiteralPath $server -PathType Leaf)) { throw "服务入口不存在：$server" }
if (-not (Test-Path -LiteralPath $watchdogScript -PathType Leaf)) { throw "外部看门狗不存在：$watchdogScript" }
if (-not (Test-Path -LiteralPath $watchdogLauncher -PathType Leaf)) { throw "无控制台看门狗启动器不存在：$watchdogLauncher" }
if (-not (Test-Path -LiteralPath $runnerRecoveryScript -PathType Leaf)) { throw "runner 隔离恢复器不存在：$runnerRecoveryScript" }
if (-not (Test-Path -LiteralPath $processHandleScript -PathType Leaf)) { throw "Windows 进程句柄校验器不存在：$processHandleScript" }
if (-not (Test-Path -LiteralPath $hiddenNodeInstaller -PathType Leaf)) { throw "无控制台 Node 安装器不存在：$hiddenNodeInstaller" }
if (-not (Test-Path -LiteralPath $powerShellPath -PathType Leaf)) { throw "Windows PowerShell 不存在：$powerShellPath" }
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw "机器人安全配置不存在，请先运行 configure-bot.ps1：$configPath" }
. $processHandleScript
$storedConfig = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]$storedConfig.schemaVersion -notin @('3.0', '4.0') -or [string]$storedConfig.wecomBotId -notmatch '^[A-Za-z0-9_-]{4,256}$' -or
    [string]$storedConfig.wecomWsUrl -notmatch '^wss://' -or [string]$storedConfig.modelProvider -notin @('local-codex', 'codex-app-server')) {
    throw '机器人安全配置不符合产品合同。'
}
$defaultLeasePath = Join-Path ([IO.Path]::GetDirectoryName($configPath)) 'service-lease.json'
$leasePath = if ($storedConfig.PSObject.Properties.Name -contains 'serviceLeasePath' -and -not [string]::IsNullOrWhiteSpace([string]$storedConfig.serviceLeasePath)) {
    if (-not (Test-FullyQualifiedWindowsPath ([string]$storedConfig.serviceLeasePath))) { throw 'serviceLeasePath 必须是 fully-qualified Windows 路径。' }
    [IO.Path]::GetFullPath([string]$storedConfig.serviceLeasePath)
} else {
    [IO.Path]::GetFullPath($defaultLeasePath)
}
$defaultStatusLogPath = Join-Path ([IO.Path]::GetDirectoryName($configPath)) 'status.jsonl'
$statusLogPath = if ($storedConfig.PSObject.Properties.Name -contains 'statusLogPath' -and -not [string]::IsNullOrWhiteSpace([string]$storedConfig.statusLogPath)) {
    if (-not (Test-FullyQualifiedWindowsPath ([string]$storedConfig.statusLogPath))) { throw 'statusLogPath 必须是 fully-qualified Windows 路径。' }
    [IO.Path]::GetFullPath([string]$storedConfig.statusLogPath)
} else {
    [IO.Path]::GetFullPath($defaultStatusLogPath)
}
$newMainArguments = "`"$server`" --managed-config `"$configPath`""
$productServerArgumentPrefix = "`"$server`""
$productArgumentPattern = '^(?:"(?<serverPath>[^\r\n"]+)"|(?<plainServerPath>\S+))(?: --managed-config "(?<configPath>[^\r\n"]+)")?$'
$productServerSuffix = '\shared\wecom\server.js'
$productStartScriptSuffix = '\scripts\start-wecom-bot.ps1'
$productWatchdogScriptSuffix = '\scripts\watchdog-wecom-task.ps1'
$productWatchdogLauncherSuffix = '\scripts\launch-wecom-watchdog.js'
$trustedProductServerPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
[void]$trustedProductServerPaths.Add([IO.Path]::GetFullPath($server))
$productWatchdogPrefix = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$watchdogScript`" -TaskName `""
$productWatchdogArgumentPattern = '^' + [regex]::Escape($productWatchdogPrefix) + '(?<taskName>[A-Za-z0-9][A-Za-z0-9._-]{0,127})' +
    [regex]::Escape('" -LeasePath "') + '(?<leasePath>[^\r\n"]+)' + [regex]::Escape('" -StaleSeconds 180') + '$'
$productWatchdogFilePattern = '(?:^|\s)-File\s+"' + [regex]::Escape($watchdogScript) + '"(?:\s|$)'
$newMainMetadata = [pscustomobject][ordered]@{
    Executable = [IO.Path]::GetFullPath($hiddenNodePath)
    Arguments = $newMainArguments
    ProductExecutable = [IO.Path]::GetFullPath($hiddenNodePath)
    ProductArguments = $newMainArguments
    ProductServerPath = $server
    ConfigPath = $configPath
    LeasePath = ''
    ScriptPath = ''
    TargetTaskName = ''
    Description = $mainTaskDescription
    Kind = 'main'
}
$watchdogArguments = "`"$watchdogLauncher`" --powershell `"$powerShellPath`" --script `"$watchdogScript`" --task-name `"$TaskName`" --lease-path `"$leasePath`" --stale-seconds 180"
$newWatchdogMetadata = [pscustomobject][ordered]@{
    Executable = [IO.Path]::GetFullPath($hiddenNodePath); Arguments = $watchdogArguments
    ProductExecutable = ''; ProductArguments = ''; ProductServerPath = ''; ConfigPath = ''
    LeasePath = $leasePath; ScriptPath = $watchdogScript; TargetTaskName = $TaskName
    Description = $watchdogTaskDescription; Kind = 'watchdog'
}

function Get-ExactTask([string]$Name) {
    # 枚举根路径可以把“确实不存在”表示为空，同时让 ScheduledTasks/CIM provider
    # 故障继续抛错；不能把 provider 故障误当成可安全覆盖的空槽位。
    $matches = @(Get-ScheduledTask -TaskPath $taskPath -ErrorAction Stop | Where-Object {
        ([string]$_.TaskName).Equals($Name, [StringComparison]::OrdinalIgnoreCase) -and
        ([string]$_.TaskPath).Equals($taskPath, [StringComparison]::OrdinalIgnoreCase)
    })
    if ($matches.Count -gt 1) { throw "检测到多个同名计划任务，拒绝继续：$Name" }
    $independentExists = Test-IndependentScheduledTaskExists $Name $taskPath
    if (($matches.Count -eq 1) -ne $independentExists) { throw "计划任务 provider 与独立快照不一致：$Name" }
    if ($matches.Count -eq 1) { return $matches[0] }

    Start-Sleep -Milliseconds 100
    $confirmation = @(Get-ScheduledTask -TaskPath $taskPath -ErrorAction Stop | Where-Object {
        ([string]$_.TaskName).Equals($Name, [StringComparison]::OrdinalIgnoreCase) -and
        ([string]$_.TaskPath).Equals($taskPath, [StringComparison]::OrdinalIgnoreCase)
    })
    $independentConfirmation = Test-IndependentScheduledTaskExists $Name $taskPath
    if ($confirmation.Count -gt 1) { throw "二次任务快照发现多个同名计划任务：$Name" }
    if (($confirmation.Count -eq 1) -ne $independentConfirmation) { throw "二次计划任务 provider 与独立快照不一致：$Name" }
    if ($confirmation.Count -ne 0) { throw "计划任务在空槽复核期间出现：$Name" }
    return $null
}

function Test-ProductPathSuffix([string]$Path, [string]$Suffix) {
    if (-not (Test-FullyQualifiedWindowsPath $Path)) { return $false }
    try { $resolved = [IO.Path]::GetFullPath($Path).Replace('/', '\') } catch { return $false }
    return $resolved.EndsWith($Suffix, [StringComparison]::OrdinalIgnoreCase)
}

function Get-VerifiedExecTaskActionFields($Action) {
    if ($null -eq $Action) { return [pscustomobject]@{ State = 'indeterminate'; Execute = ''; Arguments = '' } }
    $properties = @($Action.PSObject.Properties.Name)
    $semantics = [Collections.Generic.List[string]]::new()
    if ($properties -contains 'ActionType') {
        try { $actionType = [int]$Action.ActionType } catch { return [pscustomobject]@{ State = 'indeterminate'; Execute = ''; Arguments = '' } }
        if ($actionType -eq 0) { $semantics.Add('exec') | Out-Null }
        elseif ($actionType -in @(5, 6, 7)) { $semantics.Add('not-exec') | Out-Null }
        else { return [pscustomobject]@{ State = 'indeterminate'; Execute = ''; Arguments = '' } }
    }
    if ($properties -contains 'CimClass') {
        try { $cimClassName = [string]$Action.CimClass.CimClassName } catch { $cimClassName = '' }
        if ($cimClassName -ceq 'MSFT_TaskExecAction') { $semantics.Add('exec') | Out-Null }
        elseif (@('MSFT_TaskComHandlerAction', 'MSFT_TaskSendEmailAction', 'MSFT_TaskShowMessageAction') -ccontains $cimClassName) { $semantics.Add('not-exec') | Out-Null }
        else { return [pscustomobject]@{ State = 'indeterminate'; Execute = ''; Arguments = '' } }
    }
    try { $typeNames = @($Action.PSObject.TypeNames) } catch { return [pscustomobject]@{ State = 'indeterminate'; Execute = ''; Arguments = '' } }
    $execTypeNames = @(
        'Microsoft.Management.Infrastructure.CimInstance#ROOT/Microsoft/Windows/TaskScheduler/MSFT_TaskExecAction',
        'Microsoft.Management.Infrastructure.CimInstance#MSFT_TaskExecAction'
    )
    $nonExecTypeNames = @(
        'Microsoft.Management.Infrastructure.CimInstance#ROOT/Microsoft/Windows/TaskScheduler/MSFT_TaskComHandlerAction',
        'Microsoft.Management.Infrastructure.CimInstance#MSFT_TaskComHandlerAction',
        'Microsoft.Management.Infrastructure.CimInstance#ROOT/Microsoft/Windows/TaskScheduler/MSFT_TaskSendEmailAction',
        'Microsoft.Management.Infrastructure.CimInstance#MSFT_TaskSendEmailAction',
        'Microsoft.Management.Infrastructure.CimInstance#ROOT/Microsoft/Windows/TaskScheduler/MSFT_TaskShowMessageAction',
        'Microsoft.Management.Infrastructure.CimInstance#MSFT_TaskShowMessageAction'
    )
    if (@($typeNames | Where-Object { $execTypeNames -ccontains [string]$_ }).Count -gt 0) { $semantics.Add('exec') | Out-Null }
    if (@($typeNames | Where-Object { $nonExecTypeNames -ccontains [string]$_ }).Count -gt 0) { $semantics.Add('not-exec') | Out-Null }
    $distinctSemantics = @($semantics | Sort-Object -Unique)
    if ($distinctSemantics.Count -ne 1) { return [pscustomobject]@{ State = 'indeterminate'; Execute = ''; Arguments = '' } }
    if ($distinctSemantics[0] -eq 'not-exec') { return [pscustomobject]@{ State = 'not-exec'; Execute = ''; Arguments = '' } }
    if ($properties -notcontains 'Execute') { return [pscustomobject]@{ State = 'indeterminate'; Execute = ''; Arguments = '' } }
    try { $execute = [string]$Action.Execute } catch { return [pscustomobject]@{ State = 'indeterminate'; Execute = ''; Arguments = '' } }
    if ([string]::IsNullOrWhiteSpace($execute)) { return [pscustomobject]@{ State = 'indeterminate'; Execute = ''; Arguments = '' } }
    try { $arguments = if ($properties -contains 'Arguments') { [string]$Action.Arguments } else { '' } } catch {
        return [pscustomobject]@{ State = 'indeterminate'; Execute = ''; Arguments = '' }
    }
    return [pscustomobject]@{ State = 'exec'; Execute = $execute; Arguments = $arguments }
}

function Get-ProductArgumentsMetadata([string]$Arguments) {
    $argumentMatch = [regex]::Match($Arguments, $productArgumentPattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $argumentMatch.Success) { return $null }
    $serverPath = if ($argumentMatch.Groups['serverPath'].Success) {
        [string]$argumentMatch.Groups['serverPath'].Value
    } else { [string]$argumentMatch.Groups['plainServerPath'].Value }
    if (-not (Test-ProductPathSuffix $serverPath $productServerSuffix)) { return $null }
    $resolvedServer = [IO.Path]::GetFullPath($serverPath)
    $resolvedConfig = ''
    if ($argumentMatch.Groups['configPath'].Success) {
        $rawConfig = [string]$argumentMatch.Groups['configPath'].Value
        if (-not (Test-FullyQualifiedWindowsPath $rawConfig)) { return $null }
        $resolvedConfig = [IO.Path]::GetFullPath($rawConfig)
    }
    return [pscustomobject][ordered]@{ ServerPath = $resolvedServer; ConfigPath = $resolvedConfig; Arguments = $Arguments }
}

function Get-ProductTaskActionMetadata($Action) {
    $execAction = Get-VerifiedExecTaskActionFields $Action
    if ([string]$execAction.State -eq 'not-exec') { return [pscustomobject]@{ State = 'not-product'; Kind = '' } }
    if ([string]$execAction.State -ne 'exec') { return [pscustomobject]@{ State = 'indeterminate'; Kind = '' } }
    $arguments = [string]$execAction.Arguments
    $rawExecutable = [Environment]::ExpandEnvironmentVariables([string]$execAction.Execute)
    $argumentMetadata = Get-ProductArgumentsMetadata $arguments
    $mentionsProductScript = $arguments.IndexOf($productServerSuffix, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $arguments.IndexOf($productStartScriptSuffix, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $arguments.IndexOf($productWatchdogScriptSuffix, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $arguments.IndexOf($productWatchdogLauncherSuffix, [StringComparison]::OrdinalIgnoreCase) -ge 0
    $legacyPowerShellAlias = $rawExecutable.Equals('powershell.exe', [StringComparison]::OrdinalIgnoreCase)
    if (-not (Test-FullyQualifiedWindowsPath $rawExecutable) -and -not $legacyPowerShellAlias) {
        $state = if ($null -ne $argumentMetadata -or $mentionsProductScript) { 'indeterminate' } else { 'not-product' }
        return [pscustomobject][ordered]@{ State = $state; Kind = ''; Executable = ''; Arguments = $arguments }
    }
    try { $actualExecutable = if ($legacyPowerShellAlias) { [IO.Path]::GetFullPath($powerShellPath) } else { [IO.Path]::GetFullPath($rawExecutable) } } catch {
        return [pscustomobject][ordered]@{ State = 'indeterminate'; Kind = ''; Executable = ''; Arguments = $arguments }
    }
    $executableName = [IO.Path]::GetFileName($actualExecutable)
    if ($executableName -imatch '^(?:node|nodew)\.exe$') {
        $hiddenWatchdogMatch = [regex]::Match($arguments,
            '^(?:"(?<launcher>[^\r\n"]+)"|(?<plainLauncher>\S+)) --powershell "(?<powershell>[^\r\n"]+)" --script "(?<script>[^\r\n"]+)" --task-name "(?<taskName>[A-Za-z0-9][A-Za-z0-9._-]{0,127})" --lease-path "(?<leasePath>[^\r\n"]+)" --stale-seconds 180$',
            [Text.RegularExpressions.RegexOptions]::IgnoreCase)
        if ($hiddenWatchdogMatch.Success) {
            $launcherPath = if ($hiddenWatchdogMatch.Groups['launcher'].Success) { [string]$hiddenWatchdogMatch.Groups['launcher'].Value } else { [string]$hiddenWatchdogMatch.Groups['plainLauncher'].Value }
            $watchdogPowerShell = [string]$hiddenWatchdogMatch.Groups['powershell'].Value
            $watchdogScriptPath = [string]$hiddenWatchdogMatch.Groups['script'].Value
            $watchdogLeasePath = [string]$hiddenWatchdogMatch.Groups['leasePath'].Value
            if ((Test-ProductPathSuffix $launcherPath $productWatchdogLauncherSuffix) -and
                (Test-FullyQualifiedWindowsPath $watchdogPowerShell) -and
                [IO.Path]::GetFileName($watchdogPowerShell) -imatch '^(?:powershell|pwsh)\.exe$' -and
                (Test-ProductPathSuffix $watchdogScriptPath $productWatchdogScriptSuffix) -and
                (Test-FullyQualifiedWindowsPath $watchdogLeasePath)) {
                return [pscustomobject][ordered]@{
                    State = 'candidate'; Kind = 'watchdog'; Executable = $actualExecutable; Arguments = $arguments
                    ProductExecutable = ''; ProductArguments = ''; ProductServerPath = ''; ConfigPath = ''
                    LeasePath = [IO.Path]::GetFullPath($watchdogLeasePath)
                    ScriptPath = [IO.Path]::GetFullPath($watchdogScriptPath)
                    TargetTaskName = [string]$hiddenWatchdogMatch.Groups['taskName'].Value
                }
            }
        }
        if ($null -eq $argumentMetadata) {
            $state = if ($mentionsProductScript) { 'indeterminate' } else { 'not-product' }
            return [pscustomobject][ordered]@{ State = $state; Kind = ''; Executable = $actualExecutable; Arguments = $arguments }
        }
        $managedConfig = if ([string]::IsNullOrWhiteSpace([string]$argumentMetadata.ConfigPath)) { $defaultConfigPath } else { [string]$argumentMetadata.ConfigPath }
        return [pscustomobject][ordered]@{
            State = 'candidate'; Kind = 'main'; Executable = $actualExecutable; Arguments = $arguments
            ProductExecutable = $actualExecutable; ProductArguments = $arguments; ProductServerPath = [string]$argumentMetadata.ServerPath
            ConfigPath = $managedConfig; LeasePath = ''; ScriptPath = ''; TargetTaskName = ''
        }
    }
    if ($executableName -inotmatch '^(?:powershell|pwsh)\.exe$') {
        $state = if ($null -ne $argumentMetadata -or $mentionsProductScript) { 'indeterminate' } else { 'not-product' }
        return [pscustomobject][ordered]@{ State = $state; Kind = ''; Executable = $actualExecutable; Arguments = $arguments }
    }
    $startMatch = [regex]::Match($arguments, '^-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "(?<script>[^\r\n"]+)"$', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if ($startMatch.Success -and (Test-ProductPathSuffix ([string]$startMatch.Groups['script'].Value) $productStartScriptSuffix)) {
        $startScriptPath = [IO.Path]::GetFullPath([string]$startMatch.Groups['script'].Value)
        $legacyServer = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent (Split-Path -Parent $startScriptPath)) 'shared\wecom\server.js'))
        return [pscustomobject][ordered]@{
            State = 'candidate'; Kind = 'main'; Executable = $actualExecutable; Arguments = $arguments
            ProductExecutable = ''; ProductArguments = ''; ProductServerPath = $legacyServer
            ConfigPath = $defaultConfigPath; LeasePath = ''; ScriptPath = $startScriptPath; TargetTaskName = ''
        }
    }
    $watchdogMatch = [regex]::Match($arguments,
        '^-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "(?<script>[^\r\n"]+)" -TaskName "(?<taskName>[A-Za-z0-9][A-Za-z0-9._-]{0,127})" -LeasePath "(?<leasePath>[^\r\n"]+)" -StaleSeconds 180$',
        [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if ($watchdogMatch.Success -and
        (Test-ProductPathSuffix ([string]$watchdogMatch.Groups['script'].Value) $productWatchdogScriptSuffix) -and
        (Test-FullyQualifiedWindowsPath ([string]$watchdogMatch.Groups['leasePath'].Value))) {
        return [pscustomobject][ordered]@{
            State = 'candidate'; Kind = 'watchdog'; Executable = $actualExecutable; Arguments = $arguments
            ProductExecutable = ''; ProductArguments = ''; ProductServerPath = ''; ConfigPath = ''
            LeasePath = [IO.Path]::GetFullPath([string]$watchdogMatch.Groups['leasePath'].Value)
            ScriptPath = [IO.Path]::GetFullPath([string]$watchdogMatch.Groups['script'].Value)
            TargetTaskName = [string]$watchdogMatch.Groups['taskName'].Value
        }
    }
    $state = if ($mentionsProductScript) { 'indeterminate' } else { 'not-product' }
    return [pscustomobject][ordered]@{ State = $state; Kind = ''; Executable = $actualExecutable; Arguments = $arguments }
}

function Get-ProductTaskActionState($Action) {
    return [string](Get-ProductTaskActionMetadata $Action).State
}

function Get-ProductTaskSignatures([object[]]$Tasks) {
    $signatures = [Collections.Generic.List[string]]::new()
    foreach ($candidateTask in @($Tasks)) {
        $taskKey = Get-TaskIdentityKey ([string]$candidateTask.TaskName) ([string]$candidateTask.TaskPath)
        foreach ($candidateAction in @($candidateTask.Actions)) {
            $metadata = Get-ProductTaskActionMetadata $candidateAction
            if ([string]$metadata.State -eq 'indeterminate') { throw "产品计划任务 action 身份不确定：$taskKey" }
            if ([string]$metadata.State -ne 'candidate') { continue }
            $signatures.Add(($taskKey + '|' + ([string]$metadata.Kind).ToLowerInvariant() + '|' +
                ([string]$metadata.Executable).ToLowerInvariant() + '|' + ([string]$metadata.Arguments).ToLowerInvariant() + '|' +
                ([string]$candidateTask.Description))) | Out-Null
        }
    }
    return @($signatures | Sort-Object -Unique)
}

function Get-VerifiedProductTaskSnapshot {
    $providerSnapshot = @(Get-ScheduledTask -ErrorAction Stop)
    $independentSnapshot = @(Get-IndependentScheduledTaskSnapshot)
    $providerSignatures = @(Get-ProductTaskSignatures $providerSnapshot)
    $independentSignatures = @(Get-ProductTaskSignatures $independentSnapshot)
    if (($providerSignatures -join "`n") -cne ($independentSignatures -join "`n")) {
        throw '计划任务 provider 与独立 COM 产品任务快照不一致。'
    }
    if ($providerSignatures.Count -eq 0) {
        Start-Sleep -Milliseconds 100
        $confirmationProvider = @(Get-ScheduledTask -ErrorAction Stop)
        $confirmationIndependent = @(Get-IndependentScheduledTaskSnapshot)
        $confirmationProviderSignatures = @(Get-ProductTaskSignatures $confirmationProvider)
        $confirmationIndependentSignatures = @(Get-ProductTaskSignatures $confirmationIndependent)
        if (($confirmationProviderSignatures -join "`n") -cne ($confirmationIndependentSignatures -join "`n") -or
            $confirmationProviderSignatures.Count -ne 0) {
            throw '产品计划任务空快照未通过连续独立确认。'
        }
        return @($confirmationProvider)
    }
    return @($providerSnapshot)
}

function Assert-NoOtherProductTasks {
    $allTasks = @(Get-VerifiedProductTaskSnapshot)
    foreach ($candidateTask in $allTasks) {
        $isExpectedSlot = ([string]$candidateTask.TaskPath).Equals($taskPath, [StringComparison]::OrdinalIgnoreCase) -and
            (([string]$candidateTask.TaskName).Equals($TaskName, [StringComparison]::OrdinalIgnoreCase) -or
            ([string]$candidateTask.TaskName).Equals($watchdogTaskName, [StringComparison]::OrdinalIgnoreCase))
        foreach ($candidateAction in @($candidateTask.Actions)) {
            $actionState = Get-ProductTaskActionState $candidateAction
            if ($actionState -eq 'indeterminate') { throw '发现无法完整验证的本产品计划任务 action；未修改任何计划任务。' }
            if ($actionState -eq 'candidate' -and -not $isExpectedSlot) {
                throw '发现其他名称或路径的疑似机器人任务；证据未闭环，为避免顺序安装形成双活，未修改任何计划任务。'
            }
        }
    }
}

function Assert-OwnedTask($Task, [string]$Name) {
    $actions = @($Task.Actions)
    if ($actions.Count -ne 1) { throw "计划任务名称已被其他任务占用：$Name" }
    $metadata = Get-ProductTaskActionMetadata $actions[0]
    $expectedKind = if ($Name -eq $TaskName) { 'main' } else { 'watchdog' }
    $expectedDescription = if ($Name -eq $TaskName) { $mainTaskDescription } else { $watchdogTaskDescription }
    if ([string]$metadata.State -ne 'candidate' -or [string]$metadata.Kind -ne $expectedKind) {
        throw "计划任务名称已被非本机器人任务占用，拒绝覆盖：$Name"
    }
    if (-not ([string]$Task.Description).Equals($expectedDescription, [StringComparison]::Ordinal)) {
        throw "计划任务描述与本机器人部署身份不一致，拒绝覆盖：$Name"
    }
    return [pscustomobject][ordered]@{
        Executable = [string]$metadata.Executable
        Arguments = [string]$metadata.Arguments
        ProductExecutable = [string]$metadata.ProductExecutable
        ProductArguments = [string]$metadata.ProductArguments
        ProductServerPath = [string]$metadata.ProductServerPath
        ConfigPath = [string]$metadata.ConfigPath
        LeasePath = [string]$metadata.LeasePath
        ScriptPath = [string]$metadata.ScriptPath
        TargetTaskName = [string]$metadata.TargetTaskName
        Description = [string]$Task.Description
        Kind = [string]$metadata.Kind
    }
}

function Get-VerifiedTaskConfigLease([string]$ManagedConfigPath, [string]$WatchdogLeasePath = '') {
    if (-not (Test-FullyQualifiedWindowsPath $ManagedConfigPath) -or -not [IO.File]::Exists($ManagedConfigPath)) {
        throw '任务配置缺失，无法闭合机器人部署身份。'
    }
    try { $config = Get-Content -LiteralPath $ManagedConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { throw '任务配置损坏，无法闭合机器人部署身份。' }
    if ([string]$config.schemaVersion -notin @('3.0', '4.0') -or [string]$config.wecomBotId -notmatch '^[A-Za-z0-9_-]{4,256}$' -or
        [string]$config.wecomWsUrl -notmatch '^wss://' -or [string]$config.modelProvider -notin @('local-codex', 'codex-app-server')) {
        throw '任务配置不符合机器人产品合同。'
    }
    $watchdogLease = ''
    if (-not [string]::IsNullOrWhiteSpace($WatchdogLeasePath)) {
        if (-not (Test-FullyQualifiedWindowsPath $WatchdogLeasePath)) { throw '看门狗 lease 路径无效。' }
        $watchdogLease = [IO.Path]::GetFullPath($WatchdogLeasePath)
    }
    if ($config.PSObject.Properties.Name -contains 'serviceLeasePath' -and -not [string]::IsNullOrWhiteSpace([string]$config.serviceLeasePath)) {
        if (-not (Test-FullyQualifiedWindowsPath ([string]$config.serviceLeasePath))) { throw '任务配置 serviceLeasePath 无效。' }
        $configuredLease = [IO.Path]::GetFullPath([string]$config.serviceLeasePath)
        if ($watchdogLease -and -not $configuredLease.Equals($watchdogLease, [StringComparison]::OrdinalIgnoreCase)) { throw '主任务配置与看门狗 lease 不一致。' }
        return $configuredLease
    }
    if ($watchdogLease) { return $watchdogLease }
    throw '任务配置没有显式 serviceLeasePath，且无配对看门狗提供受控证据。'
}

function Assert-OwnedTaskEvidence($MainBackup, $WatchdogBackup) {
    if (-not $MainBackup.Exists) {
        if (-not $WatchdogBackup.Exists) { return }
        $watchdog = $WatchdogBackup.Metadata
        if (-not [IO.File]::Exists([string]$watchdog.ScriptPath) -or
            -not ([string]$watchdog.TargetTaskName).Equals($TaskName, [StringComparison]::OrdinalIgnoreCase)) {
            throw '孤立看门狗任务缺少可验证的部署证据。'
        }
        $watchdogRoot = [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent ([string]$watchdog.ScriptPath))))
        $derivedServer = [IO.Path]::GetFullPath((Join-Path $watchdogRoot 'shared\wecom\server.js'))
        if (-not [IO.File]::Exists($derivedServer)) { throw '孤立看门狗对应的服务入口不存在。' }
        [void]$trustedProductServerPaths.Add($derivedServer)
        return
    }
    $main = $MainBackup.Metadata
    if (-not [IO.File]::Exists([string]$main.ProductServerPath)) { throw '主任务服务入口不存在，无法闭合旧部署身份。' }
    if ($WatchdogBackup.Exists) {
        $watchdog = $WatchdogBackup.Metadata
        if (-not [IO.File]::Exists([string]$watchdog.ScriptPath)) { throw '看门狗入口不存在，无法闭合旧部署身份。' }
        $mainRoot = [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent (Split-Path -Parent ([string]$main.ProductServerPath)))))
        $watchdogRoot = [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent ([string]$watchdog.ScriptPath))))
        if (-not $mainRoot.Equals($watchdogRoot, [StringComparison]::OrdinalIgnoreCase) -or
            -not ([string]$watchdog.TargetTaskName).Equals($TaskName, [StringComparison]::OrdinalIgnoreCase)) {
            throw '主任务与看门狗不属于同一受控部署。'
        }
        [void](Get-VerifiedTaskConfigLease ([string]$main.ConfigPath) ([string]$watchdog.LeasePath))
    } else {
        [void](Get-VerifiedTaskConfigLease ([string]$main.ConfigPath))
    }
    [void]$trustedProductServerPaths.Add([IO.Path]::GetFullPath([string]$main.ProductServerPath))
}

function Assert-TaskMetadataMatchesExpected([string]$Name, $Metadata, $ExpectedMetadata, [string]$Source = 'ScheduledTasks') {
    if ($null -eq $ExpectedMetadata) { throw "缺少不可变任务身份基线：$Name" }
    foreach ($field in @('Arguments', 'Description', 'Kind', 'TargetTaskName')) {
        if ([string]$metadata.$field -cne [string]$ExpectedMetadata.$field) {
            throw "$Source 任务身份与初始闭环证据不一致：$Name ($field)"
        }
    }
    foreach ($field in @('Executable', 'ProductExecutable', 'ProductServerPath', 'ConfigPath', 'LeasePath', 'ScriptPath')) {
        if (-not ([string]$metadata.$field).Equals([string]$ExpectedMetadata.$field, [StringComparison]::OrdinalIgnoreCase)) {
            throw "$Source 任务身份与初始闭环证据不一致：$Name ($field)"
        }
    }
}

function Get-VerifiedOwnedTask([string]$Name, $ExpectedMetadata) {
    $task = Get-ExactTask $Name
    if ($null -eq $task) { throw "计划任务在维护操作前消失：$Name" }
    $metadata = Assert-OwnedTask $task $Name
    Assert-TaskMetadataMatchesExpected $Name $metadata $ExpectedMetadata 'ScheduledTasks provider'

    $taskKey = Get-TaskIdentityKey $Name $taskPath
    $independentMatches = @(Get-IndependentScheduledTaskSnapshot | Where-Object {
        (Get-TaskIdentityKey ([string]$_.TaskName) ([string]$_.TaskPath)) -ceq $taskKey
    })
    if ($independentMatches.Count -ne 1) { throw "COM 无法唯一复核任务身份：$Name" }
    $independentMetadata = Assert-OwnedTask $independentMatches[0] $Name
    Assert-TaskMetadataMatchesExpected $Name $independentMetadata $ExpectedMetadata 'Task Scheduler COM'
    return [pscustomobject]@{ Task = $task; Metadata = $metadata }
}

function Disable-VerifiedOwnedTask([string]$Name, $ExpectedMetadata) {
    $verified = Get-VerifiedOwnedTask $Name $ExpectedMetadata
    if ([bool]$verified.Task.Settings.Enabled) { Disable-ScheduledTask -TaskName $Name -TaskPath $taskPath -ErrorAction Stop | Out-Null }
}

function Stop-VerifiedOwnedTask([string]$Name, $ExpectedMetadata) {
    $verified = Get-VerifiedOwnedTask $Name $ExpectedMetadata
    if ([string]$verified.Task.State -eq 'Running') { Stop-ScheduledTask -TaskName $Name -TaskPath $taskPath -ErrorAction Stop }
}

function Unregister-VerifiedOwnedTask([string]$Name, $ExpectedMetadata) {
    [void](Get-VerifiedOwnedTask $Name $ExpectedMetadata)
    Unregister-ScheduledTask -TaskName $Name -TaskPath $taskPath -Confirm:$false -ErrorAction Stop
    if ($null -ne (Get-ExactTask $Name)) { throw "注销后计划任务仍存在：$Name" }
}

function Enable-VerifiedOwnedTask([string]$Name, $ExpectedMetadata) {
    $verified = Get-VerifiedOwnedTask $Name $ExpectedMetadata
    if (-not [bool]$verified.Task.Settings.Enabled) { Enable-ScheduledTask -TaskName $Name -TaskPath $taskPath -ErrorAction Stop | Out-Null }
}

function Start-VerifiedOwnedTask([string]$Name, $ExpectedMetadata) {
    [void](Get-VerifiedOwnedTask $Name $ExpectedMetadata)
    Start-ScheduledTask -TaskName $Name -TaskPath $taskPath -ErrorAction Stop
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

function Remove-ExistingTaskForUpgrade([string]$Name, [object[]]$AllowedExpectedMetadata) {
    $task = Get-ExactTask $Name
    if ($null -eq $task) { return }
    $metadata = $null
    foreach ($expected in @($AllowedExpectedMetadata | Where-Object { $null -ne $_ })) {
        try {
            [void](Get-VerifiedOwnedTask $Name $expected)
            $metadata = $expected
            break
        } catch {}
    }
    if ($null -eq $metadata) {
        throw "当前任务不匹配任何初始备份或本次新代际身份，保持围栏且拒绝删除：$Name"
    }
    $wasRunning = [string]$task.State -eq 'Running'
    Disable-VerifiedOwnedTask $Name $metadata
    $currentTask = Get-ExactTask $Name
    if ($wasRunning -or ($null -ne $currentTask -and [string]$currentTask.State -eq 'Running')) {
        Stop-VerifiedOwnedTask $Name $metadata
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
    Unregister-VerifiedOwnedTask $Name $metadata
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
    if ($null -ne (Get-ExactTask ([string]$Backup.Name))) { throw "恢复旧计划任务注册前目标名称被占用：$($Backup.Name)" }
    Register-ScheduledTask -TaskName ([string]$Backup.Name) -TaskPath $taskPath -Xml $disabledXml -ErrorAction Stop | Out-Null
    [void](Get-VerifiedOwnedTask ([string]$Backup.Name) $Backup.Metadata)
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

function Test-ExactCommandArgument([string]$CommandLine, [string]$Argument) {
    if ([string]::IsNullOrWhiteSpace($CommandLine) -or [string]::IsNullOrWhiteSpace($Argument)) { return $false }
    $pattern = '(?i)(?:^|[\s"])' + [regex]::Escape([IO.Path]::GetFullPath($Argument)) + '(?=$|[\s"])'
    return [regex]::IsMatch($CommandLine, $pattern)
}

function ConvertTo-MaintenanceSnapshotSentinel($Process) {
    $properties = if ($null -eq $Process) { @() } else { @($Process.PSObject.Properties.Name) }
    if ($properties -notcontains 'Name' -or $properties -notcontains 'ExecutablePath' -or
        $properties -notcontains 'CommandLine' -or $properties -notcontains 'CreationDate' -or
        $properties -notcontains 'ProcessId') { throw '维护进程 CIM sentinel 字段不完整。' }
    try { $processId = [int]$Process.ProcessId } catch { throw '维护进程 CIM sentinel PID 无效。' }
    if (-not (Test-FullyQualifiedWindowsPath ([string]$Process.ExecutablePath))) { throw '维护进程 CIM sentinel 身份无效。' }
    $actualExecutable = [IO.Path]::GetFullPath([string]$Process.ExecutablePath)
    $processName = [string]$Process.Name
    $commandLine = [string]$Process.CommandLine
    if ($processId -ne $PID -or $processName -inotmatch '^(?:powershell|pwsh)\.exe$' -or
        -not ([IO.Path]::GetFileName($actualExecutable)).Equals($processName, [StringComparison]::OrdinalIgnoreCase) -or
        [string]::IsNullOrWhiteSpace($commandLine)) {
        throw '维护进程 CIM sentinel 身份无效。'
    }
    $creation = ConvertTo-ProcessCreationStamp $Process.CreationDate
    if ($null -eq $creation) { throw '维护进程 CIM sentinel 创建时间无效。' }
    return [pscustomobject][ordered]@{
        ProcessId = $processId
        CreationDate = [string]$creation.Token
        Executable = $actualExecutable
        CommandLine = $commandLine
    }
}

function New-MaintenanceSnapshotSentinel {
    $rows = @(Get-CimInstance Win32_Process -Filter "ProcessId = $PID" -ErrorAction Stop)
    if ($rows.Count -ne 1) { throw '无法建立维护进程 CIM sentinel。' }
    return ConvertTo-MaintenanceSnapshotSentinel $rows[0]
}

function Get-HealthyMaintenanceProcessSnapshot {
    $rows = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    $sentinelRows = @($rows | Where-Object { $_.PSObject.Properties.Name -contains 'ProcessId' -and [int64]$_.ProcessId -eq [int64]$maintenanceSnapshotSentinel.ProcessId })
    if ($sentinelRows.Count -ne 1) { throw 'CIM 快照遗漏维护进程 sentinel。' }
    $observed = ConvertTo-MaintenanceSnapshotSentinel $sentinelRows[0]
    if ([string]$observed.CreationDate -ne [string]$maintenanceSnapshotSentinel.CreationDate -or
        -not ([string]$observed.Executable).Equals([string]$maintenanceSnapshotSentinel.Executable, [StringComparison]::OrdinalIgnoreCase) -or
        [string]$observed.CommandLine -cne [string]$maintenanceSnapshotSentinel.CommandLine) {
        throw 'CIM 快照中的维护进程 sentinel 已变化。'
    }
    return @($rows)
}

function Test-ProductArguments([string]$Arguments) {
    return $null -ne (Get-ProductArgumentsMetadata $Arguments)
}

function ConvertTo-ProductProcessIdentity($Process, [string]$ExpectedArguments = '', [string]$ExpectedCreationDate = '') {
    $processProperties = if ($null -eq $Process) { @() } else { @($Process.PSObject.Properties.Name) }
    if ($processProperties -notcontains 'ExecutablePath' -or $processProperties -notcontains 'CommandLine' -or
        $processProperties -notcontains 'CreationDate' -or $processProperties -notcontains 'ProcessId' -or
        -not (Test-FullyQualifiedWindowsPath ([string]$Process.ExecutablePath))) {
        return [pscustomobject][ordered]@{ State = 'indeterminate'; Identity = $null }
    }
    try { $processId = [int64]$Process.ProcessId } catch { return [pscustomobject][ordered]@{ State = 'indeterminate'; Identity = $null } }
    if ($processId -le 0 -or $processId -gt [int]::MaxValue) { return [pscustomobject][ordered]@{ State = 'indeterminate'; Identity = $null } }
    try { $actualExecutable = [IO.Path]::GetFullPath([string]$Process.ExecutablePath) } catch {
        return [pscustomobject][ordered]@{ State = 'indeterminate'; Identity = $null }
    }
    if ([IO.Path]::GetFileName($actualExecutable) -inotmatch '^(?:node|nodew)\.exe$') {
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
    $argumentMetadata = Get-ProductArgumentsMetadata $processArguments
    if ($null -eq $argumentMetadata) {
        if ($processArguments.IndexOf($productServerSuffix, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return [pscustomobject][ordered]@{ State = 'indeterminate'; Identity = $null }
        }
        return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null }
    }
    if (-not $trustedProductServerPaths.Contains([IO.Path]::GetFullPath([string]$argumentMetadata.ServerPath))) {
        return [pscustomobject][ordered]@{ State = 'indeterminate'; Identity = $null }
    }
    if (-not [string]::IsNullOrWhiteSpace($ExpectedArguments) -and
        -not $processArguments.Equals($ExpectedArguments, [StringComparison]::OrdinalIgnoreCase)) {
        return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null }
    }
    $creationStamp = ConvertTo-ProcessCreationStamp $Process.CreationDate
    if ($null -eq $creationStamp) { return [pscustomobject][ordered]@{ State = 'indeterminate'; Identity = $null } }
    $creationDate = [string]$creationStamp.Token
    if (-not [string]::IsNullOrWhiteSpace($ExpectedCreationDate) -and $creationDate -ne $ExpectedCreationDate) {
        return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null }
    }
    $identity = [pscustomobject][ordered]@{
        ProcessId = $processId
        CreationDate = $creationDate
        CreationAt = $creationStamp.At
        Executable = $actualExecutable
        Arguments = $processArguments
        ServerPath = [string]$argumentMetadata.ServerPath
        ConfigPath = [string]$argumentMetadata.ConfigPath
    }
    return [pscustomobject][ordered]@{ State = 'alive'; Identity = $identity }
}

function Get-ProductProcessProbe([int64]$ProcessId, [string]$ExpectedArguments = '', [string]$ExpectedCreationDate = '') {
    if ($ProcessId -le 0 -or $ProcessId -gt [int]::MaxValue) { return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null } }
    try {
        $snapshot = @(Get-HealthyMaintenanceProcessSnapshot)
        $processRows = @($snapshot | Where-Object { $_.PSObject.Properties.Name -contains 'ProcessId' -and [int64]$_.ProcessId -eq $ProcessId })
    } catch {
        return [pscustomobject][ordered]@{ State = 'indeterminate'; Identity = $null }
    }
    if ($processRows.Count -eq 0) { return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null } }
    if ($processRows.Count -ne 1) { return [pscustomobject][ordered]@{ State = 'indeterminate'; Identity = $null } }
    return ConvertTo-ProductProcessIdentity $processRows[0] $ExpectedArguments $ExpectedCreationDate
}

function Find-ProductProcessCandidates {
    try { $processes = @(Get-HealthyMaintenanceProcessSnapshot) } catch {
        return [pscustomobject][ordered]@{ State = 'indeterminate'; Identities = @() }
    }
    $identities = [Collections.Generic.List[object]]::new()
    foreach ($process in $processes) {
        if (@($process.PSObject.Properties.Name) -notcontains 'Name' -or [string]::IsNullOrWhiteSpace([string]$process.Name)) {
            return [pscustomobject][ordered]@{ State = 'indeterminate'; Identities = @() }
        }
        if ([string]$process.Name -inotmatch '^(?:node|nodew)\.exe$') { continue }
        $probe = ConvertTo-ProductProcessIdentity $process
        if ($probe.State -eq 'indeterminate') { return [pscustomobject][ordered]@{ State = 'indeterminate'; Identities = @() } }
        if ($probe.State -eq 'alive') { $identities.Add($probe.Identity) | Out-Null }
    }
    if ($identities.Count -eq 0) { return [pscustomobject][ordered]@{ State = 'none'; Identities = @() } }
    if ($identities.Count -eq 1) { return [pscustomobject][ordered]@{ State = 'unique'; Identities = @($identities[0]) } }
    return [pscustomobject][ordered]@{ State = 'multiple'; Identities = @($identities) }
}

function Get-ManagedProcessProbe([int64]$ProcessId, $Metadata, [string]$ExpectedCreationDate = '') {
    if ($null -eq $Metadata) { return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null } }
    $probe = Get-ProductProcessProbe $ProcessId ([string]$Metadata.ProductArguments) $ExpectedCreationDate
    if ($probe.State -ne 'alive') { return $probe }
    if (-not [string]::IsNullOrWhiteSpace([string]$Metadata.ProductExecutable) -and
        -not ([string]$probe.Identity.Executable).Equals([string]$Metadata.ProductExecutable, [StringComparison]::OrdinalIgnoreCase)) {
        return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null }
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$Metadata.ProductServerPath) -and
        -not ([string]$probe.Identity.ServerPath).Equals([string]$Metadata.ProductServerPath, [StringComparison]::OrdinalIgnoreCase)) {
        return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null }
    }
    return $probe
}

function Wait-ProductProcessExit($Identity, [int]$TimeoutSeconds) {
    if ($null -eq $Identity) { return [pscustomobject][ordered]@{ State = 'stopped' } }
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    $missingSnapshots = 0
    do {
        $probe = Get-ProductProcessProbe ([int64]$Identity.ProcessId) ([string]$Identity.Arguments) ([string]$Identity.CreationDate)
        if ($probe.State -eq 'indeterminate') { return [pscustomobject][ordered]@{ State = 'indeterminate' } }
        if ($probe.State -eq 'missing') {
            $missingSnapshots += 1
            if ($missingSnapshots -ge 2) { return [pscustomobject][ordered]@{ State = 'stopped' } }
        } else { $missingSnapshots = 0 }
        Start-Sleep -Milliseconds 250
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    return [pscustomobject][ordered]@{ State = 'timeout' }
}

function Test-CanonicalProcessArgumentPath([string]$Value, [string]$ExpectedPath) {
    if (-not (Test-FullyQualifiedWindowsPath $Value) -or -not (Test-FullyQualifiedWindowsPath $ExpectedPath)) { return $false }
    try { return [IO.Path]::GetFullPath($Value).Equals([IO.Path]::GetFullPath($ExpectedPath), [StringComparison]::OrdinalIgnoreCase) } catch { return $false }
}

function ConvertTo-VerifiedProductDescendantIdentity($Process, $ParentIdentity) {
    $properties = if ($null -eq $Process) { @() } else { @($Process.PSObject.Properties.Name) }
    foreach ($required in @('ProcessId', 'ParentProcessId', 'Name', 'ExecutablePath', 'CommandLine', 'CreationDate')) {
        if ($properties -notcontains $required) { throw '产品进程后代 CIM 字段不完整；拒绝终止任何进程。' }
    }
    try { $processId = [int]$Process.ProcessId; $parentProcessId = [int]$Process.ParentProcessId } catch { throw '产品进程后代 PID 无效；拒绝终止任何进程。' }
    if ($processId -le 0 -or $parentProcessId -ne [int]$ParentIdentity.ProcessId -or
        -not (Test-FullyQualifiedWindowsPath ([string]$Process.ExecutablePath)) -or
        [string]::IsNullOrWhiteSpace([string]$Process.CommandLine)) { throw '产品进程后代身份不完整；拒绝终止任何进程。' }
    $executable = [IO.Path]::GetFullPath([string]$Process.ExecutablePath); $name = [string]$Process.Name
    if (-not [IO.Path]::GetFileName($executable).Equals($name, [StringComparison]::OrdinalIgnoreCase)) { throw '产品进程后代可执行文件身份不一致。' }
    $creation = ConvertTo-ProcessCreationStamp $Process.CreationDate
    if ($null -eq $creation -or $creation.At -lt $ParentIdentity.CreationAt) { throw '产品进程后代创建时间不可信。' }
    try { $argv = @(ConvertFrom-XbbWindowsCommandLine ([string]$Process.CommandLine)) } catch { throw '产品进程后代命令行不可解析。' }
    if ($argv.Count -lt 2 -or -not (Test-CanonicalProcessArgumentPath ([string]$argv[0]) $executable)) { throw '产品进程后代命令入口无法绑定。' }
    $offset = 1
    if ($name -imatch '^(?:node|nodew)\.exe$') {
        if ($argv.Count -ne 9 -or -not (Test-ProductPathSuffix ([string]$argv[1]) '\node_modules\@openai\codex\bin\codex.js')) { throw '发现不在白名单内的 Node 产品后代；拒绝终止任何进程。' }
        $offset = 2
    } elseif ($name -inotmatch '^codex\.exe$') { throw '发现不在白名单内的产品后代；拒绝终止任何进程。' }
    if ($argv.Count -ne ($offset + 7) -or [string]$argv[$offset] -cne 'app-server' -or
        [string]$argv[$offset + 1] -cne '--listen' -or [string]$argv[$offset + 2] -notmatch '^ws://127[.]0[.]0[.]1:(?<port>[0-9]{1,5})$' -or
        [int]$Matches.port -lt 1 -or [int]$Matches.port -gt 65535 -or [string]$argv[$offset + 3] -cne '--ws-auth' -or
        [string]$argv[$offset + 4] -cne 'capability-token' -or [string]$argv[$offset + 5] -cne '--ws-token-sha256' -or
        [string]$argv[$offset + 6] -cnotmatch '^[a-f0-9]{64}$') { throw 'Codex App Server 后代参数不符合固定身份合同。' }
    return [pscustomobject][ordered]@{
        ProcessId = $processId; ParentProcessId = $parentProcessId; CreationDate = [string]$creation.Token
        CreationToken = [string]$creation.Token; CreationAt = $creation.At; Executable = $executable
        ExecutablePath = $executable; CommandLine = [string]$Process.CommandLine
    }
}

function Add-VerifiedProductDescendantHandles([object[]]$Snapshot, $BoundProcesses, $KnownProcesses) {
    $rows = @($Snapshot)
    if (@($rows | Group-Object { [string]$_.ProcessId } | Where-Object { $_.Count -ne 1 }).Count -ne 0) { throw 'CIM 产品树快照包含重复 PID。' }
    $added = 0; $progress = $true
    while ($progress) {
        $progress = $false
        foreach ($row in $rows) {
            try { $rowPid = [int]$row.ProcessId; $rowParentPid = [int]$row.ParentProcessId } catch { throw 'CIM 产品树 PID 字段不可读。' }
            if ($KnownProcesses.ContainsKey($rowPid) -or -not $KnownProcesses.ContainsKey($rowParentPid)) { continue }
            $identity = ConvertTo-VerifiedProductDescendantIdentity $row $KnownProcesses[$rowParentPid].Identity
            $handle = Open-XbbVerifiedProcessHandle ([pscustomobject]@{ ProcessId = $identity.ProcessId; CreationToken = $identity.CreationToken; ExecutablePath = $identity.ExecutablePath })
            $bound = [pscustomobject]@{ Identity = $identity; Handle = $handle }
            try {
                $candidateTicks = [int64]$identity.CreationToken; $handleTicks = [int64]$handle.CreationToken
                if ([int]$handle.ProcessId -ne [int]$identity.ProcessId -or ($candidateTicks - ($candidateTicks % 10)) -ne ($handleTicks - ($handleTicks % 10)) -or
                    -not ([string]$handle.ExecutablePath).Equals([string]$identity.ExecutablePath, [StringComparison]::OrdinalIgnoreCase)) { throw '产品进程后代 native handle 身份不一致。' }
                $BoundProcesses.Add($bound) | Out-Null; $KnownProcesses[$identity.ProcessId] = $bound; $added += 1; $progress = $true
            } catch { $handle.Dispose(); throw }
        }
    }
    return $added
}

function Confirm-EmptyProductProcessSlot($InitialCandidates) {
    if ([string]$InitialCandidates.State -eq 'indeterminate') { return 'indeterminate' }
    if ([string]$InitialCandidates.State -eq 'multiple') { return 'multiple' }
    if ([string]$InitialCandidates.State -ne 'none') { return 'occupied' }
    Start-Sleep -Milliseconds 250
    $confirmation = Find-ProductProcessCandidates
    if ([string]$confirmation.State -eq 'indeterminate') { return 'indeterminate' }
    if ([string]$confirmation.State -eq 'multiple') { return 'multiple' }
    if ([string]$confirmation.State -ne 'none') { return 'occupied' }
    return 'empty'
}

function Stop-ProductProcessTree($Identity) {
    if ($null -eq $Identity) { return $false }
    $probe = Get-ProductProcessProbe ([int64]$Identity.ProcessId) ([string]$Identity.Arguments) ([string]$Identity.CreationDate)
    if ($probe.State -eq 'indeterminate') { throw 'CIM 无法确认机器人进程身份；拒绝强制终止。' }
    if ($probe.State -eq 'missing') { return $false }
    $rootHandle = Open-XbbVerifiedProcessHandle ([pscustomobject]@{ ProcessId = [int]$probe.Identity.ProcessId; CreationToken = [string]$probe.Identity.CreationDate; ExecutablePath = [string]$probe.Identity.Executable })
    $rootIdentity = [pscustomobject]@{ ProcessId = [int]$probe.Identity.ProcessId; CreationToken = [string]$probe.Identity.CreationDate; CreationAt = $probe.Identity.CreationAt; ExecutablePath = [string]$probe.Identity.Executable }
    $boundProcesses = [Collections.Generic.List[object]]::new(); $knownProcesses = @{}
    $rootBound = [pscustomobject]@{ Identity = $rootIdentity; Handle = $rootHandle }
    $boundProcesses.Add($rootBound) | Out-Null; $knownProcesses[$rootIdentity.ProcessId] = $rootBound
    try {
        $stableRounds = 0
        for ($round = 0; $round -lt 32 -and $stableRounds -lt 2; $round += 1) {
            $added = Add-VerifiedProductDescendantHandles @(Get-HealthyMaintenanceProcessSnapshot) $boundProcesses $knownProcesses
            if ($added -eq 0) { $stableRounds += 1 } else { $stableRounds = 0 }
            if ($stableRounds -lt 2) { Start-Sleep -Milliseconds 100 }
        }
        if ($stableRounds -lt 2) { throw '产品进程树持续变化，未终止任何进程。' }
        foreach ($bound in @($boundProcesses | Sort-Object @{ Expression = { if ($_.Identity.ProcessId -eq $rootIdentity.ProcessId) { 0 } else { 1 } } }, @{ Expression = { $_.Identity.CreationAt } })) {
            if (-not $bound.Handle.HasExited -and -not $bound.Handle.TerminateAndWait(1, 5000)) { throw '持柄产品进程未确认终止。' }
        }
        $emptyRounds = 0
        for ($round = 0; $round -lt 32 -and $emptyRounds -lt 2; $round += 1) {
            $added = Add-VerifiedProductDescendantHandles @(Get-HealthyMaintenanceProcessSnapshot) $boundProcesses $knownProcesses
            foreach ($bound in @($boundProcesses)) { if (-not $bound.Handle.HasExited -and -not $bound.Handle.TerminateAndWait(1, 5000)) { throw '新生产品后代未确认终止。' } }
            if ($added -eq 0 -and @($boundProcesses | Where-Object { -not $_.Handle.HasExited }).Count -eq 0) { $emptyRounds += 1 } else { $emptyRounds = 0 }
            if ($emptyRounds -lt 2) { Start-Sleep -Milliseconds 100 }
        }
        if ($emptyRounds -lt 2) { throw '产品进程树未通过连续健康空确认。' }
        $emptyState = Confirm-EmptyProductProcessSlot (Find-ProductProcessCandidates)
        if ($emptyState -ne 'empty') { throw "持柄终止后未能连续确认机器人产品进程槽为空：$emptyState" }
        return $true
    } finally { foreach ($bound in @($boundProcesses | Sort-Object { $_.Identity.CreationAt } -Descending)) { $bound.Handle.Dispose() } }
}

function Assert-ProductProcessSlotEmpty([string]$Reason) {
    $candidates = Find-ProductProcessCandidates
    $emptyState = Confirm-EmptyProductProcessSlot $candidates
    if ($emptyState -eq 'indeterminate') { throw "CIM 无法确认$Reason机器人产品进程。" }
    if ($emptyState -eq 'multiple') { throw "$Reason发现多个机器人产品进程；拒绝并行启动。" }
    if ($emptyState -ne 'empty') { throw "$Reason仍存在机器人产品进程；拒绝并行启动。" }
}

function Ensure-ProductProcessesStopped($KnownIdentity = $null) {
    if ($null -ne $KnownIdentity) {
        $wait = Wait-ProductProcessExit $KnownIdentity 15
        if ($wait.State -eq 'indeterminate') { throw 'CIM 无法确认升级前机器人进程是否退出。' }
        if ($wait.State -eq 'timeout') {
            [void](Stop-ProductProcessTree $KnownIdentity)
            $wait = Wait-ProductProcessExit $KnownIdentity 1
            if ($wait.State -ne 'stopped') { throw '升级前机器人进程未能安全退出。' }
        }
    }
    $remaining = Find-ProductProcessCandidates
    if ($remaining.State -eq 'indeterminate') { throw 'CIM 无法确认机器人孤儿进程。' }
    if ($remaining.State -eq 'multiple') { throw '发现多个完整匹配的机器人进程；拒绝批量终止。' }
    if ($remaining.State -eq 'unique') {
        $identity = @($remaining.Identities)[0]
        [void](Stop-ProductProcessTree $identity)
        $wait = Wait-ProductProcessExit $identity 1
        if ($wait.State -ne 'stopped') { throw '唯一匹配的机器人孤儿进程未能安全退出。' }
    }
    Assert-ProductProcessSlotEmpty '升级前最终确认'
}

function Resolve-ManagedRuntimePaths($MainMetadata, $WatchdogMetadata = $null) {
    if (-not (Test-FullyQualifiedWindowsPath ([string]$MainMetadata.ConfigPath))) { throw '旧机器人配置不是 fully-qualified Windows 路径。' }
    $managedConfig = [IO.Path]::GetFullPath([string]$MainMetadata.ConfigPath)
    if (-not [IO.File]::Exists($managedConfig)) { throw "旧机器人配置不存在，无法提供可验证回滚：$managedConfig" }
    $stored = Get-Content -LiteralPath $managedConfig -Raw -Encoding UTF8 | ConvertFrom-Json
    $parent = [IO.Path]::GetDirectoryName($managedConfig)
    $managedLease = if ($null -ne $WatchdogMetadata -and -not [string]::IsNullOrWhiteSpace([string]$WatchdogMetadata.LeasePath)) {
        if (-not (Test-FullyQualifiedWindowsPath ([string]$WatchdogMetadata.LeasePath))) { throw '旧看门狗租约不是 fully-qualified Windows 路径。' }
        [IO.Path]::GetFullPath([string]$WatchdogMetadata.LeasePath)
    } elseif ($stored.PSObject.Properties.Name -contains 'serviceLeasePath' -and -not [string]::IsNullOrWhiteSpace([string]$stored.serviceLeasePath)) {
        if (-not (Test-FullyQualifiedWindowsPath ([string]$stored.serviceLeasePath))) { throw '旧 serviceLeasePath 不是 fully-qualified Windows 路径。' }
        [IO.Path]::GetFullPath([string]$stored.serviceLeasePath)
    } else { [IO.Path]::GetFullPath((Join-Path $parent 'service-lease.json')) }
    $managedStatus = if ($stored.PSObject.Properties.Name -contains 'statusLogPath' -and -not [string]::IsNullOrWhiteSpace([string]$stored.statusLogPath)) {
        if (-not (Test-FullyQualifiedWindowsPath ([string]$stored.statusLogPath))) { throw '旧 statusLogPath 不是 fully-qualified Windows 路径。' }
        [IO.Path]::GetFullPath([string]$stored.statusLogPath)
    } else { [IO.Path]::GetFullPath((Join-Path $parent 'status.jsonl')) }
    return [pscustomobject][ordered]@{ LeasePath = $managedLease; StatusPath = $managedStatus }
}

function Get-RunnerIsolationMarkerDirectories([string[]]$LeasePaths) {
    $directories = [Collections.Generic.List[string]]::new()
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($candidateLeasePath in @($LeasePaths)) {
        if (-not (Test-FullyQualifiedWindowsPath $candidateLeasePath)) {
            throw "runner 隔离恢复租约必须是 fully-qualified Windows 路径：$candidateLeasePath"
        }
        $resolvedRuntimeLease = [IO.Path]::GetFullPath($candidateLeasePath)
        $runtimeDirectory = [IO.Path]::GetDirectoryName($resolvedRuntimeLease)
        if ([string]::IsNullOrWhiteSpace($runtimeDirectory)) { throw "无法解析 runner 隔离恢复目录：$candidateLeasePath" }
        $markerDirectory = [IO.Path]::GetFullPath((Join-Path $runtimeDirectory 'runner-isolation'))
        if ($seen.Add($markerDirectory)) { $directories.Add($markerDirectory) | Out-Null }
    }
    return @($directories)
}

function Assert-RunnerIsolationRecoveryResult($Result, [string]$MarkerDirectory) {
    $properties = if ($null -eq $Result) { @() } else { @($Result.PSObject.Properties.Name) }
    if ($properties -notcontains 'success' -or $properties -notcontains 'markersRecovered' -or
        $properties -notcontains 'processesTerminated' -or $properties -notcontains 'runDirectoriesRemoved' -or
        -not ($Result.success -is [bool]) -or -not [bool]$Result.success) {
        throw "runner 隔离恢复器返回了无效结果：$MarkerDirectory"
    }
    try {
        $markersRecovered = [int64]$Result.markersRecovered
        $processesTerminated = [int64]$Result.processesTerminated
        $runDirectoriesRemoved = [int64]$Result.runDirectoriesRemoved
    } catch { throw "runner 隔离恢复器返回了无效计数：$MarkerDirectory" }
    if ($markersRecovered -lt 0 -or $processesTerminated -lt 0 -or $runDirectoriesRemoved -lt 0) {
        throw "runner 隔离恢复器返回了负数计数：$MarkerDirectory"
    }
    return [pscustomobject][ordered]@{
        MarkersRecovered = $markersRecovered
        ProcessesTerminated = $processesTerminated
        RunDirectoriesRemoved = $runDirectoriesRemoved
    }
}

function Invoke-RunnerIsolationRecoveryForLeasePaths([string[]]$LeasePaths, [scriptblock]$RecoveryInvoker = $null) {
    $markerDirectories = @(Get-RunnerIsolationMarkerDirectories $LeasePaths)
    $markersRecovered = [int64]0
    $processesTerminated = [int64]0
    $runDirectoriesRemoved = [int64]0
    foreach ($markerDirectory in $markerDirectories) {
        if ($null -ne $RecoveryInvoker) {
            $rawResult = & $RecoveryInvoker $markerDirectory
        } else {
            $output = @(& $powerShellPath '-NoLogo' '-NoProfile' '-NonInteractive' '-ExecutionPolicy' 'Bypass' `
                '-File' $runnerRecoveryScript '-MarkerDirectory' $markerDirectory '-ProjectRoot' $projectRoot 2>&1)
            $recoveryExitCode = $LASTEXITCODE
            if ($recoveryExitCode -ne 0) {
                throw "runner 隔离恢复器失败（exit=$recoveryExitCode）：$markerDirectory"
            }
            $outputLines = @($output | ForEach-Object { ([string]$_).Trim() } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
            if ($outputLines.Count -eq 0) { throw "runner 隔离恢复器没有返回结果：$markerDirectory" }
            try { $rawResult = $outputLines[-1] | ConvertFrom-Json } catch {
                throw "runner 隔离恢复器返回了无效 JSON：$markerDirectory"
            }
        }
        $verifiedResult = Assert-RunnerIsolationRecoveryResult $rawResult $markerDirectory
        $markersRecovered += [int64]$verifiedResult.MarkersRecovered
        $processesTerminated += [int64]$verifiedResult.ProcessesTerminated
        $runDirectoriesRemoved += [int64]$verifiedResult.RunDirectoriesRemoved
    }
    return [pscustomobject][ordered]@{
        MarkerDirectories = @($markerDirectories)
        MarkersRecovered = $markersRecovered
        ProcessesTerminated = $processesTerminated
        RunDirectoriesRemoved = $runDirectoriesRemoved
    }
}

function Get-ManagedLeaseHealth([string]$ManagedLeasePath, $Metadata, [DateTimeOffset]$NotBefore) {
    $emptyHealth = [ordered]@{ State = 'unhealthy'; InstanceId = ''; StateSinceAt = $null; Identity = $null }
    if (-not (Test-FullyQualifiedWindowsPath $ManagedLeasePath)) {
        $emptyHealth.State = 'indeterminate'
        return [pscustomobject]$emptyHealth
    }
    $roundCandidates = Find-ProductProcessCandidates
    if ($roundCandidates.State -eq 'indeterminate') { $emptyHealth.State = 'indeterminate'; return [pscustomobject]$emptyHealth }
    if ($roundCandidates.State -eq 'multiple') { $emptyHealth.State = 'conflict'; return [pscustomobject]$emptyHealth }
    if (-not [IO.File]::Exists($ManagedLeasePath)) {
        if ($roundCandidates.State -ne 'none') { $emptyHealth.State = 'conflict' }
        return [pscustomobject]$emptyHealth
    }
    try {
        $lease = Get-Content -LiteralPath $ManagedLeasePath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([string]$lease.schemaVersion -ne '1.0' -or [string]$lease.service -ne 'xbb-executive-analyst-wecom' -or
            [string]$lease.state -notin @('starting', 'running')) {
            if ($roundCandidates.State -eq 'unique') { $emptyHealth.State = 'conflict' }
            return [pscustomobject]$emptyHealth
        }
        if ([string]$lease.instanceId -notmatch '^[A-Za-z0-9-]{16,128}$') {
            if ($roundCandidates.State -eq 'unique') { $emptyHealth.State = 'conflict' }
            return [pscustomobject]$emptyHealth
        }
        $style = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
        $updatedAt = [DateTimeOffset]::Parse([string]$lease.updatedAt, [Globalization.CultureInfo]::InvariantCulture, $style)
        $stateSinceAt = [DateTimeOffset]::Parse([string]$lease.stateSinceAt, [Globalization.CultureInfo]::InvariantCulture, $style)
        $now = [DateTimeOffset]::UtcNow
        $probe = Get-ManagedProcessProbe ([int64]$lease.pid) $Metadata
        if ($probe.State -eq 'indeterminate') { $emptyHealth.State = 'indeterminate'; return [pscustomobject]$emptyHealth }
        $productCandidates = Find-ProductProcessCandidates
        if ($productCandidates.State -eq 'indeterminate') { $emptyHealth.State = 'indeterminate'; return [pscustomobject]$emptyHealth }
        if ($productCandidates.State -eq 'multiple') { $emptyHealth.State = 'conflict'; return [pscustomobject]$emptyHealth }
        if ($probe.State -ne 'alive') {
            if ($productCandidates.State -eq 'unique') { $emptyHealth.State = 'conflict' }
            return [pscustomobject]$emptyHealth
        }
        if ($productCandidates.State -ne 'unique') { $emptyHealth.State = 'conflict'; return [pscustomobject]$emptyHealth }
        $productIdentity = @($productCandidates.Identities)[0]
        if ([int64]$productIdentity.ProcessId -ne [int64]$probe.Identity.ProcessId -or
            [string]$productIdentity.CreationDate -ne [string]$probe.Identity.CreationDate -or
            -not ([string]$productIdentity.Executable).Equals([string]$probe.Identity.Executable, [StringComparison]::OrdinalIgnoreCase) -or
            -not ([string]$productIdentity.Arguments).Equals([string]$probe.Identity.Arguments, [StringComparison]::OrdinalIgnoreCase)) {
            $emptyHealth.State = 'conflict'
            return [pscustomobject]$emptyHealth
        }
        if ([string]$lease.state -ne 'running' -or $updatedAt -lt $NotBefore -or $stateSinceAt -lt $NotBefore -or
            $updatedAt -gt $now.AddSeconds(60) -or ($now - $updatedAt).TotalSeconds -gt 180) {
            return [pscustomobject]$emptyHealth
        }
        if ($probe.Identity.CreationAt -lt $NotBefore -or $probe.Identity.CreationAt -gt $stateSinceAt.AddSeconds(2)) {
            return [pscustomobject]$emptyHealth
        }
        return [pscustomobject][ordered]@{ State = 'healthy'; InstanceId = [string]$lease.instanceId; StateSinceAt = $stateSinceAt; Identity = $probe.Identity }
    } catch {
        if ($roundCandidates.State -eq 'unique') { $emptyHealth.State = 'conflict' }
        return [pscustomobject]$emptyHealth
    }
}

function Wait-ManagedRuntimeHealthy([string]$Name, [string]$ManagedLeasePath, [string]$ManagedStatusPath, $Metadata, [DateTimeOffset]$NotBefore, [int]$TimeoutSeconds) {
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try {
            $task = Get-ExactTask $Name
            $health = Get-ManagedLeaseHealth $ManagedLeasePath $Metadata $NotBefore
            if ($health.State -in @('indeterminate', 'conflict')) { return [pscustomobject][ordered]@{ State = $health.State } }
            if ($null -ne $task -and [string]$task.State -eq 'Running' -and $health.State -eq 'healthy' -and
                (Test-NewReadyStatus $ManagedStatusPath $health.StateSinceAt $health.InstanceId)) {
                $finalHealth = Get-ManagedLeaseHealth $ManagedLeasePath $Metadata $NotBefore
                if ($finalHealth.State -in @('indeterminate', 'conflict')) { return [pscustomobject][ordered]@{ State = $finalHealth.State } }
                if ($finalHealth.State -eq 'healthy' -and [string]$finalHealth.InstanceId -ceq [string]$health.InstanceId -and
                    (Test-NewReadyStatus $ManagedStatusPath $finalHealth.StateSinceAt $finalHealth.InstanceId)) {
                    return [pscustomobject][ordered]@{ State = 'healthy'; InstanceId = $finalHealth.InstanceId }
                }
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
    $initialCandidates = Find-ProductProcessCandidates
    if ($initialCandidates.State -eq 'indeterminate') { throw 'CIM 无法确认启动租约对应的机器人产品进程。' }
    if ($initialCandidates.State -eq 'multiple') { throw '启动租约等待期间出现多个机器人产品代际。' }
    if ($null -eq $Lease -or [string]$Lease.instanceId -notmatch '^[A-Za-z0-9-]{16,128}$') { return $false }
    if ([string]$Lease.state -notin @('starting', 'running')) { return $false }
    if (-not [string]::IsNullOrWhiteSpace($RequiredState) -and [string]$Lease.state -ne $RequiredState) { return $false }
    try {
        $updatedAt = [DateTimeOffset]::Parse([string]$Lease.updatedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal)
        $stateSinceAt = [DateTimeOffset]::Parse([string]$Lease.stateSinceAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal)
        $probe = Get-ManagedProcessProbe ([int64]$Lease.pid) $newMainMetadata
        if ($probe.State -eq 'indeterminate') { throw 'CIM 无法确认启动租约 PID 身份。' }
        $finalCandidates = Find-ProductProcessCandidates
        if ($finalCandidates.State -eq 'indeterminate') { throw 'CIM 无法复核启动租约对应的机器人产品进程。' }
        if ($finalCandidates.State -eq 'multiple') { throw '启动租约复核期间出现多个机器人产品代际。' }
        if ($probe.State -ne 'alive' -or $finalCandidates.State -ne 'unique') { return $false }
        $productIdentity = @($finalCandidates.Identities)[0]
        return [int64]$productIdentity.ProcessId -eq [int64]$probe.Identity.ProcessId -and
            [string]$productIdentity.CreationDate -eq [string]$probe.Identity.CreationDate -and
            ([string]$productIdentity.Executable).Equals([string]$probe.Identity.Executable, [StringComparison]::OrdinalIgnoreCase) -and
            ([string]$productIdentity.Arguments).Equals([string]$probe.Identity.Arguments, [StringComparison]::OrdinalIgnoreCase) -and
            $updatedAt -ge $NotBefore -and $stateSinceAt -ge $NotBefore -and
            $probe.State -eq 'alive' -and $probe.Identity.CreationAt -ge $NotBefore -and
            $probe.Identity.CreationAt -le $stateSinceAt.AddSeconds(2)
    } catch {
        if ($_.Exception.Message -match '^CIM 无法|多个机器人产品代际') { throw }
        return $false
    }
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

$maintenanceSnapshotSentinel = New-MaintenanceSnapshotSentinel
$maintenanceMutex = [Threading.Mutex]::new($false, (Get-MaintenanceMutexName $TaskName))
$maintenanceMutexHeld = $false
try {
    try { $maintenanceMutexHeld = $maintenanceMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $maintenanceMutexHeld = $true }
    if (-not $maintenanceMutexHeld) { throw '另一个机器人安装、卸载或看门狗维护操作正在进行；未修改任何计划任务。' }
} catch {
    $maintenanceMutex.Dispose()
    throw
}

try {
Assert-NoOtherProductTasks
$mainTaskBackup = Export-OwnedTaskBackup $TaskName
$watchdogTaskBackup = Export-OwnedTaskBackup $watchdogTaskName
Assert-OwnedTaskEvidence $mainTaskBackup $watchdogTaskBackup
$oldProcessIdentity = $null
$preexistingProductIdentity = $null
$oldRuntimePaths = $null
$shouldRestoreRuntime = $false
$runnerRecoveryLeasePaths = [Collections.Generic.List[string]]::new()
$productCandidates = Find-ProductProcessCandidates
if ($productCandidates.State -eq 'indeterminate') { throw 'CIM 无法确认安装前机器人产品进程；未修改任何计划任务。' }
if ($productCandidates.State -eq 'multiple') { throw '安装前发现多个不同代际的机器人产品进程；未修改任何计划任务。' }
if ($productCandidates.State -eq 'unique') { $preexistingProductIdentity = @($productCandidates.Identities)[0] }
$oldWatchdogMetadata = if ($watchdogTaskBackup.Exists) { $watchdogTaskBackup.Metadata } else { $null }
if ($null -ne $oldWatchdogMetadata -and -not [string]::IsNullOrWhiteSpace([string]$oldWatchdogMetadata.LeasePath)) {
    $runnerRecoveryLeasePaths.Add([string]$oldWatchdogMetadata.LeasePath) | Out-Null
}
if ($mainTaskBackup.Exists) {
    if ($null -ne $preexistingProductIdentity -and
        ([string]$preexistingProductIdentity.Arguments).Equals([string]$mainTaskBackup.Metadata.Arguments, [StringComparison]::OrdinalIgnoreCase)) {
        $oldProcessIdentity = $preexistingProductIdentity
    }
    $shouldRestoreRuntime = $mainTaskBackup.WasRunning -or $null -ne $oldProcessIdentity
    $oldConfiguredRuntimePaths = Resolve-ManagedRuntimePaths $mainTaskBackup.Metadata
    $runnerRecoveryLeasePaths.Add([string]$oldConfiguredRuntimePaths.LeasePath) | Out-Null
    $oldRuntimePaths = Resolve-ManagedRuntimePaths $mainTaskBackup.Metadata $oldWatchdogMetadata
}
$runnerRecoveryLeasePaths.Add($leasePath) | Out-Null

try {
    Remove-ExistingTaskForUpgrade $watchdogTaskName @($watchdogTaskBackup.Metadata)
    Remove-ExistingTaskForUpgrade $TaskName @($mainTaskBackup.Metadata)
    # 先收敛仍挂在旧服务下的 marker-bound 查询树，避免把非 App Server 后代
    # 误交给产品树终止器；服务根退出后再做一次，覆盖并发收尾窗口。
    $preStopRunnerIsolationRecovery = Invoke-RunnerIsolationRecoveryForLeasePaths @($runnerRecoveryLeasePaths)
    Ensure-ProductProcessesStopped $preexistingProductIdentity
    $runnerIsolationRecovery = Invoke-RunnerIsolationRecoveryForLeasePaths @($runnerRecoveryLeasePaths)

    & $hiddenNodeInstaller -NodePath $nodePath -OutputPath $hiddenNodePath -HashPath $hiddenNodeHashPath | Out-Null
    [IO.File]::Delete((Join-Path $runtimeRoot 'xbb-wecom-hidden-launcher.exe'))
    [IO.File]::Delete((Join-Path $runtimeRoot 'xbb-wecom-hidden-launcher.sha256'))

    $action = New-ScheduledTaskAction -Execute $hiddenNodePath -Argument $newMainArguments -WorkingDirectory $projectRoot
    $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    $settings.IdleSettings.RestartOnIdle = $true
    $settings.Hidden = $true
    $task = New-ScheduledTask -Action $action -Trigger $logonTrigger -Principal $principal -Settings $settings -Description $mainTaskDescription
    if ($null -ne (Get-ExactTask $TaskName)) { throw '注册主任务前任务槽不为空。' }
    Register-ScheduledTask -TaskName $TaskName -TaskPath $taskPath -InputObject $task -ErrorAction Stop | Out-Null
    [void](Get-VerifiedOwnedTask $TaskName $newMainMetadata)
    $watchdogAction = New-ScheduledTaskAction -Execute $hiddenNodePath -Argument $watchdogArguments -WorkingDirectory $projectRoot
    $watchdogLogonTrigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
    $watchdogLogonTrigger.Delay = 'PT30S'
    $watchdogRecoveryTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 5)
    $watchdogSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    $watchdogSettings.Hidden = $true
    $watchdogTask = New-ScheduledTask -Action $watchdogAction -Trigger @($watchdogLogonTrigger, $watchdogRecoveryTrigger) -Principal $principal -Settings $watchdogSettings -Description $watchdogTaskDescription
    if ($null -ne (Get-ExactTask $watchdogTaskName)) { throw '注册看门狗前任务槽不为空。' }
    Register-ScheduledTask -TaskName $watchdogTaskName -TaskPath $taskPath -InputObject $watchdogTask -ErrorAction Stop | Out-Null
    [void](Get-VerifiedOwnedTask $watchdogTaskName $newWatchdogMetadata)
    $launchRequestedAt = [DateTimeOffset]::UtcNow.AddSeconds(-2)
    Assert-ProductProcessSlotEmpty '启动新任务前'
    Start-VerifiedOwnedTask $TaskName $newMainMetadata
    $leaseObservedDeadline = [DateTimeOffset]::UtcNow.AddSeconds(15)
    do {
        $launchLease = Read-LeaseState
        if (Test-LaunchLease $launchLease $launchRequestedAt) { break }
        Start-Sleep -Milliseconds 250
    } while ([DateTimeOffset]::UtcNow -lt $leaseObservedDeadline)
    Start-VerifiedOwnedTask $watchdogTaskName $newWatchdogMetadata

    $readyDeadline = [DateTimeOffset]::UtcNow.AddSeconds(120)
    $runtimeStarted = $false
    $authenticated = $false
    $acceptedHealth = $null
    do {
        $mainTask = Get-ExactTask $TaskName
        $health = Get-ManagedLeaseHealth $leasePath $newMainMetadata $launchRequestedAt
        if ($health.State -eq 'indeterminate') { throw 'CIM 无法确认新机器人进程；安装器进入安全回滚。' }
        if ($health.State -eq 'conflict') { throw '新机器人等待期间出现第二代际或租约身份冲突；安装器进入安全回滚。' }
        $runtimeStarted = $null -ne $mainTask -and [string]$mainTask.State -eq 'Running' -and $health.State -eq 'healthy'
        if ($runtimeStarted -and (Test-NewReadyStatus $statusLogPath $health.StateSinceAt $health.InstanceId)) {
            $authenticated = $true
            $acceptedHealth = $health
            break
        }
        Start-Sleep -Milliseconds 500
    } while ([DateTimeOffset]::UtcNow -lt $readyDeadline)

    if (-not $runtimeStarted) { throw '机器人任务已安装，但 120 秒内没有形成有效 running 租约。' }
    if (-not $authenticated) { throw '机器人运行时已启动，但 120 秒内未通过企业微信认证。' }

    $finalMainTask = Get-ExactTask $TaskName
    $finalHealth = Get-ManagedLeaseHealth $leasePath $newMainMetadata $launchRequestedAt
    $finalReady = $null -ne $finalMainTask -and [string]$finalMainTask.State -eq 'Running' -and
        $finalHealth.State -eq 'healthy' -and $null -ne $acceptedHealth -and
        [string]$finalHealth.InstanceId -ceq [string]$acceptedHealth.InstanceId -and
        [int64]$finalHealth.Identity.ProcessId -eq [int64]$acceptedHealth.Identity.ProcessId -and
        [string]$finalHealth.Identity.CreationDate -eq [string]$acceptedHealth.Identity.CreationDate -and
        (Test-NewReadyStatus $statusLogPath $finalHealth.StateSinceAt $finalHealth.InstanceId)
    if (-not $finalReady) { throw '输出安装成功前的产品级最终验活失败；安装器进入安全回滚。' }

    Write-Output ([ordered]@{ success = $true; taskName = $TaskName; watchdogTaskName = $watchdogTaskName; projectRoot = $projectRoot; started = $true; authenticated = $true; windowMode = 'direct-node-windows-gui-subsystem'; watchdogWindowMode = 'nodew-windowsHide'; processTree = 'task-scheduler-direct-root+external-lease-watchdog'; recoveryMode = 'restart-on-failure+connection-watchdog+external-lease-watchdog'; recoveryAttempts = 3; recoveryIntervalMinutes = 1; watchdogIntervalMinutes = 5; leaseStaleSeconds = 180 } | ConvertTo-Json -Compress)
} catch {
    $installFailure = $_
    $rollbackErrors = [Collections.Generic.List[string]]::new()
    $rollbackProcessSafe = $true

    foreach ($cleanupTarget in @(
        [pscustomobject]@{ Name = $watchdogTaskName; Allowed = @($newWatchdogMetadata, $watchdogTaskBackup.Metadata) },
        [pscustomobject]@{ Name = $TaskName; Allowed = @($newMainMetadata, $mainTaskBackup.Metadata) }
    )) {
        try { Remove-ExistingTaskForUpgrade ([string]$cleanupTarget.Name) @($cleanupTarget.Allowed) } catch {
            $rollbackProcessSafe = $false
            $rollbackErrors.Add("清理半安装任务 $($cleanupTarget.Name) 失败：$($_.Exception.Message)") | Out-Null
        }
    }
    try {
        $rollbackPreStopRunnerIsolationRecovery = Invoke-RunnerIsolationRecoveryForLeasePaths @($runnerRecoveryLeasePaths)
    } catch {
        $rollbackProcessSafe = $false
        $rollbackErrors.Add("回滚强停前清理 runner 隔离状态失败：$($_.Exception.Message)") | Out-Null
    }
    try { Ensure-ProductProcessesStopped } catch {
        $rollbackProcessSafe = $false
        $rollbackErrors.Add("清理新机器人进程失败：$($_.Exception.Message)") | Out-Null
    }
    # 首次 recovery 之后仍可能已有半安装代际启动 runner；在恢复任何旧任务前，
    # 必须再次扫描旧/新 lease 对应的全部 isolation 目录。失败时旧主任务保持围栏。
    try {
        $rollbackRunnerIsolationRecovery = Invoke-RunnerIsolationRecoveryForLeasePaths @($runnerRecoveryLeasePaths)
    } catch {
        $rollbackProcessSafe = $false
        $rollbackErrors.Add("回滚前再次清理 runner 隔离状态失败：$($_.Exception.Message)") | Out-Null
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
            try { Disable-VerifiedOwnedTask $TaskName $mainTaskBackup.Metadata } catch {
                $rollbackErrors.Add("CIM 不确定时禁用恢复主任务失败：$($_.Exception.Message)") | Out-Null
            }
        }
        if ($mainTaskBackup.Exists -and $watchdogTaskBackup.Exists -and $watchdogTaskBackup.WasEnabled) {
            try { Enable-VerifiedOwnedTask $watchdogTaskName $watchdogTaskBackup.Metadata } catch {
                $rollbackErrors.Add("启用安全恢复看门狗失败：$($_.Exception.Message)") | Out-Null
            }
        }
    } else {
        foreach ($backup in @($mainTaskBackup, $watchdogTaskBackup)) {
            $temporarilyNeeded = $backup.Exists -and ($backup.WasRunning -or
                (([string]$backup.Name).Equals($TaskName, [StringComparison]::OrdinalIgnoreCase) -and $shouldRestoreRuntime))
            if (-not $backup.Exists -or (-not $backup.WasEnabled -and -not $temporarilyNeeded)) { continue }
            try {
                if (([string]$backup.Name).Equals($TaskName, [StringComparison]::OrdinalIgnoreCase)) {
                    Assert-ProductProcessSlotEmpty '恢复旧任务前'
                }
                Enable-VerifiedOwnedTask ([string]$backup.Name) $backup.Metadata
            } catch {
                $rollbackErrors.Add("重新启用旧计划任务 $($backup.Name) 失败：$($_.Exception.Message)") | Out-Null
            }
        }
        foreach ($backup in @($mainTaskBackup, $watchdogTaskBackup)) {
            $shouldStart = $backup.Exists -and ($backup.WasRunning -or
                (([string]$backup.Name).Equals($TaskName, [StringComparison]::OrdinalIgnoreCase) -and $shouldRestoreRuntime))
            if (-not $shouldStart) { continue }
            try {
                if (([string]$backup.Name).Equals($TaskName, [StringComparison]::OrdinalIgnoreCase)) {
                    $rollbackCandidates = Find-ProductProcessCandidates
                    if ($rollbackCandidates.State -eq 'indeterminate') { throw 'CIM 无法确认恢复启动前的机器人产品进程。' }
                    if ($rollbackCandidates.State -eq 'multiple') { throw '恢复启动前出现多个机器人产品进程。' }
                    if ($rollbackCandidates.State -eq 'none') {
                        Start-VerifiedOwnedTask ([string]$backup.Name) $backup.Metadata
                    } else {
                        $autoRestoredIdentity = @($rollbackCandidates.Identities)[0]
                        if (-not ([string]$autoRestoredIdentity.Arguments).Equals([string]$mainTaskBackup.Metadata.Arguments, [StringComparison]::OrdinalIgnoreCase) -or
                            $autoRestoredIdentity.CreationAt -lt $rollbackRequestedAt) {
                            throw '恢复任务启用后出现无法归属到本次回滚的新产品进程。'
                        }
                    }
                } else {
                    Start-VerifiedOwnedTask ([string]$backup.Name) $backup.Metadata
                }
            } catch {
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
            try { Disable-VerifiedOwnedTask ([string]$backup.Name) $backup.Metadata } catch {
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
