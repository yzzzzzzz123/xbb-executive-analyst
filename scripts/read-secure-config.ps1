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
$schemaVersion = [string]$stored.schemaVersion
if ($schemaVersion -notin @('3.0', '4.0')) { throw '机器人安全配置不是受支持的本机 Codex Agent 长连接版，请重新运行 configure-bot.ps1。' }
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
        $result['modelProvider'] = 'codex-app-server'
        $result['codexModel'] = if ($stored.PSObject.Properties.Name -contains 'codexModel') { [string]$stored.codexModel } else { 'gpt-6-astra' }
        $result['codexReasoningEffort'] = if ($stored.PSObject.Properties.Name -contains 'codexReasoningEffort') { [string]$stored.codexReasoningEffort } else { 'xhigh' }
        $result['codexContextWindow'] = if ($stored.PSObject.Properties.Name -contains 'codexContextWindow') { [int]$stored.codexContextWindow } else { 872000 }
        $result['codexAutoCompactTokenLimit'] = if ($stored.PSObject.Properties.Name -contains 'codexAutoCompactTokenLimit') { [int]$stored.codexAutoCompactTokenLimit } else { 750000 }
        $result['agentTurnTimeoutMs'] = if ($stored.PSObject.Properties.Name -contains 'agentTurnTimeoutMs') { [int]$stored.agentTurnTimeoutMs } else { 300000 }
        $result['generalTurnTimeoutMs'] = if ($stored.PSObject.Properties.Name -contains 'generalTurnTimeoutMs') { [int]$stored.generalTurnTimeoutMs } else { 900000 }
        $result['agentStatePath'] = if ($stored.PSObject.Properties.Name -contains 'agentStatePath') { [string]$stored.agentStatePath } else { Join-Path ([IO.Path]::GetDirectoryName($resolved)) 'agent-state.json' }
        $result['statusLogPath'] = if ($stored.PSObject.Properties.Name -contains 'statusLogPath') { [string]$stored.statusLogPath } else { Join-Path ([IO.Path]::GetDirectoryName($resolved)) 'status.jsonl' }
        $result['serviceLeasePath'] = if ($stored.PSObject.Properties.Name -contains 'serviceLeasePath') { [string]$stored.serviceLeasePath } else { Join-Path ([IO.Path]::GetDirectoryName($resolved)) 'service-lease.json' }
        $result['accessPolicyPath'] = [string]$stored.accessPolicyPath
        if ($stored.PSObject.Properties.Name -contains 'codexProxyUrl') { $result['codexProxyUrl'] = [string]$stored.codexProxyUrl }
        if ($stored.PSObject.Properties.Name -contains 'codexCommand') { $result['codexCommand'] = [string]$stored.codexCommand }
    }
    $result | ConvertTo-Json -Compress
} finally {
    $botSecret = $null
}
