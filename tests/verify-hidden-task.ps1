[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$installerPath = Join-Path $projectRoot 'scripts\install-wecom-task.ps1'
$uninstallerPath = Join-Path $projectRoot 'scripts\uninstall-wecom-task.ps1'
$launcherPath = Join-Path $projectRoot 'scripts\install-hidden-node.ps1'
$watchdogPath = Join-Path $projectRoot 'scripts\watchdog-wecom-task.ps1'
$watchdogLauncherPath = Join-Path $projectRoot 'scripts\launch-wecom-watchdog.js'
$runnerRecoveryPath = Join-Path $projectRoot 'scripts\recover-runner-isolation.ps1'
$processHandlePath = Join-Path $projectRoot 'scripts\windows-process-handle.ps1'

$installer = Get-Content -LiteralPath $installerPath -Raw -Encoding UTF8
$uninstaller = Get-Content -LiteralPath $uninstallerPath -Raw -Encoding UTF8
$launcher = Get-Content -LiteralPath $launcherPath -Raw -Encoding UTF8
$watchdog = Get-Content -LiteralPath $watchdogPath -Raw -Encoding UTF8
$watchdogLauncher = Get-Content -LiteralPath $watchdogLauncherPath -Raw -Encoding UTF8
$runnerRecovery = Get-Content -LiteralPath $runnerRecoveryPath -Raw -Encoding UTF8
$processHandleSource = Get-Content -LiteralPath $processHandlePath -Raw -Encoding UTF8

foreach ($scriptPath in @($installerPath, $uninstallerPath, $launcherPath, $watchdogPath, $runnerRecoveryPath, $processHandlePath)) {
    $tokens = $null
    $parseErrors = $null
    [Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors) | Out-Null
    if ($parseErrors.Count -gt 0) { throw "PowerShell parser rejected ${scriptPath}: $($parseErrors[0].Message)" }
}
& node.exe --check $watchdogLauncherPath
if ($LASTEXITCODE -ne 0) { throw 'Node parser rejected the no-console watchdog launcher.' }
foreach ($maintenancePath in @($installerPath, $uninstallerPath, $watchdogPath)) {
    $tokens = $null; $parseErrors = $null
    $maintenanceAst = [Management.Automation.Language.Parser]::ParseFile($maintenancePath, [ref]$tokens, [ref]$parseErrors)
    $sentinelFunction = $maintenanceAst.Find({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'ConvertTo-MaintenanceSnapshotSentinel'
    }, $true)
    $sentinelSource = [string]$sentinelFunction.Extent.Text
    if ($sentinelSource -match 'maintenanceScriptPath|Test-ExactCommandArgument' -or
        $sentinelSource -notmatch 'GetFileName' -or $sentinelSource -notmatch 'IsNullOrWhiteSpace\(\$commandLine\)') {
        throw "Maintenance CIM sentinel still requires a -File host or omits process executable/command validation: $maintenancePath"
    }
}

$installerTokens = $null
$installerParseErrors = $null
$installerAst = [Management.Automation.Language.Parser]::ParseFile($installerPath, [ref]$installerTokens, [ref]$installerParseErrors)
$repeatingTriggerCommands = @($installerAst.FindAll({
    param($node)
    if (-not ($node -is [Management.Automation.Language.CommandAst]) -or $node.GetCommandName() -ne 'New-ScheduledTaskTrigger') { return $false }
    $parameterNames = @($node.CommandElements | Where-Object { $_ -is [Management.Automation.Language.CommandParameterAst] } | ForEach-Object { $_.ParameterName })
    return $parameterNames -contains 'RepetitionInterval'
}, $true))
if ($repeatingTriggerCommands.Count -ne 1) { throw 'Only the external watchdog may have a repeating trigger.' }
foreach ($triggerCommand in $repeatingTriggerCommands) {
    $parameterNames = @($triggerCommand.CommandElements | Where-Object { $_ -is [Management.Automation.Language.CommandParameterAst] } | ForEach-Object { $_.ParameterName })
    if ($parameterNames -contains 'RepetitionDuration') { throw 'A repeating trigger still has a finite repetition duration.' }
    if ([string]$triggerCommand.Extent.Text -notmatch 'New-TimeSpan\s+-Minutes\s+5') { throw 'The external watchdog is not limited to one check every five minutes.' }
}
$durationProbe = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes 5)
if ($null -ne $durationProbe.Repetition.Duration -or [string]$durationProbe.Repetition.Interval -ne 'PT5M') {
    throw 'Omitting RepetitionDuration did not produce an infinite five-minute trigger on this host.'
}

function Import-ScriptFunction([string]$ScriptPath, [string]$Name) {
    $tokens = $null
    $parseErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($ScriptPath, [ref]$tokens, [ref]$parseErrors)
    $definition = $ast.Find({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $Name
    }, $true)
    if ($null -eq $definition) { throw "Function $Name was not found in $ScriptPath" }
    $definitionText = [string]$definition.Extent.Text
    $scriptDefinition = [regex]::Replace($definitionText, '^function\s+' + [regex]::Escape($Name), "function script:$Name", [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    Invoke-Expression $scriptDefinition
}

Import-ScriptFunction $watchdogPath 'Test-FullyQualifiedWindowsPath'
Import-ScriptFunction $watchdogPath 'Get-MaintenanceMutexName'
Import-ScriptFunction $watchdogPath 'ConvertTo-ProcessCreationStamp'
Import-ScriptFunction $watchdogPath 'Test-ExactCommandArgument'
Import-ScriptFunction $watchdogPath 'ConvertTo-MaintenanceSnapshotSentinel'
Import-ScriptFunction $watchdogPath 'Get-HealthyMaintenanceProcessSnapshot'
Import-ScriptFunction $watchdogPath 'Test-ProductPathSuffix'
Import-ScriptFunction $watchdogPath 'Get-ProductArgumentsMetadata'
Import-ScriptFunction $watchdogPath 'Test-ProductArguments'
Import-ScriptFunction $watchdogPath 'ConvertTo-ProductProcessIdentity'
Import-ScriptFunction $watchdogPath 'Test-ProductIdentityMatchesOwnedTask'
Import-ScriptFunction $watchdogPath 'ConvertTo-OwnedProcessIdentity'
Import-ScriptFunction $watchdogPath 'Get-VerifiedExecTaskActionFields'
Import-ScriptFunction $watchdogPath 'Get-ProductMainTaskActionMetadata'
Import-ScriptFunction $watchdogPath 'Assert-MainTaskOwnership'
Import-ScriptFunction $watchdogPath 'Get-ProductLeaseConsistency'
Import-ScriptFunction $watchdogPath 'Get-VerifiedLeaseMismatchRecoveryIdentity'
Import-ScriptFunction $watchdogPath 'Get-VerifiedCurrentMainTask'
Import-ScriptFunction $watchdogPath 'Disable-VerifiedMainTask'
Import-ScriptFunction $watchdogPath 'Enable-VerifiedMainTask'
Import-ScriptFunction $watchdogPath 'Start-VerifiedMainTask'
Import-ScriptFunction $watchdogPath 'Confirm-EmptyProductProcessSlot'
Import-ScriptFunction $watchdogPath 'Get-TaskIdentityKey'
Import-ScriptFunction $watchdogPath 'Get-ProductTaskActionMetadata'
Import-ScriptFunction $watchdogPath 'Get-ProductTaskSignatures'
Import-ScriptFunction $watchdogPath 'Assert-ManagedConfigEvidence'
Import-ScriptFunction $watchdogPath 'Assert-CurrentDeploymentEvidence'
$preciseCreation = [DateTime]::SpecifyKind([DateTime]::ParseExact('2026-09-04T08:09:10.1234567', 'yyyy-MM-ddTHH:mm:ss.fffffff', [Globalization.CultureInfo]::InvariantCulture), [DateTimeKind]::Utc)
$creationStamp = ConvertTo-ProcessCreationStamp $preciseCreation
if ([string]$creationStamp.Token -ne $preciseCreation.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)) {
    throw 'Sub-second process creation identity was not preserved as UTC ticks.'
}
$testExecutable = 'C:\Codex\nodew.exe'
$testServer = 'C:\Codex\xbb-executive-analyst\shared\wecom\server.js'
$testArguments = '"C:\Codex\xbb-executive-analyst\shared\wecom\server.js" --managed-config "C:\Codex\bot-config.json"'
$script:expectedNode = $testExecutable
$script:productServerArgumentPrefix = '"C:\Codex\xbb-executive-analyst\shared\wecom\server.js"'
$script:productArgumentPattern = '^(?:"(?<serverPath>[^\r\n"]+)"|(?<plainServerPath>\S+))(?: --managed-config "(?<configPath>[^\r\n"]+)")?$'
$script:mainArgumentPattern = $script:productArgumentPattern
$script:productServerSuffix = '\shared\wecom\server.js'
$script:productStartScriptSuffix = '\scripts\start-wecom-bot.ps1'
$script:productWatchdogScriptSuffix = '\scripts\watchdog-wecom-task.ps1'
$script:productWatchdogLauncherSuffix = '\scripts\launch-wecom-watchdog.js'
$script:powerShellPath = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$script:expectedDescription = 'owned-main-task'
$script:defaultConfigPath = 'C:\Codex\bot-config.json'
$script:trustedProductServerPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
[void]$script:trustedProductServerPaths.Add($testServer)
$ownedTask = [pscustomobject]@{
    Executable = $testExecutable
    Arguments = $testArguments
    ProductExecutable = $testExecutable
    ProductArguments = $testArguments
    ProductServerPath = $testServer
    ConfigPath = $script:defaultConfigPath
    Description = $script:expectedDescription
    Mode = 'direct'
}
$execCimClass = [pscustomobject]@{ CimClassName = 'MSFT_TaskExecAction' }
$missingArgumentsExecAction = [pscustomobject]@{
    CimClass = $execCimClass; Execute = $testExecutable; WorkingDirectory = 'C:\Codex'
}
$nonExecAction = [pscustomobject]@{
    CimClass = [pscustomobject]@{ CimClassName = 'MSFT_TaskComHandlerAction' }
    ClassId = '{00000000-0000-0000-0000-000000000000}'; Data = ''
}
$missingExecuteAction = [pscustomobject]@{ CimClass = $execCimClass; Arguments = $testArguments }
$ambiguousExecuteOnlyAction = [pscustomobject]@{ Execute = $testExecutable }
$duckTypedExecAction = [pscustomobject]@{ Execute = $testExecutable; Arguments = $testArguments; WorkingDirectory = 'C:\Codex' }
$unknownCimAction = [pscustomobject]@{ CimClass = [pscustomobject]@{ CimClassName = 'MSFT_TaskUnknownAction' }; Execute = $testExecutable; Arguments = $testArguments }
$conflictingExecTypeAction = [pscustomobject]@{ ActionType = 0; CimClass = [pscustomobject]@{ CimClassName = 'MSFT_TaskComHandlerAction' }; Execute = $testExecutable; Arguments = $testArguments }
$conflictingNonExecTypeAction = [pscustomobject]@{ ActionType = 5; CimClass = $execCimClass; Execute = $testExecutable; Arguments = $testArguments }
$substringTypeNameAction = [pscustomobject]@{ Execute = $testExecutable; Arguments = $testArguments }
$substringTypeNameAction.PSObject.TypeNames.Insert(0, 'Fake.MSFT_TaskExecAction')
$exactTypeNameExecAction = [pscustomobject]@{ Execute = $testExecutable; WorkingDirectory = 'C:\Codex' }
$exactTypeNameExecAction.PSObject.TypeNames.Insert(0, 'Microsoft.Management.Infrastructure.CimInstance#MSFT_TaskExecAction')
$reservedActionType = [pscustomobject]@{ ActionType = 1; Execute = $testExecutable; Arguments = $testArguments; WorkingDirectory = 'C:\Codex' }
$outOfRangeActionType = [pscustomobject]@{ ActionType = 99; Execute = $testExecutable; Arguments = $testArguments; WorkingDirectory = 'C:\Codex' }
foreach ($actionParserPath in @($installerPath, $uninstallerPath, $watchdogPath)) {
    Import-ScriptFunction $actionParserPath 'Get-VerifiedExecTaskActionFields'
    if ($actionParserPath -eq $watchdogPath) { Import-ScriptFunction $actionParserPath 'Get-ProductMainTaskActionMetadata' }
    Import-ScriptFunction $actionParserPath 'Get-ProductTaskActionMetadata'
    Import-ScriptFunction $actionParserPath 'Get-ProductTaskSignatures'
    $hiddenWatchdogArguments = '"C:\Codex\xbb-executive-analyst\scripts\launch-wecom-watchdog.js" --powershell "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" --script "C:\Codex\xbb-executive-analyst\scripts\watchdog-wecom-task.ps1" --task-name "Codex-XBB-Bot" --lease-path "C:\Codex\service-lease.json" --stale-seconds 180'
    $hiddenWatchdogMetadata = Get-ProductTaskActionMetadata ([pscustomobject]@{ ActionType = 0; Execute = $testExecutable; Arguments = $hiddenWatchdogArguments })
    if ([string]$hiddenWatchdogMetadata.State -ne 'candidate' -or [string]$hiddenWatchdogMetadata.Kind -ne 'watchdog' -or
        [string]$hiddenWatchdogMetadata.TargetTaskName -ne 'Codex-XBB-Bot' -or [string]$hiddenWatchdogMetadata.LeasePath -ne 'C:\Codex\service-lease.json') {
        throw "The hidden-node watchdog action was not strictly recognized: $actionParserPath"
    }
    $malformedHiddenWatchdog = $hiddenWatchdogArguments.Replace('--stale-seconds 180', '--stale-seconds 60')
    if ([string](Get-ProductTaskActionMetadata ([pscustomobject]@{ ActionType = 0; Execute = $testExecutable; Arguments = $malformedHiddenWatchdog })).State -ne 'indeterminate') {
        throw "A malformed hidden-node watchdog action did not fail closed: $actionParserPath"
    }
    $normalizedExec = Get-VerifiedExecTaskActionFields $missingArgumentsExecAction
    if ([string]$normalizedExec.State -ne 'exec' -or [string]$normalizedExec.Arguments -cne '' -or
        [string](Get-ProductTaskActionMetadata $missingArgumentsExecAction).State -ne 'not-product') {
        throw "A confirmed Exec action without optional Arguments was not safely normalized: $actionParserPath"
    }
    $typeNameExec = Get-VerifiedExecTaskActionFields $exactTypeNameExecAction
    if ([string]$typeNameExec.State -ne 'exec' -or [string]$typeNameExec.Arguments -cne '') {
        throw "An exact whitelisted Exec TypeName was not accepted: $actionParserPath"
    }
    if ([string](Get-ProductTaskActionMetadata $nonExecAction).State -ne 'not-product') {
        throw "A confirmed TaskComHandler action was not safely ignored as non-product: $actionParserPath"
    }
    $providerNonExecTask = [pscustomobject]@{ TaskName = 'System-ComHandler'; TaskPath = '\'; Description = ''; Actions = @($nonExecAction) }
    $independentNonExecTask = [pscustomobject]@{
        TaskName = 'System-ComHandler'; TaskPath = '\'; Description = ''
        Actions = @([pscustomobject]@{ ActionType = 5; Execute = ''; Arguments = ''; WorkingDirectory = '' })
    }
    if (@(Get-ProductTaskSignatures @($providerNonExecTask)).Count -ne 0 -or
        @(Get-ProductTaskSignatures @($independentNonExecTask)).Count -ne 0) {
        throw "Provider and COM TaskComHandler shapes were not consistently ignored: $actionParserPath"
    }
    foreach ($rejectedAction in @(
        $missingExecuteAction, $ambiguousExecuteOnlyAction, $duckTypedExecAction, $unknownCimAction,
        $conflictingExecTypeAction, $conflictingNonExecTypeAction, $substringTypeNameAction,
        $reservedActionType, $outOfRangeActionType
    )) {
        if ([string](Get-ProductTaskActionMetadata $rejectedAction).State -ne 'indeterminate') {
            throw "An incomplete, duck-typed, conflicting, reserved, or unknown task action did not fail closed: $actionParserPath"
        }
    }
}
Import-ScriptFunction $watchdogPath 'Get-VerifiedExecTaskActionFields'
Import-ScriptFunction $watchdogPath 'Get-ProductMainTaskActionMetadata'
Import-ScriptFunction $watchdogPath 'Get-ProductTaskActionMetadata'
if (Test-FullyQualifiedWindowsPath 'C:relative\bot.json') { throw 'Drive-relative Windows path was accepted.' }
if (Test-FullyQualifiedWindowsPath '\root-relative\bot.json') { throw 'Root-relative Windows path was accepted.' }
if (-not (Test-FullyQualifiedWindowsPath 'C:\')) { throw 'Drive-root Windows path was rejected.' }
if (-not (Test-FullyQualifiedWindowsPath '\\server\share\bot-config.json')) { throw 'A legal UNC path was rejected.' }
if ((Get-MaintenanceMutexName 'Bot-A') -cne (Get-MaintenanceMutexName 'Bot-B')) {
    throw 'Different task names do not resolve to the same product maintenance mutex.'
}
$ownedProcess = [pscustomobject]@{
    ExecutablePath = $testExecutable
    CommandLine = "`"$testExecutable`" $testArguments"
    CreationDate = $preciseCreation
    ProcessId = 43210
}
$identityProbe = ConvertTo-OwnedProcessIdentity $ownedProcess $ownedTask
if ($identityProbe.State -ne 'alive' -or [string]$identityProbe.Identity.CreationDate -ne [string]$creationStamp.Token) {
    throw 'Exact owned process identity did not retain its creation token.'
}
$reusedPidProbe = ConvertTo-OwnedProcessIdentity $ownedProcess $ownedTask ([string]([int64]$creationStamp.Token + 1))
if ($reusedPidProbe.State -ne 'missing') { throw 'A PID with a different creation token was not rejected.' }
$unreadableProcess = [pscustomobject]@{ ExecutablePath = ''; CommandLine = ''; CreationDate = $null; ProcessId = 43210 }
if ((ConvertTo-OwnedProcessIdentity $unreadableProcess $ownedTask).State -ne 'indeterminate') {
    throw 'Unreadable CIM identity fields were not treated as indeterminate.'
}
if (-not (Test-ProductArguments '"C:\Codex\xbb-executive-analyst\shared\wecom\server.js"')) {
    throw 'The legacy server argument shape was not accepted as the same product.'
}
if (-not (Test-ProductArguments '"D:\Old Workspace\xbb-executive-analyst\shared\wecom\server.js" --managed-config "D:\Runtime\alternate.json"')) {
    throw 'An arbitrary absolute managed-config path was not accepted as the same product.'
}
if (Test-ProductArguments '"C:\Codex\xbb-executive-analyst\shared\wecom\server.js" --managed-config "relative\bot.json"') {
    throw 'A relative managed-config path was accepted as a product process.'
}
$relativeConfigProcess = [pscustomobject]@{
    Name = 'nodew.exe'; ExecutablePath = $testExecutable; CommandLine = "`"$testExecutable`" `"$testServer`" --managed-config `"C:relative\bot.json`""; CreationDate = $preciseCreation; ProcessId = 43214
}
if ((ConvertTo-ProductProcessIdentity $relativeConfigProcess).State -ne 'indeterminate') {
    throw 'A product-like process with a non-fully-qualified config did not fail closed.'
}
$rootRelativeExecutableProcess = [pscustomobject]@{
    Name = 'nodew.exe'; ExecutablePath = '\Codex\nodew.exe'; CommandLine = "`"$testExecutable`" $testArguments"; CreationDate = $preciseCreation; ProcessId = 43215
}
if ((ConvertTo-ProductProcessIdentity $rootRelativeExecutableProcess).State -ne 'indeterminate') {
    throw 'A product-like process with a non-fully-qualified executable did not fail closed.'
}
if (Test-ProductArguments '"C:\Codex\xbb-executive-analyst\shared\wecom\server.js" --managed-config "C:\Codex\bot.json" --extra') {
    throw 'Unanchored extra product arguments were accepted.'
}
$legacyProcess = [pscustomobject]@{
    Name = 'nodew.exe'; ExecutablePath = $testExecutable; CommandLine = "`"$testExecutable`" `"$testServer`""; CreationDate = $preciseCreation; ProcessId = 43211
}
if ((ConvertTo-ProductProcessIdentity $legacyProcess).State -ne 'alive') {
    throw 'The legacy live process was not recognized at product scope.'
}
$alternateArguments = '"D:\Old Workspace\xbb-executive-analyst\shared\wecom\server.js" --managed-config "D:\Runtime\alternate.json"'
$alternateProcess = [pscustomobject]@{
    Name = 'nodew.exe'; ExecutablePath = $testExecutable; CommandLine = "`"$testExecutable`" $alternateArguments"; CreationDate = $preciseCreation.AddSeconds(1); ProcessId = 43212
}
if ((ConvertTo-ProductProcessIdentity $alternateProcess).State -ne 'indeterminate') {
    throw 'An arbitrary suffix-matching workspace was trusted without deployment evidence.'
}
[void]$script:trustedProductServerPaths.Add('D:\Old Workspace\xbb-executive-analyst\shared\wecom\server.js')
if ((ConvertTo-ProductProcessIdentity $alternateProcess).State -ne 'alive') {
    throw 'A historical workspace was not recognized after explicit deployment evidence trusted its server entry.'
}
if ((ConvertTo-ProductProcessIdentity $alternateProcess $testArguments).State -ne 'missing') {
    throw 'Product identity revalidation did not bind the exact anchored arguments.'
}
if ((ConvertTo-ProductProcessIdentity $alternateProcess '' ([string]([int64](ConvertTo-ProcessCreationStamp $alternateProcess.CreationDate).Token + 1))).State -ne 'missing') {
    throw 'Product identity revalidation did not bind the sub-second creation token.'
}
$alternateExecutableProcess = [pscustomobject]@{
    Name = 'node.exe'; ExecutablePath = 'D:\Other\node.exe'; CommandLine = '"D:\Other\node.exe" "D:\Old Workspace\xbb-executive-analyst\shared\wecom\server.js"'; CreationDate = $preciseCreation; ProcessId = 43213
}
if ((ConvertTo-ProductProcessIdentity $alternateExecutableProcess).State -ne 'alive') {
    throw 'A historical workspace launched by node.exe was not recognized at product scope.'
}
$consistentLease = [pscustomobject]@{ pidState = 'alive'; pidAlive = $true; processIdentity = $identityProbe.Identity }
$consistentCandidates = [pscustomobject][ordered]@{ State = 'unique'; Identities = @($identityProbe.Identity) }
if ((Get-ProductLeaseConsistency $consistentLease $ownedTask $consistentCandidates).State -ne 'consistent') {
    throw 'A unique exact lease/product identity was not accepted.'
}
$multipleCandidates = [pscustomobject][ordered]@{ State = 'multiple'; Identities = @($identityProbe.Identity, $identityProbe.Identity) }
if ((Get-ProductLeaseConsistency $consistentLease $ownedTask $multipleCandidates).State -ne 'multiple') {
    throw 'A second product generation appearing during a wait was not fenced.'
}
$indeterminateCandidates = [pscustomobject][ordered]@{ State = 'indeterminate'; Identities = @() }
if ((Get-ProductLeaseConsistency $consistentLease $ownedTask $indeterminateCandidates).State -ne 'indeterminate') {
    throw 'CIM uncertainty was not propagated into the watchdog fence state.'
}
$changedCreationIdentity = [pscustomobject][ordered]@{
    ProcessId = $identityProbe.Identity.ProcessId
    CreationDate = ([int64]$identityProbe.Identity.CreationDate + 1).ToString()
    CreationAt = $identityProbe.Identity.CreationAt.AddTicks(1)
    Executable = $identityProbe.Identity.Executable
    Arguments = $identityProbe.Identity.Arguments
}
$changedCreationCandidates = [pscustomobject][ordered]@{ State = 'unique'; Identities = @($changedCreationIdentity) }
if ((Get-ProductLeaseConsistency $consistentLease $ownedTask $changedCreationCandidates).State -ne 'mismatch') {
    throw 'PID reuse with a changed creation token was not fenced as a mismatch.'
}
$deadLease = [pscustomobject]@{ pidState = 'missing'; pidAlive = $false; processIdentity = $null }
$emptyCandidates = [pscustomobject][ordered]@{ State = 'none'; Identities = @() }
if ((Get-ProductLeaseConsistency $deadLease $ownedTask $emptyCandidates).State -ne 'none') {
    throw 'A fenced task whose old process died did not expose the empty-slot recovery state.'
}
if ($null -eq (Get-VerifiedLeaseMismatchRecoveryIdentity $consistentCandidates $ownedTask)) {
    throw 'A unique process exactly matching the direct-node task was not eligible for corrupt-lease recovery.'
}
$otherGenerationCandidates = [pscustomobject][ordered]@{ State = 'unique'; Identities = @((ConvertTo-ProductProcessIdentity $alternateProcess).Identity) }
if ($null -ne (Get-VerifiedLeaseMismatchRecoveryIdentity $otherGenerationCandidates $ownedTask)) {
    throw 'A different product generation was allowed into corrupt-lease self-healing.'
}
$historicalPowerShellTask = [pscustomobject]@{
    Executable = $script:powerShellPath; Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "D:\Old Workspace\xbb-executive-analyst\scripts\start-wecom-bot.ps1"'
    ProductExecutable = ''; ProductArguments = ''; ProductServerPath = 'D:\Old Workspace\xbb-executive-analyst\shared\wecom\server.js'
}
if ($null -ne (Get-VerifiedLeaseMismatchRecoveryIdentity $otherGenerationCandidates $historicalPowerShellTask)) {
    throw 'A historical PowerShell task without an exact child command was allowed into corrupt-lease self-healing.'
}
$script:emptyConfirmationCandidates = $emptyCandidates
function script:Find-ProductProcessCandidates { return $script:emptyConfirmationCandidates }
try {
    if ((Confirm-EmptyProductProcessSlot $emptyCandidates) -ne 'empty') {
        throw 'Two consecutive healthy empty product snapshots did not permit controlled recovery.'
    }
    $script:emptyConfirmationCandidates = $multipleCandidates
    if ((Confirm-EmptyProductProcessSlot $emptyCandidates) -ne 'multiple') {
        throw 'A second-generation appearance during empty-slot confirmation did not preserve the fence.'
    }
    $script:emptyConfirmationCandidates = $indeterminateCandidates
    if ((Confirm-EmptyProductProcessSlot $emptyCandidates) -ne 'indeterminate') {
        throw 'Transient CIM failure during empty-slot confirmation did not preserve the fence.'
    }
} finally {
    Remove-Item Function:\Find-ProductProcessCandidates -Force -ErrorAction SilentlyContinue
}

# A broad Win32_Process snapshot is trusted only when it contains the exact maintenance
# process used to establish the out-of-band sentinel. An empty provider result is not an
# empty product slot.
$script:maintenanceScriptPath = 'C:\Ops\watchdog-wecom-task.ps1'
$maintenancePowerShell = [IO.Path]::GetFullPath((Get-Command powershell.exe -ErrorAction Stop).Source)
$maintenanceProcess = [pscustomobject]@{
    Name = 'powershell.exe'
    ExecutablePath = $maintenancePowerShell
    CommandLine = "`"$maintenancePowerShell`" -NoProfile -Command `"& { `$null = 1 }`""
    CreationDate = $preciseCreation
    ProcessId = $PID
}
if ([string]$maintenanceProcess.CommandLine -like "*$($script:maintenanceScriptPath)*") {
    throw 'The interactive -Command maintenance-host fixture unexpectedly contains the maintenance script path.'
}
$script:maintenanceSnapshotSentinel = ConvertTo-MaintenanceSnapshotSentinel $maintenanceProcess
$invalidMaintenanceProcesses = @(
    [pscustomobject]@{ Name = 'powershell.exe'; ExecutablePath = $maintenancePowerShell; CommandLine = $maintenanceProcess.CommandLine; CreationDate = $preciseCreation; ProcessId = $PID + 1 },
    [pscustomobject]@{ Name = 'powershell.exe'; ExecutablePath = (Join-Path $env:SystemRoot 'System32\cmd.exe'); CommandLine = $maintenanceProcess.CommandLine; CreationDate = $preciseCreation; ProcessId = $PID },
    [pscustomobject]@{ Name = 'pwsh.exe'; ExecutablePath = $maintenancePowerShell; CommandLine = $maintenanceProcess.CommandLine; CreationDate = $preciseCreation; ProcessId = $PID },
    [pscustomobject]@{ Name = 'powershell.exe'; ExecutablePath = $maintenancePowerShell; CommandLine = ' '; CreationDate = $preciseCreation; ProcessId = $PID },
    [pscustomobject]@{ Name = 'powershell.exe'; ExecutablePath = $maintenancePowerShell; CommandLine = $maintenanceProcess.CommandLine; CreationDate = 'not-a-date'; ProcessId = $PID }
)
foreach ($invalidMaintenanceProcess in $invalidMaintenanceProcesses) {
    try {
        [void](ConvertTo-MaintenanceSnapshotSentinel $invalidMaintenanceProcess)
        throw 'An invalid maintenance-host identity was accepted as the CIM sentinel.'
    } catch {
        if ($_.Exception.Message -eq 'An invalid maintenance-host identity was accepted as the CIM sentinel.') { throw }
    }
}
$script:maintenanceSnapshotRows = @()
function script:Get-CimInstance { return @($script:maintenanceSnapshotRows) }
try {
    try {
        [void](Get-HealthyMaintenanceProcessSnapshot)
        throw 'A false-empty CIM process snapshot was accepted without its maintenance sentinel.'
    } catch {
        if ($_.Exception.Message -eq 'A false-empty CIM process snapshot was accepted without its maintenance sentinel.') { throw }
    }
    $script:maintenanceSnapshotRows = @($maintenanceProcess)
    if (@(Get-HealthyMaintenanceProcessSnapshot).Count -ne 1) {
        throw 'An exact maintenance sentinel did not validate a healthy CIM process snapshot.'
    }
    $script:maintenanceSnapshotRows = @([pscustomobject]@{
        Name = $maintenanceProcess.Name; ExecutablePath = $maintenanceProcess.ExecutablePath
        CommandLine = $maintenanceProcess.CommandLine; CreationDate = $preciseCreation.AddTicks(1); ProcessId = $PID
    })
    try {
        [void](Get-HealthyMaintenanceProcessSnapshot)
        throw 'A reused maintenance PID with changed creation identity was accepted as the sentinel.'
    } catch {
        if ($_.Exception.Message -eq 'A reused maintenance PID with changed creation identity was accepted as the sentinel.') { throw }
    }
    $script:maintenanceSnapshotRows = @([pscustomobject]@{
        Name = $maintenanceProcess.Name; ExecutablePath = $maintenanceProcess.ExecutablePath
        CommandLine = "$($maintenanceProcess.CommandLine) "; CreationDate = $preciseCreation; ProcessId = $PID
    })
    try {
        [void](Get-HealthyMaintenanceProcessSnapshot)
        throw 'A changed maintenance command line was accepted by the broad CIM snapshot.'
    } catch {
        if ($_.Exception.Message -eq 'A changed maintenance command line was accepted by the broad CIM snapshot.') { throw }
    }
} finally {
    Remove-Item Function:\Get-CimInstance -Force -ErrorAction SilentlyContinue
}
$legacyWatchdogTask = [pscustomobject]@{
    Actions = @([pscustomobject]@{ ActionType = 0; Execute = $testExecutable; Arguments = "`"$testServer`"" })
    Description = $script:expectedDescription
}
if ([string](Assert-MainTaskOwnership $legacyWatchdogTask).Arguments -ne "`"$testServer`"") {
    throw 'Watchdog ownership no longer accepts the legacy live main-task action.'
}

# A suffix-shaped action is only a collision candidate.  The watchdog may trust
# a deployment only after exact descriptions, paired actions, root, lease, and
# managed-config evidence all agree.
$script:TaskName = 'Evidence-Test-Bot'
$script:watchdogTaskName = "$($script:TaskName)-Watchdog"
$script:taskPath = '\'
$script:watchdogTaskDescription = 'owned-watchdog-task'
$script:maintenanceScriptPath = [IO.Path]::GetFullPath($watchdogPath)
$script:expectedServer = [IO.Path]::GetFullPath((Join-Path $projectRoot 'shared\wecom\server.js'))
$script:resolvedLease = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) "xbb-evidence-lease-$PID.json"))
$evidenceConfigPath = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) "xbb-evidence-config-$PID.json"))
$evidenceMainArguments = "`"$($script:expectedServer)`" --managed-config `"$evidenceConfigPath`""
$evidenceWatchdogArguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$($script:maintenanceScriptPath)`" -TaskName `"$($script:TaskName)`" -LeasePath `"$($script:resolvedLease)`" -StaleSeconds 180"
$evidenceMainTask = [pscustomobject]@{
    TaskName = $script:TaskName; TaskPath = '\'; Description = $script:expectedDescription
    Actions = @([pscustomobject]@{ ActionType = 0; Execute = $testExecutable; Arguments = $evidenceMainArguments })
}
$evidenceWatchdogTask = [pscustomobject]@{
    TaskName = $script:watchdogTaskName; TaskPath = '\'; Description = $script:watchdogTaskDescription
    Actions = @([pscustomobject]@{ ActionType = 0; Execute = $script:powerShellPath; Arguments = $evidenceWatchdogArguments })
}
try {
    [ordered]@{
        schemaVersion = '4.0'; wecomBotId = 'evidence_bot'; wecomWsUrl = 'wss://openws.work.weixin.qq.com'
        modelProvider = 'codex-app-server'; serviceLeasePath = $script:resolvedLease
    } | ConvertTo-Json | Set-Content -LiteralPath $evidenceConfigPath -Encoding UTF8
    $evidenceOwnedTask = Assert-MainTaskOwnership $evidenceMainTask
    [void](Assert-CurrentDeploymentEvidence $evidenceMainTask $evidenceOwnedTask @($evidenceMainTask, $evidenceWatchdogTask))
    if (-not $script:trustedProductServerPaths.Contains($script:expectedServer)) { throw 'Closed deployment evidence did not authorize its exact server path.' }

    $wrongDescriptionMain = [pscustomobject]@{ Actions = $evidenceMainTask.Actions; Description = 'lookalike'; TaskName = $script:TaskName; TaskPath = '\' }
    try { [void](Assert-MainTaskOwnership $wrongDescriptionMain); throw 'A default-name main task with a mismatched Description was accepted.' } catch {
        if ($_.Exception.Message -eq 'A default-name main task with a mismatched Description was accepted.') { throw }
    }
    $wrongDescriptionWatchdog = [pscustomobject]@{ Actions = $evidenceWatchdogTask.Actions; Description = 'lookalike'; TaskName = $script:watchdogTaskName; TaskPath = '\' }
    try { [void](Assert-CurrentDeploymentEvidence $evidenceMainTask $evidenceOwnedTask @($evidenceMainTask, $wrongDescriptionWatchdog)); throw 'A paired watchdog with a mismatched Description was accepted.' } catch {
        if ($_.Exception.Message -eq 'A paired watchdog with a mismatched Description was accepted.') { throw }
    }
    $signatureA = @(Get-ProductTaskSignatures @($evidenceMainTask))
    $signatureB = @(Get-ProductTaskSignatures @($wrongDescriptionMain))
    if (($signatureA -join "`n") -ceq ($signatureB -join "`n")) { throw 'Task provider signatures did not bind Description.' }
} finally {
    if ([IO.File]::Exists($evidenceConfigPath)) { [IO.File]::Delete($evidenceConfigPath) }
}

Import-ScriptFunction $uninstallerPath 'ConvertTo-ProcessCreationStamp'
Import-ScriptFunction $uninstallerPath 'Test-ProductPathSuffix'
Import-ScriptFunction $uninstallerPath 'Get-ProductArgumentsMetadata'
Import-ScriptFunction $uninstallerPath 'Test-ProductArguments'
Import-ScriptFunction $uninstallerPath 'ConvertTo-ProductProcessIdentity'
Import-ScriptFunction $uninstallerPath 'Find-ProductProcessCandidates'
$script:hiddenNodePath = $testExecutable
$script:productServerArgumentPrefix = "`"$testServer`""
$script:productArgumentPattern = '^(?:"(?<serverPath>[^\r\n"]+)"|(?<plainServerPath>\S+))(?: --managed-config "(?<configPath>[^\r\n"]+)")?$'
$script:productServerSuffix = '\shared\wecom\server.js'
$script:mockManagedProcesses = @()
function script:Get-HealthyMaintenanceProcessSnapshot {
    return @($script:mockManagedProcesses)
}
try {
    $strictManagedProcess = [pscustomobject]@{
        Name = 'nodew.exe'
        ExecutablePath = $testExecutable
        CommandLine = "`"$testExecutable`" $testArguments"
        CreationDate = $preciseCreation
        ProcessId = 43220
    }
    $script:mockManagedProcesses = @($strictManagedProcess)
    $uniquePattern = Find-ProductProcessCandidates
    if ($uniquePattern.State -ne 'unique' -or @($uniquePattern.Identities).Count -ne 1) {
        throw 'Task/lease-independent strict managed-pattern discovery did not find the unique orphan.'
    }

    $secondManagedProcess = [pscustomobject]@{
        Name = 'nodew.exe'
        ExecutablePath = $testExecutable
        CommandLine = "`"$testExecutable`" $alternateArguments"
        CreationDate = $preciseCreation.AddSeconds(1)
        ProcessId = 43221
    }
    $script:mockManagedProcesses = @($strictManagedProcess, $secondManagedProcess)
    if ((Find-ProductProcessCandidates).State -ne 'multiple') {
        throw 'Different argument generations were not rejected as multiple product roots.'
    }

    $script:mockManagedProcesses = @([pscustomobject]@{
        Name = 'nodew.exe'; ExecutablePath = ''; CommandLine = ''; CreationDate = $null; ProcessId = 43222
    })
    if ((Find-ProductProcessCandidates).State -ne 'indeterminate') {
        throw 'Unreadable managed-pattern candidates did not fail closed.'
    }

    $script:mockManagedProcesses = @([pscustomobject]@{
        Name = 'nodew.exe'; ExecutablePath = $testExecutable; CommandLine = "`"$testExecutable`" `"C:\Other\server.js`""; CreationDate = $preciseCreation; ProcessId = 43223
    })
    if ((Find-ProductProcessCandidates).State -ne 'none') {
        throw 'An unrelated hidden-node process matched the managed orphan pattern.'
    }
} finally {
    Remove-Item Function:\Get-HealthyMaintenanceProcessSnapshot -Force -ErrorAction SilentlyContinue
}

# Installer health must observe product scope again after probing the lease PID. A second
# generation introduced between those two reads turns the round into a conflict.
Import-ScriptFunction $installerPath 'Get-ManagedLeaseHealth'
$healthLeasePath = [IO.Path]::GetTempFileName()
$healthNow = [DateTimeOffset]::UtcNow
$healthLease = [ordered]@{
    schemaVersion = '1.0'
    service = 'xbb-executive-analyst-wecom'
    state = 'running'
    pid = $identityProbe.Identity.ProcessId
    instanceId = 'health-check-instance-0001'
    stateSinceAt = $healthNow.ToString('o')
    updatedAt = $healthNow.ToString('o')
}
[IO.File]::WriteAllText($healthLeasePath, ($healthLease | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
$script:healthCandidateCall = 0
function script:Find-ProductProcessCandidates {
    $script:healthCandidateCall += 1
    if ($script:healthCandidateCall -eq 1) { return $consistentCandidates }
    return $multipleCandidates
}
function script:Get-ManagedProcessProbe {
    [CmdletBinding()]
    param([int64]$ProcessId, $Metadata, [string]$ExpectedCreationDate = '')
    return [pscustomobject][ordered]@{ State = 'alive'; Identity = $identityProbe.Identity }
}
try {
    $waitingHealth = Get-ManagedLeaseHealth $healthLeasePath $ownedTask $healthNow.AddMinutes(-1)
    if ($waitingHealth.State -ne 'conflict' -or $script:healthCandidateCall -lt 2) {
        throw 'Installer health accepted a second product generation introduced during its wait round.'
    }
} finally {
    Remove-Item Function:\Find-ProductProcessCandidates -Force -ErrorAction SilentlyContinue
    Remove-Item Function:\Get-ManagedProcessProbe -Force -ErrorAction SilentlyContinue
    if ([IO.File]::Exists($healthLeasePath)) { [IO.File]::Delete($healthLeasePath) }
}

# The fencing primitive revalidates task ownership immediately before disabling it.
$script:TaskName = 'Fence-Test-Bot'
$script:taskPath = '\'
$script:fenceDisableCalls = 0
$script:fenceEnableCalls = 0
$script:fenceStartCalls = 0
$script:fenceTask = [pscustomobject]@{ Settings = [pscustomobject]@{ Enabled = $true }; State = 'Ready' }
function script:Get-ExactTask { return $script:fenceTask }
function script:Assert-MainTaskOwnership { param($Task); return $ownedTask }
function script:Assert-NoOtherProductTasks { return @() }
function script:Assert-CurrentDeploymentEvidence { param($MainTask, $OwnedTask, [object[]]$TaskSnapshot); return $null }
function script:Disable-ScheduledTask {
    [CmdletBinding()]
    param([string]$TaskName, [string]$TaskPath)
    $script:fenceDisableCalls += 1
    $script:fenceTask.Settings.Enabled = $false
    return $script:fenceTask
}
function script:Enable-ScheduledTask {
    [CmdletBinding()]
    param([string]$TaskName, [string]$TaskPath)
    $script:fenceEnableCalls += 1
    $script:fenceTask.Settings.Enabled = $true
    return $script:fenceTask
}
function script:Start-ScheduledTask {
    [CmdletBinding()]
    param([string]$TaskName, [string]$TaskPath)
    $script:fenceStartCalls += 1
    $script:fenceTask.State = 'Running'
}
try {
    [void](Disable-VerifiedMainTask $ownedTask)
    if ($script:fenceDisableCalls -ne 1 -or [bool]$script:fenceTask.Settings.Enabled) {
        throw 'Verified main-task fencing did not disable the task.'
    }
    [void](Enable-VerifiedMainTask $ownedTask)
    [void](Start-VerifiedMainTask $ownedTask)
    if ($script:fenceEnableCalls -ne 1 -or $script:fenceStartCalls -ne 1 -or
        -not [bool]$script:fenceTask.Settings.Enabled -or [string]$script:fenceTask.State -ne 'Running') {
        throw 'Enable/start did not revalidate and operate on the verified main task.'
    }
} finally {
    Remove-Item Function:\Get-ExactTask -Force -ErrorAction SilentlyContinue
    Remove-Item Function:\Assert-MainTaskOwnership -Force -ErrorAction SilentlyContinue
    Remove-Item Function:\Assert-NoOtherProductTasks -Force -ErrorAction SilentlyContinue
    Remove-Item Function:\Assert-CurrentDeploymentEvidence -Force -ErrorAction SilentlyContinue
    Remove-Item Function:\Disable-ScheduledTask -Force -ErrorAction SilentlyContinue
    Remove-Item Function:\Enable-ScheduledTask -Force -ErrorAction SilentlyContinue
    Remove-Item Function:\Start-ScheduledTask -Force -ErrorAction SilentlyContinue
}

# Task absence requires two provider reads and two independent Task Scheduler COM
# observations. A fake-empty provider or a task appearing between reads is fenced.
Import-ScriptFunction $installerPath 'Get-TaskIdentityKey'
Import-ScriptFunction $installerPath 'Test-IndependentScheduledTaskExists'
Import-ScriptFunction $installerPath 'Get-ExactTask'
Import-ScriptFunction $installerPath 'Get-VerifiedExecTaskActionFields'
Import-ScriptFunction $installerPath 'Get-ProductTaskActionMetadata'
Import-ScriptFunction $installerPath 'Get-ProductTaskSignatures'
Import-ScriptFunction $installerPath 'Get-VerifiedProductTaskSnapshot'
$script:taskPath = '\'
$script:defaultConfigPath = 'C:\Default\bot-config.json'
$script:taskSnapshotFixture = [pscustomobject]@{
    TaskName = 'Old-Workspace-XBB-Bot'; TaskPath = '\'
    Actions = @([pscustomobject]@{ ActionType = 0; Execute = $testExecutable; Arguments = $alternateArguments })
    Description = 'owned-main-task'
}
$script:providerSnapshotCalls = 0
$script:independentSnapshotCalls = 0
$script:providerSnapshotMode = 'empty'
$script:independentSnapshotMode = 'present'
function script:Get-ScheduledTask {
    [CmdletBinding()]
    param([string]$TaskPath)
    $script:providerSnapshotCalls += 1
    if ($script:providerSnapshotMode -eq 'appears' -and $script:providerSnapshotCalls -gt 1) { return @($script:taskSnapshotFixture) }
    if ($script:providerSnapshotMode -eq 'present') { return @($script:taskSnapshotFixture) }
    return @()
}
function script:Get-IndependentScheduledTaskSnapshot {
    $script:independentSnapshotCalls += 1
    if ($script:independentSnapshotMode -eq 'appears' -and $script:independentSnapshotCalls -gt 1) { return @($script:taskSnapshotFixture) }
    if ($script:independentSnapshotMode -eq 'present') { return @($script:taskSnapshotFixture) }
    return @()
}
try {
    try {
        [void](Get-ExactTask 'Old-Workspace-XBB-Bot')
        throw 'A fake-empty ScheduledTasks provider hid an independently visible product task.'
    } catch {
        if ($_.Exception.Message -eq 'A fake-empty ScheduledTasks provider hid an independently visible product task.') { throw }
    }

    $script:providerSnapshotCalls = 0; $script:independentSnapshotCalls = 0
    $script:providerSnapshotMode = 'empty'; $script:independentSnapshotMode = 'empty'
    if ($null -ne (Get-ExactTask 'Missing-XBB-Bot') -or $script:providerSnapshotCalls -ne 2 -or $script:independentSnapshotCalls -ne 2) {
        throw 'Exact task absence was not confirmed by two provider and two independent snapshots.'
    }

    $script:providerSnapshotCalls = 0; $script:independentSnapshotCalls = 0
    $script:providerSnapshotMode = 'appears'; $script:independentSnapshotMode = 'appears'
    try {
        [void](Get-ExactTask 'Old-Workspace-XBB-Bot')
        throw 'A product task appearing during empty-slot confirmation was returned as a safe absence.'
    } catch {
        if ($_.Exception.Message -eq 'A product task appearing during empty-slot confirmation was returned as a safe absence.') { throw }
    }

    $script:providerSnapshotCalls = 0; $script:independentSnapshotCalls = 0
    $script:providerSnapshotMode = 'empty'; $script:independentSnapshotMode = 'present'
    try {
        [void](Get-VerifiedProductTaskSnapshot)
        throw 'A broad fake-empty task provider snapshot hid a product task visible through COM.'
    } catch {
        if ($_.Exception.Message -eq 'A broad fake-empty task provider snapshot hid a product task visible through COM.') { throw }
    }
} finally {
    Remove-Item Function:\Get-ScheduledTask -Force -ErrorAction SilentlyContinue
    Remove-Item Function:\Get-IndependentScheduledTaskSnapshot -Force -ErrorAction SilentlyContinue
}

foreach ($functionName in @(
    'Read-RunnerIsolationMarker',
    'Test-FullyQualifiedWindowsPath',
    'Test-CanonicalWindowsPath',
    'Test-CanonicalArgumentPath',
    'Get-ExactFlagValue',
    'ConvertTo-StrictRunnerCommandIdentity',
    'ConvertTo-RunnerProcessCreationIdentity',
    'ConvertTo-RecoverySentinel',
    'Get-HealthyRunnerProcessSnapshot',
    'ConvertTo-RunnerCimObservation',
    'Test-SameRunnerCimObservation',
    'ConvertTo-RunnerIsolationProcessProbe',
    'Get-RunnerIsolationCandidates',
    'Test-SameProcessIdentity',
    'Get-VerifiedRunnerProcessSnapshot',
    'Remove-RunnerIsolationRunDirectories',
    'Remove-RunnerIsolationGatewayWorkDirectory',
    'Remove-RunnerIsolationMarkerAtomically',
    'Invoke-RunnerIsolationRecovery'
)) {
    Import-ScriptFunction $runnerRecoveryPath $functionName
}
$script:isolationSchemaVersion = '2.0'
$script:isolationService = 'xbb-executive-analyst-runner'
$script:isolationTokenPattern = '^[a-f0-9]{64}$'
$script:recoveryScriptPath = [IO.Path]::GetFullPath($runnerRecoveryPath)
. $processHandlePath
$isolationTestRoot = Join-Path ([IO.Path]::GetTempPath()) "xbb-runner-isolation-test-$PID-$([Guid]::NewGuid().ToString('N'))"
[IO.Directory]::CreateDirectory($isolationTestRoot) | Out-Null
$runnerRunRoot = Join-Path $isolationTestRoot 'runs'
[IO.Directory]::CreateDirectory($runnerRunRoot) | Out-Null
$oldProjectRoot = Join-Path $isolationTestRoot 'old-project-root'
[IO.Directory]::CreateDirectory($oldProjectRoot) | Out-Null
$runnerPath = Join-Path $oldProjectRoot 'skills\xbb-executive-analyst\scripts\query-xbb.ps1'
$childPaths = @(
    (Join-Path $oldProjectRoot 'shared\xbb\export-live-data.js'),
    (Join-Path $oldProjectRoot 'shared\xbb\build-fact-pack.js'),
    (Join-Path $oldProjectRoot 'shared\xbb\aggregate-multi-period.js')
)
$gatewayWorkRoot = Join-Path ([IO.Path]::GetTempPath()) 'Codex\xbb-executive-analyst\bot-runs'
[IO.Directory]::CreateDirectory($gatewayWorkRoot) | Out-Null
$script:testGatewayWorkDirectories = @()

function script:New-RunnerIsolationTestMarker([string]$Token, [int64]$CreatedAtMs, $RootProcess = $null) {
    $gatewayWork = Join-Path $gatewayWorkRoot "request-$([Guid]::NewGuid().ToString('N'))"
    [IO.Directory]::CreateDirectory($gatewayWork) | Out-Null
    $script:testGatewayWorkDirectories += $gatewayWork
    $path = Join-Path $isolationTestRoot "$Token.json"
    $payload = [ordered]@{
        schemaVersion = '2.0'
        service = 'xbb-executive-analyst-runner'
        token = $Token
        createdAtMs = $CreatedAtMs
        projectRoot = [IO.Path]::GetFullPath($oldProjectRoot).TrimEnd('\')
        queryScriptPath = [IO.Path]::GetFullPath($runnerPath)
        childScriptPaths = @($childPaths | ForEach-Object { [IO.Path]::GetFullPath($_) })
        runRoot = [IO.Path]::GetFullPath($runnerRunRoot).TrimEnd('\')
        gatewayWorkDirectory = [IO.Path]::GetFullPath($gatewayWork).TrimEnd('\')
        rootProcess = $RootProcess
    }
    $json = $payload | ConvertTo-Json -Depth 10 -Compress
    [IO.File]::WriteAllText($path, $json, [Text.UTF8Encoding]::new($false))
    return [pscustomobject]@{ Path = $path; Payload = $payload; GatewayWorkDirectory = $gatewayWork }
}

function script:Get-TestRunnerRootCommandLine($MarkerRecord, [string]$Token) {
    $output = Join-Path ([string]$MarkerRecord.GatewayWorkDirectory) 'fact-pack.json'
    return "`"$powershellExecutable`" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$runnerPath`" " +
        "-OutputPath `"$output`" -RequestFromStdin -IsolationToken $Token -IsolationMarkerPath `"$($MarkerRecord.Path)`""
}

try {
    $markerCreatedAt = [DateTimeOffset]::new($preciseCreation).ToUnixTimeMilliseconds()
    $powershellExecutable = (Get-Command powershell.exe -ErrorAction Stop).Source
    $nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
    $quotedArguments = @(ConvertFrom-XbbWindowsCommandLine "`"$nodeExecutable`" `"$($childPaths[0])`" --isolation-token $('1' * 64)")
    if ($quotedArguments.Count -ne 4 -or $quotedArguments[1] -cne $childPaths[0] -or $quotedArguments[3] -cne ('1' * 64)) {
        throw 'Native Windows command-line parser did not preserve exact argument boundaries.'
    }
    $selfCim = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $PID" -ErrorAction Stop
    $selfCreation = ConvertTo-RunnerProcessCreationIdentity $selfCim.CreationDate
    $selfHandle = Open-XbbVerifiedProcessHandle ([pscustomobject]@{
        ProcessId = $PID
        CreationToken = $selfCreation.Token
        ExecutablePath = [string]$selfCim.ExecutablePath
    })
    try {
        if ($selfHandle.ProcessId -ne $PID -or [bool]$selfHandle.HasExited) {
            throw 'Verified process handle did not stay bound to the current PowerShell process.'
        }
    } finally {
        $selfHandle.Dispose()
    }
    try {
        Open-XbbVerifiedProcessHandle ([pscustomobject]@{
            ProcessId = $PID
            CreationToken = ([int64]$selfCreation.Token + 10000).ToString([Globalization.CultureInfo]::InvariantCulture)
            ExecutablePath = [string]$selfCim.ExecutablePath
        }) | Out-Null
        throw 'Native process handle accepted a changed creation identity.'
    } catch {
        if ($_.Exception.Message -eq 'Native process handle accepted a changed creation identity.') { throw }
    }
    $sentinelProcess = [pscustomobject]@{
        Name = [IO.Path]::GetFileName($powershellExecutable)
        ExecutablePath = $powershellExecutable
        CommandLine = "`"$powershellExecutable`" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$runnerRecoveryPath`" " +
            "-MarkerDirectory `"$isolationTestRoot`" -ProjectRoot `"$projectRoot`""
        CreationDate = $preciseCreation.AddSeconds(-10)
        ProcessId = 45000
        ParentProcessId = 1
    }
    $snapshotSentinel = ConvertTo-RecoverySentinel $sentinelProcess $runnerRecoveryPath
    $recoveryScriptArguments = "-File `"$runnerRecoveryPath`" -MarkerDirectory `"$isolationTestRoot`" -ProjectRoot `"$projectRoot`""
    foreach ($hostConflict in @(
        "-Command `"Write-Output conflict`" $recoveryScriptArguments",
        "-c `"Write-Output conflict`" $recoveryScriptArguments",
        "-EncodedCommand VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIAAnAGMAbwBuAGYAbABpAGMAdAAnAA== $recoveryScriptArguments",
        "-enc VwByAGkAdABlAC0ATwB1AHQAcAB1AHQAIAAnAGMAbwBuAGYAbABpAGMAdAAnAA== $recoveryScriptArguments",
        "-ConfigurationName Microsoft.PowerShell $recoveryScriptArguments",
        "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass $recoveryScriptArguments -File `"$runnerRecoveryPath`""
    )) {
        $maliciousSentinel = [pscustomobject]@{
            Name = [IO.Path]::GetFileName($powershellExecutable); ExecutablePath = $powershellExecutable
            CommandLine = "`"$powershellExecutable`" $hostConflict"
            CreationDate = $preciseCreation.AddSeconds(-10); ProcessId = 45001; ParentProcessId = 1
        }
        try {
            ConvertTo-RecoverySentinel $maliciousSentinel $runnerRecoveryPath | Out-Null
            throw "Competing PowerShell host mode was accepted: $hostConflict"
        } catch {
            if ($_.Exception.Message -like 'Competing PowerShell host mode was accepted:*') { throw }
        }
    }

    $hostModeToken = '8' * 64
    $hostModeMarker = New-RunnerIsolationTestMarker $hostModeToken $markerCreatedAt
    $hostModeOutput = Join-Path $hostModeMarker.GatewayWorkDirectory 'fact-pack.json'
    $hostModeProcess = [pscustomobject]@{
        Name = [IO.Path]::GetFileName($powershellExecutable); ExecutablePath = $powershellExecutable
        CommandLine = "`"$powershellExecutable`" -Command `"Write-Output conflict`" -File `"$runnerPath`" " +
            "-OutputPath `"$hostModeOutput`" -RequestFromStdin -IsolationToken $hostModeToken -IsolationMarkerPath `"$($hostModeMarker.Path)`""
        CreationDate = $preciseCreation.AddSeconds(1); ProcessId = 45002; ParentProcessId = 1
    }
    $script:hostModeProcesses = @($sentinelProcess, $hostModeProcess)
    $script:hostModeKillCalls = 0
    try {
        Invoke-RunnerIsolationRecovery -MarkerDirectory $isolationTestRoot -ProjectRoot $projectRoot -IsolationToken $hostModeToken `
            -ProcessProvider { @($script:hostModeProcesses) } -SnapshotSentinel $snapshotSentinel `
            -HandleBinder { $script:hostModeKillCalls += 1 } -TreeKiller { $script:hostModeKillCalls += 1 } `
            -HandleTerminator { $script:hostModeKillCalls += 1 } -HandleDisposer { } -VerificationDelay { } `
            -NowProvider { $markerCreatedAt + 60000 } | Out-Null
        throw 'Competing -Command runner identity was accepted for recovery.'
    } catch {
        if ($_.Exception.Message -eq 'Competing -Command runner identity was accepted for recovery.') { throw }
    }
    if ($script:hostModeKillCalls -ne 0 -or -not [IO.File]::Exists($hostModeMarker.Path)) {
        throw 'Competing PowerShell host mode caused a kill or marker cleanup.'
    }

    # The marker is persisted before spawn and can represent a crashed parent;
    # both an exact PowerShell root and an orphaned Node child remain recoverable.
    $isolationToken = 'a' * 64
    $runnerCreation = ConvertTo-RunnerProcessCreationIdentity $preciseCreation.AddSeconds(1)
    $boundRoot = [ordered]@{
        pid = 45101
        creationToken = [string]$runnerCreation.Token
        createdAtMs = [int64]$runnerCreation.AtMs
        executablePath = [IO.Path]::GetFullPath($powershellExecutable)
    }
    $markerRecord = New-RunnerIsolationTestMarker $isolationToken $markerCreatedAt $boundRoot
    $markerPath = $markerRecord.Path
    [IO.File]::WriteAllText((Join-Path $markerRecord.GatewayWorkDirectory 'fact-pack.json'), '{"sensitive":"test-only"}', [Text.UTF8Encoding]::new($false))
    $innerRunDirectory = Join-Path $runnerRunRoot "run-$isolationToken-777-20260904080910123-deadbeef"
    [IO.Directory]::CreateDirectory($innerRunDirectory) | Out-Null
    $runnerProcess = [pscustomobject]@{
        Name = [IO.Path]::GetFileName($powershellExecutable)
        ExecutablePath = $powershellExecutable
        CommandLine = Get-TestRunnerRootCommandLine $markerRecord $isolationToken
        CreationDate = $preciseCreation.AddSeconds(1)
        ProcessId = 45101
        ParentProcessId = 45000
    }
    $nodeProcess = [pscustomobject]@{
        Name = [IO.Path]::GetFileName($nodeExecutable)
        ExecutablePath = $nodeExecutable
        CommandLine = "`"$nodeExecutable`" `"$($childPaths[1])`" --isolation-token $isolationToken"
        CreationDate = $preciseCreation.AddSeconds(2)
        ProcessId = 45102
        ParentProcessId = 45101
    }
    $unrelatedProcess = [pscustomobject]@{
        Name = [IO.Path]::GetFileName($nodeExecutable)
        ExecutablePath = $nodeExecutable
        CommandLine = "`"$nodeExecutable`" `"C:\Other\unrelated.js`" --tag no-isolation-token"
        CreationDate = $preciseCreation.AddSeconds(2)
        ProcessId = 45103
        ParentProcessId = 1
    }
    $script:isolationMockProcesses = @($sentinelProcess, $runnerProcess, $nodeProcess, $unrelatedProcess)
    $script:isolationTreeKillCalls = @()
    $script:isolationIndividualKillCalls = @()
    $processProvider = { @($script:isolationMockProcesses) }
    $rootProcessProvider = {
        param([int]$TargetProcessId)
        @($script:isolationMockProcesses | Where-Object { [int]$_.ProcessId -eq $TargetProcessId })
    }
    $handleBinder = {
        param($Identity)
        [pscustomobject]@{
            ProcessId = $Identity.ProcessId
            CreationToken = $Identity.CreationToken
            ExecutablePath = $Identity.ExecutablePath
        }
    }
    $treeKiller = {
        param($BoundCandidate)
        $TargetProcessId = [int]$BoundCandidate.Identity.ProcessId
        $script:isolationTreeKillCalls += $TargetProcessId
        return $false
    }
    $handleTerminator = {
        param($BoundCandidate)
        $TargetProcessId = [int]$BoundCandidate.Identity.ProcessId
        $script:isolationIndividualKillCalls += $TargetProcessId
        $script:isolationMockProcesses = @($script:isolationMockProcesses | Where-Object { [int]$_.ProcessId -ne $TargetProcessId })
        return $true
    }
    $recoveryResult = Invoke-RunnerIsolationRecovery `
        -MarkerDirectory $isolationTestRoot `
        -ProjectRoot $projectRoot `
        -IsolationToken $isolationToken `
        -ProcessProvider $processProvider `
        -RootProcessProvider $rootProcessProvider `
        -SnapshotSentinel $snapshotSentinel `
        -HandleBinder $handleBinder `
        -TreeKiller $treeKiller `
        -HandleTerminator $handleTerminator `
        -HandleDisposer { } `
        -VerificationDelay { } `
        -NowProvider { $markerCreatedAt + 60000 }
    if ($recoveryResult.markersRecovered -ne 1 -or $recoveryResult.runDirectoriesRemoved -ne 1 -or [IO.File]::Exists($markerPath)) {
        throw 'Verified isolation recovery did not atomically clear its marker.'
    }
    if ([IO.Directory]::Exists($markerRecord.GatewayWorkDirectory) -or [IO.Directory]::Exists($innerRunDirectory)) {
        throw 'Verified isolation recovery left a protected gateway or inner runner directory behind.'
    }
    if ($script:isolationTreeKillCalls -notcontains 45101 -or $script:isolationTreeKillCalls -notcontains 45102) {
        throw 'Isolation recovery did not pass every handle-bound candidate through its compatibility hook.'
    }
    if ($script:isolationIndividualKillCalls -notcontains 45101 -or $script:isolationIndividualKillCalls -notcontains 45102 -or
        $script:isolationIndividualKillCalls -contains 45103) {
        throw 'Isolation recovery did not constrain handle termination to strict candidates.'
    }
    if (@($script:isolationMockProcesses | Where-Object { [int]$_.ProcessId -eq 45103 }).Count -ne 1) {
        throw 'Isolation recovery touched a process without the exact project-script match.'
    }

    # A clock rollback cannot hide an exact token+fixed-script orphan. Process
    # time is auxiliary; the exact command identity remains authoritative.
    $clockRollbackToken = '5' * 64
    $clockRollbackMarker = New-RunnerIsolationTestMarker $clockRollbackToken $markerCreatedAt
    $clockRollbackProcess = [pscustomobject]@{
        Name = [IO.Path]::GetFileName($nodeExecutable)
        ExecutablePath = $nodeExecutable
        CommandLine = "`"$nodeExecutable`" `"$($childPaths[0])`" --isolation-token $clockRollbackToken"
        CreationDate = $preciseCreation.AddSeconds(-30)
        ProcessId = 45107
        ParentProcessId = 1
    }
    $script:isolationMockProcesses = @($sentinelProcess, $clockRollbackProcess)
    $script:clockRollbackKillCalls = 0
    Invoke-RunnerIsolationRecovery -MarkerDirectory $isolationTestRoot -ProjectRoot $projectRoot -IsolationToken $clockRollbackToken `
        -ProcessProvider $processProvider -SnapshotSentinel $snapshotSentinel -HandleBinder $handleBinder `
        -TreeKiller { return $false } `
        -HandleTerminator {
            param($BoundCandidate)
            $script:clockRollbackKillCalls += 1
            $target = [int]$BoundCandidate.Identity.ProcessId
            $script:isolationMockProcesses = @($script:isolationMockProcesses | Where-Object { [int]$_.ProcessId -ne $target })
            return $true
        } -HandleDisposer { } -VerificationDelay { } `
        -NowProvider { $markerCreatedAt + 60000 } | Out-Null
    if ($script:clockRollbackKillCalls -ne 1 -or [IO.File]::Exists($clockRollbackMarker.Path)) {
        throw 'Clock rollback caused an exact token child to be ignored.'
    }

    # All process-object handles must be acquired and matched before any
    # termination. A changed second identity leaves the whole batch alive.
    $batchToken = '4' * 64
    $batchMarker = New-RunnerIsolationTestMarker $batchToken $markerCreatedAt
    $batchProcesses = @(
        [pscustomobject]@{
            Name = [IO.Path]::GetFileName($nodeExecutable); ExecutablePath = $nodeExecutable
            CommandLine = "`"$nodeExecutable`" `"$($childPaths[0])`" --isolation-token $batchToken"
            CreationDate = $preciseCreation.AddSeconds(1); ProcessId = 45108; ParentProcessId = 1
        },
        [pscustomobject]@{
            Name = [IO.Path]::GetFileName($nodeExecutable); ExecutablePath = $nodeExecutable
            CommandLine = "`"$nodeExecutable`" `"$($childPaths[1])`" --isolation-token $batchToken"
            CreationDate = $preciseCreation.AddSeconds(2); ProcessId = 45109; ParentProcessId = 45108
        }
    )
    $script:isolationMockProcesses = @($sentinelProcess) + $batchProcesses
    $script:batchBindCalls = 0
    $script:batchDisposeCalls = 0
    $script:batchKillCalls = 0
    try {
        Invoke-RunnerIsolationRecovery -MarkerDirectory $isolationTestRoot -ProjectRoot $projectRoot -IsolationToken $batchToken `
            -ProcessProvider $processProvider -SnapshotSentinel $snapshotSentinel `
            -HandleBinder {
                param($Identity)
                $script:batchBindCalls += 1
                [pscustomobject]@{
                    ProcessId = $Identity.ProcessId
                    CreationToken = if ($script:batchBindCalls -eq 2) { ([int64]$Identity.CreationToken + 10000).ToString() } else { $Identity.CreationToken }
                    ExecutablePath = $Identity.ExecutablePath
                }
            } -TreeKiller { $script:batchKillCalls += 1; return $true } `
            -HandleTerminator { $script:batchKillCalls += 1; return $true } `
            -HandleDisposer { $script:batchDisposeCalls += 1 } -VerificationDelay { } `
            -NowProvider { $markerCreatedAt + 60000 } | Out-Null
        throw 'Changed native handle identity was accepted.'
    } catch {
        if ($_.Exception.Message -eq 'Changed native handle identity was accepted.') { throw }
    }
    if ($script:batchBindCalls -ne 2 -or $script:batchDisposeCalls -ne 2 -or $script:batchKillCalls -ne 0 -or
        -not [IO.File]::Exists($batchMarker.Path)) {
        throw 'Handle-batch identity failure performed a partial kill or leaked a handle/marker.'
    }

    # A child created after the first snapshot/root termination is not swept by
    # an unsafe PID tree operation. The next healthy snapshot must discover it,
    # bind its own process-object handle, and terminate that exact identity.
    $newbornToken = '0' * 64
    $newbornCreation = ConvertTo-RunnerProcessCreationIdentity $preciseCreation.AddSeconds(1)
    $newbornRootIdentity = [ordered]@{
        pid = 45112; creationToken = [string]$newbornCreation.Token; createdAtMs = [int64]$newbornCreation.AtMs
        executablePath = [IO.Path]::GetFullPath($powershellExecutable)
    }
    $newbornMarker = New-RunnerIsolationTestMarker $newbornToken $markerCreatedAt $newbornRootIdentity
    $newbornRootProcess = [pscustomobject]@{
        Name = [IO.Path]::GetFileName($powershellExecutable); ExecutablePath = $powershellExecutable
        CommandLine = Get-TestRunnerRootCommandLine $newbornMarker $newbornToken
        CreationDate = $preciseCreation.AddSeconds(1); ProcessId = 45112; ParentProcessId = 1
    }
    $newbornChildProcess = [pscustomobject]@{
        Name = [IO.Path]::GetFileName($nodeExecutable); ExecutablePath = $nodeExecutable
        CommandLine = "`"$nodeExecutable`" `"$($childPaths[2])`" --isolation-token $newbornToken"
        CreationDate = $preciseCreation.AddSeconds(2); ProcessId = 45113; ParentProcessId = 45112
    }
    $script:isolationMockProcesses = @($sentinelProcess, $newbornRootProcess)
    $script:newbornTerminationCalls = @()
    Invoke-RunnerIsolationRecovery -MarkerDirectory $isolationTestRoot -ProjectRoot $projectRoot -IsolationToken $newbornToken `
        -ProcessProvider $processProvider -RootProcessProvider $rootProcessProvider -SnapshotSentinel $snapshotSentinel `
        -HandleBinder $handleBinder -TreeKiller { return $false } -HandleTerminator {
            param($BoundCandidate)
            $target = [int]$BoundCandidate.Identity.ProcessId
            $script:newbornTerminationCalls += $target
            $script:isolationMockProcesses = @($script:isolationMockProcesses | Where-Object { [int]$_.ProcessId -ne $target })
            if ($target -eq 45112) { $script:isolationMockProcesses += $newbornChildProcess }
            return $true
        } -HandleDisposer { } -VerificationDelay { } -NowProvider { $markerCreatedAt + 60000 } | Out-Null
    if (($script:newbornTerminationCalls -join ',') -cne '45112,45113' -or [IO.File]::Exists($newbornMarker.Path)) {
        throw 'A post-snapshot child was not independently re-snapshotted, handle-bound, and terminated.'
    }

    # A healthy wide snapshot cannot claim zero while an independent root-PID
    # CIM query still sees the exact bound process.
    $omittedRootToken = '3' * 64
    $omittedCreation = ConvertTo-RunnerProcessCreationIdentity $preciseCreation.AddSeconds(1)
    $omittedRootIdentity = [ordered]@{
        pid = 45110; creationToken = [string]$omittedCreation.Token; createdAtMs = [int64]$omittedCreation.AtMs
        executablePath = [IO.Path]::GetFullPath($powershellExecutable)
    }
    $omittedRootMarker = New-RunnerIsolationTestMarker $omittedRootToken $markerCreatedAt $omittedRootIdentity
    $omittedRootProcess = [pscustomobject]@{
        Name = [IO.Path]::GetFileName($powershellExecutable); ExecutablePath = $powershellExecutable
        CommandLine = Get-TestRunnerRootCommandLine $omittedRootMarker $omittedRootToken
        CreationDate = $preciseCreation.AddSeconds(1); ProcessId = 45110; ParentProcessId = 1
    }
    $script:isolationMockProcesses = @($sentinelProcess)
    try {
        Invoke-RunnerIsolationRecovery -MarkerDirectory $isolationTestRoot -ProjectRoot $projectRoot -IsolationToken $omittedRootToken `
            -ProcessProvider $processProvider -RootProcessProvider { param([int]$TargetProcessId) @($omittedRootProcess) } `
            -SnapshotSentinel $snapshotSentinel -HandleBinder { throw 'must not bind' } -TreeKiller { throw 'must not kill' } `
            -HandleTerminator { throw 'must not terminate' } -HandleDisposer { } -VerificationDelay { } `
            -NowProvider { $markerCreatedAt + 60000 } | Out-Null
        throw 'Wide CIM omission of the bound root was accepted.'
    } catch {
        if ($_.Exception.Message -eq 'Wide CIM omission of the bound root was accepted.') { throw }
    }
    if (-not [IO.File]::Exists($omittedRootMarker.Path)) { throw 'Wide CIM omission removed its marker.' }

    # Confirmation-only performs the same healthy double-zero scan but cannot
    # delete either the marker or the fact-bearing gateway directory.
    $confirmationToken = '9' * 64
    $confirmationMarker = New-RunnerIsolationTestMarker $confirmationToken $markerCreatedAt
    $script:isolationMockProcesses = @($sentinelProcess, $unrelatedProcess)
    $confirmationResult = Invoke-RunnerIsolationRecovery -MarkerDirectory $isolationTestRoot -ProjectRoot $projectRoot `
        -IsolationToken $confirmationToken -ConfirmationOnly -ProcessProvider $processProvider -SnapshotSentinel $snapshotSentinel `
        -HandleBinder { throw 'must not bind' } -TreeKiller { throw 'must not kill' } `
        -HandleTerminator { throw 'must not terminate' } -HandleDisposer { } -VerificationDelay { } `
        -RunDirectoryRemover { throw 'confirmation removed run directory' } `
        -GatewayWorkDirectoryRemover { throw 'confirmation removed gateway directory' } `
        -MarkerRemover { throw 'confirmation removed marker' } -NowProvider { $markerCreatedAt + 60000 }
    if ($confirmationResult.markersRecovered -ne 0 -or -not [IO.File]::Exists($confirmationMarker.Path) -or
        -not [IO.Directory]::Exists($confirmationMarker.GatewayWorkDirectory)) {
        throw 'Confirmation-only recovery consumed protected state.'
    }
    [IO.Directory]::Delete($confirmationMarker.GatewayWorkDirectory, $true)
    [IO.File]::Delete($confirmationMarker.Path)

    $corruptToken = 'b' * 64
    $corruptMarker = Join-Path $isolationTestRoot "$corruptToken.json"
    [IO.File]::WriteAllText($corruptMarker, '{"schemaVersion":"2.0","token":"broken"}', [Text.UTF8Encoding]::new($false))
    try {
        Invoke-RunnerIsolationRecovery -MarkerDirectory $isolationTestRoot -ProjectRoot $projectRoot -IsolationToken $corruptToken `
            -ProcessProvider $processProvider -SnapshotSentinel $snapshotSentinel -HandleBinder { throw 'must not bind' } `
            -TreeKiller { } -HandleTerminator { } -HandleDisposer { } `
            -VerificationDelay { } -NowProvider { $markerCreatedAt + 60000 } | Out-Null
        throw 'Corrupt isolation marker was accepted.'
    } catch {
        if ($_.Exception.Message -eq 'Corrupt isolation marker was accepted.') { throw }
    }
    if (-not [IO.File]::Exists($corruptMarker)) { throw 'Corrupt isolation marker was removed instead of failing closed.' }

    $identityToken = 'c' * 64
    $identityMarker = New-RunnerIsolationTestMarker $identityToken $markerCreatedAt
    $badIdentityProcess = [pscustomobject]@{
        Name = 'powershell.exe'
        ExecutablePath = 'powershell.exe'
        CommandLine = Get-TestRunnerRootCommandLine $identityMarker $identityToken
        CreationDate = $preciseCreation.AddSeconds(1)
        ProcessId = 45104
        ParentProcessId = 1
    }
    $script:isolationMockProcesses = @($sentinelProcess, $badIdentityProcess)
    try {
        Invoke-RunnerIsolationRecovery -MarkerDirectory $isolationTestRoot -ProjectRoot $projectRoot -IsolationToken $identityToken `
            -ProcessProvider $processProvider -SnapshotSentinel $snapshotSentinel -HandleBinder { throw 'must not bind' } `
            -TreeKiller { throw 'must not kill' } -HandleTerminator { throw 'must not terminate' } -HandleDisposer { } `
            -VerificationDelay { } -NowProvider { $markerCreatedAt + 60000 } | Out-Null
        throw 'Indeterminate executable/creation identity was accepted.'
    } catch {
        if ($_.Exception.Message -eq 'Indeterminate executable/creation identity was accepted.') { throw }
    }
    if (-not [IO.File]::Exists($identityMarker.Path)) { throw 'Indeterminate process identity did not retain its marker.' }

    # A token-bearing process in the marker window with the wrong fixed script
    # is indeterminate, not an ignorable unrelated process.
    $wrongScriptToken = 'e' * 64
    $wrongScriptMarker = New-RunnerIsolationTestMarker $wrongScriptToken $markerCreatedAt
    $wrongScriptProcess = [pscustomobject]@{
        Name = [IO.Path]::GetFileName($nodeExecutable)
        ExecutablePath = $nodeExecutable
        CommandLine = "`"$nodeExecutable`" `"C:\Other\unknown.js`" --isolation-token $wrongScriptToken"
        CreationDate = $preciseCreation.AddSeconds(1)
        ProcessId = 45105
        ParentProcessId = 1
    }
    $script:isolationMockProcesses = @($sentinelProcess, $wrongScriptProcess)
    try {
        Invoke-RunnerIsolationRecovery -MarkerDirectory $isolationTestRoot -ProjectRoot $projectRoot -IsolationToken $wrongScriptToken `
            -ProcessProvider $processProvider -SnapshotSentinel $snapshotSentinel -HandleBinder { throw 'must not bind' } `
            -TreeKiller { throw 'must not kill' } -HandleTerminator { throw 'must not terminate' } -HandleDisposer { } `
            -VerificationDelay { } -NowProvider { $markerCreatedAt + 60000 } | Out-Null
        throw 'Token-bearing wrong-script process was treated as absent.'
    } catch {
        if ($_.Exception.Message -eq 'Token-bearing wrong-script process was treated as absent.') { throw }
    }
    if (-not [IO.File]::Exists($wrongScriptMarker.Path)) { throw 'Wrong-script uncertainty did not retain its marker.' }

    # Merely mentioning a fixed child path and token is not executable identity:
    # the child must be argv[1] and the token must be the unique flag value.
    $incidentalToken = '2' * 64
    $incidentalMarker = New-RunnerIsolationTestMarker $incidentalToken $markerCreatedAt
    $incidentalProcess = [pscustomobject]@{
        Name = [IO.Path]::GetFileName($nodeExecutable)
        ExecutablePath = $nodeExecutable
        CommandLine = "`"$nodeExecutable`" `"C:\Other\evil.js`" --input `"$($childPaths[0])`" --note $incidentalToken"
        CreationDate = $preciseCreation.AddSeconds(1)
        ProcessId = 45111
        ParentProcessId = 1
    }
    $script:isolationMockProcesses = @($sentinelProcess, $incidentalProcess)
    $script:incidentalKillCalls = 0
    try {
        Invoke-RunnerIsolationRecovery -MarkerDirectory $isolationTestRoot -ProjectRoot $projectRoot -IsolationToken $incidentalToken `
            -ProcessProvider $processProvider -SnapshotSentinel $snapshotSentinel -HandleBinder { $script:incidentalKillCalls += 1 } `
            -TreeKiller { $script:incidentalKillCalls += 1 } -HandleTerminator { $script:incidentalKillCalls += 1 } `
            -HandleDisposer { } -VerificationDelay { } -NowProvider { $markerCreatedAt + 60000 } | Out-Null
        throw 'Incidental token/script arguments were accepted as executable identity.'
    } catch {
        if ($_.Exception.Message -eq 'Incidental token/script arguments were accepted as executable identity.') { throw }
    }
    if ($script:incidentalKillCalls -ne 0 -or -not [IO.File]::Exists($incidentalMarker.Path)) {
        throw 'Incidental token/script arguments caused a process kill or marker cleanup.'
    }

    # Empty/unhealthy snapshots fail closed even when the caller supplied the
    # expected sentinel identity out-of-band.
    $emptySnapshotToken = 'f' * 64
    $emptySnapshotMarker = New-RunnerIsolationTestMarker $emptySnapshotToken $markerCreatedAt
    try {
        Invoke-RunnerIsolationRecovery -MarkerDirectory $isolationTestRoot -ProjectRoot $projectRoot -IsolationToken $emptySnapshotToken `
            -ProcessProvider { @() } -SnapshotSentinel $snapshotSentinel -HandleBinder { throw 'must not bind' } `
            -TreeKiller { throw 'must not kill' } -HandleTerminator { throw 'must not terminate' } -HandleDisposer { } `
            -VerificationDelay { } -NowProvider { $markerCreatedAt + 60000 } | Out-Null
        throw 'Empty CIM snapshot was accepted.'
    } catch {
        if ($_.Exception.Message -eq 'Empty CIM snapshot was accepted.') { throw }
    }
    if (-not [IO.File]::Exists($emptySnapshotMarker.Path)) { throw 'Empty snapshot removed its marker.' }

    # Bound root PID reuse is never trusted: a changed creation identity is not
    # passed to any handle terminator, and the surviving token keeps the marker.
    $reuseToken = '7' * 64
    $originalIdentity = ConvertTo-RunnerProcessCreationIdentity $preciseCreation.AddSeconds(1)
    $reuseRoot = [ordered]@{
        pid = 45106
        creationToken = [string]$originalIdentity.Token
        createdAtMs = [int64]$originalIdentity.AtMs
        executablePath = [IO.Path]::GetFullPath($powershellExecutable)
    }
    $reuseMarker = New-RunnerIsolationTestMarker $reuseToken $markerCreatedAt $reuseRoot
    $reusedPidProcess = [pscustomobject]@{
        Name = [IO.Path]::GetFileName($powershellExecutable)
        ExecutablePath = $powershellExecutable
        CommandLine = Get-TestRunnerRootCommandLine $reuseMarker $reuseToken
        CreationDate = $preciseCreation.AddSeconds(2)
        ProcessId = 45106
        ParentProcessId = 1
    }
    $script:isolationMockProcesses = @($sentinelProcess, $reusedPidProcess)
    $script:reuseKillCalls = 0
    try {
        Invoke-RunnerIsolationRecovery -MarkerDirectory $isolationTestRoot -ProjectRoot $projectRoot -IsolationToken $reuseToken `
            -ProcessProvider $processProvider -RootProcessProvider $rootProcessProvider -SnapshotSentinel $snapshotSentinel `
            -HandleBinder { $script:reuseKillCalls += 1 } -TreeKiller { $script:reuseKillCalls += 1 } `
            -HandleTerminator { $script:reuseKillCalls += 1 } -HandleDisposer { } `
            -VerificationDelay { } -NowProvider { $markerCreatedAt + 60000 } | Out-Null
        throw 'Reused bound PID was accepted as safely recovered.'
    } catch {
        if ($_.Exception.Message -eq 'Reused bound PID was accepted as safely recovered.') { throw }
    }
    if ($script:reuseKillCalls -ne 0 -or -not [IO.File]::Exists($reuseMarker.Path)) {
        throw 'Reused bound PID was killed or its marker was cleared.'
    }

    # Cleanup errors are injected (never real process kills) and must leave the
    # JSON marker visible to the next service generation.
    $cleanupToken = '6' * 64
    $cleanupMarker = New-RunnerIsolationTestMarker $cleanupToken $markerCreatedAt
    $script:isolationMockProcesses = @($sentinelProcess, $unrelatedProcess)
    try {
        Invoke-RunnerIsolationRecovery -MarkerDirectory $isolationTestRoot -ProjectRoot $projectRoot -IsolationToken $cleanupToken `
            -ProcessProvider $processProvider -SnapshotSentinel $snapshotSentinel -HandleBinder { throw 'must not bind' } `
            -TreeKiller { throw 'must not kill' } -HandleTerminator { throw 'must not terminate' } -HandleDisposer { } `
            -VerificationDelay { } -RunDirectoryRemover { return 0 } `
            -GatewayWorkDirectoryRemover { throw 'injected gateway cleanup failure' } `
            -MarkerRemover { throw 'marker remover must not run' } -NowProvider { $markerCreatedAt + 60000 } | Out-Null
        throw 'Gateway cleanup failure was accepted.'
    } catch {
        if ($_.Exception.Message -eq 'Gateway cleanup failure was accepted.') { throw }
    }
    if (-not [IO.File]::Exists($cleanupMarker.Path) -or -not [IO.Directory]::Exists($cleanupMarker.GatewayWorkDirectory)) {
        throw 'Gateway cleanup failure did not retain both marker and work directory.'
    }

    try {
        Remove-RunnerIsolationMarkerAtomically $cleanupMarker.Path $cleanupToken { throw 'injected marker delete failure' }
        throw 'Marker delete failure was accepted.'
    } catch {
        if ($_.Exception.Message -eq 'Marker delete failure was accepted.') { throw }
    }
    if (-not [IO.File]::Exists($cleanupMarker.Path)) { throw 'Marker delete failure hid the marker from the next scan.' }

    $futureToken = 'd' * 64
    $futureMarker = New-RunnerIsolationTestMarker $futureToken ($markerCreatedAt + 6001)
    $script:isolationMockProcesses = @($sentinelProcess)
    try {
        Invoke-RunnerIsolationRecovery -MarkerDirectory $isolationTestRoot -ProjectRoot $projectRoot -IsolationToken $futureToken `
            -ProcessProvider $processProvider -SnapshotSentinel $snapshotSentinel -HandleBinder { } -TreeKiller { } `
            -HandleTerminator { } -HandleDisposer { } `
            -VerificationDelay { } -NowProvider { $markerCreatedAt } | Out-Null
        throw 'Future isolation marker was accepted.'
    } catch {
        if ($_.Exception.Message -eq 'Future isolation marker was accepted.') { throw }
    }
    if (-not [IO.File]::Exists($futureMarker.Path)) { throw 'Future isolation marker did not fail closed.' }
} finally {
    Remove-Item Function:\New-RunnerIsolationTestMarker -Force -ErrorAction SilentlyContinue
    Remove-Item Function:\Get-TestRunnerRootCommandLine -Force -ErrorAction SilentlyContinue
    foreach ($gatewayWork in @($script:testGatewayWorkDirectories)) {
        if ([IO.Directory]::Exists($gatewayWork)) { [IO.Directory]::Delete($gatewayWork, $true) }
    }
    if ([IO.Directory]::Exists($isolationTestRoot)) { [IO.Directory]::Delete($isolationTestRoot, $true) }
}

Import-ScriptFunction $installerPath 'Test-FullyQualifiedWindowsPath'
Import-ScriptFunction $installerPath 'ConvertTo-ProcessCreationStamp'
Import-ScriptFunction $installerPath 'Test-ProductPathSuffix'
Import-ScriptFunction $installerPath 'Test-CanonicalProcessArgumentPath'
Import-ScriptFunction $installerPath 'ConvertTo-VerifiedProductDescendantIdentity'
Import-ScriptFunction $installerPath 'Add-VerifiedProductDescendantHandles'
$script:productServerSuffix = '\shared\wecom\server.js'
$treeRootIdentity = [pscustomobject]@{ ProcessId = 51000; CreationAt = [DateTimeOffset]$preciseCreation }
$codexExecutable = 'C:\Codex\bin\codex.exe'
$codexVerifier = 'a' * 64
$codexChild = [pscustomobject]@{
    ProcessId = 51001; ParentProcessId = 51000; Name = 'codex.exe'; ExecutablePath = $codexExecutable
    CommandLine = "`"$codexExecutable`" app-server --listen ws://127.0.0.1:4321 --ws-auth capability-token --ws-token-sha256 $codexVerifier"
    CreationDate = $preciseCreation.AddSeconds(1)
}
$codexGrandchild = [pscustomobject]@{
    ProcessId = 51002; ParentProcessId = 51001; Name = 'codex.exe'; ExecutablePath = $codexExecutable
    CommandLine = "`"$codexExecutable`" app-server --listen ws://127.0.0.1:4322 --ws-auth capability-token --ws-token-sha256 $codexVerifier"
    CreationDate = $preciseCreation.AddSeconds(2)
}
if ($null -eq (ConvertTo-VerifiedProductDescendantIdentity $codexChild $treeRootIdentity)) {
    throw 'A strict Codex App Server descendant was not recognized.'
}
$script:productTreeHandleOpens = 0
$script:productTreeHandleDisposals = 0
function script:Open-XbbVerifiedProcessHandle {
    param($Identity)
    $script:productTreeHandleOpens += 1
    $handle = [pscustomobject]@{ ProcessId = [int]$Identity.ProcessId; CreationToken = [string]$Identity.CreationToken; ExecutablePath = [string]$Identity.ExecutablePath }
    $handle | Add-Member -MemberType ScriptMethod -Name Dispose -Value { $script:productTreeHandleDisposals += 1 }
    return $handle
}
try {
    $rootBinding = [pscustomobject]@{ Identity = $treeRootIdentity; Handle = [pscustomobject]@{} }
    $bindings = [Collections.Generic.List[object]]::new(); $bindings.Add($rootBinding) | Out-Null
    $known = @{ 51000 = $rootBinding }
    $added = Add-VerifiedProductDescendantHandles @($codexChild, $codexGrandchild) $bindings $known
    if ($added -ne 2 -or $bindings.Count -ne 3 -or $script:productTreeHandleOpens -ne 2) {
        throw 'Product descendants were not all handle-bound before termination.'
    }
    foreach ($binding in @($bindings | Where-Object { $_ -ne $rootBinding })) { $binding.Handle.Dispose() }

    $staleParentChild = [pscustomobject]@{
        ProcessId = 51003; ParentProcessId = 51000; Name = 'codex.exe'; ExecutablePath = $codexExecutable
        CommandLine = $codexChild.CommandLine; CreationDate = $preciseCreation.AddTicks(-1)
    }
    try {
        [void](ConvertTo-VerifiedProductDescendantIdentity $staleParentChild $treeRootIdentity)
        throw 'A stale-parent PID relation with older creation identity was accepted.'
    } catch {
        if ($_.Exception.Message -eq 'A stale-parent PID relation with older creation identity was accepted.') { throw }
    }
    $unknownChild = [pscustomobject]@{
        ProcessId = 51004; ParentProcessId = 51000; Name = 'cmd.exe'; ExecutablePath = 'C:\Windows\System32\cmd.exe'
        CommandLine = '"C:\Windows\System32\cmd.exe" /c exit'; CreationDate = $preciseCreation.AddSeconds(1)
    }
    try {
        [void](ConvertTo-VerifiedProductDescendantIdentity $unknownChild $treeRootIdentity)
        throw 'An unknown descendant was accepted for parent-chain-only termination.'
    } catch {
        if ($_.Exception.Message -eq 'An unknown descendant was accepted for parent-chain-only termination.') { throw }
    }
} finally {
    Remove-Item Function:\Open-XbbVerifiedProcessHandle -Force -ErrorAction SilentlyContinue
    . $processHandlePath
}

Import-ScriptFunction $installerPath 'Get-DisabledTaskXml'
Import-ScriptFunction $installerPath 'Test-ProductPathSuffix'
Import-ScriptFunction $installerPath 'Get-ProductArgumentsMetadata'
Import-ScriptFunction $installerPath 'Get-VerifiedExecTaskActionFields'
Import-ScriptFunction $installerPath 'Get-ProductTaskActionMetadata'
Import-ScriptFunction $installerPath 'Assert-OwnedTask'
Import-ScriptFunction $installerPath 'Get-ProductTaskActionState'
Import-ScriptFunction $installerPath 'Assert-NoOtherProductTasks'
Import-ScriptFunction $installerPath 'Get-RunnerIsolationMarkerDirectories'
Import-ScriptFunction $installerPath 'Assert-RunnerIsolationRecoveryResult'
Import-ScriptFunction $installerPath 'Invoke-RunnerIsolationRecoveryForLeasePaths'
$legacyRuntimeLease = 'C:\Legacy Runtime\service-lease.json'
$newRuntimeLease = 'D:\New Runtime\service-lease.json'
$script:recoveredMarkerDirectories = @()
$recoveryMigrationResult = Invoke-RunnerIsolationRecoveryForLeasePaths `
    -LeasePaths @($legacyRuntimeLease, $newRuntimeLease, 'd:\NEW RUNTIME\service-lease.json') `
    -RecoveryInvoker {
        param([string]$MarkerDirectory)
        $script:recoveredMarkerDirectories += $MarkerDirectory
        return [pscustomobject]@{ success = $true; markersRecovered = 1; processesTerminated = 2; runDirectoriesRemoved = 3 }
    }
if ($script:recoveredMarkerDirectories.Count -ne 2 -or
    -not $script:recoveredMarkerDirectories[0].Equals('C:\Legacy Runtime\runner-isolation', [StringComparison]::OrdinalIgnoreCase) -or
    -not $script:recoveredMarkerDirectories[1].Equals('D:\New Runtime\runner-isolation', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Config/lease migration did not recover the deduplicated old and new runner marker directories.'
}
if ($recoveryMigrationResult.MarkersRecovered -ne 2 -or $recoveryMigrationResult.ProcessesTerminated -ne 4 -or
    $recoveryMigrationResult.RunDirectoriesRemoved -ne 6) {
    throw 'Runner isolation migration recovery did not aggregate verified results.'
}
try {
    Invoke-RunnerIsolationRecoveryForLeasePaths -LeasePaths @($newRuntimeLease) -RecoveryInvoker {
        [pscustomobject]@{ success = $false; markersRecovered = 0; processesTerminated = 0; runDirectoriesRemoved = 0 }
    } | Out-Null
    throw 'An uncertain runner isolation recovery result was accepted.'
} catch {
    if ($_.Exception.Message -eq 'An uncertain runner isolation recovery result was accepted.') { throw }
}
$sampleTaskXml = '<?xml version="1.0" encoding="UTF-16"?><Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Settings><Enabled>true</Enabled></Settings></Task>'
[xml]$disabledTaskXml = Get-DisabledTaskXml $sampleTaskXml 'test-task'
if ($disabledTaskXml.Task.Settings.Enabled -ne 'false') { throw 'Rollback XML was not forced into the disabled state.' }
$script:TaskName = 'Test-XBB-Bot'
$script:hiddenNodePath = $testExecutable
$script:server = $testServer
$script:mainTaskDescription = 'owned-main-task'
$script:defaultConfigPath = 'C:\Default\bot-config.json'
$legacyOwnedTask = [pscustomobject]@{
    Actions = @([pscustomobject]@{ ActionType = 0; Execute = $testExecutable; Arguments = "`"$testServer`"" })
    Description = $script:mainTaskDescription
}
$legacyMetadata = Assert-OwnedTask $legacyOwnedTask $script:TaskName
if ([string]$legacyMetadata.ConfigPath -ne $script:defaultConfigPath) {
    throw 'Installer ownership no longer accepts the legacy live action with the default config path.'
}
$alternateOwnedTask = [pscustomobject]@{
    Actions = @([pscustomobject]@{ ActionType = 0; Execute = $testExecutable; Arguments = $alternateArguments })
    Description = $script:mainTaskDescription
}
$alternateMetadata = Assert-OwnedTask $alternateOwnedTask $script:TaskName
if ([string]$alternateMetadata.ConfigPath -ne 'D:\Runtime\alternate.json') {
    throw 'Installer ownership does not accept an arbitrary absolute managed-config action.'
}
$historicalStartScript = 'D:\Old Workspace\xbb-executive-analyst\scripts\start-wecom-bot.ps1'
$historicalOwnedTask = [pscustomobject]@{
    Actions = @([pscustomobject]@{
        ActionType = 0
        Execute = 'powershell.exe'
        Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$historicalStartScript`""
    })
    Description = $script:mainTaskDescription
}
$historicalMetadata = Assert-OwnedTask $historicalOwnedTask $script:TaskName
if ([string]$historicalMetadata.ProductServerPath -ne 'D:\Old Workspace\xbb-executive-analyst\shared\wecom\server.js' -or
    -not [string]::IsNullOrWhiteSpace([string]$historicalMetadata.ProductArguments)) {
    throw 'A historical PowerShell product action from another workspace was not safely recognized.'
}
$script:newMainMetadata = [pscustomobject]@{ Executable = $testExecutable; Arguments = $testArguments; ProductExecutable = $testExecutable; ProductArguments = $testArguments; ProductServerPath = $testServer }
$script:productServerArgumentPrefix = "`"$testServer`""
$script:productArgumentPattern = '^(?:"(?<serverPath>[^\r\n"]+)"|(?<plainServerPath>\S+))(?: --managed-config "(?<configPath>[^\r\n"]+)")?$'
$script:productServerSuffix = '\shared\wecom\server.js'
$script:productStartScriptSuffix = '\scripts\start-wecom-bot.ps1'
$script:productWatchdogScriptSuffix = '\scripts\watchdog-wecom-task.ps1'
$script:productWatchdogLauncherSuffix = '\scripts\launch-wecom-watchdog.js'
$script:powerShellPath = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$script:watchdogScript = 'C:\Codex\xbb-executive-analyst\scripts\watchdog-wecom-task.ps1'
$script:taskPath = '\'
$script:watchdogTaskName = "$($script:TaskName)-Watchdog"
$script:productWatchdogPrefix = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$($script:watchdogScript)`" -TaskName `""
$script:productWatchdogArgumentPattern = '^' + [regex]::Escape($script:productWatchdogPrefix) + '(?<taskName>[A-Za-z0-9][A-Za-z0-9._-]{0,127})' +
    [regex]::Escape('" -LeasePath "') + '(?<leasePath>[^\r\n"]+)' + [regex]::Escape('" -StaleSeconds 180') + '$'
$script:productWatchdogFilePattern = '(?:^|\s)-File\s+"' + [regex]::Escape($script:watchdogScript) + '"(?:\s|$)'
$script:scheduledTaskCandidates = @([pscustomobject]@{
    TaskName = 'Other-XBB-Bot'
    TaskPath = '\'
    Actions = @([pscustomobject]@{ ActionType = 0; Execute = $testExecutable; Arguments = $alternateArguments })
})
function script:Get-VerifiedProductTaskSnapshot { return @($script:scheduledTaskCandidates) }
try {
    try {
        Assert-NoOtherProductTasks
        throw 'A sequential install under another TaskName was accepted.'
    } catch {
        if ($_.Exception.Message -eq 'A sequential install under another TaskName was accepted.') { throw }
    }
    $otherWatchdogArguments = $script:productWatchdogPrefix + 'Other-XBB-Bot" -LeasePath "\\server\share\service-lease.json" -StaleSeconds 180'
    $script:scheduledTaskCandidates = @([pscustomobject]@{
        TaskName = 'Other-XBB-Bot-Watchdog'
        TaskPath = '\'
        Actions = @([pscustomobject]@{ ActionType = 0; Execute = $script:powerShellPath; Arguments = $otherWatchdogArguments })
    })
    try {
        Assert-NoOtherProductTasks
        throw 'A sequential watchdog install under another TaskName was accepted.'
    } catch {
        if ($_.Exception.Message -eq 'A sequential watchdog install under another TaskName was accepted.') { throw }
    }
    $script:scheduledTaskCandidates = @([pscustomobject]@{
        TaskName = 'Old-XBB-Bot-Watchdog'
        TaskPath = '\'
        Actions = @([pscustomobject]@{
            ActionType = 0
            Execute = $script:powerShellPath
            Arguments = "-NoProfile -File `"$($script:watchdogScript)`" -LeasePath `"\\server\share\service-lease.json`" -TaskName `"Old-XBB-Bot`""
        })
    })
    try {
        Assert-NoOtherProductTasks
        throw 'A nonstandard watchdog action pointing at this project was accepted.'
    } catch {
        if ($_.Exception.Message -eq 'A nonstandard watchdog action pointing at this project was accepted.') { throw }
    }
    $ownedWatchdogArguments = $script:productWatchdogPrefix + $script:TaskName + '" -LeasePath "\\server\share\service-lease.json" -StaleSeconds 180'
    $script:scheduledTaskCandidates = @(
        [pscustomobject]@{
            TaskName = $script:TaskName
            TaskPath = '\'
            Actions = @([pscustomobject]@{ ActionType = 0; Execute = $testExecutable; Arguments = $testArguments })
        },
        [pscustomobject]@{
            TaskName = $script:watchdogTaskName
            TaskPath = '\'
            Actions = @([pscustomobject]@{ ActionType = 0; Execute = $script:powerShellPath; Arguments = $ownedWatchdogArguments })
        }
    )
    Assert-NoOtherProductTasks
} finally {
    Remove-Item Function:\Get-VerifiedProductTaskSnapshot -Force -ErrorAction SilentlyContinue
}

# Uninstall may never guess a sibling/default lease for an historical task when
# its managed config is absent, corrupt, or cannot be cross-checked.
Import-ScriptFunction $uninstallerPath 'Resolve-LeasePath'
$leaseEvidenceRoot = Join-Path ([IO.Path]::GetTempPath()) "xbb-uninstall-evidence-$PID-$([Guid]::NewGuid().ToString('N'))"
[IO.Directory]::CreateDirectory($leaseEvidenceRoot) | Out-Null
$leaseEvidenceConfig = Join-Path $leaseEvidenceRoot 'bot-config.json'
$leaseEvidencePath = Join-Path $leaseEvidenceRoot 'custom-service-lease.json'
try {
    try { [void](Resolve-LeasePath (Join-Path $leaseEvidenceRoot 'missing.json')); throw 'Missing managed config was replaced by a guessed uninstall lease.' } catch {
        if ($_.Exception.Message -eq 'Missing managed config was replaced by a guessed uninstall lease.') { throw }
    }
    Set-Content -LiteralPath $leaseEvidenceConfig -Value '{broken' -Encoding UTF8
    try { [void](Resolve-LeasePath $leaseEvidenceConfig); throw 'Corrupt managed config was replaced by a guessed uninstall lease.' } catch {
        if ($_.Exception.Message -eq 'Corrupt managed config was replaced by a guessed uninstall lease.') { throw }
    }
    [ordered]@{ schemaVersion = '4.0'; wecomBotId = 'lease_bot'; wecomWsUrl = 'wss://openws.work.weixin.qq.com'; modelProvider = 'codex-app-server' } |
        ConvertTo-Json | Set-Content -LiteralPath $leaseEvidenceConfig -Encoding UTF8
    try { [void](Resolve-LeasePath $leaseEvidenceConfig); throw 'A config without explicit lease or paired watchdog evidence was accepted.' } catch {
        if ($_.Exception.Message -eq 'A config without explicit lease or paired watchdog evidence was accepted.') { throw }
    }
    if (-not (Resolve-LeasePath $leaseEvidenceConfig $leaseEvidencePath).Equals($leaseEvidencePath, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'An exact paired-watchdog lease was not accepted as controlled uninstall evidence.'
    }
} finally {
    Remove-Item -LiteralPath $leaseEvidenceRoot -Recurse -Force -ErrorAction SilentlyContinue
}

# Every destructive task mutation re-reads ownership.  A replacement arriving
# after the first read must prevent the underlying ScheduledTasks command.
Import-ScriptFunction $uninstallerPath 'Get-VerifiedOwnedTask'
Import-ScriptFunction $uninstallerPath 'Disable-VerifiedOwnedTask'
Import-ScriptFunction $uninstallerPath 'Remove-ExactTask'
$expectedUninstallMetadata = [pscustomobject]@{
    Arguments = $testArguments; Description = 'owned-main-task'; Kind = 'main'; TargetTaskName = ''
    Executable = $testExecutable; ProductExecutable = $testExecutable; ProductServerPath = $testServer
    ConfigPath = 'C:\Codex\bot-config.json'; LeasePath = ''; ScriptPath = ''
}
$script:uninstallMutationCalls = 0
function script:Get-ExactTask { param([string]$Name); return [pscustomobject]@{ Settings = [pscustomobject]@{ Enabled = $true }; State = 'Ready' } }
function script:Get-OwnedTaskMetadata { param($Task, [string]$Name); return $script:replacementUninstallMetadata }
function script:Disable-ScheduledTask { [CmdletBinding()]param([string]$TaskName, [string]$TaskPath); $script:uninstallMutationCalls += 1 }
try {
    $replacementVariants = @(
        [pscustomobject]@{ Label = 'root'; Expected = $expectedUninstallMetadata; Actual = [pscustomobject]@{
            Arguments = $alternateArguments; Description = 'owned-main-task'; Kind = 'main'; TargetTaskName = ''
            Executable = $testExecutable; ProductExecutable = $testExecutable; ProductServerPath = 'D:\Old Workspace\xbb-executive-analyst\shared\wecom\server.js'
            ConfigPath = 'D:\Runtime\alternate.json'; LeasePath = ''; ScriptPath = ''
        } },
        [pscustomobject]@{ Label = 'config'; Expected = $expectedUninstallMetadata; Actual = [pscustomobject]@{
            Arguments = "`"$testServer`" --managed-config `"D:\Runtime\alternate.json`""; Description = 'owned-main-task'; Kind = 'main'; TargetTaskName = ''
            Executable = $testExecutable; ProductExecutable = $testExecutable; ProductServerPath = $testServer
            ConfigPath = 'D:\Runtime\alternate.json'; LeasePath = ''; ScriptPath = ''
        } },
        [pscustomobject]@{ Label = 'lease-target'; Expected = [pscustomobject]@{
            Arguments = 'watchdog-original'; Description = 'owned-watchdog-task'; Kind = 'watchdog'; TargetTaskName = 'Evidence-Test-Bot'
            Executable = $script:powerShellPath; ProductExecutable = ''; ProductServerPath = ''; ConfigPath = ''
            LeasePath = 'C:\Runtime\service-lease.json'; ScriptPath = $watchdogPath
        }; Actual = [pscustomobject]@{
            Arguments = 'watchdog-replacement'; Description = 'owned-watchdog-task'; Kind = 'watchdog'; TargetTaskName = 'Other-Bot'
            Executable = $script:powerShellPath; ProductExecutable = ''; ProductServerPath = ''; ConfigPath = ''
            LeasePath = 'D:\Other\service-lease.json'; ScriptPath = $watchdogPath
        } }
    )
    foreach ($variant in $replacementVariants) {
        $script:replacementUninstallMetadata = $variant.Actual
        $variantTaskName = if ([string]$variant.Expected.Kind -eq 'watchdog') { 'Evidence-Test-Bot-Watchdog' } else { 'Evidence-Test-Bot' }
        try { [void](Remove-ExactTask $variantTaskName $variant.Expected); throw "A same-name/same-Description $($variant.Label) replacement reached task mutation." } catch {
            if ($_.Exception.Message -eq "A same-name/same-Description $($variant.Label) replacement reached task mutation.") { throw }
        }
    }
    if ($script:uninstallMutationCalls -ne 0) { throw 'Task ownership was not revalidated immediately before uninstall mutation.' }

    Import-ScriptFunction $installerPath 'Assert-TaskMetadataMatchesExpected'
    Import-ScriptFunction $installerPath 'Get-VerifiedOwnedTask'
    Import-ScriptFunction $installerPath 'Remove-ExistingTaskForUpgrade'
    function script:Assert-OwnedTask { param($Task, [string]$Name); return $script:replacementUninstallMetadata }
    $script:replacementUninstallMetadata = $replacementVariants[0].Actual
    try { Remove-ExistingTaskForUpgrade 'Evidence-Test-Bot' @($expectedUninstallMetadata); throw 'Installer cleanup accepted a replacement outside backup/new immutable generations.' } catch {
        if ($_.Exception.Message -eq 'Installer cleanup accepted a replacement outside backup/new immutable generations.') { throw }
    }
    if ($script:uninstallMutationCalls -ne 0) { throw 'Installer rollback cleanup mutated a task outside its immutable allowed generations.' }
} finally {
    Remove-Item Function:\Get-ExactTask -Force -ErrorAction SilentlyContinue
    Remove-Item Function:\Get-OwnedTaskMetadata -Force -ErrorAction SilentlyContinue
    Remove-Item Function:\Disable-ScheduledTask -Force -ErrorAction SilentlyContinue
    Remove-Item Function:\Assert-OwnedTask -Force -ErrorAction SilentlyContinue
}

# Final isolation cleanup performs two complete recovery/empty rounds, so a
# marker born in the post-unregister race window is consumed by the second one.
Import-ScriptFunction $uninstallerPath 'Get-RunnerIsolationMarkerDirectories'
Import-ScriptFunction $uninstallerPath 'Assert-RunnerIsolationRecoveryResult'
Import-ScriptFunction $uninstallerPath 'Invoke-RunnerIsolationRecoveryForLeasePaths'
Import-ScriptFunction $uninstallerPath 'Confirm-RunnerIsolationRecoveryForLeasePaths'
$finalRecoveryRoot = Join-Path ([IO.Path]::GetTempPath()) "xbb-final-recovery-$PID-$([Guid]::NewGuid().ToString('N'))"
$finalRecoveryMarkerDirectory = Join-Path $finalRecoveryRoot 'runner-isolation'
[IO.Directory]::CreateDirectory($finalRecoveryMarkerDirectory) | Out-Null
$script:finalRecoveryCalls = 0
$script:finalRecoveryMarkerDirectory = $finalRecoveryMarkerDirectory
function script:Start-Sleep { [CmdletBinding()]param([int]$Milliseconds); Set-Content -LiteralPath (Join-Path $script:finalRecoveryMarkerDirectory 'late.json') -Value '{}' -Encoding UTF8 }
try {
    [void](Confirm-RunnerIsolationRecoveryForLeasePaths @(Join-Path $finalRecoveryRoot 'service-lease.json') {
        param([string]$MarkerDirectory)
        $script:finalRecoveryCalls += 1
        if ($script:finalRecoveryCalls -eq 2) { Get-ChildItem -LiteralPath $MarkerDirectory -Filter '*.json' -File | Remove-Item -Force }
        [pscustomobject]@{ success = $true; markersRecovered = 0; processesTerminated = 0; runDirectoriesRemoved = 0 }
    })
    if ($script:finalRecoveryCalls -ne 2) { throw 'Final uninstall recovery did not perform two independent rounds.' }
} finally {
    Remove-Item Function:\Start-Sleep -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $finalRecoveryRoot -Recurse -Force -ErrorAction SilentlyContinue
}

if ($installer -notmatch [regex]::Escape('scripts\install-hidden-node.ps1')) { throw 'The scheduled task does not use the bundled hidden Node installer.' }
if ([regex]::Matches($installer, 'New-ScheduledTaskAction\s+-Execute\s+\$hiddenNodePath').Count -ne 2) { throw 'Main and watchdog tasks do not both launch the hidden Node executable directly.' }
if ($installer -match 'New-ScheduledTaskAction\s+-Execute\s+\$powerShellPath') { throw 'The external watchdog still launches a console-subsystem PowerShell directly.' }
if ($installer -match 'New-ScheduledTaskAction[^\r\n]+wscript\.exe') { throw 'The scheduled task still launches an obsolete wrapper host.' }
if ($launcher -notmatch '\$subsystemOffset = \$optionalHeaderOffset \+ 68') { throw 'The hidden Node installer does not address the PE subsystem field.' }
if ($launcher -notmatch '\$writer\.Write\(\[uint16\]2\)') { throw 'The hidden Node installer does not set the Windows GUI subsystem.' }
if ($launcher -notmatch 'Get-PeSubsystem \$temporary') { throw 'The hidden Node installer does not verify the patched executable.' }
if ($watchdogLauncher -notmatch 'windowsHide:\s*true' -or $watchdogLauncher -notmatch 'shell:\s*false' -or
    $watchdogLauncher -notmatch 'detached:\s*false' -or $watchdogLauncher -notmatch 'stdio:\s*\["ignore",\s*"pipe",\s*"pipe"\]') {
    throw 'The watchdog launcher does not suppress the child console with a direct, non-shell Windows spawn.'
}
if ($installer -notmatch 'watchdog-wecom-task\.ps1') { throw 'The scheduled task installer does not register the external lease watchdog.' }
if ($watchdog -notmatch 'Stop-ScheduledTask' -or $watchdog -notmatch 'Start-ScheduledTask') { throw 'The external watchdog cannot restart the main task.' }
if ($runnerRecovery -match 'taskkill\.exe' -or $runnerRecovery -match 'Stop-Process\s+-Id' -or
    $runnerRecovery -notmatch 'Open-XbbVerifiedProcessHandle' -or $runnerRecovery -notmatch 'TerminateAndWait') {
    throw 'Runner isolation recovery can terminate a PID/tree without a verified native process-object handle.'
}
if ($runnerRecovery -notmatch 'ExecutablePath' -or $runnerRecovery -notmatch 'CreationDate' -or
    $runnerRecovery -notmatch 'CreatedAtMs' -or $runnerRecovery -notmatch 'CreationToken') {
    throw 'Runner isolation recovery does not bind token candidates to executable and creation identity.'
}
if ($processHandleSource -notmatch 'OpenProcess' -or $processHandleSource -notmatch 'GetProcessTimes' -or
    $processHandleSource -notmatch 'QueryFullProcessImageName' -or $processHandleSource -notmatch 'WaitForSingleObject' -or
    $processHandleSource -notmatch 'TerminateProcess' -or $processHandleSource -notmatch 'CommandLineToArgvW' -or
    $processHandleSource -match 'PROCESS_ALL_ACCESS') {
    throw 'Native runner handle helper does not use the minimum verified process-object API.'
}
if ($watchdog -notmatch '\$productArgumentPattern\s*=\s*\x27\^' -or $watchdog -notmatch '\$processArguments\.Equals' -or
    $watchdog -notmatch 'ProductExecutable' -or $watchdog -notmatch 'ProductServerPath') {
    throw 'The external watchdog does not strictly bind the main task and lease process to executable, arguments, and stable product entry.'
}
if ($watchdog.IndexOf('Wait-TaskStopped 15 $oldProcessIdentity $ownedTask', [StringComparison]::Ordinal) -lt $watchdog.IndexOf("if (`$taskRunning -or", [StringComparison]::Ordinal)) {
    throw 'The external watchdog can skip orphan-process cleanup when Task Scheduler no longer reports Running.'
}
if ($watchdog -notmatch 'Find-ProductProcessCandidates' -or $watchdog -notmatch "State -eq 'multiple'" -or $watchdog -notmatch "State -eq 'indeterminate'") {
    throw 'The watchdog does not fail closed on CIM uncertainty or multiple product process candidates.'
}
if ($watchdog -notmatch 'ExpectedCreationDate' -or $watchdog -notmatch 'UtcDateTime\.Ticks' -or $watchdog -notmatch 'CreationAt') {
    throw 'The watchdog forced-stop identity is not bound to sub-second process creation time.'
}
if ($watchdog -notmatch 'Codex-XBB-WeCom-Maintenance' -or $installer -notmatch 'Codex-XBB-WeCom-Maintenance' -or $uninstaller -notmatch 'Codex-XBB-WeCom-Maintenance') {
    throw 'Install, uninstall, and watchdog do not share a maintenance mutex.'
}
foreach ($taskScript in @($installer, $uninstaller, $watchdog)) {
    if ($taskScript -notmatch [regex]::Escape("return 'Global\Codex-XBB-WeCom-Maintenance'") -or
        $taskScript -match [regex]::Escape('Local\Codex-XBB-WeCom-Maintenance') -or
        $taskScript -match [regex]::Escape('Codex-XBB-WeCom-Maintenance-$TaskName')) {
        throw 'Task maintenance mutex is not fixed at product scope across Windows sessions.'
    }
}
if ($installer -notmatch 'Export-ScheduledTask' -or $installer.IndexOf('Export-OwnedTaskBackup $TaskName', [StringComparison]::Ordinal) -gt $installer.IndexOf('Remove-ExistingTaskForUpgrade $watchdogTaskName', [StringComparison]::Ordinal)) {
    throw 'The installer does not export the owned tasks before the upgrade removes either task.'
}
if ($installer -notmatch 'Register-ScheduledTask[^\r\n]+-Xml' -or $installer -notmatch 'Restore-TaskBackup' -or $installer -notmatch '\$rollbackErrors') {
    throw 'The installer does not provide cleanup and XML rollback for a failed upgrade.'
}
if ($installer -notmatch 'Get-DisabledTaskXml' -or $installer -notmatch 'WasEnabled' -or $installer.IndexOf('$rollbackRequestedAt =', [StringComparison]::Ordinal) -gt $installer.IndexOf('Restore-TaskBackup $backup', [StringComparison]::Ordinal)) {
    throw 'The installer does not restore rollback XML disabled before explicitly re-enabling a verified runtime.'
}
if ($installer -notmatch 'Find-ProductProcessCandidates' -or $installer -notmatch '\$preexistingProductIdentity' -or $installer -notmatch '\$shouldRestoreRuntime') {
    throw 'The installer does not stop a unique product orphan or restore a pre-upgrade runtime.'
}
if ($installer -notmatch 'Wait-ManagedRuntimeHealthy' -or $installer -notmatch 'Test-NewReadyStatus[^\r\n]+\$health\.InstanceId' -or $installer -notmatch 'instanceId -cne \$InstanceId') {
    throw 'The installer rollback/startup health check is not bound to the current running lease generation.'
}
if ($installer -match 'Get-ScheduledTask[^\r\n]+SilentlyContinue' -or $uninstaller -match 'Get-ScheduledTask[^\r\n]+SilentlyContinue') {
    throw 'Install or uninstall can mistake a ScheduledTasks provider failure for an absent task.'
}
if ($installer -notmatch '\.Execute' -or $installer -notmatch 'Get-ProductTaskActionMetadata' -or
    $installer -notmatch '\$productArgumentPattern\s*=\s*\x27\^' -or $installer -notmatch 'productServerSuffix') {
    throw 'The installer ownership check does not bind executable and anchored stable-product arguments.'
}
if ($uninstaller -notmatch '\.Execute' -or $uninstaller -notmatch 'Get-ProductTaskActionMetadata' -or
    $uninstaller -notmatch '\$mainArgumentPattern\s*=\s*\x27\^' -or $uninstaller -notmatch 'productServerSuffix') {
    throw 'The uninstaller ownership check does not bind executable and anchored stable-product arguments.'
}
if ($uninstaller -notmatch 'Get-CimInstance\s+Win32_Process' -or $uninstaller -notmatch 'ExecutablePath' -or $uninstaller -notmatch 'CommandLine' -or $uninstaller -notmatch 'CreationDate') {
    throw 'The uninstaller does not strictly identify the lease process before waiting or terminating it.'
}
if ($uninstaller -notmatch 'Wait-ManagedProcessExit' -or $uninstaller -notmatch 'Stop-ProductProcessTree' -or $uninstaller -notmatch 'ExpectedCreationDate') {
    throw 'The uninstaller does not wait for the owned process or constrain tree termination to the revalidated PID.'
}
if ($uninstaller -match 'Stop-Process[^\r\n]+\$lease\.pid') { throw 'The uninstaller can terminate an unverified lease PID.' }
if ($uninstaller -notmatch 'Find-ProductProcessCandidates' -or $uninstaller -notmatch "State -eq 'multiple'" -or $uninstaller -notmatch "State -eq 'indeterminate'") {
    throw 'The uninstaller does not fail closed on CIM uncertainty or multiple product process candidates.'
}
if ($uninstaller.IndexOf('$candidates = Find-ProductProcessCandidates', [StringComparison]::Ordinal) -lt 0 -or
    $uninstaller.IndexOf('$candidates = Find-ProductProcessCandidates', [StringComparison]::Ordinal) -gt $uninstaller.IndexOf('$watchdogRemoved =', [StringComparison]::Ordinal)) {
    throw 'The uninstaller does not discover all product generations before task removal.'
}

foreach ($taskScript in @($installer, $uninstaller, $watchdog)) {
    if ($taskScript -match 'taskkill\.exe' -or $taskScript -match 'Stop-Process\s+-Id' -or
        $taskScript -notmatch 'Open-XbbVerifiedProcessHandle' -or $taskScript -notmatch 'TerminateAndWait' -or
        $taskScript -notmatch 'Add-VerifiedProductDescendantHandles' -or $taskScript -notmatch '\.Dispose\(\)') {
        throw 'A maintenance script can terminate a dynamic PID tree without verified process-object handles.'
    }
    if ($taskScript -notmatch 'Find-ProductProcessCandidates' -or $taskScript -notmatch 'ConvertTo-ProductProcessIdentity') {
        throw 'A maintenance script does not enforce product-level process discovery.'
    }
    if ($taskScript -notmatch 'Get-HealthyMaintenanceProcessSnapshot' -or $taskScript -notmatch 'maintenanceSnapshotSentinel' -or
        $taskScript -notmatch '\$emptyRounds\s*=\s*0' -or $taskScript -notmatch '\$emptyRounds\s*-lt\s*2') {
        throw 'A maintenance process-tree stop is not protected by a sentinel and consecutive empty snapshots.'
    }
}
if ($installer -match 'RepetitionDuration' -or $installer -match 'New-TimeSpan\s+-Days\s+3650') {
    throw 'Scheduled recovery repetition is still capped instead of having an omitted duration.'
}
if ($installer.IndexOf('$productCandidates = Find-ProductProcessCandidates', [StringComparison]::Ordinal) -gt $installer.IndexOf('Remove-ExistingTaskForUpgrade $watchdogTaskName', [StringComparison]::Ordinal) -or
    $installer.IndexOf("Assert-ProductProcessSlotEmpty '启动新任务前'", [StringComparison]::Ordinal) -gt $installer.IndexOf('Start-ScheduledTask -TaskName $TaskName', [StringComparison]::Ordinal)) {
    throw 'The installer does not enforce an empty product slot before task mutation and launch.'
}
if ($watchdog.IndexOf('$candidates = Find-ProductProcessCandidates', [StringComparison]::Ordinal) -gt $watchdog.IndexOf("action = 'healthy'", [StringComparison]::Ordinal) -or
    $watchdog.IndexOf("Assert-ProductProcessSlotEmpty '重新启用主任务前'", [StringComparison]::Ordinal) -gt $watchdog.IndexOf('Start-ScheduledTask -TaskName $TaskName', [StringComparison]::Ordinal)) {
    throw 'The watchdog does not enforce the product-level singleton before health acceptance and restart.'
}
foreach ($taskScript in @($installer, $uninstaller, $watchdog)) {
    if ($taskScript -notmatch 'Test-FullyQualifiedWindowsPath' -or $taskScript -match '\[IO\.Path\]::IsPathRooted') {
        throw 'A maintenance script can still accept drive-relative or root-relative Windows paths.'
    }
}
if ($watchdog -notmatch 'Disable-VerifiedMainTask' -or $watchdog -notmatch 'fenced-health-indeterminate' -or
    $watchdog -notmatch 'fenced-ambiguous-product-roots' -or $watchdog -notmatch 'fenced-lease-product-mismatch' -or
    $watchdog -notmatch 'fenced-waiting-for-exact-health' -or $watchdog -notmatch 'fence-cleared') {
    throw 'The watchdog does not fence uncertainty/conflict or require exact health before re-enabling.'
}
if ($watchdog -notmatch 'Confirm-EmptyProductProcessSlot' -or
    $watchdog -notmatch '\$emptyConfirmation\s*=\s*Confirm-EmptyProductProcessSlot[\s\S]+\$emptySlotRecovery\s*=\s*\$true[\s\S]+Disable-VerifiedMainTask') {
    throw 'A fenced watchdog cannot safely recover after two healthy empty CIM snapshots.'
}
if ($installer -notmatch '\$finalHealth\s*=\s*Get-ManagedLeaseHealth' -or
    $installer -notmatch '\$finalHealth\.Identity\.CreationDate' -or
    $installer -notmatch '\$finalHealth\s*=\s*Get-ManagedLeaseHealth[\s\S]+Write-Output') {
    throw 'Installer success is not protected by a final product-wide lease identity check.'
}
if ($watchdog -notmatch '\$roundConsistency\s*=\s*Get-ProductLeaseConsistency' -or
    $watchdog -notmatch '\$finalConsistency\s*=\s*Get-ProductLeaseConsistency' -or
    $watchdog.IndexOf('$finalConsistency = Get-ProductLeaseConsistency', [StringComparison]::Ordinal) -gt $watchdog.IndexOf("action = 'restarted'", [StringComparison]::Ordinal)) {
    throw 'Watchdog restart waiting/success does not re-check product-wide lease identity each round.'
}
if ([regex]::Matches($installer, 'Assert-NoOtherProductTasks').Count -lt 2 -or
    $installer.LastIndexOf('Assert-NoOtherProductTasks', [StringComparison]::Ordinal) -gt $installer.IndexOf('$mainTaskBackup = Export-OwnedTaskBackup', [StringComparison]::Ordinal)) {
    throw 'Installer does not reject another scheduled task for the same product before mutation.'
}
if ($installer -notmatch 'Invoke-RunnerIsolationRecoveryForLeasePaths' -or
    $installer.IndexOf('$runnerIsolationRecovery = Invoke-RunnerIsolationRecoveryForLeasePaths', [StringComparison]::Ordinal) -lt
        $installer.IndexOf('Ensure-ProductProcessesStopped $preexistingProductIdentity', [StringComparison]::Ordinal) -or
    $installer.IndexOf('$runnerIsolationRecovery = Invoke-RunnerIsolationRecoveryForLeasePaths', [StringComparison]::Ordinal) -gt
        $installer.IndexOf('Start-VerifiedOwnedTask $TaskName', [StringComparison]::Ordinal)) {
    throw 'Installer does not recover old/new runner isolation directories after product stop and before new launch.'
}
if ($uninstaller -notmatch 'Confirm-RunnerIsolationRecoveryForLeasePaths' -or
    $uninstaller.LastIndexOf('$runnerIsolationRecovery = Confirm-RunnerIsolationRecoveryForLeasePaths', [StringComparison]::Ordinal) -lt
        $uninstaller.IndexOf('$finalCandidates = Find-ProductProcessCandidates', [StringComparison]::Ordinal) -or
    $uninstaller.LastIndexOf('$runnerIsolationRecovery = Confirm-RunnerIsolationRecoveryForLeasePaths', [StringComparison]::Ordinal) -gt
        $uninstaller.IndexOf('Write-Output', [StringComparison]::Ordinal)) {
    throw 'Uninstaller does not recover every owned runtime isolation directory before declaring success.'
}
foreach ($maintenanceScript in @($installer, $uninstaller)) {
    if ($maintenanceScript -notmatch '''-File''\s+\$runnerRecoveryScript' -or
        $maintenanceScript -notmatch '\$recoveryExitCode\s+-ne\s+0' -or
        $maintenanceScript -match '&\s+\$runnerRecoveryScript') {
        throw 'Runner isolation recovery is not launched as an independently fenced PowerShell process with exit validation.'
    }
}

foreach ($maintenanceScript in @($installer, $uninstaller, $watchdog)) {
    if ($maintenanceScript -notmatch 'Get-IndependentScheduledTaskSnapshot' -or
        $maintenanceScript -notmatch 'Test-IndependentScheduledTaskExists' -or
        $maintenanceScript -notmatch 'Get-VerifiedProductTaskSnapshot') {
        throw 'A maintenance script does not independently cross-check ScheduledTasks provider results.'
    }
    if ($maintenanceScript -notmatch 'productStartScriptSuffix' -or $maintenanceScript -notmatch 'productWatchdogScriptSuffix' -or
        $maintenanceScript -notmatch '\(\?:node\|nodew\)\\\.exe') {
        throw 'A maintenance script is still tied only to the current workspace/task generation.'
    }
}
if ($watchdog -notmatch 'Get-VerifiedLeaseMismatchRecoveryIdentity' -or
    $watchdog.IndexOf('$mismatchIdentity = Get-VerifiedLeaseMismatchRecoveryIdentity', [StringComparison]::Ordinal) -gt
        $watchdog.IndexOf('Stop-UniqueProductProcessTree $oldProcessIdentity', [StringComparison]::Ordinal) -or
    $watchdog -notmatch '\$emptySlotRecovery\s*=\s*\$verifiedMismatchRecovery') {
    throw 'Watchdog corrupt-lease recovery is not restricted to an exact unique task process before controlled restart.'
}
foreach ($operation in @('Disable', 'Enable', 'Start')) {
    if ($watchdog -notmatch "function $operation-VerifiedMainTask" -or
        [regex]::Matches($watchdog, "$operation-ScheduledTask").Count -ne 1) {
        throw "Watchdog $operation operations can bypass immediate main-task ownership revalidation."
    }
}
$rollbackRecoveryIndex = $installer.IndexOf('$rollbackRunnerIsolationRecovery = Invoke-RunnerIsolationRecoveryForLeasePaths', [StringComparison]::Ordinal)
$restoreBackupIndex = $installer.IndexOf('Restore-TaskBackup $backup', [StringComparison]::Ordinal)
if ($rollbackRecoveryIndex -lt 0 -or $restoreBackupIndex -lt 0 -or $rollbackRecoveryIndex -gt $restoreBackupIndex) {
    throw 'Installer rollback does not rerun isolation recovery before restoring old tasks.'
}
if ($watchdog -notmatch 'Invoke-VerifiedRunnerIsolationRecovery' -or
    $watchdog.IndexOf('Invoke-VerifiedRunnerIsolationRecovery $ownedTask', [StringComparison]::Ordinal) -gt
        $watchdog.IndexOf('Stop-UniqueProductProcessTree $oldProcessIdentity', [StringComparison]::Ordinal)) {
    throw 'Watchdog does not recover marker-bound runner trees before forced service-root termination.'
}

Write-Output ([ordered]@{ success = $true; checks = 103; launcher = 'direct-hidden-node+windowsHide-watchdog-child'; processTree = 'verified-handle-root+allowlisted-descendants+external-lease-watchdog'; upgradeRollback = 'disabled-owned-task-xml+product-wide-generation-health+runner-isolation-migration'; repetition = 'main-logon-only+watchdog-five-minute-infinite-duration'; watchdogProcessGuard = 'fixed-global-maintenance-mutex+fenced-product-root+exact-lease-identity+two-empty-snapshot-recovery'; uninstallProcessGuard = 'fixed-global-maintenance-mutex+unique-product-root+handle-tree+runner-isolation-recovery' } | ConvertTo-Json -Compress)
