[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$NodePath,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath,

    [Parameter(Mandatory = $true)]
    [string]$HashPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$source = [IO.Path]::GetFullPath($NodePath)
$target = [IO.Path]::GetFullPath($OutputPath)
$hashFile = [IO.Path]::GetFullPath($HashPath)
$allowedRoot = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Codex\xbb-executive-analyst\bin'))
if (-not $target.StartsWith(($allowedRoot + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe hidden Node output path.' }
if (-not $hashFile.StartsWith(($allowedRoot + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe hidden Node hash path.' }
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw 'Node source executable does not exist.' }

function Get-PeSubsystem([string]$Path) {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $reader = New-Object IO.BinaryReader($stream)
    try {
        if ($stream.Length -lt 256) { throw 'Executable is too small to be a valid PE image.' }
        $stream.Position = 0x3c
        $peOffset = $reader.ReadInt32()
        if ($peOffset -lt 0x40 -or ($peOffset + 96) -gt $stream.Length) { throw 'Invalid PE header offset.' }
        $stream.Position = $peOffset
        if ($reader.ReadUInt32() -ne 0x00004550) { throw 'Invalid PE signature.' }
        $optionalHeaderOffset = $peOffset + 24
        $stream.Position = $optionalHeaderOffset
        $magic = $reader.ReadUInt16()
        if ($magic -ne 0x010b -and $magic -ne 0x020b) { throw 'Unsupported PE optional header.' }
        $stream.Position = $optionalHeaderOffset + 68
        return $reader.ReadUInt16()
    } finally {
        $reader.Dispose()
        $stream.Dispose()
    }
}

[IO.Directory]::CreateDirectory($allowedRoot) | Out-Null
$sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
$installedHash = if (Test-Path -LiteralPath $hashFile -PathType Leaf) { (Get-Content -LiteralPath $hashFile -Raw).Trim().ToLowerInvariant() } else { '' }
if ((Test-Path -LiteralPath $target -PathType Leaf) -and $installedHash -eq $sourceHash -and (Get-PeSubsystem $target) -eq 2) {
    Write-Output ([ordered]@{ success = $true; reused = $true; subsystem = 'windows-gui'; sourceSha256 = $sourceHash } | ConvertTo-Json -Compress)
    return
}

$temporary = Join-Path $allowedRoot ('nodew.tmp-' + [Guid]::NewGuid().ToString('N') + '.exe')
try {
    [IO.File]::Copy($source, $temporary, $false)
    $stream = [IO.File]::Open($temporary, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $reader = New-Object IO.BinaryReader($stream)
    $writer = New-Object IO.BinaryWriter($stream)
    try {
        $stream.Position = 0x3c
        $peOffset = $reader.ReadInt32()
        $stream.Position = $peOffset
        if ($reader.ReadUInt32() -ne 0x00004550) { throw 'Invalid PE signature.' }
        $optionalHeaderOffset = $peOffset + 24
        $stream.Position = $optionalHeaderOffset
        $magic = $reader.ReadUInt16()
        if ($magic -ne 0x010b -and $magic -ne 0x020b) { throw 'Unsupported PE optional header.' }
        $subsystemOffset = $optionalHeaderOffset + 68
        $stream.Position = $subsystemOffset
        $originalSubsystem = $reader.ReadUInt16()
        if ($originalSubsystem -ne 2 -and $originalSubsystem -ne 3) { throw 'Node executable has an unexpected PE subsystem.' }
        $stream.Position = $subsystemOffset
        $writer.Write([uint16]2)
        $writer.Flush()
        $stream.Flush($true)
    } finally {
        $writer.Dispose()
        $reader.Dispose()
        $stream.Dispose()
    }
    if ((Get-PeSubsystem $temporary) -ne 2) { throw 'Hidden Node PE subsystem verification failed.' }
    Move-Item -LiteralPath $temporary -Destination $target -Force
    [IO.File]::WriteAllText($hashFile, ($sourceHash + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
} finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
}

Write-Output ([ordered]@{ success = $true; reused = $false; subsystem = 'windows-gui'; sourceSha256 = $sourceHash } | ConvertTo-Json -Compress)
