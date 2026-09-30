<#
.SYNOPSIS
    Adds the OpenConsole terminal to Visual Studio Code: a tab "OpenConsole" in the panel that shows Arabic and Hebrew correctly.

.DESCRIPTION
    Installs the extension file (openconsole-terminal-*.vsix) that is next to this script into every Visual Studio Code that it
    finds (the normal one and Insiders). Nothing else is changed. In the source repository, when there is no .vsix yet, it builds one
    first (that needs Node.js and the Visual Studio C++ build tools). No administrator rights are needed.

    Run it from a normal PowerShell window, or double-click Install-VSCode.cmd. Use -Uninstall to remove the extension again.
    Windows of VS Code that are already open have to be reloaded (Ctrl+Shift+P, "Developer: Reload Window").

.PARAMETER Uninstall
    Remove the extension.

.PARAMETER Cli
    The command line tool of an editor that is based on VS Code (code.cmd, code-insiders.cmd, codium.cmd, cursor.cmd, ...),
    when it is not found automatically. Several can be given.

.PARAMETER ExtensionsDir
    Use this extensions folder instead of the default one (a portable VS Code, or a test).

.PARAMETER SkipIfMissing
    When VS Code is not installed, say so and finish without an error (install.ps1 uses this).

.PARAMETER Force
    Install again even if the same version is already installed.

.PARAMETER Rebuild
    (Source repository only) build the extension again even if a .vsix exists.

.EXAMPLE
    .\install-vscode.ps1
    .\install-vscode.ps1 -Uninstall
    .\install-vscode.ps1 -Cli C:\Tools\VSCode\bin\code.cmd
#>
[CmdletBinding()]
param(
    [switch]$Uninstall,
    [string[]]$Cli,
    [string]$ExtensionsDir,
    [switch]$SkipIfMissing,
    [switch]$Force,
    [switch]$Rebuild
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$extensionId = 'openconsole.openconsole-terminal'

# Errors the user can act on are shown as a plain message, without PowerShell's technical error record.
function Stop-Install([string]$Message) {
    Write-Host ''
    Write-Host $Message -ForegroundColor Red
    exit 1
}

# The command line tools of the VS Code installations on this computer.
function Find-VSCode {
    $found = [ordered]@{}
    if ($Cli) {
        foreach ($c in $Cli) {
            if (-not (Test-Path -LiteralPath $c)) { Stop-Install "The file '$c' does not exist." }
            $full = (Resolve-Path -LiteralPath $c).Path
            $found[$full.ToLowerInvariant()] = $full
        }
        return @($found.Values)
    }
    $candidates = @()
    if ($env:LOCALAPPDATA) {
        $candidates += Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin\code.cmd'
        $candidates += Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code Insiders\bin\code-insiders.cmd'
    }
    foreach ($programFiles in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if ($programFiles) {
            $candidates += Join-Path $programFiles 'Microsoft VS Code\bin\code.cmd'
            $candidates += Join-Path $programFiles 'Microsoft VS Code Insiders\bin\code-insiders.cmd'
        }
    }
    $onPath = Get-Command 'code.cmd', 'code-insiders.cmd' -ErrorAction SilentlyContinue
    foreach ($c in $onPath) { $candidates += $c.Source }
    foreach ($c in $candidates) {
        if (Test-Path -LiteralPath $c) {
            $full = (Resolve-Path -LiteralPath $c).Path
            $found[$full.ToLowerInvariant()] = $full
        }
    }
    return @($found.Values)
}

# Runs the command line tool of VS Code and returns its output lines and exit code (its warnings about old Node.js code are dropped).
function Invoke-VSCode([string]$Tool, [string[]]$Arguments) {
    $all = @()
    if ($ExtensionsDir) { $all += '--extensions-dir', $ExtensionsDir }
    $all += $Arguments
    # The tool writes warnings to its error stream; they must not stop this script.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $Tool @all 2>&1
        $code = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $previous }
    $lines = @($output | ForEach-Object { "$_" } | Where-Object { $_ -and $_ -notmatch '^\(node:\d+\)|^\(Use `|DeprecationWarning' })
    return [pscustomobject]@{ Lines = $lines; ExitCode = $code }
}

function Get-InstalledVersion([string]$Tool) {
    $result = Invoke-VSCode $Tool @('--list-extensions', '--show-versions')
    foreach ($l in $result.Lines) {
        if ($l -match ('^' + [regex]::Escape($extensionId) + '@(.+)$')) { return $Matches[1].Trim() }
    }
    return $null
}

function Find-Package {
    $found = Get-ChildItem -LiteralPath $root -Filter 'openconsole-terminal*.vsix' -File -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
    if ($found) { return $found.FullName }

    $source = Join-Path $root 'vscode-extension'
    if (-not (Test-Path -LiteralPath (Join-Path $source 'package.json'))) { return $null }
    if (-not $Rebuild) {
        $built = Get-ChildItem -LiteralPath $source -Filter '*.vsix' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($built) { return $built.FullName }
    }
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-Host 'Building the extension needs Node.js. Install it with: winget install --id OpenJS.NodeJS.LTS --exact' -ForegroundColor Yellow
        Stop-Install 'Missing prerequisite: Node.js (or put a openconsole-terminal-*.vsix next to this script).'
    }
    Write-Host 'Building the extension (the first time this downloads a few packages)...'
    Push-Location $source
    try {
        foreach ($step in @('install --no-audit --no-fund', 'run build', 'run build:native', 'run package')) {
            & cmd.exe /c "npm $step"
            if ($LASTEXITCODE -ne 0) { Stop-Install "'npm $step' failed (exit code $LASTEXITCODE)." }
        }
    }
    finally { Pop-Location }
    $built = Get-ChildItem -LiteralPath $source -Filter '*.vsix' -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $built) { Stop-Install 'The build did not produce a .vsix file.' }
    return $built.FullName
}

# ----------------------------------------------------------------------------------------------------------------------
$tools = Find-VSCode
if (-not $tools) {
    if ($SkipIfMissing) {
        if ($Uninstall) { Write-Host 'Visual Studio Code was not found, so there is nothing to remove from it.' }
        else { Write-Host 'Visual Studio Code was not found, so the OpenConsole tab is not added to it. (Run Install-VSCode.cmd after installing VS Code.)' }
        exit 0
    }
    Write-Host 'Visual Studio Code was not found. Install it from https://code.visualstudio.com/ (or: winget install --id Microsoft.VisualStudioCode --exact),' -ForegroundColor Yellow
    Write-Host 'then run this again. For a portable VS Code, use -Cli <path of its bin\code.cmd>.' -ForegroundColor Yellow
    Stop-Install 'Visual Studio Code was not found.'
}

if ($Uninstall) {
    $removed = 0
    foreach ($tool in $tools) {
        Write-Host "VS Code: $tool"
        if (-not (Get-InstalledVersion $tool)) { Write-Host '  the OpenConsole extension is not installed'; continue }
        $result = Invoke-VSCode $tool @('--uninstall-extension', $extensionId)
        $result.Lines | ForEach-Object { Write-Host "  $_" }
        if ($result.ExitCode -ne 0) { Stop-Install 'Removing the extension failed. Close VS Code and try again.' }
        $removed++
    }
    if ($removed) { Write-Host 'The OpenConsole extension was removed. Reload the open VS Code windows.' -ForegroundColor Green }
    else { Write-Host 'The OpenConsole extension was not installed in VS Code.' }
    exit 0
}

$package = Find-Package
if (-not $package) {
    Stop-Install 'The extension file (openconsole-terminal-*.vsix) was not found next to this script. Extract the whole zip file first, or download the file again.'
}
$packageVersion = if ((Split-Path $package -Leaf) -match '(\d+\.\d+\.\d+[^\\]*)\.vsix$') { $Matches[1] } else { $null }
Write-Host "Extension: $package"

$failed = $false
foreach ($tool in $tools) {
    Write-Host "VS Code: $tool"
    $installed = Get-InstalledVersion $tool
    if ($installed -and $packageVersion -and $installed -eq $packageVersion -and -not $Force) {
        Write-Host "  version $installed is already installed (use -Force to install it again)"
        continue
    }
    $result = Invoke-VSCode $tool @('--install-extension', $package, '--force')
    $result.Lines | ForEach-Object { Write-Host "  $_" }
    if ($result.ExitCode -ne 0) {
        Write-Host '  the installation failed' -ForegroundColor Red
        $failed = $true
    }
}
if ($failed) { Stop-Install 'The extension could not be installed. Close VS Code and run this again.' }

Write-Host ''
Write-Host 'The OpenConsole terminal is in VS Code.' -ForegroundColor Green
Write-Host 'Open a VS Code window, run "Developer: Reload Window" if it was already open, then open the panel (Ctrl+J) and choose the OpenConsole tab.'
