[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [string]$SourceDirectory=$PSScriptRoot,
    [switch]$TestHooks
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not [IO.File]::Exists($compiler)) { throw 'Native x64 .NET Framework compiler unavailable.' }
$destination = [IO.Path]::GetFullPath($OutputDirectory)
if (-not [IO.Directory]::Exists($destination)) { [void][IO.Directory]::CreateDirectory($destination) }
$cursor = $destination
while ($cursor) {
    if (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse build output ancestor rejected: $cursor" }
    $cursor = [IO.Path]::GetDirectoryName($cursor.TrimEnd('\'))
}
$output = Join-Path $destination 'fvs-windows-launcher.exe'
$receipt = Join-Path $destination 'fvs-windows-launcher.build.json'
if ([IO.File]::Exists($output) -or [IO.File]::Exists($receipt)) { throw 'Immutable launcher output or receipt already exists.' }
$names = @('NativeMethods.cs','NativeExtra.cs','VerifiedPrivateLeafCleanup.cs','FvsWindowsLauncher.cs','WindowsLifecycle.cs')
$sourceRoot=[IO.Path]::GetFullPath($SourceDirectory)
$sources = @($names | ForEach-Object { [ordered]@{file=$_;sha256=(Get-FileHash -LiteralPath (Join-Path $sourceRoot $_) -Algorithm SHA256).Hash.ToLowerInvariant()} })
# Sort filename strings explicitly: Sort-Object's hashtable property lookup is
# not the source-set contract. Preserve the original compiler argument order.
$identityNames = [string[]]$names.Clone()
[Array]::Sort($identityNames, [StringComparer]::Ordinal)
$sourceHashes = @{}
foreach ($source in $sources) { $sourceHashes[[string]$source.file] = [string]$source.sha256 }
$identityParts = foreach ($name in $identityNames) { $name + [char]0 + $sourceHashes[$name] + [char]10 }
$identityText = $identityParts -join ''
$sha = [Security.Cryptography.SHA256]::Create()
try { $sourceSet = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($identityText))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
$arguments = @('/nologo','/platform:x64','/target:exe','/optimize+','/reference:System.Web.Extensions.dll',('/out:'+$output))
if ($TestHooks) { $arguments += '/define:FVS_NATIVE_TEST_HOOKS' }
$arguments += $names | ForEach-Object { Join-Path $sourceRoot $_ }
& $compiler @arguments
if ($LASTEXITCODE -ne 0) { throw "Native launcher compilation failed: $LASTEXITCODE" }
$manifest = [ordered]@{
    schema='fvs/windows-launcher-build/v2'; testHooks=[bool]$TestHooks
    compiler=$compiler; compilerSha256=(Get-FileHash -LiteralPath $compiler -Algorithm SHA256).Hash.ToLowerInvariant()
    compilerVersion=[Diagnostics.FileVersionInfo]::GetVersionInfo($compiler).FileVersion
    sourceSetSha256=$sourceSet; sources=$sources
    recipeSha256=(Get-FileHash -LiteralPath (Join-Path $sourceRoot 'Build-Launcher.ps1') -Algorithm SHA256).Hash.ToLowerInvariant()
    launcher=$output; launcherSha256=(Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
    target='windows-x64'; protocol='fvs/windows-native/v2'
}
$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($manifest | ConvertTo-Json -Depth 6)+[char]10)
$stream=[IO.File]::Open($receipt,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
$manifest | ConvertTo-Json -Depth 6
