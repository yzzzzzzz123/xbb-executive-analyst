[CmdletBinding(DefaultParameterSetName = 'Companies')]
param(
    [Parameter(Mandatory = $true)]
    [string]$UserId,

    [Parameter(Mandatory = $true, ParameterSetName = 'Companies')]
    [string[]]$Company,

    [Parameter(Mandatory = $true, ParameterSetName = 'All')]
    [switch]$AllowAll,

    [string]$Path = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Codex\xbb-executive-analyst\access-policy.json')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$resolved = [IO.Path]::GetFullPath($Path)
$parent = [IO.Path]::GetDirectoryName($resolved)
[IO.Directory]::CreateDirectory($parent) | Out-Null

if ([IO.File]::Exists($resolved)) {
    $policy = Get-Content -LiteralPath $resolved -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$policy.schemaVersion -ne '1.0') { throw '现有访问策略版本不是 1.0。' }
} else {
    $policy = [pscustomobject]@{ schemaVersion = '1.0'; users = [pscustomobject]@{} }
}

$rule = if ($AllowAll) {
    [pscustomobject]@{ scope = 'all' }
} else {
    $companies = @($Company | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -Unique)
    if ($companies.Count -eq 0) { throw '至少需要一个准确公司名称。' }
    [pscustomobject]@{ scope = 'companies'; companies = $companies }
}
$policy.users | Add-Member -NotePropertyName $UserId -NotePropertyValue $rule -Force

$json = $policy | ConvertTo-Json -Depth 20
$temporary = "$resolved.tmp-$PID-$([Guid]::NewGuid().ToString('N'))"
[IO.File]::WriteAllText($temporary, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
try {
    if ([IO.File]::Exists($resolved)) { [IO.File]::Replace($temporary, $resolved, $null) } else { [IO.File]::Move($temporary, $resolved) }
} finally {
    if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
}

Write-Output ([ordered]@{ success = $true; path = $resolved; userId = $UserId; scope = $rule.scope } | ConvertTo-Json -Compress)
