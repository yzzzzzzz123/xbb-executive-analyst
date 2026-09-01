[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$server = Join-Path $projectRoot 'shared\wecom\server.js'
if (-not (Test-Path -LiteralPath $server -PathType Leaf)) { throw "服务入口不存在：$server" }
& node $server
if ($LASTEXITCODE -ne 0) { throw "企业微信机器人服务退出，代码：$LASTEXITCODE" }
