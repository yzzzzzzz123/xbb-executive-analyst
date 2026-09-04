[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$installerPath = Join-Path $projectRoot 'scripts\install-wecom-task.ps1'
$uninstallerPath = Join-Path $projectRoot 'scripts\uninstall-wecom-task.ps1'
$launcherPath = Join-Path $projectRoot 'scripts\install-hidden-node.ps1'
$watchdogPath = Join-Path $projectRoot 'scripts\watchdog-wecom-task.ps1'

$installer = Get-Content -LiteralPath $installerPath -Raw -Encoding UTF8
$uninstaller = Get-Content -LiteralPath $uninstallerPath -Raw -Encoding UTF8
$launcher = Get-Content -LiteralPath $launcherPath -Raw -Encoding UTF8
$watchdog = Get-Content -LiteralPath $watchdogPath -Raw -Encoding UTF8

foreach ($scriptPath in @($installerPath, $uninstallerPath, $launcherPath, $watchdogPath)) {
    $tokens = $null
    $parseErrors = $null
    [Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors) | Out-Null
    if ($parseErrors.Count -gt 0) { throw "PowerShell parser rejected ${scriptPath}: $($parseErrors[0].Message)" }
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

Import-ScriptFunction $watchdogPath 'ConvertTo-ProcessCreationStamp'
Import-ScriptFunction $watchdogPath 'ConvertTo-OwnedProcessIdentity'
$preciseCreation = [DateTime]::SpecifyKind([DateTime]::ParseExact('2026-09-04T08:09:10.1234567', 'yyyy-MM-ddTHH:mm:ss.fffffff', [Globalization.CultureInfo]::InvariantCulture), [DateTimeKind]::Utc)
$creationStamp = ConvertTo-ProcessCreationStamp $preciseCreation
if ([string]$creationStamp.Token -ne $preciseCreation.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)) {
    throw 'Sub-second process creation identity was not preserved as UTC ticks.'
}
$testExecutable = 'C:\Codex\nodew.exe'
$testArguments = '"C:\Codex\server.js" --managed-config "C:\Codex\bot-config.json"'
$ownedTask = [pscustomobject]@{ Executable = $testExecutable; Arguments = $testArguments }
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

Import-ScriptFunction $installerPath 'Get-DisabledTaskXml'
$sampleTaskXml = '<?xml version="1.0" encoding="UTF-16"?><Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Settings><Enabled>true</Enabled></Settings></Task>'
[xml]$disabledTaskXml = Get-DisabledTaskXml $sampleTaskXml 'test-task'
if ($disabledTaskXml.Task.Settings.Enabled -ne 'false') { throw 'Rollback XML was not forced into the disabled state.' }

if ($installer -notmatch [regex]::Escape('scripts\install-hidden-node.ps1')) { throw 'The scheduled task does not use the bundled hidden Node installer.' }
if ($installer -notmatch 'New-ScheduledTaskAction\s+-Execute\s+\$hiddenNodePath') { throw 'The scheduled task does not launch the hidden Node executable directly.' }
if ($installer -match 'New-ScheduledTaskAction[^\r\n]+wscript\.exe') { throw 'The scheduled task still launches an obsolete wrapper host.' }
if ($launcher -notmatch '\$subsystemOffset = \$optionalHeaderOffset \+ 68') { throw 'The hidden Node installer does not address the PE subsystem field.' }
if ($launcher -notmatch '\$writer\.Write\(\[uint16\]2\)') { throw 'The hidden Node installer does not set the Windows GUI subsystem.' }
if ($launcher -notmatch 'Get-PeSubsystem \$temporary') { throw 'The hidden Node installer does not verify the patched executable.' }
if ($installer -notmatch 'watchdog-wecom-task\.ps1') { throw 'The scheduled task installer does not register the external lease watchdog.' }
if ($watchdog -notmatch 'Stop-ScheduledTask' -or $watchdog -notmatch 'Start-ScheduledTask') { throw 'The external watchdog cannot restart the main task.' }
if ($watchdog -notmatch '\$mainArgumentPattern\s*=\s*\x27\^' -or $watchdog -notmatch '\$processArguments\.Equals' -or $watchdog -notmatch '\$expectedDescription') {
    throw 'The external watchdog does not strictly bind the main task and lease process to the managed executable, arguments, and description.'
}
if ($watchdog.IndexOf('Wait-TaskStopped 15 $oldProcessIdentity $ownedTask', [StringComparison]::Ordinal) -lt $watchdog.IndexOf("if (`$taskRunning -or", [StringComparison]::Ordinal)) {
    throw 'The external watchdog can skip orphan-process cleanup when Task Scheduler no longer reports Running.'
}
if ($watchdog -notmatch 'Find-OwnedProcessCandidates' -or $watchdog -notmatch "State -eq 'multiple'" -or $watchdog -notmatch "State -eq 'indeterminate'") {
    throw 'The watchdog does not fail closed on CIM uncertainty or multiple exact process candidates.'
}
if ($watchdog -notmatch 'ExpectedCreationDate' -or $watchdog -notmatch 'UtcDateTime\.Ticks' -or $watchdog -notmatch 'CreationAt') {
    throw 'The watchdog forced-stop identity is not bound to sub-second process creation time.'
}
if ($watchdog -notmatch 'Codex-XBB-WeCom-Maintenance-' -or $installer -notmatch 'Codex-XBB-WeCom-Maintenance-' -or $uninstaller -notmatch 'Codex-XBB-WeCom-Maintenance-') {
    throw 'Install, uninstall, and watchdog do not share a maintenance mutex.'
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
if ($installer -notmatch 'Find-ManagedProcessCandidates' -or $installer -notmatch '\$preexistingNewProcessIdentity' -or $installer -notmatch '\$shouldRestoreRuntime') {
    throw 'The installer does not stop a unique exact orphan or restore a pre-upgrade orphan runtime.'
}
if ($installer -notmatch 'Wait-ManagedRuntimeHealthy' -or $installer -notmatch 'Test-NewReadyStatus[^\r\n]+\$health\.InstanceId' -or $installer -notmatch 'instanceId -cne \$InstanceId') {
    throw 'The installer rollback/startup health check is not bound to the current running lease generation.'
}
if ($installer -match 'Get-ScheduledTask[^\r\n]+SilentlyContinue' -or $uninstaller -match 'Get-ScheduledTask[^\r\n]+SilentlyContinue') {
    throw 'Install or uninstall can mistake a ScheduledTasks provider failure for an absent task.'
}
if ($installer -notmatch '\.Execute' -or $installer -notmatch 'description\.Equals' -or $installer -notmatch '\$argumentPattern\s*=\s*\x27\^') {
    throw 'The installer ownership check does not bind executable, description, and anchored arguments.'
}
if ($uninstaller -notmatch '\.Execute' -or $uninstaller -notmatch 'description\.Equals' -or $uninstaller -notmatch '\$mainArgumentPattern\s*=\s*\x27\^') {
    throw 'The uninstaller ownership check does not bind executable, description, and anchored arguments.'
}
if ($uninstaller -notmatch 'Get-CimInstance\s+Win32_Process' -or $uninstaller -notmatch 'ExecutablePath' -or $uninstaller -notmatch 'CommandLine' -or $uninstaller -notmatch 'CreationDate') {
    throw 'The uninstaller does not strictly identify the lease process before waiting or terminating it.'
}
if ($uninstaller -notmatch 'Wait-ManagedProcessExit' -or $uninstaller -notmatch 'Stop-ManagedProcessIdentity' -or $uninstaller -notmatch 'ExpectedCreationDate') {
    throw 'The uninstaller does not wait for the owned process or constrain forced termination to the revalidated PID.'
}
if ($uninstaller -match 'Stop-Process[^\r\n]+\$lease\.pid') { throw 'The uninstaller can terminate an unverified lease PID.' }
if ($uninstaller -notmatch 'Find-ManagedProcessCandidates' -or $uninstaller -notmatch "State -eq 'multiple'" -or $uninstaller -notmatch "State -eq 'indeterminate'") {
    throw 'The uninstaller does not fail closed on CIM uncertainty or multiple exact process candidates.'
}

Write-Output ([ordered]@{ success = $true; checks = 34; launcher = 'direct-hidden-node'; processTree = 'task-scheduler-direct-root+external-lease-watchdog'; upgradeRollback = 'disabled-owned-task-xml+generation-health'; watchdogProcessGuard = 'maintenance-mutex+task+executable+exact-arguments+subsecond-creation-time'; uninstallProcessGuard = 'maintenance-mutex+lease+unique-exact-process+subsecond-creation-time' } | ConvertTo-Json -Compress)
