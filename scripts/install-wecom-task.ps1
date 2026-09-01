[CmdletBinding()]
param(
    [string]$TaskName = 'Codex-XBB-Executive-Analyst-WeCom'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$startScript = Join-Path $projectRoot 'scripts\start-wecom-bot.ps1'
$configPath = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Codex\xbb-executive-analyst\bot-config.json'
if (-not (Test-Path -LiteralPath $startScript -PathType Leaf)) { throw "启动脚本不存在：$startScript" }
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw "机器人安全配置不存在，请先运行 configure-bot.ps1：$configPath" }

$argument = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`""
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description '真实只读销帮帮经营分析企业微信智能机器人'
Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Output ([ordered]@{ success = $true; taskName = $TaskName; projectRoot = $projectRoot; started = $true } | ConvertTo-Json -Compress)
