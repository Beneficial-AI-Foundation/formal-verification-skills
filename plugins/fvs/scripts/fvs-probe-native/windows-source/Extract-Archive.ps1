param([Parameter(Mandatory=$true)][string]$Archive,[Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference='Stop'
if(Test-Path -LiteralPath $Destination){throw 'Archive destination already exists'}
[IO.Directory]::CreateDirectory($Destination) | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=[IO.Compression.ZipFile]::OpenRead($Archive)
try {
 $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
 $total=[Int64]0
 foreach($entry in $zip.Entries){
  $name=$entry.FullName.Replace('\','/')
  if($name.StartsWith('/') -or $name.Contains(':')){throw "Invalid archive path: $name"}
  $segments=$name.TrimEnd('/').Split('/')
  foreach($segment in $segments){if(!$segment -or $segment -eq '.' -or $segment -eq '..' -or $segment -match '[. ]$|[<>"|?*\x00-\x1f]' -or $segment -match '^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)'){throw "Invalid archive path: $name"}}
  if(!$seen.Add($name.TrimEnd('/'))){throw "Duplicate archive member: $name"}
  $kind=($entry.ExternalAttributes -shr 16) -band 0xF000
  if($kind -ne 0 -and $kind -ne 0x8000 -and $kind -ne 0x4000){throw "Special archive member: $name"}
  $total += $entry.Length
  if($total -gt 12GB -or $seen.Count -gt 200000){throw 'Archive expansion limit exceeded'}
 }
 foreach($entry in $zip.Entries){
  $target=Join-Path $Destination $entry.FullName
  if($entry.FullName.EndsWith('/')){[IO.Directory]::CreateDirectory($target)|Out-Null;continue}
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))|Out-Null
  [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$target,$false)
 }
} finally {$zip.Dispose()}
