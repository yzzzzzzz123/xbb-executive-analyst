[CmdletBinding()]
param(
    [SecureString]$WecomToken,
    [SecureString]$WecomEncodingAesKey,
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^https?://')]
    [string]$ModelEndpoint,
    [Parameter(Mandatory = $true)]
    [string]$ModelName,
    [SecureString]$ModelApiKey,
    [string]$AccessPolicyPath = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Codex\xbb-executive-analyst\access-policy.json'),
    [string]$HostName = '127.0.0.1',
    [ValidateRange(1, 65535)]
    [int]$Port = 8788,
    [string]$CallbackPath = '/wecom/callback',
    [string]$Path = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Codex\xbb-executive-analyst\bot-config.json')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($null -eq $WecomToken) { $WecomToken = Read-Host '企业微信智能机器人 Token' -AsSecureString }
if ($null -eq $WecomEncodingAesKey) { $WecomEncodingAesKey = Read-Host '企业微信智能机器人 EncodingAESKey' -AsSecureString }
if ($null -eq $ModelApiKey) { $ModelApiKey = Read-Host '模型 API Key（本地免鉴权模型可直接回车）' -AsSecureString }

function Get-PlainText([SecureString]$Value) {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

$tokenText = Get-PlainText $WecomToken
$aesText = Get-PlainText $WecomEncodingAesKey
try {
    if ([string]::IsNullOrWhiteSpace($tokenText)) { throw '企业微信 Token 不能为空。' }
    if ($aesText -notmatch '^[A-Za-z0-9+/]{43}$') { throw 'EncodingAESKey 必须是 43 位 Base64 字符串。' }
} finally {
    $tokenText = $null
    $aesText = $null
}

$resolved = [IO.Path]::GetFullPath($Path)
$resolvedPolicy = [IO.Path]::GetFullPath($AccessPolicyPath)
$parent = [IO.Path]::GetDirectoryName($resolved)
[IO.Directory]::CreateDirectory($parent) | Out-Null

$stored = [ordered]@{
    schemaVersion = '1.0'
    host = $HostName
    port = $Port
    callbackPath = $CallbackPath
    wecomReceiveId = ''
    wecomTokenDpapi = ConvertFrom-SecureString $WecomToken
    wecomEncodingAesKeyDpapi = ConvertFrom-SecureString $WecomEncodingAesKey
    modelEndpoint = $ModelEndpoint
    modelName = $ModelName
    modelApiKeyDpapi = ConvertFrom-SecureString $ModelApiKey
    modelTimeoutMs = 120000
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

Write-Output ([ordered]@{ success = $true; configPath = $resolved; accessPolicyPath = $resolvedPolicy; secrets = 'DPAPI CurrentUser' } | ConvertTo-Json -Compress)
