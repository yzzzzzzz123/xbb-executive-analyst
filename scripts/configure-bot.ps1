[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9_-]{4,256}$')]
    [string]$WecomBotId,
    [SecureString]$WecomBotSecret,
    [string]$AccessPolicyPath = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Codex\xbb-executive-analyst\access-policy.json'),
    [ValidatePattern('^wss://')]
    [string]$WecomWsUrl = 'wss://openws.work.weixin.qq.com',
    [string]$Path = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Codex\xbb-executive-analyst\bot-config.json')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($WecomBotId)) { $WecomBotId = Read-Host '企业微信智能机器人 Bot ID' }
if ($WecomBotId -notmatch '^[A-Za-z0-9_-]{4,256}$') { throw '企业微信 Bot ID 格式无效。' }
if ($null -eq $WecomBotSecret) { $WecomBotSecret = Read-Host '企业微信智能机器人 Secret' -AsSecureString }

function Get-PlainText([SecureString]$Value) {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

$secretText = Get-PlainText $WecomBotSecret
try {
    if ([string]::IsNullOrWhiteSpace($secretText)) { throw '企业微信智能机器人 Secret 不能为空。' }
} finally {
    $secretText = $null
}

$resolved = [IO.Path]::GetFullPath($Path)
$resolvedPolicy = [IO.Path]::GetFullPath($AccessPolicyPath)
$parent = [IO.Path]::GetDirectoryName($resolved)
[IO.Directory]::CreateDirectory($parent) | Out-Null

$stored = [ordered]@{
    schemaVersion = '3.0'
    wecomBotId = $WecomBotId
    wecomBotSecretDpapi = ConvertFrom-SecureString $WecomBotSecret
    wecomWsUrl = $WecomWsUrl
    wecomMaxReconnectAttempts = -1
    wecomHeartbeatMs = 30000
    wecomRequestTimeoutMs = 10000
    modelProvider = 'local-codex'
    codexReasoningEffort = 'medium'
    modelTimeoutMs = 300000
    accessPolicyPath = $resolvedPolicy
}
$json = $stored | ConvertTo-Json -Depth 10
$temporary = "$resolved.tmp-$PID-$([Guid]::NewGuid().ToString('N'))"
[IO.File]::WriteAllText($temporary, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
try {
    if ([IO.File]::Exists($resolved)) { [IO.File]::Replace($temporary, $resolved, $null) } else { [IO.File]::Move($temporary, $resolved) }
} finally {
    if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
}

Write-Output ([ordered]@{ success = $true; transport = 'wecom-websocket'; modelProvider = 'local-codex'; botId = $WecomBotId; configPath = $resolved; accessPolicyPath = $resolvedPolicy; secrets = 'DPAPI CurrentUser' } | ConvertTo-Json -Compress)
