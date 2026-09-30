<#
.SYNOPSIS
    Builds bin\conpty-bridge.exe (the program that runs the shell in a pseudo console) with the Visual Studio C++ tools.
#>
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$bin = Join-Path (Split-Path $here -Parent) 'bin'
New-Item -ItemType Directory -Force $bin | Out-Null

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$vs = $null
if (Test-Path -LiteralPath $vswhere) {
    $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1
}
if (-not $vs) { throw 'Visual Studio with the C++ build tools was not found. See the README of the repository for how to install them.' }
$vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'

$obj = Join-Path ([IO.Path]::GetTempPath()) 'conpty-bridge-obj'
New-Item -ItemType Directory -Force $obj | Out-Null
$exe = Join-Path $bin 'conpty-bridge.exe'
$cmd = "`"$vcvars`" >nul && cd /d `"$here`" && cl /nologo /O2 /MT /EHsc /std:c++17 /W4 /WX /utf-8 conpty-bridge.cpp /Fo:`"$obj\\`" /Fe:`"$exe`" /link /INCREMENTAL:NO"
& cmd.exe /c $cmd
if ($LASTEXITCODE -ne 0) { throw "The build failed (exit code $LASTEXITCODE)." }
Write-Host "built $exe ($([math]::Round((Get-Item $exe).Length / 1KB)) KB)"
