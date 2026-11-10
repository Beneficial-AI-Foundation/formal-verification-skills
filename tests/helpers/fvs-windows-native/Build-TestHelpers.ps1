param([Parameter(Mandatory=$true)][string]$OutputDirectory,[string]$GoExecutable,[string]$SourceDirectory=$PSScriptRoot)
$ErrorActionPreference='Stop'
$destination=[IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($destination)|Out-Null
$compiler=Join-Path ([Environment]::GetFolderPath('Windows')) 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$job=Join-Path $destination 'job-holder.exe'
if(Test-Path -LiteralPath $job){throw 'Refusing to overwrite an existing test helper'}
& $compiler /nologo /target:exe /platform:x64 "/out:$job" (Join-Path $SourceDirectory 'JobHolder.cs')
if($LASTEXITCODE -ne 0){throw 'Job holder compilation failed'}
if($GoExecutable){
 $canary=Join-Path $destination 'native-canary.exe'
 if(Test-Path -LiteralPath $canary){throw 'Refusing to overwrite an existing canary'}
 $env:GOOS='windows';$env:GOARCH='amd64';$env:CGO_ENABLED='0';$env:GOTOOLCHAIN='local';$env:GOWORK='off'
 & $GoExecutable build -trimpath -o $canary (Join-Path $SourceDirectory 'canary.go')
 if($LASTEXITCODE -ne 0){throw 'Canary compilation failed'}
}
Get-ChildItem -LiteralPath $destination -File | ForEach-Object {Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256}
