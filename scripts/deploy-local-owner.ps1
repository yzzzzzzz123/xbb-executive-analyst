[CmdletBinding()]
param(
    [string]$TaskName = 'Codex-XBB-Executive-Analyst-WeCom'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$configure = Join-Path $projectRoot 'scripts\configure-bot.ps1'
$checkAuth = Join-Path $projectRoot 'shared\wecom\check-auth.js'
$discover = Join-Path $projectRoot 'shared\wecom\discover-user.js'
$configurePolicy = Join-Path $projectRoot 'scripts\configure-access-policy.ps1'
$installTask = Join-Path $projectRoot 'scripts\install-wecom-task.ps1'

foreach ($required in @($configure, $checkAuth, $discover, $configurePolicy, $installTask)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required deployment entry is missing: $required" }
}

Write-Host 'XBB Executive Analyst - local WeCom bot deployment' -ForegroundColor Cyan
Write-Host 'Enter Secret only as SecureString in this window. Never put it in chat or a command line.'

function Get-AuthenticationResult {
    $text = (& node $checkAuth 2>$null) | Select-Object -Last 1
    $exitCode = $LASTEXITCODE
    $payload = $null
    try { $payload = $text | ConvertFrom-Json } catch {}
    return [pscustomobject]@{ ExitCode = $exitCode; Payload = $payload }
}

$authentication = Get-AuthenticationResult
if ($authentication.ExitCode -eq 0 -and $null -ne $authentication.Payload -and $authentication.Payload.success) {
    Write-Host 'Existing encrypted configuration passed WeCom authentication; credential input was skipped.' -ForegroundColor Green
} else {
    while ($true) {
        & $configure | Out-Null

        $authentication = Get-AuthenticationResult
        if ($authentication.ExitCode -eq 0 -and $null -ne $authentication.Payload -and $authentication.Payload.success) {
            Write-Host 'WeCom long-connection authentication succeeded.' -ForegroundColor Green
            break
        }

        $code = if ($null -ne $authentication.Payload -and $null -ne $authentication.Payload.errorCode) { [string]$authentication.Payload.errorCode } else { 'unknown' }
        Write-Host "WeCom authentication failed (error code: $code). Confirm long-connection mode and obtain the current Secret." -ForegroundColor Red
        Write-Host 'Press Enter to retry Bot ID and Secret, or Ctrl+C to exit.' -ForegroundColor Yellow
        Read-Host | Out-Null
    }
}

Write-Host 'A five-minute pairing phrase is being generated. Send the displayed pairingPhrase to the bot in a WeCom private chat.' -ForegroundColor Cyan

$startInfo = [Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = 'node.exe'
$startInfo.Arguments = '"' + $discover + '"'
$startInfo.WorkingDirectory = $projectRoot
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $false
$startInfo.CreateNoWindow = $true

$process = [Diagnostics.Process]::new()
$process.StartInfo = $startInfo
if (-not $process.Start()) { throw 'Unable to start WeCom USERID pairing.' }

$binding = $null
while (-not $process.StandardOutput.EndOfStream) {
    $line = $process.StandardOutput.ReadLine()
    if (-not [string]::IsNullOrWhiteSpace($line)) { Write-Host $line }
    try {
        $value = $line | ConvertFrom-Json
        if ($value.success -and -not [string]::IsNullOrWhiteSpace([string]$value.userId)) { $binding = $value }
    } catch {}
}
$process.WaitForExit()
if ($process.ExitCode -ne 0 -or $null -eq $binding) { throw 'WeCom USERID pairing was not completed. Run this script again.' }

& $configurePolicy -UserId ([string]$binding.userId) -AllowAll | Out-Null
Write-Host 'Group-wide read-only access was configured for the paired USERID.' -ForegroundColor Green

& $installTask -TaskName $TaskName | Out-Null
Start-Sleep -Seconds 2
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
if ($task.State -notin @('Running', 'Ready')) { throw "Unexpected scheduled task state: $($task.State)" }

Write-Host 'Deployment complete: the WeCom bot is running and will start after this Windows user logs in.' -ForegroundColor Green
Write-Host 'The bot is offline while the PC is powered off, asleep, disconnected, or signed out.' -ForegroundColor Yellow
