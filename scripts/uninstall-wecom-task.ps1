[CmdletBinding()]
param(
    [string]$TaskName = 'Codex-XBB-Executive-Analyst-WeCom'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $existing) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Write-Output ([ordered]@{ success = $true; taskName = $TaskName; removed = ($null -ne $existing) } | ConvertTo-Json -Compress)
