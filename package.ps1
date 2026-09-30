<#
.SYNOPSIS
    Builds OpenConsole and its VS Code extension and packs the ready-to-install download: dist\OpenConsole-x64.zip.

.DESCRIPTION
    The zip holds OpenConsole.exe, Install.cmd / Uninstall.cmd, install.ps1, the VS Code extension (openconsole-terminal-*.vsix)
    with Install-VSCode.cmd / install-vscode.ps1, a short README.txt and the license files.
    Users need nothing else: no Visual Studio, no Git, no Node.js. Attach the zip to a GitHub release. Keep its file name,
    because the Download button of the README points to .../releases/latest/download/OpenConsole-x64.zip.
    The extension file is also written to dist\ on its own, for people who only want that.

.PARAMETER SkipBuild
    Pack the OpenConsole.exe that is already in bin\x64\Release, and the extension package that is already built, instead of
    building them first.

.PARAMETER SkipExtension
    Pack the zip without the VS Code extension (Node.js is not needed then).

.EXAMPLE
    .\package.ps1
#>
[CmdletBinding()]
param([switch]$SkipBuild, [switch]$SkipExtension)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

if (-not $SkipBuild) {
    & (Join-Path $root 'install.ps1') -BuildOnly -Configuration Release
}

$exe = Join-Path $root 'bin\x64\Release\OpenConsole.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw "$exe does not exist. Run the script without -SkipBuild." }

# The VS Code extension: xterm.js + the right-to-left layout in a webview, and a small helper that runs the shell in a pseudo console.
$extensionDir = Join-Path $root 'vscode-extension'
$extension = $null
if (-not $SkipExtension) {
    $existing = Get-ChildItem -LiteralPath $extensionDir -Filter 'openconsole-terminal-*.vsix' -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($SkipBuild -and $existing) {
        $extension = $existing
    }
    elseif (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-Warning 'Node.js was not found, so the zip is packed WITHOUT the VS Code extension. Install Node.js (winget install --id OpenJS.NodeJS.LTS --exact), or use -SkipExtension to hide this warning.'
    }
    else {
        Push-Location $extensionDir
        try {
            foreach ($step in @('install --no-audit --no-fund', 'run build', 'run build:native', 'run package')) {
                Write-Host "==> npm $step" -ForegroundColor Cyan
                & cmd.exe /c "npm $step"
                if ($LASTEXITCODE -ne 0) { throw "'npm $step' failed (exit code $LASTEXITCODE)." }
            }
        }
        finally { Pop-Location }
        $extension = Get-ChildItem -LiteralPath $extensionDir -Filter 'openconsole-terminal-*.vsix' -File |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if (-not $extension) { throw 'The extension build did not produce a .vsix file.' }
    }
}

$dist = Join-Path $root 'dist'
$stage = Join-Path $dist 'OpenConsole-x64'
$zip = Join-Path $dist 'OpenConsole-x64.zip'
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Force $stage | Out-Null

Copy-Item -LiteralPath $exe -Destination $stage
foreach ($name in 'install.ps1', 'LICENSE', 'NOTICE.md') {
    Copy-Item -LiteralPath (Join-Path $root $name) -Destination $stage
}
# The README calls them Install.cmd and Uninstall.cmd, so the zip shows them with that spelling.
Copy-Item -LiteralPath (Join-Path $root 'install.cmd') -Destination (Join-Path $stage 'Install.cmd')
Copy-Item -LiteralPath (Join-Path $root 'uninstall.cmd') -Destination (Join-Path $stage 'Uninstall.cmd')
Copy-Item -LiteralPath (Join-Path $root 'package\README.txt') -Destination $stage
if ($extension) {
    Copy-Item -LiteralPath $extension.FullName -Destination $stage
    Copy-Item -LiteralPath (Join-Path $root 'install-vscode.ps1') -Destination $stage
    Copy-Item -LiteralPath (Join-Path $root 'install-vscode.cmd') -Destination (Join-Path $stage 'Install-VSCode.cmd')
    Copy-Item -LiteralPath $extension.FullName -Destination (Join-Path $dist $extension.Name) -Force
}

if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip
$hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower()
Set-Content -LiteralPath "$zip.sha256" -Value "$hash *OpenConsole-x64.zip" -Encoding Ascii
Remove-Item -LiteralPath $stage -Recurse -Force

Write-Host ''
Write-Host ("Created {0} ({1:N2} MB)" -f $zip, ((Get-Item -LiteralPath $zip).Length / 1MB)) -ForegroundColor Green
Write-Host "SHA-256: $hash"
if ($extension) { Write-Host ("VS Code extension: dist\{0} (also inside the zip)" -f $extension.Name) }
else { Write-Host 'VS Code extension: not included.' -ForegroundColor Yellow }
Write-Host ''
Write-Host 'Publish it: on GitHub open Releases > Draft a new release, attach the files, and publish.'
if ($extension) {
    Write-Host ('With the GitHub CLI: gh release create v1.0.0 dist\OpenConsole-x64.zip dist\OpenConsole-x64.zip.sha256 dist\{0} --title "OpenConsole 1.0.0"' -f $extension.Name)
}
else {
    Write-Host 'With the GitHub CLI: gh release create v1.0.0 dist\OpenConsole-x64.zip dist\OpenConsole-x64.zip.sha256 --title "OpenConsole 1.0.0"'
}
