[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Path
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$resolved = [IO.Path]::GetFullPath($Path)
if (-not [IO.File]::Exists($resolved)) {
    throw "机器人安全配置不存在：$resolved。请先运行 configure-bot.ps1。"
}

$stored = Get-Content -LiteralPath $resolved -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($field in @('wecomTokenDpapi', 'wecomEncodingAesKeyDpapi', 'modelEndpoint', 'modelName', 'accessPolicyPath')) {
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

$token = Unprotect-Value ([string]$stored.wecomTokenDpapi)
$aesKey = Unprotect-Value ([string]$stored.wecomEncodingAesKeyDpapi)
$modelApiKey = if ([string]::IsNullOrWhiteSpace([string]$stored.modelApiKeyDpapi)) { '' } else { Unprotect-Value ([string]$stored.modelApiKeyDpapi) }
try {
    [ordered]@{
        host = if ($stored.PSObject.Properties.Name -contains 'host') { [string]$stored.host } else { '127.0.0.1' }
        port = if ($stored.PSObject.Properties.Name -contains 'port') { [int]$stored.port } else { 8788 }
        callbackPath = if ($stored.PSObject.Properties.Name -contains 'callbackPath') { [string]$stored.callbackPath } else { '/wecom/callback' }
        wecomToken = $token
        wecomEncodingAesKey = $aesKey
        wecomReceiveId = if ($stored.PSObject.Properties.Name -contains 'wecomReceiveId') { [string]$stored.wecomReceiveId } else { '' }
        modelEndpoint = [string]$stored.modelEndpoint
        modelApiKey = $modelApiKey
        modelName = [string]$stored.modelName
        modelTimeoutMs = if ($stored.PSObject.Properties.Name -contains 'modelTimeoutMs') { [int]$stored.modelTimeoutMs } else { 120000 }
        accessPolicyPath = [string]$stored.accessPolicyPath
    } | ConvertTo-Json -Compress
} finally {
    $token = $null
    $aesKey = $null
    $modelApiKey = $null
}
