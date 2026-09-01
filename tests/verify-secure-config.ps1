[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$configure = Join-Path $projectRoot 'scripts\configure-bot.ps1'
$reader = Join-Path $projectRoot 'scripts\read-secure-config.ps1'
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
    if ([string]$stored.schemaVersion -ne '3.0') { throw 'Unexpected secure config schema.' }
    if ($stored.PSObject.Properties.Name -contains 'wecomBotSecret') { throw 'Plain bot secret was persisted.' }
    if ($stored.PSObject.Properties.Name -contains 'modelApiKeyDpapi') { throw 'Local Codex config must not contain a model API key.' }

    $full = (& $reader -Path $configPath) | ConvertFrom-Json
    if ([string]$full.wecomBotId -ne 'aibot_secure_test') { throw 'Bot ID round trip failed.' }
    if ([string]$full.wecomBotSecret -ne 'dummy-bot-secret-for-test') { throw 'Bot secret DPAPI round trip failed.' }
    if ([string]$full.modelProvider -ne 'local-codex') { throw 'Local Codex provider round trip failed.' }
    if ([string]$full.codexModel -ne 'gpt-5.6-sol') { throw 'Local Codex model round trip failed.' }
    if ([string]$full.codexReasoningEffort -ne 'max') { throw 'Local Codex reasoning effort round trip failed.' }

    $transport = (& $reader -Path $configPath -WecomOnly) | ConvertFrom-Json
    if ($transport.PSObject.Properties.Name -contains 'modelApiKey') { throw 'Transport-only read exposed the model key.' }
    if ([string]$transport.wecomBotSecret -ne 'dummy-bot-secret-for-test') { throw 'Transport-only DPAPI read failed.' }

    Write-Output ([ordered]@{ success = $true; checks = 10; schemaVersion = '3.0'; dpapi = 'CurrentUser'; modelProvider = 'local-codex'; codexModel = 'gpt-5.6-sol'; reasoning = 'max' } | ConvertTo-Json -Compress)
} finally {
    if ([IO.Directory]::Exists($testRoot)) {
        $verified = [IO.Path]::GetFullPath($testRoot)
        if (-not $verified.StartsWith($expectedRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing unsafe test cleanup.' }
        Remove-Item -LiteralPath $verified -Recurse -Force
    }
}
