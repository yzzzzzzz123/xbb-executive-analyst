[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$entry = Join-Path $projectRoot 'shared\wecom\discover-user.js'
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw "WeCom user discovery entry is missing: $entry" }

Write-Output 'Stop the production bot first. This process only discovers the USERID that sends the one-time phrase; it does not query XBB.'
& node $entry
if ($LASTEXITCODE -ne 0) { throw "WeCom USERID discovery failed with exit code $LASTEXITCODE" }
