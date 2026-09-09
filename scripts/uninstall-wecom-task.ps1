[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')]
    [string]$TaskName = 'Codex-XBB-Executive-Analyst-WeCom'
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
    if ([string]::IsNullOrWhiteSpace($Name) -or [string]::IsNullOrWhiteSpace($Path) -or -not $Path.StartsWith('\')) { throw '计划任务身份字段无效。' }
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
                $snapshot.Add([pscustomobject]@{
                    TaskName = $taskName; TaskPath = $fullTaskPath.Substring(0, $fullTaskPath.Length - $taskName.Length)
                    Actions = @($actions); Description = [string]$definition.RegistrationInfo.Description
                }) | Out-Null
            }
            foreach ($childFolder in @($folder.GetFolders(0))) { $folders.Enqueue($childFolder) }
        }
        return @($snapshot)
    } finally {
        if ($null -ne $service -and [Runtime.InteropServices.Marshal]::IsComObject($service)) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($service) }
    }
}

function Test-IndependentScheduledTaskExists([string]$Name, [string]$Path) {
    $key = Get-TaskIdentityKey $Name $Path
    $matches = @(Get-IndependentScheduledTaskSnapshot | Where-Object { (Get-TaskIdentityKey ([string]$_.TaskName) ([string]$_.TaskPath)) -ceq $key })
    if ($matches.Count -gt 1) { throw "独立任务快照发现重复身份：$Path$Name" }
    return $matches.Count -eq 1
}

$taskPath = '\'
$watchdogTaskName = "$TaskName-Watchdog"
$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$maintenanceScriptPath = [IO.Path]::GetFullPath($MyInvocation.MyCommand.Path)
$server = [IO.Path]::GetFullPath((Join-Path $projectRoot 'shared\wecom\server.js'))
$watchdogScript = [IO.Path]::GetFullPath((Join-Path $projectRoot 'scripts\watchdog-wecom-task.ps1'))
$runnerRecoveryScript = [IO.Path]::GetFullPath((Join-Path $projectRoot 'scripts\recover-runner-isolation.ps1'))
$processHandleScript = [IO.Path]::GetFullPath((Join-Path $projectRoot 'scripts\windows-process-handle.ps1'))
$runtimeRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Codex\xbb-executive-analyst\bin'
$hiddenNodePath = [IO.Path]::GetFullPath((Join-Path $runtimeRoot 'nodew.exe'))
$powerShellPath = [IO.Path]::GetFullPath((Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'))
$defaultConfigPath = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Codex\xbb-executive-analyst\bot-config.json'))
$mainTaskDescription = '无控制台 Node + Codex App Server + xbb-executive-analyst Skill 企业微信智能 Agent（异常退出自动重启）'
$watchdogTaskDescription = '外部租约看门狗：检测机器人进程卡死并重启主计划任务'
$productServerArgumentPrefix = "`"$server`""
$mainArgumentPattern = '^(?:"(?<serverPath>[^\r\n"]+)"|(?<plainServerPath>\S+))(?: --managed-config "(?<configPath>[^\r\n"]+)")?$'
$productArgumentPattern = $mainArgumentPattern
$productServerSuffix = '\shared\wecom\server.js'
$productStartScriptSuffix = '\scripts\start-wecom-bot.ps1'
$productWatchdogScriptSuffix = '\scripts\watchdog-wecom-task.ps1'
$productWatchdogLauncherSuffix = '\scripts\launch-wecom-watchdog.js'
$trustedProductServerPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
[void]$trustedProductServerPaths.Add([IO.Path]::GetFullPath($server))
$watchdogArgumentPrefix = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$watchdogScript`" -TaskName `"$TaskName`" -LeasePath `""
$watchdogArgumentPattern = '^' + [regex]::Escape($watchdogArgumentPrefix) + '(?<leasePath>[^\r\n"]+)' + [regex]::Escape('" -StaleSeconds 180') + '$'
if (-not [IO.File]::Exists($runnerRecoveryScript)) { throw "runner 隔离恢复器不存在：$runnerRecoveryScript" }
if (-not [IO.File]::Exists($powerShellPath)) { throw "Windows PowerShell 不存在：$powerShellPath" }
if (-not [IO.File]::Exists($processHandleScript)) { throw "Windows 进程句柄校验器不存在：$processHandleScript" }
. $processHandleScript

function Get-ExactTask([string]$Name) {
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
    $serverPath = if ($argumentMatch.Groups['serverPath'].Success) { [string]$argumentMatch.Groups['serverPath'].Value } else { [string]$argumentMatch.Groups['plainServerPath'].Value }
    if (-not (Test-ProductPathSuffix $serverPath $productServerSuffix)) { return $null }
    $resolvedConfig = ''
    if ($argumentMatch.Groups['configPath'].Success) {
        $rawConfig = [string]$argumentMatch.Groups['configPath'].Value
        if (-not (Test-FullyQualifiedWindowsPath $rawConfig)) { return $null }
        $resolvedConfig = [IO.Path]::GetFullPath($rawConfig)
    }
    return [pscustomobject]@{ ServerPath = [IO.Path]::GetFullPath($serverPath); ConfigPath = $resolvedConfig; Arguments = $Arguments }
}

function Get-ProductTaskActionMetadata($Action) {
    $execAction = Get-VerifiedExecTaskActionFields $Action
    if ([string]$execAction.State -eq 'not-exec') { return [pscustomobject]@{ State = 'not-product'; Kind = '' } }
    if ([string]$execAction.State -ne 'exec') { return [pscustomobject]@{ State = 'indeterminate'; Kind = '' } }
    $arguments = [string]$execAction.Arguments
    $rawExecutable = [Environment]::ExpandEnvironmentVariables([string]$execAction.Execute)
    $mentionsProductScript = $arguments.IndexOf($productServerSuffix, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $arguments.IndexOf($productStartScriptSuffix, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $arguments.IndexOf($productWatchdogScriptSuffix, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $arguments.IndexOf($productWatchdogLauncherSuffix, [StringComparison]::OrdinalIgnoreCase) -ge 0
    $legacyPowerShellAlias = $rawExecutable.Equals('powershell.exe', [StringComparison]::OrdinalIgnoreCase)
    if (-not (Test-FullyQualifiedWindowsPath $rawExecutable) -and -not $legacyPowerShellAlias) {
        $state = if ($mentionsProductScript) { 'indeterminate' } else { 'not-product' }
        return [pscustomobject]@{ State = $state; Kind = '' }
    }
    try { $actualExecutable = if ($legacyPowerShellAlias) { $powerShellPath } else { [IO.Path]::GetFullPath($rawExecutable) } } catch { return [pscustomobject]@{ State = 'indeterminate'; Kind = '' } }
    $executableName = [IO.Path]::GetFileName($actualExecutable)
    $argumentMetadata = Get-ProductArgumentsMetadata $arguments
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
        if ($null -ne $argumentMetadata) {
            return [pscustomobject][ordered]@{
                State = 'candidate'; Kind = 'main'; Executable = $actualExecutable; Arguments = $arguments
                ProductExecutable = $actualExecutable; ProductArguments = $arguments; ProductServerPath = [string]$argumentMetadata.ServerPath
                ConfigPath = if ([string]::IsNullOrWhiteSpace([string]$argumentMetadata.ConfigPath)) { $defaultConfigPath } else { [string]$argumentMetadata.ConfigPath }
                LeasePath = ''; ScriptPath = ''; TargetTaskName = ''
            }
        }
    }
    if ($executableName -imatch '^(?:powershell|pwsh)\.exe$') {
        $startMatch = [regex]::Match($arguments, '^-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "(?<script>[^\r\n"]+)"$', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
        if ($startMatch.Success -and (Test-ProductPathSuffix ([string]$startMatch.Groups['script'].Value) $productStartScriptSuffix)) {
            $startScriptPath = [IO.Path]::GetFullPath([string]$startMatch.Groups['script'].Value)
            $legacyServer = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent (Split-Path -Parent $startScriptPath)) 'shared\wecom\server.js'))
            return [pscustomobject][ordered]@{
                State = 'candidate'; Kind = 'main'; Executable = $actualExecutable; Arguments = $arguments
                ProductExecutable = ''; ProductArguments = ''; ProductServerPath = $legacyServer; ConfigPath = $defaultConfigPath; LeasePath = ''
                ScriptPath = $startScriptPath; TargetTaskName = ''
            }
        }
        $watchdogMatch = [regex]::Match($arguments,
            '^-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "(?<script>[^\r\n"]+)" -TaskName "(?<taskName>[A-Za-z0-9][A-Za-z0-9._-]{0,127})" -LeasePath "(?<leasePath>[^\r\n"]+)" -StaleSeconds 180$',
            [Text.RegularExpressions.RegexOptions]::IgnoreCase)
        if ($watchdogMatch.Success -and (Test-ProductPathSuffix ([string]$watchdogMatch.Groups['script'].Value) $productWatchdogScriptSuffix) -and
            (Test-FullyQualifiedWindowsPath ([string]$watchdogMatch.Groups['leasePath'].Value))) {
            return [pscustomobject][ordered]@{
                State = 'candidate'; Kind = 'watchdog'; Executable = $actualExecutable; Arguments = $arguments
                ProductExecutable = ''; ProductArguments = ''; ProductServerPath = ''; ConfigPath = ''
                LeasePath = [IO.Path]::GetFullPath([string]$watchdogMatch.Groups['leasePath'].Value)
                ScriptPath = [IO.Path]::GetFullPath([string]$watchdogMatch.Groups['script'].Value)
                TargetTaskName = [string]$watchdogMatch.Groups['taskName'].Value
            }
        }
    }
    $state = if ($mentionsProductScript -or $null -ne $argumentMetadata) { 'indeterminate' } else { 'not-product' }
    return [pscustomobject]@{ State = $state; Kind = '' }
}

function Get-ProductTaskSignatures([object[]]$Tasks) {
    $signatures = [Collections.Generic.List[string]]::new()
    foreach ($candidateTask in @($Tasks)) {
        $taskKey = Get-TaskIdentityKey ([string]$candidateTask.TaskName) ([string]$candidateTask.TaskPath)
        foreach ($candidateAction in @($candidateTask.Actions)) {
            $metadata = Get-ProductTaskActionMetadata $candidateAction
            if ([string]$metadata.State -eq 'indeterminate') { throw "产品计划任务 action 身份不确定：$taskKey" }
            if ([string]$metadata.State -eq 'candidate') {
                $signatures.Add(($taskKey + '|' + ([string]$metadata.Kind).ToLowerInvariant() + '|' +
                    ([string]$metadata.Executable).ToLowerInvariant() + '|' + ([string]$metadata.Arguments).ToLowerInvariant() + '|' +
                    ([string]$candidateTask.Description))) | Out-Null
            }
        }
    }
    return @($signatures | Sort-Object -Unique)
}

function Get-VerifiedProductTaskSnapshot {
    $providerSnapshot = @(Get-ScheduledTask -ErrorAction Stop)
    $independentSnapshot = @(Get-IndependentScheduledTaskSnapshot)
    $providerSignatures = @(Get-ProductTaskSignatures $providerSnapshot)
    $independentSignatures = @(Get-ProductTaskSignatures $independentSnapshot)
    if (($providerSignatures -join "`n") -cne ($independentSignatures -join "`n")) { throw '计划任务 provider 与独立 COM 产品任务快照不一致。' }
    if ($providerSignatures.Count -eq 0) {
        Start-Sleep -Milliseconds 100
        $confirmationProvider = @(Get-ScheduledTask -ErrorAction Stop)
        $confirmationIndependent = @(Get-IndependentScheduledTaskSnapshot)
        $confirmationProviderSignatures = @(Get-ProductTaskSignatures $confirmationProvider)
        $confirmationIndependentSignatures = @(Get-ProductTaskSignatures $confirmationIndependent)
        if (($confirmationProviderSignatures -join "`n") -cne ($confirmationIndependentSignatures -join "`n") -or $confirmationProviderSignatures.Count -ne 0) {
            throw '产品计划任务空快照未通过连续独立确认。'
        }
        return @($confirmationProvider)
    }
    return @($providerSnapshot)
}

function Assert-NoOtherProductTasks {
    $allowedKeys = @(
        (Get-TaskIdentityKey $TaskName $taskPath),
        (Get-TaskIdentityKey $watchdogTaskName $taskPath)
    )
    foreach ($candidateTask in @(Get-VerifiedProductTaskSnapshot)) {
        $taskKey = Get-TaskIdentityKey ([string]$candidateTask.TaskName) ([string]$candidateTask.TaskPath)
        foreach ($candidateAction in @($candidateTask.Actions)) {
            $metadata = Get-ProductTaskActionMetadata $candidateAction
            if ([string]$metadata.State -eq 'indeterminate') { throw "产品计划任务 action 身份不确定：$taskKey" }
            if ([string]$metadata.State -eq 'candidate' -and $allowedKeys -notcontains $taskKey) {
                throw "发现其他任务名或 TaskPath 的疑似机器人任务；证据未闭环，拒绝遗漏式卸载：$taskKey"
            }
        }
    }
}

function Get-OwnedTaskMetadata($Task, [string]$Name) {
    $actions = @($Task.Actions)
    if ($actions.Count -ne 1) { throw "计划任务名称已被其他任务占用：$Name" }
    $metadata = Get-ProductTaskActionMetadata $actions[0]
    $expectedKind = if ($Name -eq $TaskName) { 'main' } else { 'watchdog' }
    $expectedDescription = if ($Name -eq $TaskName) { $mainTaskDescription } else { $watchdogTaskDescription }
    if ([string]$metadata.State -ne 'candidate' -or [string]$metadata.Kind -ne $expectedKind) { throw "计划任务名称对应的不是本机器人，拒绝卸载：$Name" }
    if (-not ([string]$Task.Description).Equals($expectedDescription, [StringComparison]::Ordinal)) { throw "计划任务描述不属于本机器人，拒绝卸载：$Name" }
    return [pscustomobject][ordered]@{
        Name = $Name; Kind = [string]$metadata.Kind; Executable = [string]$metadata.Executable; Arguments = [string]$metadata.Arguments
        ProductExecutable = [string]$metadata.ProductExecutable; ProductArguments = [string]$metadata.ProductArguments; ProductServerPath = [string]$metadata.ProductServerPath
        ConfigPath = [string]$metadata.ConfigPath; LeasePath = [string]$metadata.LeasePath; ScriptPath = [string]$metadata.ScriptPath
        TargetTaskName = [string]$metadata.TargetTaskName; Description = [string]$Task.Description
    }
}

function Resolve-LeasePath([string]$ConfigPath, [string]$WatchdogLeasePath = '') {
    if (-not (Test-FullyQualifiedWindowsPath $ConfigPath) -or -not [IO.File]::Exists($ConfigPath)) { throw '托管配置缺失，无法证明 lease 归属。' }
    $resolvedConfig = [IO.Path]::GetFullPath($ConfigPath)
    try { $stored = Get-Content -LiteralPath $resolvedConfig -Raw -Encoding UTF8 | ConvertFrom-Json } catch { throw '托管配置损坏，无法证明 lease 归属。' }
    if ([string]$stored.schemaVersion -notin @('3.0', '4.0') -or [string]$stored.wecomBotId -notmatch '^[A-Za-z0-9_-]{4,256}$' -or
        [string]$stored.wecomWsUrl -notmatch '^wss://' -or [string]$stored.modelProvider -notin @('local-codex', 'codex-app-server')) { throw '托管配置不符合机器人产品合同。' }
    $watchdogLease = ''
    if (-not [string]::IsNullOrWhiteSpace($WatchdogLeasePath)) {
        if (-not (Test-FullyQualifiedWindowsPath $WatchdogLeasePath)) { throw '看门狗 lease 路径无效。' }
        $watchdogLease = [IO.Path]::GetFullPath($WatchdogLeasePath)
    }
    if ($stored.PSObject.Properties.Name -contains 'serviceLeasePath' -and -not [string]::IsNullOrWhiteSpace([string]$stored.serviceLeasePath)) {
        if (-not (Test-FullyQualifiedWindowsPath ([string]$stored.serviceLeasePath))) { throw 'serviceLeasePath 必须是 fully-qualified Windows 路径。' }
        $configuredLease = [IO.Path]::GetFullPath([string]$stored.serviceLeasePath)
        if ($watchdogLease -and -not $configuredLease.Equals($watchdogLease, [StringComparison]::OrdinalIgnoreCase)) { throw '托管配置与看门狗 lease 不一致。' }
        return $configuredLease
    }
    if ($watchdogLease) { return $watchdogLease }
    throw '托管配置没有显式 serviceLeasePath，且缺少配对看门狗证据。'
}

function Assert-OwnedTaskEvidence($MainMetadata, $WatchdogMetadata) {
    if ($null -eq $MainMetadata) {
        if ($null -eq $WatchdogMetadata) { return }
        if (-not [IO.File]::Exists([string]$WatchdogMetadata.ScriptPath) -or
            -not ([string]$WatchdogMetadata.TargetTaskName).Equals($TaskName, [StringComparison]::OrdinalIgnoreCase)) {
            throw '孤立看门狗任务缺少可验证的部署证据。'
        }
        $watchdogRoot = [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent ([string]$WatchdogMetadata.ScriptPath))))
        $derivedServer = [IO.Path]::GetFullPath((Join-Path $watchdogRoot 'shared\wecom\server.js'))
        if (-not [IO.File]::Exists($derivedServer)) { throw '孤立看门狗对应的服务入口不存在。' }
        [void]$trustedProductServerPaths.Add($derivedServer)
        return
    }
    if (-not [IO.File]::Exists([string]$MainMetadata.ProductServerPath)) { throw '主任务服务入口缺失，无法证明旧部署归属。' }
    if ($null -ne $WatchdogMetadata) {
        if (-not [IO.File]::Exists([string]$WatchdogMetadata.ScriptPath)) { throw '看门狗入口缺失，无法证明旧部署归属。' }
        $mainRoot = [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent (Split-Path -Parent ([string]$MainMetadata.ProductServerPath)))))
        $watchdogRoot = [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent ([string]$WatchdogMetadata.ScriptPath))))
        if (-not $mainRoot.Equals($watchdogRoot, [StringComparison]::OrdinalIgnoreCase) -or
            -not ([string]$WatchdogMetadata.TargetTaskName).Equals($TaskName, [StringComparison]::OrdinalIgnoreCase)) { throw '主任务与看门狗证据不能闭环。' }
        [void](Resolve-LeasePath ([string]$MainMetadata.ConfigPath) ([string]$WatchdogMetadata.LeasePath))
    } else { [void](Resolve-LeasePath ([string]$MainMetadata.ConfigPath)) }
    [void]$trustedProductServerPaths.Add([IO.Path]::GetFullPath([string]$MainMetadata.ProductServerPath))
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
    if ($null -eq $task) { throw "计划任务在卸载操作前消失：$Name" }
    $metadata = Get-OwnedTaskMetadata $task $Name
    Assert-TaskMetadataMatchesExpected $Name $metadata $ExpectedMetadata 'ScheduledTasks provider'

    $taskKey = Get-TaskIdentityKey $Name $taskPath
    $independentMatches = @(Get-IndependentScheduledTaskSnapshot | Where-Object {
        (Get-TaskIdentityKey ([string]$_.TaskName) ([string]$_.TaskPath)) -ceq $taskKey
    })
    if ($independentMatches.Count -ne 1) { throw "COM 无法唯一复核任务身份：$Name" }
    $independentMetadata = Get-OwnedTaskMetadata $independentMatches[0] $Name
    Assert-TaskMetadataMatchesExpected $Name $independentMetadata $ExpectedMetadata 'Task Scheduler COM'
    return [pscustomobject]@{ Task = $task; Metadata = $metadata }
}

function Disable-VerifiedOwnedTask([string]$Name, $ExpectedMetadata) {
    $verified = Get-VerifiedOwnedTask $Name $ExpectedMetadata
    if ([bool]$verified.Task.Settings.Enabled) {
        Disable-ScheduledTask -TaskName $Name -TaskPath $taskPath -ErrorAction Stop | Out-Null
    }
}

function Stop-VerifiedOwnedTask([string]$Name, $ExpectedMetadata) {
    $verified = Get-VerifiedOwnedTask $Name $ExpectedMetadata
    if ([string]$verified.Task.State -eq 'Running') {
        Stop-ScheduledTask -TaskName $Name -TaskPath $taskPath -ErrorAction Stop
    }
}

function Unregister-VerifiedOwnedTask([string]$Name, $ExpectedMetadata) {
    [void](Get-VerifiedOwnedTask $Name $ExpectedMetadata)
    Unregister-ScheduledTask -TaskName $Name -TaskPath $taskPath -Confirm:$false -ErrorAction Stop
    if ($null -ne (Get-ExactTask $Name)) { throw "注销后计划任务仍存在：$Name" }
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

function Confirm-RunnerIsolationRecoveryForLeasePaths([string[]]$LeasePaths, [scriptblock]$RecoveryInvoker = $null) {
    $lastResult = $null
    for ($round = 0; $round -lt 2; $round += 1) {
        $lastResult = Invoke-RunnerIsolationRecoveryForLeasePaths $LeasePaths $RecoveryInvoker
        foreach ($markerDirectory in @($lastResult.MarkerDirectories)) {
            if ([IO.Directory]::Exists([string]$markerDirectory)) {
                try { $remainingMarkers = @([IO.Directory]::EnumerateFiles([string]$markerDirectory, '*.json', [IO.SearchOption]::TopDirectoryOnly)) } catch {
                    throw "无法确认 runner 隔离 marker 目录为空：$markerDirectory"
                }
                if ($remainingMarkers.Count -ne 0) { throw "runner 隔离恢复后仍存在 marker：$markerDirectory" }
            }
        }
        if ($round -eq 0) { Start-Sleep -Milliseconds 250 }
    }
    return $lastResult
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
    if ($properties -notcontains 'Name' -or $properties -notcontains 'ExecutablePath' -or $properties -notcontains 'CommandLine' -or
        $properties -notcontains 'CreationDate' -or $properties -notcontains 'ProcessId') { throw '维护进程 CIM sentinel 字段不完整。' }
    try { $processId = [int]$Process.ProcessId } catch { throw '维护进程 CIM sentinel PID 无效。' }
    if (-not (Test-FullyQualifiedWindowsPath ([string]$Process.ExecutablePath))) { throw '维护进程 CIM sentinel 身份无效。' }
    $actualExecutable = [IO.Path]::GetFullPath([string]$Process.ExecutablePath)
    $processName = [string]$Process.Name
    $commandLine = [string]$Process.CommandLine
    if ($processId -ne $PID -or $processName -inotmatch '^(?:powershell|pwsh)\.exe$' -or
        -not ([IO.Path]::GetFileName($actualExecutable)).Equals($processName, [StringComparison]::OrdinalIgnoreCase) -or
        [string]::IsNullOrWhiteSpace($commandLine)) { throw '维护进程 CIM sentinel 身份无效。' }
    $creation = ConvertTo-ProcessCreationStamp $Process.CreationDate
    if ($null -eq $creation) { throw '维护进程 CIM sentinel 创建时间无效。' }
    return [pscustomobject][ordered]@{ ProcessId = $processId; CreationDate = [string]$creation.Token; Executable = $actualExecutable; CommandLine = $commandLine }
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
        [string]$observed.CommandLine -cne [string]$maintenanceSnapshotSentinel.CommandLine) { throw 'CIM 快照中的维护进程 sentinel 已变化。' }
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
        $arguments = $commandLine.Substring($quotedPrefix.Length)
    } elseif ($commandLine.StartsWith($plainPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        $arguments = $commandLine.Substring($plainPrefix.Length)
    } else {
        return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null }
    }
    $argumentMetadata = Get-ProductArgumentsMetadata $arguments
    if ($null -eq $argumentMetadata) {
        if ($arguments.IndexOf($productServerSuffix, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return [pscustomobject][ordered]@{ State = 'indeterminate'; Identity = $null }
        }
        return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null }
    }
    if (-not $trustedProductServerPaths.Contains([IO.Path]::GetFullPath([string]$argumentMetadata.ServerPath))) {
        # A matching filename suffix is only a collision signal.  It is never
        # sufficient authority to classify, stop, or uninstall another tree.
        return [pscustomobject][ordered]@{ State = 'indeterminate'; Identity = $null }
    }
    if (-not [string]::IsNullOrWhiteSpace($ExpectedArguments) -and
        -not $arguments.Equals($ExpectedArguments, [StringComparison]::OrdinalIgnoreCase)) {
        return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null }
    }

    $creationStamp = ConvertTo-ProcessCreationStamp $Process.CreationDate
    if ($null -eq $creationStamp) { return [pscustomobject][ordered]@{ State = 'indeterminate'; Identity = $null } }
    $creationDate = [string]$creationStamp.Token
    if (-not [string]::IsNullOrWhiteSpace($ExpectedCreationDate) -and $creationDate -ne $ExpectedCreationDate) {
        return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null }
    }
    $identity = [pscustomobject][ordered]@{
        ProcessId = $processId; CreationDate = $creationDate; CreationAt = $creationStamp.At
        Executable = $actualExecutable; Arguments = $arguments; ServerPath = [string]$argumentMetadata.ServerPath; ConfigPath = [string]$argumentMetadata.ConfigPath
    }
    return [pscustomobject][ordered]@{ State = 'alive'; Identity = $identity }
}

function Get-ProductProcessProbe([int64]$ProcessId, [string]$ExpectedArguments = '', [string]$ExpectedCreationDate = '') {
    if ($ProcessId -le 0 -or $ProcessId -gt [int]::MaxValue) {
        return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null }
    }
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

function Test-ProductIdentityMatchesTaskMetadata($Identity, $Metadata) {
    if ($null -eq $Identity -or $null -eq $Metadata) { return $false }
    if (-not [string]::IsNullOrWhiteSpace([string]$Metadata.ProductExecutable) -and
        -not ([string]$Identity.Executable).Equals([string]$Metadata.ProductExecutable, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    if (-not [string]::IsNullOrWhiteSpace([string]$Metadata.ProductArguments) -and
        -not ([string]$Identity.Arguments).Equals([string]$Metadata.ProductArguments, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    return ([string]$Identity.ServerPath).Equals([string]$Metadata.ProductServerPath, [StringComparison]::OrdinalIgnoreCase)
}

function Read-LeaseProcess([string]$LeasePath, $ExpectedMetadata = $null) {
    if ([string]::IsNullOrWhiteSpace($LeasePath) -or -not [IO.File]::Exists($LeasePath)) {
        return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null }
    }
    try {
        $lease = Get-Content -LiteralPath $LeasePath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([string]$lease.schemaVersion -ne '1.0' -or [string]$lease.service -ne 'xbb-executive-analyst-wecom') {
            return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null }
        }
        $probe = Get-ProductProcessProbe ([int64]$lease.pid)
        if ($probe.State -eq 'alive' -and $null -ne $ExpectedMetadata -and -not (Test-ProductIdentityMatchesTaskMetadata $probe.Identity $ExpectedMetadata)) {
            return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null }
        }
        return $probe
    } catch {
        return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null }
    }
}

function Wait-ManagedProcessExit($Identity, [int]$TimeoutSeconds) {
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
    if ($processId -le 0 -or $parentProcessId -ne [int]$ParentIdentity.ProcessId -or -not (Test-FullyQualifiedWindowsPath ([string]$Process.ExecutablePath)) -or
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
    if ($argv.Count -ne ($offset + 7) -or [string]$argv[$offset] -cne 'app-server' -or [string]$argv[$offset + 1] -cne '--listen' -or
        [string]$argv[$offset + 2] -notmatch '^ws://127[.]0[.]0[.]1:(?<port>[0-9]{1,5})$' -or [int]$Matches.port -lt 1 -or [int]$Matches.port -gt 65535 -or
        [string]$argv[$offset + 3] -cne '--ws-auth' -or [string]$argv[$offset + 4] -cne 'capability-token' -or
        [string]$argv[$offset + 5] -cne '--ws-token-sha256' -or [string]$argv[$offset + 6] -cnotmatch '^[a-f0-9]{64}$') { throw 'Codex App Server 后代参数不符合固定身份合同。' }
    return [pscustomobject][ordered]@{
        ProcessId = $processId; ParentProcessId = $parentProcessId; CreationDate = [string]$creation.Token; CreationToken = [string]$creation.Token
        CreationAt = $creation.At; Executable = $executable; ExecutablePath = $executable; CommandLine = [string]$Process.CommandLine
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
    if ($probe.State -eq 'indeterminate') { throw 'CIM 无法确认机器人进程身份；为避免误杀，拒绝强制终止。' }
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

function Remove-ExactTask([string]$Name, $ExpectedMetadata) {
    $task = Get-ExactTask $Name
    if ($null -eq $task) { return $false }
    if ($null -eq $ExpectedMetadata) { throw "任务在初始闭环快照后出现，拒绝删除：$Name" }
    [void](Get-VerifiedOwnedTask $Name $ExpectedMetadata)
    $wasRunning = [string]$task.State -eq 'Running'
    Disable-VerifiedOwnedTask $Name $ExpectedMetadata
    $currentTask = Get-ExactTask $Name
    if ($wasRunning -or ($null -ne $currentTask -and [string]$currentTask.State -eq 'Running')) {
        Stop-VerifiedOwnedTask $Name $ExpectedMetadata
    }
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(15)
    do {
        $currentTask = Get-ExactTask $Name
        if ($null -eq $currentTask -or [string]$currentTask.State -ne 'Running') { break }
        Start-Sleep -Milliseconds 250
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    $currentTask = Get-ExactTask $Name
    if ($null -ne $currentTask -and [string]$currentTask.State -eq 'Running') { throw "计划任务未能安全停止：$Name" }
    if ($null -eq $currentTask) { throw "计划任务在注销前被外部删除，无法确认卸载事务：$Name" }
    Unregister-VerifiedOwnedTask $Name $ExpectedMetadata
    return $true
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

$runnerRecoveryLeasePaths = $null
$taskMutationStarted = $false
$finalRecoveryConfirmed = $false
try {
# 在任何删除前完成双任务归属校验，避免卸掉看门狗后才发现主任务是同名异物。
Assert-NoOtherProductTasks
$mainTask = Get-ExactTask $TaskName
$watchdogTask = Get-ExactTask $watchdogTaskName
$mainMetadata = if ($null -ne $mainTask) { Get-OwnedTaskMetadata $mainTask $TaskName } else { $null }
$watchdogMetadata = if ($null -ne $watchdogTask) { Get-OwnedTaskMetadata $watchdogTask $watchdogTaskName } else { $null }
Assert-OwnedTaskEvidence $mainMetadata $watchdogMetadata

$runnerRecoveryLeasePaths = [Collections.Generic.List[string]]::new()
if ($null -ne $mainMetadata) {
    $pairedWatchdogLease = if ($null -ne $watchdogMetadata) { [string]$watchdogMetadata.LeasePath } else { '' }
    $runnerRecoveryLeasePaths.Add((Resolve-LeasePath ([string]$mainMetadata.ConfigPath) $pairedWatchdogLease)) | Out-Null
} elseif ($null -ne $watchdogMetadata) {
    $runnerRecoveryLeasePaths.Add([string]$watchdogMetadata.LeasePath) | Out-Null
} elseif ([IO.File]::Exists($defaultConfigPath)) {
    # A current, explicit managed config is useful evidence for a no-task orphan.
    # Missing or corrupt config is never replaced with a guessed sibling lease.
    $runnerRecoveryLeasePaths.Add((Resolve-LeasePath $defaultConfigPath)) | Out-Null
}
$leaseProbes = @($runnerRecoveryLeasePaths | ForEach-Object { Read-LeaseProcess ([string]$_) $mainMetadata })
if (@($leaseProbes | Where-Object { $_.State -eq 'indeterminate' }).Count -gt 0) {
    throw 'CIM 无法确认租约进程身份；未修改任何计划任务。'
}

# 删除任务前先按产品入口解析唯一进程。无论任务或 lease 记录的是 legacy、当前配置，
# 还是另一个绝对 managed-config，均不能漏掉不同参数的旧代际。
$processIdentity = $null
$candidates = Find-ProductProcessCandidates
if ($candidates.State -eq 'indeterminate') { throw 'CIM 无法确认机器人进程；未修改任何计划任务。' }
if ($candidates.State -eq 'multiple') { throw '发现多个机器人产品进程；拒绝猜测或批量终止。' }
if ($candidates.State -eq 'unique') {
    $processIdentity = @($candidates.Identities)[0]
}
if ($null -ne $processIdentity -and $runnerRecoveryLeasePaths.Count -eq 0) {
    throw '发现机器人进程，但缺少可验证的 config/lease 证据；未修改任何计划任务。'
}
foreach ($leaseProbe in @($leaseProbes | Where-Object { $_.State -eq 'alive' })) {
    if ($null -eq $processIdentity -or
        [int64]$leaseProbe.Identity.ProcessId -ne [int64]$processIdentity.ProcessId -or
        [string]$leaseProbe.Identity.CreationDate -ne [string]$processIdentity.CreationDate) {
        throw '租约与唯一机器人产品进程不一致；未修改任何计划任务。'
    }
}

$preStopRunnerIsolationRecovery = Invoke-RunnerIsolationRecoveryForLeasePaths @($runnerRecoveryLeasePaths)
$taskMutationStarted = $null -ne $mainMetadata -or $null -ne $watchdogMetadata
$watchdogRemoved = Remove-ExactTask $watchdogTaskName $watchdogMetadata
$removed = Remove-ExactTask $TaskName $mainMetadata
$forcedProcessStop = $false
if ($null -ne $processIdentity) {
    $wait = Wait-ManagedProcessExit $processIdentity 15
    if ($wait.State -eq 'indeterminate') { throw '任务已停止，但 CIM 无法确认机器人进程是否退出；拒绝强制终止。' }
    if ($wait.State -eq 'timeout') {
        [void](Stop-ProductProcessTree $processIdentity)
        $forcedProcessStop = $true
        $wait = Wait-ManagedProcessExit $processIdentity 5
        if ($wait.State -ne 'stopped') { throw '计划任务已卸载，但严格匹配 PID 与创建时间的机器人进程仍未退出。' }
    }
}

$remaining = Find-ProductProcessCandidates
if ($remaining.State -eq 'indeterminate') { throw '计划任务已卸载，但 CIM 无法完成产品孤儿确认。' }
if ($remaining.State -eq 'multiple') { throw '计划任务已卸载，但发现多个机器人产品孤儿；拒绝批量终止。' }
if ($remaining.State -eq 'unique') {
    $remainingIdentity = @($remaining.Identities)[0]
    [void](Stop-ProductProcessTree $remainingIdentity)
    $forcedProcessStop = $true
    $wait = Wait-ManagedProcessExit $remainingIdentity 1
    if ($wait.State -ne 'stopped') { throw '计划任务已卸载，但唯一机器人产品孤儿仍未退出。' }
}
$finalCandidates = Find-ProductProcessCandidates
$finalEmptyState = Confirm-EmptyProductProcessSlot $finalCandidates
if ($finalEmptyState -eq 'indeterminate') { throw '计划任务已卸载，但 CIM 无法完成最终产品进程确认。' }
if ($finalEmptyState -ne 'empty') { throw "计划任务已卸载，但机器人产品进程仍存在：$finalEmptyState" }
$runnerIsolationRecovery = Confirm-RunnerIsolationRecoveryForLeasePaths @($runnerRecoveryLeasePaths)
$postRecoveryEmptyState = Confirm-EmptyProductProcessSlot (Find-ProductProcessCandidates)
if ($postRecoveryEmptyState -ne 'empty') { throw "注销后的最终 recovery 未能确认产品进程槽为空：$postRecoveryEmptyState" }
$finalRecoveryConfirmed = $true

Write-Output ([ordered]@{ success = $true; taskName = $TaskName; removed = $removed; watchdogTaskName = $watchdogTaskName; watchdogRemoved = $watchdogRemoved; forcedProcessStop = $forcedProcessStop } | ConvertTo-Json -Compress)
} finally {
    $finalizationError = ''
    if ($taskMutationStarted -and -not $finalRecoveryConfirmed -and $null -ne $runnerRecoveryLeasePaths) {
        try {
            [void](Confirm-RunnerIsolationRecoveryForLeasePaths @($runnerRecoveryLeasePaths))
            $cleanupEmptyState = Confirm-EmptyProductProcessSlot (Find-ProductProcessCandidates)
            if ($cleanupEmptyState -ne 'empty') { throw "回滚清理未能确认产品进程槽为空：$cleanupEmptyState" }
        } catch { $finalizationError = [string]$_.Exception.Message }
    }
    if ($maintenanceMutexHeld) { try { $maintenanceMutex.ReleaseMutex() } catch {} }
    $maintenanceMutex.Dispose()
    if (-not [string]::IsNullOrWhiteSpace($finalizationError)) {
        throw "卸载未完成，最终 runner recovery 也未能确认安全收敛：$finalizationError"
    }
}
