[CmdletBinding()]
param(
    [string]$TaskName = 'Codex-XBB-Executive-Analyst-WeCom'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$server = Join-Path $projectRoot 'shared\wecom\server.js'
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$configPath = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Codex\xbb-executive-analyst\bot-config.json'
if (-not (Test-Path -LiteralPath $server -PathType Leaf)) { throw "服务入口不存在：$server" }
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw "机器人安全配置不存在，请先运行 configure-bot.ps1：$configPath" }

$action = New-ScheduledTaskAction -Execute $nodePath -Argument "`"$server`"" -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Codex App Server + xbb-executive-analyst Skill 企业微信智能 Agent（真实只读销帮帮）'
Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Output ([ordered]@{ success = $true; taskName = $TaskName; projectRoot = $projectRoot; started = $true } | ConvertTo-Json -Compress)
