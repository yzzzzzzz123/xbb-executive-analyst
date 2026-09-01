[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$configure = Join-Path $projectRoot 'scripts\configure-bot.ps1'
$configurePolicy = Join-Path $projectRoot 'scripts\configure-access-policy.ps1'
$reader = Join-Path $projectRoot 'scripts\read-secure-config.ps1'
$migrate = Join-Path $projectRoot 'scripts\migrate-app-server-config.ps1'
$expectedRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$testRoot = [IO.Path]::GetFullPath((Join-Path $expectedRoot ('xbb-secure-config-test-' + [Guid]::NewGuid().ToString('N'))))
if (-not $testRoot.StartsWith($expectedRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe temporary test path.' }

[IO.Directory]::CreateDirectory($testRoot) | Out-Null
try {
    $configPath = Join-Path $testRoot 'bot-config.json'
    $policyPath = Join-Path $testRoot 'access-policy.json'
    $botSecret = ConvertTo-SecureString 'dummy-bot-secret-for-test' -AsPlainText -Force
    & $configure `
        -WecomBotId 'aibot_secure_test' `
        -WecomBotSecret $botSecret `
        -AccessPolicyPath $policyPath `
        -Path $configPath | Out-Null

    $stored = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$stored.schemaVersion -ne '4.0') { throw 'Unexpected secure config schema.' }
    if ($stored.PSObject.Properties.Name -contains 'wecomBotSecret') { throw 'Plain bot secret was persisted.' }
    if ($stored.PSObject.Properties.Name -contains 'modelApiKeyDpapi') { throw 'Local Codex config must not contain a model API key.' }

    $full = (& $reader -Path $configPath) | ConvertFrom-Json
    if ([string]$full.wecomBotId -ne 'aibot_secure_test') { throw 'Bot ID round trip failed.' }
    if ([string]$full.wecomBotSecret -ne 'dummy-bot-secret-for-test') { throw 'Bot secret DPAPI round trip failed.' }
    if ([string]$full.modelProvider -ne 'codex-app-server') { throw 'Codex App Server provider round trip failed.' }
    if ([string]$full.codexModel -ne 'gpt-5.6-sol') { throw 'Local Codex model round trip failed.' }
    if ([string]$full.codexReasoningEffort -ne 'medium') { throw 'Local Codex reasoning effort round trip failed.' }
    if ([int]$full.agentTurnTimeoutMs -ne 300000) { throw 'Codex Agent timeout round trip failed.' }
    if ([string]$full.agentStatePath -ne [IO.Path]::GetFullPath((Join-Path $testRoot 'agent-state.json'))) { throw 'Codex Agent state path round trip failed.' }
    if ([string]$full.statusLogPath -ne [IO.Path]::GetFullPath((Join-Path $testRoot 'status.jsonl'))) { throw 'Status log path round trip failed.' }

    $transport = (& $reader -Path $configPath -WecomOnly) | ConvertFrom-Json
    if ($transport.PSObject.Properties.Name -contains 'modelApiKey') { throw 'Transport-only read exposed the model key.' }
    if ([string]$transport.wecomBotSecret -ne 'dummy-bot-secret-for-test') { throw 'Transport-only DPAPI read failed.' }

    $updatedSecret = ConvertTo-SecureString 'updated-bot-secret-for-test' -AsPlainText -Force
    & $configure `
        -WecomBotId 'aibot_secure_updated' `
        -WecomBotSecret $updatedSecret `
        -AccessPolicyPath $policyPath `
        -Path $configPath | Out-Null
    $updated = (& $reader -Path $configPath -WecomOnly) | ConvertFrom-Json
    if ([string]$updated.wecomBotId -ne 'aibot_secure_updated') { throw 'Atomic config replacement did not update Bot ID.' }
    if ([string]$updated.wecomBotSecret -ne 'updated-bot-secret-for-test') { throw 'Atomic config replacement did not update the DPAPI secret.' }
    if (@(Get-ChildItem -LiteralPath $testRoot -File | Where-Object { $_.Name -like 'bot-config.json.tmp-*' -or $_.Name -like 'bot-config.json.bak-*' }).Count -ne 0) { throw 'Atomic config replacement left temporary files.' }

    $legacy = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $legacyCipher = [string]$legacy.wecomBotSecretDpapi
    $legacy.schemaVersion = '3.0'
    $legacy.modelProvider = 'local-codex'
    $legacy | Add-Member -NotePropertyName modelTimeoutMs -NotePropertyValue 300000 -Force
    $legacy.PSObject.Properties.Remove('agentTurnTimeoutMs')
    $legacy.PSObject.Properties.Remove('agentStatePath')
    $legacy.PSObject.Properties.Remove('statusLogPath')
    [IO.File]::WriteAllText($configPath, (($legacy | ConvertTo-Json -Depth 10) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
    & $migrate -Path $configPath | Out-Null
    $migrated = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$migrated.schemaVersion -ne '4.0' -or [string]$migrated.modelProvider -ne 'codex-app-server') { throw 'Idempotent App Server config migration failed.' }
    if ([string]$migrated.wecomBotSecretDpapi -ne $legacyCipher) { throw 'App Server config migration changed the DPAPI ciphertext.' }
    $migratedFull = (& $reader -Path $configPath) | ConvertFrom-Json
    if ([string]$migratedFull.wecomBotSecret -ne 'updated-bot-secret-for-test') { throw 'Migrated DPAPI secret no longer decrypts.' }

    & $configurePolicy -UserId 'first-user' -AllowAll -Path $policyPath | Out-Null
    & $configurePolicy -UserId 'second-user' -AllowAll -Path $policyPath | Out-Null
    $policy = Get-Content -LiteralPath $policyPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$policy.users.'first-user'.scope -ne 'all' -or [string]$policy.users.'second-user'.scope -ne 'all') { throw 'Atomic access policy replacement did not preserve and add users.' }
    if (@(Get-ChildItem -LiteralPath $testRoot -File | Where-Object { $_.Name -like 'access-policy.json.tmp-*' -or $_.Name -like 'access-policy.json.bak-*' }).Count -ne 0) { throw 'Atomic access policy replacement left temporary files.' }

    Write-Output ([ordered]@{ success = $true; checks = 24; schemaVersion = '4.0'; dpapi = 'CurrentUser'; modelProvider = 'codex-app-server'; codexModel = 'gpt-5.6-sol'; reasoning = 'medium'; atomicReplace = 'passed'; migration = '3.0-to-4.0-passed' } | ConvertTo-Json -Compress)
} finally {
    if ([IO.Directory]::Exists($testRoot)) {
        $verified = [IO.Path]::GetFullPath($testRoot)
        if (-not $verified.StartsWith($expectedRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing unsafe test cleanup.' }
        Remove-Item -LiteralPath $verified -Recurse -Force
    }
}
