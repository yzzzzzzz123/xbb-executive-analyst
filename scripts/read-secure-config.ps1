[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [switch]$WecomOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$resolved = [IO.Path]::GetFullPath($Path)
if (-not [IO.File]::Exists($resolved)) {
    throw "机器人安全配置不存在：$resolved。请先运行 configure-bot.ps1。"
}

$stored = Get-Content -LiteralPath $resolved -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]$stored.schemaVersion -ne '3.0') { throw '机器人安全配置不是本机 Codex 长连接版 3.0，请重新运行 configure-bot.ps1。' }
$requiredFields = @('wecomBotId', 'wecomBotSecretDpapi')
if (-not $WecomOnly) { $requiredFields += @('modelProvider', 'accessPolicyPath') }
foreach ($field in $requiredFields) {
    if ([string]::IsNullOrWhiteSpace([string]$stored.$field)) { throw "机器人安全配置缺少字段：$field" }
}

function Unprotect-Value([string]$ProtectedValue) {
    $secure = ConvertTo-SecureString $ProtectedValue
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        $pointer = [IntPtr]::Zero
        $secure = $null
    }
}

$botSecret = Unprotect-Value ([string]$stored.wecomBotSecretDpapi)
try {
    $result = [ordered]@{
        wecomBotId = [string]$stored.wecomBotId
        wecomBotSecret = $botSecret
        wecomWsUrl = if ($stored.PSObject.Properties.Name -contains 'wecomWsUrl') { [string]$stored.wecomWsUrl } else { 'wss://openws.work.weixin.qq.com' }
        wecomMaxReconnectAttempts = if ($stored.PSObject.Properties.Name -contains 'wecomMaxReconnectAttempts') { [int]$stored.wecomMaxReconnectAttempts } else { -1 }
        wecomHeartbeatMs = if ($stored.PSObject.Properties.Name -contains 'wecomHeartbeatMs') { [int]$stored.wecomHeartbeatMs } else { 30000 }
        wecomRequestTimeoutMs = if ($stored.PSObject.Properties.Name -contains 'wecomRequestTimeoutMs') { [int]$stored.wecomRequestTimeoutMs } else { 10000 }
    }
    if (-not $WecomOnly) {
        $result['modelProvider'] = [string]$stored.modelProvider
        $result['codexModel'] = 'gpt-5.6-sol'
        $result['codexReasoningEffort'] = 'max'
        $result['modelTimeoutMs'] = if ($stored.PSObject.Properties.Name -contains 'modelTimeoutMs') { [int]$stored.modelTimeoutMs } else { 300000 }
        $result['accessPolicyPath'] = [string]$stored.accessPolicyPath
    }
    $result | ConvertTo-Json -Compress
} finally {
    $botSecret = $null
}
