[CmdletBinding()]
param(
    [string]$Path = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Codex\xbb-executive-analyst\bot-config.json')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$resolved = [IO.Path]::GetFullPath($Path)
if (-not [IO.File]::Exists($resolved)) { throw "Bot secure config does not exist: $resolved" }
$stored = Get-Content -LiteralPath $resolved -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]$stored.schemaVersion -notin @('3.0', '4.0')) { throw 'Only secure config schema 3.0 or 4.0 can be migrated.' }
if ([string]::IsNullOrWhiteSpace([string]$stored.wecomBotSecretDpapi)) { throw 'The DPAPI-protected WeCom secret is missing.' }

$parent = [IO.Path]::GetDirectoryName($resolved)
$stored.schemaVersion = '4.0'
$stored.modelProvider = 'codex-app-server'
$stored.codexModel = 'gpt-6-astra'
$stored.codexReasoningEffort = 'xhigh'
if ($stored.PSObject.Properties.Name -notcontains 'codexContextWindow') { $stored | Add-Member -NotePropertyName codexContextWindow -NotePropertyValue 872000 }
if ($stored.PSObject.Properties.Name -notcontains 'codexAutoCompactTokenLimit') { $stored | Add-Member -NotePropertyName codexAutoCompactTokenLimit -NotePropertyValue 750000 }
if ($stored.PSObject.Properties.Name -contains 'modelTimeoutMs') { $stored.PSObject.Properties.Remove('modelTimeoutMs') }
if ($stored.PSObject.Properties.Name -contains 'modelEndpoint') { $stored.PSObject.Properties.Remove('modelEndpoint') }
if ($stored.PSObject.Properties.Name -contains 'modelName') { $stored.PSObject.Properties.Remove('modelName') }
if ($stored.PSObject.Properties.Name -contains 'modelApiKeyDpapi') { throw 'External model API key config cannot be migrated. Run configure-bot.ps1.' }
if ($stored.PSObject.Properties.Name -contains 'agentTurnTimeoutMs') { $stored.agentTurnTimeoutMs = 300000 } else { $stored | Add-Member -NotePropertyName agentTurnTimeoutMs -NotePropertyValue 300000 }
if ($stored.PSObject.Properties.Name -contains 'generalTurnTimeoutMs') { $stored.generalTurnTimeoutMs = 900000 } else { $stored | Add-Member -NotePropertyName generalTurnTimeoutMs -NotePropertyValue 900000 }
$statePath = [IO.Path]::GetFullPath((Join-Path $parent 'agent-state.json'))
if ($stored.PSObject.Properties.Name -contains 'agentStatePath') { $stored.agentStatePath = $statePath } else { $stored | Add-Member -NotePropertyName agentStatePath -NotePropertyValue $statePath }
$statusLogPath = [IO.Path]::GetFullPath((Join-Path $parent 'status.jsonl'))
if ($stored.PSObject.Properties.Name -contains 'statusLogPath') { $stored.statusLogPath = $statusLogPath } else { $stored | Add-Member -NotePropertyName statusLogPath -NotePropertyValue $statusLogPath }
$serviceLeasePath = [IO.Path]::GetFullPath((Join-Path $parent 'service-lease.json'))
if ($stored.PSObject.Properties.Name -contains 'serviceLeasePath') { $stored.serviceLeasePath = $serviceLeasePath } else { $stored | Add-Member -NotePropertyName serviceLeasePath -NotePropertyValue $serviceLeasePath }

$json = $stored | ConvertTo-Json -Depth 10
$temporary = "$resolved.tmp-$PID-$([Guid]::NewGuid().ToString('N'))"
$backup = "$resolved.bak-$PID-$([Guid]::NewGuid().ToString('N'))"
[IO.File]::WriteAllText($temporary, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
try {
    [IO.File]::Replace($temporary, $resolved, $backup)
} finally {
    if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    if ([IO.File]::Exists($backup)) { [IO.File]::Delete($backup) }
}

Write-Output ([ordered]@{ success = $true; schemaVersion = '4.0'; modelProvider = 'codex-app-server'; configPath = $resolved; secret = 'preserved-dpapi' } | ConvertTo-Json -Compress)
