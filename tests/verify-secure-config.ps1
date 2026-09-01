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
    $modelSecret = ConvertTo-SecureString 'dummy-model-secret-for-test' -AsPlainText -Force

    & $configure `
        -WecomBotId 'aibot_secure_test' `
        -WecomBotSecret $botSecret `
        -ModelEndpoint 'https://model.example/v1/chat/completions' `
        -ModelName 'tool-model' `
        -ModelApiKey $modelSecret `
        -AccessPolicyPath $policyPath `
        -Path $configPath | Out-Null

    $stored = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$stored.schemaVersion -ne '2.0') { throw 'Unexpected secure config schema.' }
    if ($stored.PSObject.Properties.Name -contains 'wecomBotSecret') { throw 'Plain bot secret was persisted.' }

    $full = (& $reader -Path $configPath) | ConvertFrom-Json
    if ([string]$full.wecomBotId -ne 'aibot_secure_test') { throw 'Bot ID round trip failed.' }
    if ([string]$full.wecomBotSecret -ne 'dummy-bot-secret-for-test') { throw 'Bot secret DPAPI round trip failed.' }
    if ([string]$full.modelApiKey -ne 'dummy-model-secret-for-test') { throw 'Model key DPAPI round trip failed.' }

    $transport = (& $reader -Path $configPath -WecomOnly) | ConvertFrom-Json
    if ($transport.PSObject.Properties.Name -contains 'modelApiKey') { throw 'Transport-only read exposed the model key.' }
    if ([string]$transport.wecomBotSecret -ne 'dummy-bot-secret-for-test') { throw 'Transport-only DPAPI read failed.' }

    Write-Output ([ordered]@{ success = $true; checks = 7; schemaVersion = '2.0'; dpapi = 'CurrentUser' } | ConvertTo-Json -Compress)
} finally {
    if ([IO.Directory]::Exists($testRoot)) {
        $verified = [IO.Path]::GetFullPath($testRoot)
        if (-not $verified.StartsWith($expectedRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing unsafe test cleanup.' }
        Remove-Item -LiteralPath $verified -Recurse -Force
    }
}
