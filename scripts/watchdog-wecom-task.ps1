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
        $service.Connect(); $folders.Enqueue($service.GetFolder('\'))
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
                $fullTaskPath = [string]$registeredTask.Path; $taskName = [string]$registeredTask.Name
                $snapshot.Add([pscustomobject]@{ TaskName = $taskName; TaskPath = $fullTaskPath.Substring(0, $fullTaskPath.Length - $taskName.Length); Actions = @($actions); Description = [string]$definition.RegistrationInfo.Description }) | Out-Null
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
if (-not (Test-FullyQualifiedWindowsPath $LeasePath)) { throw 'LeasePath 必须是 fully-qualified Windows 路径。' }
$resolvedLease = [IO.Path]::GetFullPath($LeasePath)
$futureSkewSeconds = 60
$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$maintenanceScriptPath = [IO.Path]::GetFullPath($MyInvocation.MyCommand.Path)
$processHandleScript = [IO.Path]::GetFullPath((Join-Path $projectRoot 'scripts\windows-process-handle.ps1'))
$runnerRecoveryScript = [IO.Path]::GetFullPath((Join-Path $projectRoot 'scripts\recover-runner-isolation.ps1'))
$expectedServer = [IO.Path]::GetFullPath((Join-Path $projectRoot 'shared\wecom\server.js'))
$expectedNode = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Codex\xbb-executive-analyst\bin\nodew.exe'))
$powerShellPath = [IO.Path]::GetFullPath((Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'))
$expectedDescription = '无控制台 Node + Codex App Server + xbb-executive-analyst Skill 企业微信智能 Agent（异常退出自动重启）'
$watchdogTaskDescription = '外部租约看门狗：检测机器人进程卡死并重启主计划任务'
$defaultConfigPath = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Codex\xbb-executive-analyst\bot-config.json'))
$productServerArgumentPrefix = "`"$expectedServer`""
$productArgumentPattern = '^(?:"(?<serverPath>[^\r\n"]+)"|(?<plainServerPath>\S+))(?: --managed-config "(?<configPath>[^\r\n"]+)")?$'
$productServerSuffix = '\shared\wecom\server.js'
$productStartScriptSuffix = '\scripts\start-wecom-bot.ps1'
$productWatchdogScriptSuffix = '\scripts\watchdog-wecom-task.ps1'
$productWatchdogLauncherSuffix = '\scripts\launch-wecom-watchdog.js'
$mainArgumentPattern = $productArgumentPattern
$trustedProductServerPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
if (-not [IO.File]::Exists($processHandleScript)) { throw "Windows 进程句柄校验器不存在：$processHandleScript" }
if (-not [IO.File]::Exists($runnerRecoveryScript)) { throw "runner 隔离恢复器不存在：$runnerRecoveryScript" }
. $processHandleScript

function Get-ExactTask {
    $matches = @(Get-ScheduledTask -TaskPath $taskPath -ErrorAction Stop | Where-Object {
        ([string]$_.TaskName).Equals($TaskName, [StringComparison]::OrdinalIgnoreCase) -and ([string]$_.TaskPath).Equals($taskPath, [StringComparison]::OrdinalIgnoreCase)
    })
    if ($matches.Count -gt 1) { throw '检测到多个同名主任务；看门狗拒绝操作。' }
    $independentExists = Test-IndependentScheduledTaskExists $TaskName $taskPath
    if (($matches.Count -eq 1) -ne $independentExists) { throw '主任务 provider 与独立快照不一致；看门狗拒绝操作。' }
    if ($matches.Count -eq 1) { return $matches[0] }
    Start-Sleep -Milliseconds 100
    $confirmation = @(Get-ScheduledTask -TaskPath $taskPath -ErrorAction Stop | Where-Object {
        ([string]$_.TaskName).Equals($TaskName, [StringComparison]::OrdinalIgnoreCase) -and ([string]$_.TaskPath).Equals($taskPath, [StringComparison]::OrdinalIgnoreCase)
    })
    $independentConfirmation = Test-IndependentScheduledTaskExists $TaskName $taskPath
    if (($confirmation.Count -eq 1) -ne $independentConfirmation) { throw '二次主任务 provider 与独立快照不一致；看门狗拒绝操作。' }
    if ($confirmation.Count -ne 0) { throw '主任务在空槽复核期间出现；看门狗拒绝操作。' }
    throw '机器人主任务不存在；看门狗拒绝操作。'
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
    $resolvedConfig = ''
    if ($argumentMatch.Groups['configPath'].Success) {
        $rawConfig = [string]$argumentMatch.Groups['configPath'].Value
        if (-not (Test-FullyQualifiedWindowsPath $rawConfig)) { return $null }
        $resolvedConfig = [IO.Path]::GetFullPath($rawConfig)
    }
    return [pscustomobject]@{ ServerPath = [IO.Path]::GetFullPath($serverPath); ConfigPath = $resolvedConfig; Arguments = $Arguments }
}

function Get-ProductMainTaskActionMetadata($Action) {
    $execAction = Get-VerifiedExecTaskActionFields $Action
    if ([string]$execAction.State -ne 'exec') { return $null }
    $arguments = [string]$execAction.Arguments
    $rawExecutable = [Environment]::ExpandEnvironmentVariables([string]$execAction.Execute)
    $legacyPowerShellAlias = $rawExecutable.Equals('powershell.exe', [StringComparison]::OrdinalIgnoreCase)
    if (-not (Test-FullyQualifiedWindowsPath $rawExecutable) -and -not $legacyPowerShellAlias) { return $null }
    try { $actualExecutable = if ($legacyPowerShellAlias) { [IO.Path]::GetFullPath($powerShellPath) } else { [IO.Path]::GetFullPath($rawExecutable) } } catch { return $null }
    $executableName = [IO.Path]::GetFileName($actualExecutable)
    if ($executableName -imatch '^(?:node|nodew)\.exe$') {
        $argumentMetadata = Get-ProductArgumentsMetadata $arguments
        if ($null -eq $argumentMetadata) { return $null }
        return [pscustomobject][ordered]@{
            Executable = $actualExecutable; Arguments = $arguments
            ProductExecutable = $actualExecutable; ProductArguments = $arguments; ProductServerPath = [string]$argumentMetadata.ServerPath
            ConfigPath = if ([string]::IsNullOrWhiteSpace([string]$argumentMetadata.ConfigPath)) { $defaultConfigPath } else { [string]$argumentMetadata.ConfigPath }
            ScriptPath = ''; Mode = 'direct'
        }
    }
    if ($executableName -inotmatch '^(?:powershell|pwsh)\.exe$') { return $null }
    $startMatch = [regex]::Match($arguments, '^-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "(?<script>[^\r\n"]+)"$', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $startMatch.Success -or -not (Test-ProductPathSuffix ([string]$startMatch.Groups['script'].Value) $productStartScriptSuffix)) { return $null }
    $startScriptPath = [IO.Path]::GetFullPath([string]$startMatch.Groups['script'].Value)
    $legacyServer = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent (Split-Path -Parent $startScriptPath)) 'shared\wecom\server.js'))
    return [pscustomobject][ordered]@{
        Executable = $actualExecutable; Arguments = $arguments
        ProductExecutable = ''; ProductArguments = ''; ProductServerPath = $legacyServer
        ConfigPath = $defaultConfigPath; ScriptPath = $startScriptPath; Mode = 'legacy'
    }
}

function Get-ProductTaskActionMetadata($Action) {
    $mainMetadata = Get-ProductMainTaskActionMetadata $Action
    if ($null -ne $mainMetadata) {
        return [pscustomobject][ordered]@{
            State = 'candidate'; Kind = 'main'; Executable = [string]$mainMetadata.Executable; Arguments = [string]$mainMetadata.Arguments
            ProductExecutable = [string]$mainMetadata.ProductExecutable; ProductArguments = [string]$mainMetadata.ProductArguments
            ProductServerPath = [string]$mainMetadata.ProductServerPath; ConfigPath = [string]$mainMetadata.ConfigPath
            LeasePath = ''; ScriptPath = [string]$mainMetadata.ScriptPath; TargetTaskName = ''; Mode = [string]$mainMetadata.Mode
        }
    }
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
        return [pscustomobject]@{ State = if ($mentionsProductScript) { 'indeterminate' } else { 'not-product' }; Kind = '' }
    }
    try { $actualExecutable = if ($legacyPowerShellAlias) { $powerShellPath } else { [IO.Path]::GetFullPath($rawExecutable) } } catch {
        return [pscustomobject]@{ State = if ($mentionsProductScript) { 'indeterminate' } else { 'not-product' }; Kind = '' }
    }
    if ([IO.Path]::GetFileName($actualExecutable) -imatch '^(?:node|nodew)\.exe$') {
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
                    TargetTaskName = [string]$hiddenWatchdogMatch.Groups['taskName'].Value; Mode = 'watchdog-hidden-node'
                }
            }
        }
    } elseif ([IO.Path]::GetFileName($actualExecutable) -imatch '^(?:powershell|pwsh)\.exe$') {
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
                TargetTaskName = [string]$watchdogMatch.Groups['taskName'].Value; Mode = 'watchdog'
            }
        }
    }
    return [pscustomobject]@{ State = if ($mentionsProductScript) { 'indeterminate' } else { 'not-product' }; Kind = '' }
}

function Get-ProductTaskSignatures([object[]]$Tasks) {
    $signatures = [Collections.Generic.List[string]]::new()
    foreach ($candidateTask in @($Tasks)) {
        $taskKey = Get-TaskIdentityKey ([string]$candidateTask.TaskName) ([string]$candidateTask.TaskPath)
        foreach ($candidateAction in @($candidateTask.Actions)) {
            $metadata = Get-ProductTaskActionMetadata $candidateAction
            if ([string]$metadata.State -eq 'indeterminate') { throw "产品计划任务 action 身份不确定：$taskKey" }
            if ([string]$metadata.State -eq 'candidate') {
                $signatures.Add(($taskKey + '|' + ([string]$metadata.Kind).ToLowerInvariant() + '|' + ([string]$metadata.Executable).ToLowerInvariant() + '|' + ([string]$metadata.Arguments).ToLowerInvariant() + '|' + [string]$candidateTask.Description)) | Out-Null
            }
        }
    }
    return @($signatures | Sort-Object -Unique)
}

function Get-VerifiedProductTaskSnapshot {
    $providerSnapshot = @(Get-ScheduledTask -ErrorAction Stop); $independentSnapshot = @(Get-IndependentScheduledTaskSnapshot)
    $providerSignatures = @(Get-ProductTaskSignatures $providerSnapshot); $independentSignatures = @(Get-ProductTaskSignatures $independentSnapshot)
    if (($providerSignatures -join "`n") -cne ($independentSignatures -join "`n")) { throw '计划任务 provider 与独立 COM 产品任务快照不一致。' }
    if ($providerSignatures.Count -eq 0) {
        Start-Sleep -Milliseconds 100
        $providerConfirmation = @(Get-ProductTaskSignatures @(Get-ScheduledTask -ErrorAction Stop))
        $independentConfirmation = @(Get-ProductTaskSignatures @(Get-IndependentScheduledTaskSnapshot))
        if (($providerConfirmation -join "`n") -cne ($independentConfirmation -join "`n") -or $providerConfirmation.Count -ne 0) { throw '产品计划任务空快照未通过连续独立确认。' }
    }
    return @($providerSnapshot)
}

function Assert-NoOtherProductTasks {
    $allowedKeys = @((Get-TaskIdentityKey $TaskName $taskPath), (Get-TaskIdentityKey "$TaskName-Watchdog" $taskPath))
    $snapshot = @(Get-VerifiedProductTaskSnapshot)
    foreach ($candidateTask in $snapshot) {
        $taskKey = Get-TaskIdentityKey ([string]$candidateTask.TaskName) ([string]$candidateTask.TaskPath)
        foreach ($candidateAction in @($candidateTask.Actions)) {
            $metadata = Get-ProductTaskActionMetadata $candidateAction
            if ([string]$metadata.State -eq 'indeterminate' -or ([string]$metadata.State -eq 'candidate' -and $allowedKeys -notcontains $taskKey)) {
                throw "发现其他或无法验证的疑似机器人任务：$taskKey"
            }
        }
    }
    return @($snapshot)
}

function Assert-MainTaskOwnership($Task) {
    $actions = @($Task.Actions)
    if ($actions.Count -ne 1) { throw '计划任务名称已被非本机器人任务占用；看门狗拒绝操作。' }
    $metadata = Get-ProductMainTaskActionMetadata $actions[0]
    if ($null -eq $metadata) { throw '计划任务名称已被非本机器人任务占用；看门狗拒绝操作。' }
    if (-not ([string]$Task.Description).Equals($expectedDescription, [StringComparison]::Ordinal)) {
        throw '计划任务描述不属于本机器人；看门狗拒绝操作。'
    }
    $metadata | Add-Member -NotePropertyName Description -NotePropertyValue ([string]$Task.Description) -Force
    $metadata | Add-Member -NotePropertyName Kind -NotePropertyValue 'main' -Force
    return $metadata
}

function Assert-ManagedConfigEvidence([string]$ConfigPath, [string]$ExpectedLeasePath, [bool]$Required) {
    if (-not (Test-FullyQualifiedWindowsPath $ConfigPath) -or -not [IO.File]::Exists($ConfigPath)) {
        if ($Required) { throw '主任务 managed config 缺失，无法闭合部署身份。' }
        return
    }
    try { $config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch {
        throw '主任务 managed config 损坏，无法闭合部署身份。'
    }
    if ([string]$config.schemaVersion -notin @('3.0', '4.0') -or
        [string]$config.wecomBotId -notmatch '^[A-Za-z0-9_-]{4,256}$' -or
        [string]$config.wecomWsUrl -notmatch '^wss://' -or
        [string]$config.modelProvider -notin @('local-codex', 'codex-app-server')) {
        throw '主任务 managed config 不符合机器人产品合同。'
    }
    if ($config.PSObject.Properties.Name -contains 'serviceLeasePath' -and
        -not [string]::IsNullOrWhiteSpace([string]$config.serviceLeasePath)) {
        if (-not (Test-FullyQualifiedWindowsPath ([string]$config.serviceLeasePath)) -or
            -not ([IO.Path]::GetFullPath([string]$config.serviceLeasePath)).Equals($ExpectedLeasePath, [StringComparison]::OrdinalIgnoreCase)) {
            throw '主任务 managed config 与看门狗 lease 不一致。'
        }
    }
}

function Assert-CurrentDeploymentEvidence($MainTask, $OwnedTask, [object[]]$TaskSnapshot) {
    $mainKey = Get-TaskIdentityKey $TaskName $taskPath
    $watchdogKey = Get-TaskIdentityKey $watchdogTaskName $taskPath
    $mainMatches = @($TaskSnapshot | Where-Object { (Get-TaskIdentityKey ([string]$_.TaskName) ([string]$_.TaskPath)) -ceq $mainKey })
    $watchdogMatches = @($TaskSnapshot | Where-Object { (Get-TaskIdentityKey ([string]$_.TaskName) ([string]$_.TaskPath)) -ceq $watchdogKey })
    if ($mainMatches.Count -ne 1 -or $watchdogMatches.Count -ne 1) { throw '标准主任务与看门狗任务未形成唯一配对。' }

    $snapshotMain = Assert-MainTaskOwnership $mainMatches[0]
    if (-not ([string]$snapshotMain.Executable).Equals([string]$OwnedTask.Executable, [StringComparison]::OrdinalIgnoreCase) -or
        [string]$snapshotMain.Arguments -cne [string]$OwnedTask.Arguments -or
        [string]$snapshotMain.Description -cne [string]$OwnedTask.Description) { throw '主任务 provider 快照身份不一致。' }

    $watchdogTask = $watchdogMatches[0]
    $watchdogActions = @($watchdogTask.Actions)
    if ($watchdogActions.Count -ne 1 -or [string]$watchdogTask.Description -cne $watchdogTaskDescription) {
        throw '看门狗任务描述或 action 数量不属于本机器人。'
    }
    $watchdogMetadata = Get-ProductTaskActionMetadata $watchdogActions[0]
    if ([string]$watchdogMetadata.State -ne 'candidate' -or [string]$watchdogMetadata.Kind -ne 'watchdog' -or
        -not ([string]$watchdogMetadata.ScriptPath).Equals($maintenanceScriptPath, [StringComparison]::OrdinalIgnoreCase) -or
        -not ([string]$watchdogMetadata.TargetTaskName).Equals($TaskName, [StringComparison]::OrdinalIgnoreCase) -or
        -not ([string]$watchdogMetadata.LeasePath).Equals($resolvedLease, [StringComparison]::OrdinalIgnoreCase)) {
        throw '看门狗 action 未与当前维护实例闭环。'
    }
    if (-not ([string]$OwnedTask.ProductServerPath).Equals($expectedServer, [StringComparison]::OrdinalIgnoreCase) -or
        -not [IO.File]::Exists([string]$OwnedTask.ProductServerPath) -or
        -not [IO.File]::Exists([string]$watchdogMetadata.ScriptPath)) { throw '主任务与看门狗入口未锚定到当前部署。' }
    $mainRoot = [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent (Split-Path -Parent ([string]$OwnedTask.ProductServerPath)))))
    $watchdogRoot = [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent ([string]$watchdogMetadata.ScriptPath))))
    if (-not $mainRoot.Equals($watchdogRoot, [StringComparison]::OrdinalIgnoreCase)) { throw '主任务与看门狗不属于同一部署根。' }

    Assert-ManagedConfigEvidence ([string]$OwnedTask.ConfigPath) $resolvedLease ([string]$OwnedTask.Mode -eq 'direct')
    [void]$trustedProductServerPaths.Add([IO.Path]::GetFullPath([string]$OwnedTask.ProductServerPath))
    return $watchdogMetadata
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
    if ($null -eq $creationStamp) {
        return [pscustomobject][ordered]@{ State = 'indeterminate'; Identity = $null }
    }
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

function ConvertTo-OwnedProcessIdentity($Process, $OwnedTask, [string]$ExpectedCreationDate = '') {
    if ($null -eq $OwnedTask) { return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null } }
    $probe = ConvertTo-ProductProcessIdentity $Process ([string]$OwnedTask.ProductArguments) $ExpectedCreationDate
    if ($probe.State -ne 'alive') { return $probe }
    if (-not (Test-ProductIdentityMatchesOwnedTask $probe.Identity $OwnedTask)) {
        return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null }
    }
    return $probe
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

function Get-OwnedProcessProbe([int64]$ProcessId, $OwnedTask, [string]$ExpectedCreationDate = '') {
    if ($null -eq $OwnedTask) { return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null } }
    $probe = Get-ProductProcessProbe $ProcessId ([string]$OwnedTask.ProductArguments) $ExpectedCreationDate
    if ($probe.State -ne 'alive') { return $probe }
    if (-not (Test-ProductIdentityMatchesOwnedTask $probe.Identity $OwnedTask)) {
        return [pscustomobject][ordered]@{ State = 'missing'; Identity = $null }
    }
    return $probe
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
        if ($probe.State -eq 'indeterminate') {
            return [pscustomobject][ordered]@{ State = 'indeterminate'; Identities = @() }
        }
        if ($probe.State -eq 'alive') { $identities.Add($probe.Identity) | Out-Null }
    }
    if ($identities.Count -eq 0) { return [pscustomobject][ordered]@{ State = 'none'; Identities = @() } }
    if ($identities.Count -eq 1) { return [pscustomobject][ordered]@{ State = 'unique'; Identities = @($identities[0]) } }
    return [pscustomobject][ordered]@{ State = 'multiple'; Identities = @($identities) }
}

function Test-ProductIdentityMatchesOwnedTask($Identity, $OwnedTask) {
    if ($null -eq $Identity -or $null -eq $OwnedTask) { return $false }
    if (-not [string]::IsNullOrWhiteSpace([string]$OwnedTask.ProductExecutable) -and
        -not ([string]$Identity.Executable).Equals([string]$OwnedTask.ProductExecutable, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    if (-not [string]::IsNullOrWhiteSpace([string]$OwnedTask.ProductArguments) -and
        -not ([string]$Identity.Arguments).Equals([string]$OwnedTask.ProductArguments, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    return ([string]$Identity.ServerPath).Equals([string]$OwnedTask.ProductServerPath, [StringComparison]::OrdinalIgnoreCase)
}

function Get-ProductLeaseConsistency($Lease, $OwnedTask, $Candidates = $null) {
    if ($null -eq $Candidates) { $Candidates = Find-ProductProcessCandidates }
    if ([string]$Lease.pidState -eq 'indeterminate' -or [string]$Candidates.State -eq 'indeterminate') {
        return [pscustomobject][ordered]@{ State = 'indeterminate'; Identity = $null }
    }
    if ([string]$Candidates.State -eq 'multiple') {
        return [pscustomobject][ordered]@{ State = 'multiple'; Identity = $null }
    }
    if ([string]$Candidates.State -eq 'none') {
        $state = if ([bool]$Lease.pidAlive) { 'mismatch' } else { 'none' }
        return [pscustomobject][ordered]@{ State = $state; Identity = $null }
    }
    $identity = @($Candidates.Identities)[0]
    if (-not [bool]$Lease.pidAlive -or $null -eq $Lease.processIdentity -or
        [int64]$Lease.processIdentity.ProcessId -ne [int64]$identity.ProcessId -or
        [string]$Lease.processIdentity.CreationDate -ne [string]$identity.CreationDate -or
        -not (Test-ProductIdentityMatchesOwnedTask $identity $OwnedTask) -or
        -not ([string]$Lease.processIdentity.Arguments).Equals([string]$identity.Arguments, [StringComparison]::OrdinalIgnoreCase)) {
        return [pscustomobject][ordered]@{ State = 'mismatch'; Identity = $identity }
    }
    return [pscustomobject][ordered]@{ State = 'consistent'; Identity = $identity }
}

function Get-VerifiedLeaseMismatchRecoveryIdentity($Candidates, $OwnedTask) {
    if ([string]$Candidates.State -ne 'unique' -or $null -eq $OwnedTask -or
        [string]::IsNullOrWhiteSpace([string]$OwnedTask.ProductExecutable) -or
        [string]::IsNullOrWhiteSpace([string]$OwnedTask.ProductArguments)) { return $null }
    $identity = @($Candidates.Identities)[0]
    if (-not (Test-ProductIdentityMatchesOwnedTask $identity $OwnedTask)) { return $null }
    return $identity
}

function Get-VerifiedCurrentMainTask($OwnedTask) {
    $currentTask = Get-ExactTask
    $currentOwnedTask = Assert-MainTaskOwnership $currentTask
    if (-not ([string]$currentOwnedTask.Executable).Equals([string]$OwnedTask.Executable, [StringComparison]::OrdinalIgnoreCase) -or
        [string]$currentOwnedTask.Arguments -cne [string]$OwnedTask.Arguments -or
        -not ([string]$currentOwnedTask.ProductExecutable).Equals([string]$OwnedTask.ProductExecutable, [StringComparison]::OrdinalIgnoreCase) -or
        [string]$currentOwnedTask.ProductArguments -cne [string]$OwnedTask.ProductArguments -or
        -not ([string]$currentOwnedTask.ProductServerPath).Equals([string]$OwnedTask.ProductServerPath, [StringComparison]::OrdinalIgnoreCase) -or
        -not ([string]$currentOwnedTask.ConfigPath).Equals([string]$OwnedTask.ConfigPath, [StringComparison]::OrdinalIgnoreCase) -or
        [string]$currentOwnedTask.Description -cne [string]$OwnedTask.Description -or
        [string]$currentOwnedTask.Mode -cne [string]$OwnedTask.Mode) {
        throw '主任务归属在维护操作前发生变化；拒绝操作。'
    }
    [void](Assert-CurrentDeploymentEvidence $currentTask $currentOwnedTask @(Assert-NoOtherProductTasks))
    return [pscustomobject][ordered]@{ Task = $currentTask; Metadata = $currentOwnedTask }
}

function Disable-VerifiedMainTask($OwnedTask) {
    $verified = Get-VerifiedCurrentMainTask $OwnedTask
    if ([bool]$verified.Task.Settings.Enabled) { Disable-ScheduledTask -TaskName $TaskName -TaskPath $taskPath -ErrorAction Stop | Out-Null }
    return $verified.Task
}

function Enable-VerifiedMainTask($OwnedTask) {
    $verified = Get-VerifiedCurrentMainTask $OwnedTask
    if (-not [bool]$verified.Task.Settings.Enabled) { Enable-ScheduledTask -TaskName $TaskName -TaskPath $taskPath -ErrorAction Stop | Out-Null }
    return $verified.Task
}

function Stop-VerifiedMainTask($OwnedTask) {
    $verified = Get-VerifiedCurrentMainTask $OwnedTask
    if ([string]$verified.Task.State -eq 'Running') { Stop-ScheduledTask -TaskName $TaskName -TaskPath $taskPath -ErrorAction Stop }
    return $verified.Task
}

function Start-VerifiedMainTask($OwnedTask) {
    $verified = Get-VerifiedCurrentMainTask $OwnedTask
    Start-ScheduledTask -TaskName $TaskName -TaskPath $taskPath -ErrorAction Stop
    return $verified.Task
}

function Invoke-VerifiedRunnerIsolationRecovery($OwnedTask) {
    if ($null -eq $OwnedTask -or -not (Test-FullyQualifiedWindowsPath ([string]$OwnedTask.ProductServerPath))) {
        throw '无法从主任务确定 runner recovery 项目根。'
    }
    $productRoot = [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent (Split-Path -Parent ([string]$OwnedTask.ProductServerPath)))))
    if (-not [IO.Directory]::Exists($productRoot)) { throw "runner recovery 项目根不存在：$productRoot" }
    $markerDirectory = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetDirectoryName($resolvedLease)) 'runner-isolation'))
    $output = @(& $powerShellPath '-NoLogo' '-NoProfile' '-NonInteractive' '-ExecutionPolicy' 'Bypass' `
        '-File' $runnerRecoveryScript '-MarkerDirectory' $markerDirectory '-ProjectRoot' $productRoot 2>&1)
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) { throw "runner 隔离恢复失败（exit=$exitCode）。" }
    $lines = @($output | ForEach-Object { ([string]$_).Trim() } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($lines.Count -eq 0) { throw 'runner 隔离恢复没有返回结果。' }
    try { $result = $lines[-1] | ConvertFrom-Json } catch { throw 'runner 隔离恢复返回无效 JSON。' }
    $properties = @($result.PSObject.Properties.Name)
    if ($properties -notcontains 'success' -or $properties -notcontains 'markersRecovered' -or
        $properties -notcontains 'processesTerminated' -or $properties -notcontains 'runDirectoriesRemoved' -or
        -not ($result.success -is [bool]) -or -not [bool]$result.success) { throw 'runner 隔离恢复结果未得到确认。' }
    foreach ($countName in @('markersRecovered', 'processesTerminated', 'runDirectoriesRemoved')) {
        try { $count = [int64]$result.$countName } catch { throw 'runner 隔离恢复计数无效。' }
        if ($count -lt 0) { throw 'runner 隔离恢复计数无效。' }
    }
    return $result
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
    $missingSnapshots = 0
    do {
        $probe = if ($null -eq $Identity) {
            [pscustomobject][ordered]@{ State = 'missing'; Identity = $null }
        } else {
            Get-ProductProcessProbe ([int64]$Identity.ProcessId) ([string]$Identity.Arguments) ([string]$Identity.CreationDate)
        }
        if ($probe.State -eq 'indeterminate') { return [pscustomobject][ordered]@{ State = 'indeterminate' } }
        if ([string](Get-ExactTask).State -ne 'Running' -and $probe.State -eq 'missing') {
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
    $executable = [IO.Path]::GetFullPath([string]$Process.ExecutablePath)
    $name = [string]$Process.Name
    if (-not [IO.Path]::GetFileName($executable).Equals($name, [StringComparison]::OrdinalIgnoreCase)) { throw '产品进程后代可执行文件身份不一致。' }
    $creation = ConvertTo-ProcessCreationStamp $Process.CreationDate
    if ($null -eq $creation -or $creation.At -lt $ParentIdentity.CreationAt) { throw '产品进程后代创建时间不可信。' }
    try { $argv = @(ConvertFrom-XbbWindowsCommandLine ([string]$Process.CommandLine)) } catch { throw '产品进程后代命令行不可解析。' }
    if ($argv.Count -lt 2 -or -not (Test-CanonicalProcessArgumentPath ([string]$argv[0]) $executable)) { throw '产品进程后代命令入口无法绑定。' }

    $offset = 1
    if ($name -imatch '^(?:node|nodew)\.exe$') {
        if ($argv.Count -ne 9 -or -not (Test-ProductPathSuffix ([string]$argv[1]) '\node_modules\@openai\codex\bin\codex.js')) {
            throw '发现不在白名单内的 Node 产品后代；拒绝终止任何进程。'
        }
        $offset = 2
    } elseif ($name -inotmatch '^codex\.exe$') {
        throw '发现不在白名单内的产品后代；拒绝终止任何进程。'
    }
    if ($argv.Count -ne ($offset + 7) -or [string]$argv[$offset] -cne 'app-server' -or
        [string]$argv[$offset + 1] -cne '--listen' -or [string]$argv[$offset + 2] -notmatch '^ws://127[.]0[.]0[.]1:(?<port>[0-9]{1,5})$' -or
        [int]$Matches.port -lt 1 -or [int]$Matches.port -gt 65535 -or
        [string]$argv[$offset + 3] -cne '--ws-auth' -or [string]$argv[$offset + 4] -cne 'capability-token' -or
        [string]$argv[$offset + 5] -cne '--ws-token-sha256' -or [string]$argv[$offset + 6] -cnotmatch '^[a-f0-9]{64}$') {
        throw 'Codex App Server 后代参数不符合固定身份合同。'
    }
    return [pscustomobject][ordered]@{
        ProcessId = $processId; ParentProcessId = $parentProcessId; CreationDate = [string]$creation.Token
        CreationToken = [string]$creation.Token; CreationAt = $creation.At; Executable = $executable
        ExecutablePath = $executable; CommandLine = [string]$Process.CommandLine
    }
}

function Add-VerifiedProductDescendantHandles([object[]]$Snapshot, $BoundProcesses, $KnownProcesses) {
    $rows = @($Snapshot)
    $groups = @($rows | Group-Object { [string]$_.ProcessId } | Where-Object { $_.Count -ne 1 })
    if ($groups.Count -ne 0) { throw 'CIM 产品树快照包含重复 PID。' }
    $added = 0
    $progress = $true
    while ($progress) {
        $progress = $false
        foreach ($row in $rows) {
            try { $rowPid = [int]$row.ProcessId; $rowParentPid = [int]$row.ParentProcessId } catch { throw 'CIM 产品树 PID 字段不可读。' }
            if ($KnownProcesses.ContainsKey($rowPid) -or -not $KnownProcesses.ContainsKey($rowParentPid)) { continue }
            $parent = $KnownProcesses[$rowParentPid].Identity
            $identity = ConvertTo-VerifiedProductDescendantIdentity $row $parent
            $handle = Open-XbbVerifiedProcessHandle ([pscustomobject]@{
                ProcessId = $identity.ProcessId; CreationToken = $identity.CreationToken; ExecutablePath = $identity.ExecutablePath
            })
            $bound = [pscustomobject]@{ Identity = $identity; Handle = $handle }
            try {
                $candidateTicks = [int64]$identity.CreationToken; $handleTicks = [int64]$handle.CreationToken
                if ([int]$handle.ProcessId -ne [int]$identity.ProcessId -or
                    ($candidateTicks - ($candidateTicks % 10)) -ne ($handleTicks - ($handleTicks % 10)) -or
                    -not ([string]$handle.ExecutablePath).Equals([string]$identity.ExecutablePath, [StringComparison]::OrdinalIgnoreCase)) {
                    throw '产品进程后代 native handle 身份不一致。'
                }
                $BoundProcesses.Add($bound) | Out-Null
                $KnownProcesses[$identity.ProcessId] = $bound
                $added += 1; $progress = $true
            } catch { $handle.Dispose(); throw }
        }
    }
    return $added
}

function Stop-UniqueProductProcessTree($Identity) {
    if ($null -eq $Identity) { return $false }
    $probe = Get-ProductProcessProbe ([int64]$Identity.ProcessId) ([string]$Identity.Arguments) ([string]$Identity.CreationDate)
    if ($probe.State -eq 'indeterminate') { throw 'CIM 无法确认机器人进程身份；为避免误杀，本轮拒绝重启。' }
    if ($probe.State -eq 'missing') { return $false }
    $rootHandle = Open-XbbVerifiedProcessHandle ([pscustomobject]@{
        ProcessId = [int]$probe.Identity.ProcessId; CreationToken = [string]$probe.Identity.CreationDate; ExecutablePath = [string]$probe.Identity.Executable
    })
    $rootIdentity = [pscustomobject][ordered]@{
        ProcessId = [int]$probe.Identity.ProcessId; CreationToken = [string]$probe.Identity.CreationDate
        CreationAt = $probe.Identity.CreationAt; ExecutablePath = [string]$probe.Identity.Executable
    }
    $boundProcesses = [Collections.Generic.List[object]]::new()
    $knownProcesses = @{}
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
            foreach ($bound in @($boundProcesses)) {
                if (-not $bound.Handle.HasExited -and -not $bound.Handle.TerminateAndWait(1, 5000)) { throw '新生产品后代未确认终止。' }
            }
            if ($added -eq 0 -and @($boundProcesses | Where-Object { -not $_.Handle.HasExited }).Count -eq 0) { $emptyRounds += 1 } else { $emptyRounds = 0 }
            if ($emptyRounds -lt 2) { Start-Sleep -Milliseconds 100 }
        }
        if ($emptyRounds -lt 2) { throw '产品进程树未通过连续健康空确认。' }
        $emptyState = Confirm-EmptyProductProcessSlot (Find-ProductProcessCandidates)
        if ($emptyState -ne 'empty') { throw "持柄终止后未能连续确认机器人产品进程槽为空：$emptyState" }
        return $true
    } finally {
        foreach ($bound in @($boundProcesses | Sort-Object { $_.Identity.CreationAt } -Descending)) { $bound.Handle.Dispose() }
    }
}

function Assert-ProductProcessSlotEmpty([string]$Reason) {
    $candidates = Find-ProductProcessCandidates
    $emptyState = Confirm-EmptyProductProcessSlot $candidates
    if ($emptyState -eq 'indeterminate') { throw "CIM 无法确认$Reason机器人产品进程。" }
    if ($emptyState -eq 'multiple') { throw "$Reason发现多个机器人产品进程；拒绝并行启动。" }
    if ($emptyState -ne 'empty') { throw "$Reason仍存在机器人产品进程；拒绝并行启动。" }
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

$maintenanceMutex = [Threading.Mutex]::new($false, (Get-MaintenanceMutexName $TaskName))
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
try {
    $verifiedTaskSnapshot = @(Assert-NoOtherProductTasks)
    [void](Assert-CurrentDeploymentEvidence $task $ownedTask $verifiedTaskSnapshot)
} catch {
    Write-Output ([ordered]@{ success = $false; action = 'fenced-task-provider-or-product-conflict'; taskName = $TaskName } | ConvertTo-Json -Compress)
    exit 3
}
try { $maintenanceSnapshotSentinel = New-MaintenanceSnapshotSentinel } catch {
    [void](Disable-VerifiedMainTask $ownedTask)
    Write-Output ([ordered]@{ success = $false; action = 'fenced-health-indeterminate'; taskName = $TaskName; reason = 'cim-sentinel-unavailable' } | ConvertTo-Json -Compress)
    exit 2
}
$lease = Read-Lease $ownedTask
$taskRunning = [string]$task.State -eq 'Running'
$taskEnabled = [bool]$task.Settings.Enabled
$heartbeatFresh = $lease.valid -and $lease.ageSeconds -le $StaleSeconds

if ($lease.pidState -eq 'indeterminate') {
    [void](Disable-VerifiedMainTask $ownedTask)
    Write-Output ([ordered]@{ success = $false; action = 'fenced-health-indeterminate'; taskName = $TaskName; reason = 'cim-unavailable' } | ConvertTo-Json -Compress)
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
    $taskEnabled = [bool]$task.Settings.Enabled
    $heartbeatFresh = $lease.valid -and $lease.ageSeconds -le $StaleSeconds
    if ($lease.pidState -eq 'indeterminate') {
        [void](Disable-VerifiedMainTask $ownedTask)
        Write-Output ([ordered]@{ success = $false; action = 'fenced-health-indeterminate'; taskName = $TaskName; reason = 'cim-unavailable' } | ConvertTo-Json -Compress)
        exit 2
    }
}

# 以产品入口而不是当前配置参数为边界检查单实例。这样旧 legacy 进程、其他绝对
# managed-config 代际都不能与当前任务同时被误判为健康。
$candidates = Find-ProductProcessCandidates
$consistency = Get-ProductLeaseConsistency $lease $ownedTask $candidates
if ($consistency.State -eq 'indeterminate') {
    [void](Disable-VerifiedMainTask $ownedTask)
    Write-Output ([ordered]@{ success = $false; action = 'fenced-health-indeterminate'; taskName = $TaskName; reason = 'cim-unavailable' } | ConvertTo-Json -Compress)
    exit 2
}
if ($consistency.State -eq 'multiple') {
    [void](Disable-VerifiedMainTask $ownedTask)
    Write-Output ([ordered]@{ success = $false; action = 'fenced-ambiguous-product-roots'; taskName = $TaskName; candidateCount = @($candidates.Identities).Count } | ConvertTo-Json -Compress)
    exit 3
}
$verifiedMismatchRecovery = $false
if ($consistency.State -eq 'mismatch') {
    # 丢失/损坏的 lease 不能直接证明唯一产品根属于当前任务。只有 direct-node
    # action 的 executable、完整参数和 server 路径都与候选一致，才可围栏后回收；
    # 旧 PowerShell action 或其他代际继续保持 fail-closed。
    $mismatchIdentity = Get-VerifiedLeaseMismatchRecoveryIdentity $candidates $ownedTask
    $verifiedMismatchRecovery = $null -ne $mismatchIdentity
    [void](Disable-VerifiedMainTask $ownedTask)
    if (-not $verifiedMismatchRecovery) {
        Write-Output ([ordered]@{ success = $false; action = 'fenced-lease-product-mismatch'; taskName = $TaskName } | ConvertTo-Json -Compress)
        exit 3
    }
}
$oldProcessIdentity = if ($consistency.State -eq 'consistent') { $consistency.Identity } elseif ($verifiedMismatchRecovery) { $mismatchIdentity } else { $null }
$identityHealthy = $taskRunning -and $heartbeatFresh -and $consistency.State -eq 'consistent' -and $lease.state -eq 'running'

# 围栏状态不会因“下一轮到了”自动解除。只有再次读取到产品级唯一进程、租约 PID、
# 创建时间和完整参数一致且 heartbeat 健康，才允许恢复主任务触发器。
if (-not $taskEnabled) {
    $emptySlotRecovery = $verifiedMismatchRecovery
    if ($identityHealthy) {
        $recoveryTask = Get-ExactTask
        $recoveryOwnedTask = Assert-MainTaskOwnership $recoveryTask
        $recoveryLease = Read-Lease $recoveryOwnedTask
        $recoveryCandidates = Find-ProductProcessCandidates
        $recoveryConsistency = Get-ProductLeaseConsistency $recoveryLease $recoveryOwnedTask $recoveryCandidates
        $recoveryFresh = $recoveryLease.valid -and $recoveryLease.ageSeconds -le $StaleSeconds -and
            $recoveryLease.state -eq 'running' -and [string]$recoveryTask.State -eq 'Running' -and
            $recoveryConsistency.State -eq 'consistent'
        if ($recoveryFresh) {
            [void](Enable-VerifiedMainTask $recoveryOwnedTask)
            $enabledLease = Read-Lease $recoveryOwnedTask
            $enabledConsistency = Get-ProductLeaseConsistency $enabledLease $recoveryOwnedTask (Find-ProductProcessCandidates)
            if (-not ($enabledLease.valid -and $enabledLease.ageSeconds -le $StaleSeconds -and $enabledLease.state -eq 'running' -and
                $enabledConsistency.State -eq 'consistent' -and
                [int64]$enabledConsistency.Identity.ProcessId -eq [int64]$recoveryConsistency.Identity.ProcessId -and
                [string]$enabledConsistency.Identity.CreationDate -eq [string]$recoveryConsistency.Identity.CreationDate)) {
                [void](Disable-VerifiedMainTask $recoveryOwnedTask)
                Write-Output ([ordered]@{ success = $false; action = 'fenced-health-changed-during-enable'; taskName = $TaskName } | ConvertTo-Json -Compress)
                exit 3
            }
            Write-Output ([ordered]@{ success = $true; action = 'fence-cleared'; taskName = $TaskName; leaseAgeSeconds = [Math]::Round($recoveryLease.ageSeconds, 1) } | ConvertTo-Json -Compress)
            exit 0
        }
    }
    if ($consistency.State -eq 'none') {
        $emptyConfirmation = Confirm-EmptyProductProcessSlot $candidates
        if ($emptyConfirmation -eq 'empty') {
            # 上一轮异常期间旧进程已经退出时，连续两个健康 CIM 空快照才允许进入
            # 下方完整的禁用、租约标记、单实例检查和新代际验活流程。
            [void](Disable-VerifiedMainTask $ownedTask)
            $emptySlotRecovery = $true
        } elseif ($emptyConfirmation -eq 'indeterminate') {
            [void](Disable-VerifiedMainTask $ownedTask)
            Write-Output ([ordered]@{ success = $false; action = 'fenced-health-indeterminate'; taskName = $TaskName; reason = 'cim-unavailable-during-empty-confirmation' } | ConvertTo-Json -Compress)
            exit 2
        } elseif ($emptyConfirmation -eq 'multiple') {
            [void](Disable-VerifiedMainTask $ownedTask)
            Write-Output ([ordered]@{ success = $false; action = 'fenced-ambiguous-product-roots'; taskName = $TaskName } | ConvertTo-Json -Compress)
            exit 3
        } else {
            [void](Disable-VerifiedMainTask $ownedTask)
            Write-Output ([ordered]@{ success = $false; action = 'fenced-lease-product-mismatch'; taskName = $TaskName } | ConvertTo-Json -Compress)
            exit 3
        }
    }
    if (-not $emptySlotRecovery) {
        Write-Output ([ordered]@{ success = $false; action = 'fenced-waiting-for-exact-health'; taskName = $TaskName } | ConvertTo-Json -Compress)
        exit 3
    }
}

if ($identityHealthy) {
    $finalLease = Read-Lease $ownedTask
    $finalConsistency = Get-ProductLeaseConsistency $finalLease $ownedTask (Find-ProductProcessCandidates)
    if (-not ($finalLease.valid -and $finalLease.ageSeconds -le $StaleSeconds -and $finalLease.state -eq 'running' -and
        $finalConsistency.State -eq 'consistent' -and
        [int64]$finalConsistency.Identity.ProcessId -eq [int64]$oldProcessIdentity.ProcessId -and
        [string]$finalConsistency.Identity.CreationDate -eq [string]$oldProcessIdentity.CreationDate)) {
        [void](Disable-VerifiedMainTask $ownedTask)
        Write-Output ([ordered]@{ success = $false; action = 'fenced-health-changed-before-success'; taskName = $TaskName } | ConvertTo-Json -Compress)
        exit 3
    }
    Write-Output ([ordered]@{ success = $true; action = 'healthy'; taskName = $TaskName; leaseAgeSeconds = [Math]::Round($finalLease.ageSeconds, 1) } | ConvertTo-Json -Compress)
    exit 0
}

if ($taskRunning -and $heartbeatFresh -and $consistency.State -eq 'consistent' -and $lease.state -eq 'starting' -and $lease.stateAgeSeconds -le $StartupGraceSeconds) {
    $graceLease = Read-Lease $ownedTask
    $graceConsistency = Get-ProductLeaseConsistency $graceLease $ownedTask (Find-ProductProcessCandidates)
    if (-not ($graceLease.valid -and $graceLease.ageSeconds -le $StaleSeconds -and $graceLease.state -eq 'starting' -and
        $graceLease.stateAgeSeconds -le $StartupGraceSeconds -and $graceConsistency.State -eq 'consistent' -and
        [int64]$graceConsistency.Identity.ProcessId -eq [int64]$oldProcessIdentity.ProcessId -and
        [string]$graceConsistency.Identity.CreationDate -eq [string]$oldProcessIdentity.CreationDate)) {
        [void](Disable-VerifiedMainTask $ownedTask)
        Write-Output ([ordered]@{ success = $false; action = 'fenced-startup-changed'; taskName = $TaskName } | ConvertTo-Json -Compress)
        exit 3
    }
    Write-Output ([ordered]@{ success = $true; action = 'startup-grace'; taskName = $TaskName; startupAgeSeconds = [Math]::Round($graceLease.stateAgeSeconds, 1) } | ConvertTo-Json -Compress)
    exit 0
}

[void](Disable-VerifiedMainTask $ownedTask)
$oldInstanceId = [string]$lease.instanceId
$enableForRestart = $false
try {
    if ($taskRunning -or [string](Get-ExactTask).State -eq 'Running') {
        [void](Stop-VerifiedMainTask $ownedTask)
    }
    # 任务可能已显示 Ready，但旧 nodew 因调度器状态漂移成为孤儿；仍必须在启动
    # 新代际前等待并仅终止经过完整可执行文件与参数校验的旧进程。
    $stopped = Wait-TaskStopped 15 $oldProcessIdentity $ownedTask
    if ($stopped.State -eq 'indeterminate') { throw 'CIM 无法确认旧机器人进程是否退出；主任务保持禁用，等待下轮安全恢复。' }
    if ($stopped.State -eq 'timeout') {
        [void](Invoke-VerifiedRunnerIsolationRecovery $ownedTask)
        [void](Stop-UniqueProductProcessTree $oldProcessIdentity)
        $stopped = Wait-TaskStopped 5 $oldProcessIdentity $ownedTask
        if ($stopped.State -eq 'indeterminate') { throw 'CIM 无法确认强制终止结果；主任务保持禁用，等待下轮安全恢复。' }
        if ($stopped.State -ne 'stopped') { throw '机器人主任务或旧租约进程未停止，拒绝并行启动第二实例。' }
    }

    # lease PID 可能为空或已复用；任务停止后再次枚举，只处理唯一且完整匹配的孤儿。
    [void](Invoke-VerifiedRunnerIsolationRecovery $ownedTask)
    $remaining = Find-ProductProcessCandidates
    if ($remaining.State -eq 'indeterminate') { throw 'CIM 无法确认是否存在机器人孤儿进程；主任务保持禁用。' }
    if ($remaining.State -eq 'multiple') { throw '发现多个完整匹配的机器人孤儿进程；拒绝猜测或批量终止。' }
    if ($remaining.State -eq 'unique') {
        $remainingIdentity = @($remaining.Identities)[0]
        [void](Stop-UniqueProductProcessTree $remainingIdentity)
        $remainingStopped = Wait-TaskStopped 5 $remainingIdentity $ownedTask
        if ($remainingStopped.State -eq 'indeterminate') { throw 'CIM 无法确认孤儿进程终止结果；主任务保持禁用。' }
        if ($remainingStopped.State -ne 'stopped') { throw '唯一匹配的机器人孤儿进程未退出；拒绝启动第二实例。' }
    }
    [void](Invoke-VerifiedRunnerIsolationRecovery $ownedTask)
    $finalCandidates = Find-ProductProcessCandidates
    if ($finalCandidates.State -eq 'indeterminate') { throw 'CIM 无法完成启动前最终进程确认；主任务保持禁用。' }
    if ($finalCandidates.State -ne 'none') { throw '启动前仍存在机器人进程；拒绝并行启动第二实例。' }

    # 只有旧任务和严格匹配进程都已确认退出、且重启标记落盘后才重新启用任务。
    $restartRequestedAt = [DateTimeOffset]::UtcNow
    $restartMarkerId = Write-StartingLease
    Assert-ProductProcessSlotEmpty '重新启用主任务前'
    $enableForRestart = $true
} finally {
    if ($enableForRestart) {
        [void](Enable-VerifiedMainTask $ownedTask)
    }
}

$postEnableCandidates = Find-ProductProcessCandidates
if ($postEnableCandidates.State -eq 'indeterminate') {
    [void](Disable-VerifiedMainTask $ownedTask)
    throw '主任务启用后 CIM 无法确认产品进程；主任务已进入安全围栏。'
}
if ($postEnableCandidates.State -eq 'multiple') {
    [void](Disable-VerifiedMainTask $ownedTask)
    throw '主任务启用后出现多个产品进程；主任务已进入安全围栏。'
}
if ($postEnableCandidates.State -eq 'none') {
    [void](Start-VerifiedMainTask $ownedTask)
} else {
    $autoStartedIdentity = @($postEnableCandidates.Identities)[0]
    if (-not ([string]$autoStartedIdentity.Arguments).Equals([string]$ownedTask.Arguments, [StringComparison]::OrdinalIgnoreCase) -or
        $autoStartedIdentity.CreationAt -lt $restartRequestedAt) {
        [void](Disable-VerifiedMainTask $ownedTask)
        throw '主任务启用后出现无法归属到本次重启的新产品进程；主任务已进入安全围栏。'
    }
}
$readyDeadline = [DateTimeOffset]::UtcNow.AddSeconds(60)
$runtimeStarted = $false
$acceptedRestartIdentity = $null
do {
    Start-Sleep -Milliseconds 500
    $task = Get-ExactTask
    $ownedTask = Assert-MainTaskOwnership $task
    $lease = Read-Lease $ownedTask
    $roundCandidates = Find-ProductProcessCandidates
    $roundConsistency = Get-ProductLeaseConsistency $lease $ownedTask $roundCandidates
    if ($roundConsistency.State -eq 'indeterminate') {
        [void](Disable-VerifiedMainTask $ownedTask)
        throw 'CIM 无法确认新机器人进程身份；主任务已进入安全围栏。'
    }
    if ($roundConsistency.State -eq 'multiple') {
        [void](Disable-VerifiedMainTask $ownedTask)
        throw '重启等待期间出现多个机器人产品代际；主任务已进入安全围栏。'
    }
    if ($roundConsistency.State -eq 'mismatch') {
        [void](Disable-VerifiedMainTask $ownedTask)
        throw '重启等待期间租约与产品身份不一致；主任务已进入安全围栏。'
    }
    $newGeneration = $lease.valid -and $lease.instanceId -ne $restartMarkerId -and $lease.instanceId -ne $oldInstanceId -and $null -ne $lease.stateSinceAt -and $lease.stateSinceAt -ge $restartRequestedAt
    if ([string]$task.State -eq 'Running' -and $newGeneration -and $roundConsistency.State -eq 'consistent' -and $lease.state -eq 'running' -and $lease.ageSeconds -le $StaleSeconds) {
        $runtimeStarted = $true
        $acceptedRestartIdentity = $roundConsistency.Identity
        break
    }
} while ([DateTimeOffset]::UtcNow -lt $readyDeadline)

if (-not $runtimeStarted) { throw '机器人主任务已请求重启，但 60 秒内没有形成有效 running 租约。' }
$finalTask = Get-ExactTask
$finalOwnedTask = Assert-MainTaskOwnership $finalTask
$finalLease = Read-Lease $finalOwnedTask
$finalConsistency = Get-ProductLeaseConsistency $finalLease $finalOwnedTask (Find-ProductProcessCandidates)
$restartStillHealthy = [string]$finalTask.State -eq 'Running' -and [bool]$finalTask.Settings.Enabled -and
    $finalLease.valid -and $finalLease.state -eq 'running' -and $finalLease.ageSeconds -le $StaleSeconds -and
    $finalConsistency.State -eq 'consistent' -and $null -ne $acceptedRestartIdentity -and
    [int64]$finalConsistency.Identity.ProcessId -eq [int64]$acceptedRestartIdentity.ProcessId -and
    [string]$finalConsistency.Identity.CreationDate -eq [string]$acceptedRestartIdentity.CreationDate
if (-not $restartStillHealthy) {
    [void](Disable-VerifiedMainTask $finalOwnedTask)
    throw '输出重启成功前的产品级最终验活失败；主任务已进入安全围栏。'
}
Write-Output ([ordered]@{ success = $true; action = 'restarted'; taskName = $TaskName; leaseState = $finalLease.state; leaseAgeSeconds = [Math]::Round($finalLease.ageSeconds, 1); runtimeStarted = $true } | ConvertTo-Json -Compress)
} finally {
    if ($maintenanceMutexHeld) { try { $maintenanceMutex.ReleaseMutex() } catch {} }
    $maintenanceMutex.Dispose()
}
