<#
.SYNOPSIS
    Installs OpenConsole for the current user (no administrator rights needed). In the source repository it builds
    OpenConsole first; in the downloaded zip it installs the OpenConsole.exe that is next to this script.

.DESCRIPTION
    From source (this repository):
    1. Checks the prerequisites (Visual Studio C++ build tools, Windows SDK, Git).
    2. Restores the NuGet packages and fetches vcpkg (only the first time).
    3. Builds OpenConsole.exe with MSBuild.
    From the downloaded zip, steps 1 to 3 are skipped. Then, in both cases:
    4. Copies it to %LOCALAPPDATA%\Programs\OpenConsole and configures it for Arabic/Hebrew text:
       - the DirectX renderer, Cascadia Mono, a bar cursor (settings for this program only),
       - an "OpenConsole" shortcut on the desktop and in the Start menu,
       - an "Open OpenConsole here" entry in the right-click menu of folders and folder backgrounds.
    5. If Visual Studio Code is installed, adds the OpenConsole tab to it (a terminal in the panel with correct Arabic and Hebrew;
       the file openconsole-terminal-*.vsix that ships in the zip; from the source repository use -VSCode). Use -NoVSCode to skip this.

    Run it from a normal PowerShell window, or double-click install.cmd.
    Use -Uninstall to remove everything it created. The console settings of the rest of Windows are never touched.

.PARAMETER Configuration
    Release (default) or Debug.

.PARAMETER SkipBuild
    Do not build; install the OpenConsole.exe that is already in bin\x64\<Configuration>.

.PARAMETER BuildOnly
    Only build (used by package.ps1), do not install.

.PARAMETER Uninstall
    Remove the shortcuts, the right-click entries, the settings, the installed program and the VS Code extension.

.PARAMETER Name
    Name of the shortcuts, the right-click entries and the settings key. Default: OpenConsole.
    Renaming a shortcut later makes Windows look for the settings under the new name, so keep it.

.PARAMETER Shell
    The program that OpenConsole starts. Default: powershell.exe (pwsh.exe and cmd.exe also work).

.PARAMETER FontName
    A fixed-width font. Default: Cascadia Mono if it is installed, otherwise Consolas.

.PARAMETER FontSize
    Font size in points. Default: 12.

.PARAMETER IconFont
    A font used only for the icons (the private use area symbols) that programs draw, for example "CaskaydiaCove NFM",
    a Nerd Font. The regular font stays the one above, and the text is not affected. Default: none. At most 31 characters.

.PARAMETER NoVSCode
    Do not add the OpenConsole tab to Visual Studio Code (and do not remove it with -Uninstall).

.PARAMETER VSCode
    (Source repository only) also build the VS Code extension and install it. The downloaded zip installs it by default.

.PARAMETER VSCodeExtensionsDir
    Install the VS Code extension into this extensions folder (a portable VS Code, or a test) instead of the default one.

.PARAMETER BidiMode
    How right-to-left text is laid out: 0 = not at all, 1 = reorder it, 2 = the program already reordered it.
    Default: automatic (reorder it, except while claude.exe runs in the window). Leave it alone unless you know why.

.EXAMPLE
    .\install.ps1
    .\install.ps1 -SkipBuild -FontSize 16
    .\install.ps1 -Configuration Debug -Launch
    .\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [ValidateSet('Release', 'Debug')]
    [string]$Configuration = 'Release',
    [switch]$SkipBuild,
    [switch]$BuildOnly,
    [switch]$Uninstall,
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\OpenConsole'),
    [string]$Name = 'OpenConsole',
    [ValidateSet('powershell.exe', 'pwsh.exe', 'cmd.exe')]
    [string]$Shell = 'powershell.exe',
    [string]$FontName,
    [ValidateRange(6, 72)]
    [int]$FontSize = 12,
    [ValidateLength(0, 31)]
    [string]$IconFont,
    [ValidateRange(-1, 2)]
    [int]$BidiMode = -1,
    [switch]$NoDesktopShortcut,
    [switch]$NoStartMenu,
    [switch]$NoContextMenu,
    [switch]$NoVSCode,
    [switch]$VSCode,
    [string]$VSCodeExtensionsDir,
    [switch]$Launch
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

# Errors the user can act on are shown as a plain message, without PowerShell's technical error record.
function Stop-Install([string]$Message) {
    Write-Host ''
    Write-Host $Message -ForegroundColor Red
    exit 1
}
$exe = Join-Path $InstallDir 'OpenConsole.exe'
$vscodeScript = Join-Path $root 'install-vscode.ps1'

# Runs install-vscode.ps1; a problem there is a warning, because OpenConsole itself is installed (or removed) by then.
function Invoke-VSCodeInstaller([hashtable]$Arguments, [string]$WhatFailed) {
    if ($VSCodeExtensionsDir) { $Arguments.ExtensionsDir = $VSCodeExtensionsDir }
    $global:LASTEXITCODE = 0
    try { & $vscodeScript @Arguments } catch { Write-Warning "${WhatFailed}: $($_.Exception.Message)"; return }
    if ($LASTEXITCODE -ne 0) { Write-Warning "$WhatFailed. Run Install-VSCode.cmd to try again." }
}

# The same script ships in the downloaded zip, next to a ready-made OpenConsole.exe and without the source code.
$isSourceTree = Test-Path -LiteralPath (Join-Path $root 'src\host\exe\Host.EXE.vcxproj')
$packagedExe = Join-Path $root 'OpenConsole.exe'
if (-not $isSourceTree) {
    if (-not $Uninstall -and -not (Test-Path -LiteralPath $packagedExe)) {
        Stop-Install 'OpenConsole.exe was not found next to this script. Extract the whole zip file first (right-click it, then Extract All) and run Install.cmd again.'
    }
    $SkipBuild = $true
}

function Write-Step([string]$Text) {
    Write-Host ''
    Write-Host "==> $Text" -ForegroundColor Cyan
}

# conhost keeps the settings of a program in HKCU\Console\<its path with every backslash replaced by an underscore>.
# For a program that was started from a shortcut, the key is named like the shortcut (without ".lnk").
function Get-ExeSettingsKeyName([string]$Path) {
    return $Path.Replace('\', '_')
}

function Get-ShortcutPaths {
    $paths = @()
    if (-not $NoDesktopShortcut) { $paths += Join-Path ([Environment]::GetFolderPath('Desktop')) "$Name.lnk" }
    if (-not $NoStartMenu) { $paths += Join-Path ([Environment]::GetFolderPath('Programs')) "$Name.lnk" }
    return $paths
}

function Get-VerbCommand {
    switch ($Shell) {
        'cmd.exe' { return "`"$exe`" cmd.exe /k pushd `"%V`"" }
        default { return "`"$exe`" $Shell -NoExit -Command `"Set-Location -LiteralPath '%V'`"" }
    }
}

$verbParents = @('Directory\Background', 'Directory')

# ----------------------------------------------------------------------------------------------------------------------
if ($Uninstall) {
    Write-Step "Removing $Name"
    foreach ($p in @(
            (Join-Path ([Environment]::GetFolderPath('Desktop')) "$Name.lnk"),
            (Join-Path ([Environment]::GetFolderPath('Programs')) "$Name.lnk"))) {
        if (Test-Path -LiteralPath $p) {
            Remove-Item -LiteralPath $p -Force
            Write-Host "removed $p"
        }
    }
    $hkcu = [Microsoft.Win32.Registry]::CurrentUser
    foreach ($parent in $verbParents) {
        $hkcu.DeleteSubKeyTree("Software\Classes\$parent\shell\$Name", $false)
    }
    $hkcu.DeleteSubKeyTree("Console\$Name", $false)
    $hkcu.DeleteSubKeyTree("Console\$(Get-ExeSettingsKeyName $exe)", $false)
    Write-Host 'removed the right-click entries and the settings'
    if (Test-Path -LiteralPath $InstallDir) {
        foreach ($f in Get-ChildItem -LiteralPath $InstallDir -Filter 'OpenConsole*.exe') {
            try { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop } catch { Write-Warning "$($f.Name) is still running; close its windows and run -Uninstall again." }
        }
        if (-not (Get-ChildItem -LiteralPath $InstallDir -Force)) { Remove-Item -LiteralPath $InstallDir -Force }
    }
    if (-not $NoVSCode -and (Test-Path -LiteralPath $vscodeScript)) {
        Write-Step 'Removing the OpenConsole tab from Visual Studio Code'
        Invoke-VSCodeInstaller @{ Uninstall = $true; SkipIfMissing = $true } 'The VS Code extension could not be removed'
    }
    Write-Host 'Done.' -ForegroundColor Green
    return
}

# ----------------------------------------------------------------------------------------------------------------------
if (-not $SkipBuild) {
    Write-Step 'Checking the prerequisites'

    if ($root -match '\s') {
        Stop-Install "The folder '$root' contains spaces. Move the repository to a path without spaces (for example C:\src\openconsole) and run this script again."
    }

    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $vs = $null
    if (Test-Path -LiteralPath $vswhere) {
        $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1
    }
    if (-not $vs) {
        Write-Host 'Visual Studio with the C++ build tools was not found. Install them with this command, then run the script again:' -ForegroundColor Yellow
        Write-Host '  winget install --id Microsoft.VisualStudio.BuildTools --exact --override "--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"' -ForegroundColor Yellow
        Stop-Install 'Missing prerequisite: Visual Studio C++ build tools (2022 or 2026).'
    }
    Write-Host "Visual Studio: $vs"

    if (-not (Test-Path -LiteralPath (Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\Include\10.0.26100.0'))) {
        Write-Warning 'Windows SDK 10.0.26100.0 was not found. In the Visual Studio Installer, add the component "Windows 11 SDK (10.0.26100)" if the build fails.'
    }

    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Write-Host 'Git is required (it downloads vcpkg). Install it with: winget install --id Git.Git --exact' -ForegroundColor Yellow
        Stop-Install 'Missing prerequisite: Git.'
    }

    Push-Location $root
    try {
        Write-Step 'Restoring the NuGet packages'
        $nuget = Join-Path $root 'dep\nuget\nuget.exe'
        if (-not (Test-Path -LiteralPath $nuget)) {
            New-Item -ItemType Directory -Force (Split-Path $nuget) | Out-Null
            try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
            Invoke-WebRequest -UseBasicParsing -Uri 'https://dist.nuget.org/win-x86-commandline/latest/nuget.exe' -OutFile $nuget
        }
        & $nuget restore (Join-Path $root 'dep\nuget\packages.config') -NonInteractive
        if ($LASTEXITCODE -ne 0) { Stop-Install "NuGet restore failed (exit code $LASTEXITCODE)." }

        Write-Step 'Setting up vcpkg (the C++ package manager; the first run takes a minute)'
        $vcpkgDir = Join-Path $root 'dep\vcpkg'
        if (-not (Test-Path -LiteralPath (Join-Path $vcpkgDir 'vcpkg.exe'))) {
            if (-not (Test-Path -LiteralPath (Join-Path $vcpkgDir 'bootstrap-vcpkg.bat'))) {
                git clone --filter=blob:none https://github.com/microsoft/vcpkg $vcpkgDir
                if ($LASTEXITCODE -ne 0) { Stop-Install "Cloning vcpkg into '$vcpkgDir' failed (the folder must be empty or missing)." }
            }
            cmd /c "`"$vcpkgDir\bootstrap-vcpkg.bat`" -disableMetrics"
            if (-not (Test-Path -LiteralPath (Join-Path $vcpkgDir 'vcpkg.exe'))) { Stop-Install 'Bootstrapping vcpkg failed.' }
        }

        Write-Step "Building OpenConsole ($Configuration, x64). The first build takes a few minutes."
        $log = Join-Path $root 'openconsole-build.log'
        $project = Join-Path $root 'src\host\exe\Host.EXE.vcxproj'
        $vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
        $bat = Join-Path ([IO.Path]::GetTempPath()) 'openconsole-build.cmd'
        @(
            '@echo off',
            "call `"$vcvars`" >nul 2>nul || exit /b 1",
            "cd /d `"$root`"",
            "msbuild `"$project`" /p:Configuration=$Configuration /p:Platform=x64 `"/p:SolutionDir=$root\\`" /m /nologo /v:m /fl `"/flp:logfile=$log;verbosity=normal`""
        ) | Set-Content -Path $bat -Encoding Ascii
        $timer = [Diagnostics.Stopwatch]::StartNew()
        cmd /c "`"$bat`""
        $buildExit = $LASTEXITCODE
        Remove-Item -LiteralPath $bat -Force -ErrorAction SilentlyContinue
        if ($buildExit -ne 0) {
            Write-Host 'The first errors of the build:' -ForegroundColor Yellow
            if (Test-Path -LiteralPath $log) {
                Select-String -Path $log -Pattern ': error ' | Select-Object -First 8 | ForEach-Object { Write-Host "  $($_.Line.Trim())" }
            }
            Stop-Install "The build failed (exit code $buildExit). The full log is in $log"
        }
        Write-Host ("Build finished in {0:N0} s." -f $timer.Elapsed.TotalSeconds) -ForegroundColor Green
    }
    finally {
        Pop-Location
    }
}

# ----------------------------------------------------------------------------------------------------------------------
if ($BuildOnly) {
    Write-Host "Built $(Join-Path $root "bin\x64\$Configuration\OpenConsole.exe")" -ForegroundColor Green
    return
}

Write-Step "Installing to $InstallDir"
$built = if ($isSourceTree) { Join-Path $root "bin\x64\$Configuration\OpenConsole.exe" } else { $packagedExe }
if (-not (Test-Path -LiteralPath $built)) {
    Stop-Install "$built does not exist. Run the script without -SkipBuild first."
}
New-Item -ItemType Directory -Force $InstallDir | Out-Null
# A program that is running can be renamed but not overwritten. That way, updating works while windows are open.
foreach ($f in Get-ChildItem -LiteralPath $InstallDir -Filter 'OpenConsole.old*.exe') {
    try { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop } catch {}
}
if (Test-Path -LiteralPath $exe) {
    $previous = Join-Path $InstallDir ('OpenConsole.old{0}.exe' -f (Get-Date -Format 'HHmmssfff'))
    Move-Item -LiteralPath $exe -Destination $previous -Force
    # Gone right away unless windows still run it, in which case the next update or -Uninstall removes it.
    try { Remove-Item -LiteralPath $previous -Force -ErrorAction Stop } catch {}
}
Copy-Item -LiteralPath $built -Destination $exe -Force
Write-Host $exe

Write-Step 'Configuring the console (only for this program)'
Add-Type -AssemblyName System.Drawing
$installedFonts = (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }
$font = if ($FontName) { $FontName } elseif ($installedFonts -contains 'Cascadia Mono') { 'Cascadia Mono' } else { 'Consolas' }
$dword = [Microsoft.Win32.RegistryValueKind]::DWord
$hkcu = [Microsoft.Win32.Registry]::CurrentUser
foreach ($keyName in @($Name, (Get-ExeSettingsKeyName $exe))) {
    $key = $hkcu.CreateSubKey("Console\$keyName")
    try {
        $key.SetValue('UseDx', 1, $dword)               # the DirectX (Atlas) renderer, which is where the Arabic support lives
        $key.SetValue('FaceName', $font, [Microsoft.Win32.RegistryValueKind]::String)
        $key.SetValue('FontFamily', 54, $dword)         # TrueType, fixed pitch
        $key.SetValue('FontWeight', 400, $dword)
        $key.SetValue('FontSize', ($FontSize * 0x10000), $dword)   # in points; the height is stored in the high word
        $key.SetValue('CursorType', 1, $dword)          # bar
        if ($IconFont) { $key.SetValue('IconFont', $IconFont, [Microsoft.Win32.RegistryValueKind]::String) } else { $key.DeleteValue('IconFont', $false) }
        if ($BidiMode -ge 0) { $key.SetValue('BidiMode', $BidiMode, $dword) } else { $key.DeleteValue('BidiMode', $false) }
    }
    finally { $key.Close() }
}
Write-Host "font: $font $FontSize pt, renderer: DirectX (settings key HKCU\Console\$Name)"
if ($IconFont) {
    Write-Host "icon font: $IconFont"
    if ($installedFonts -notcontains $IconFont) { Write-Warning "The font '$IconFont' is not installed, so the icons will not show. Install it, or check the name." }
}

if ($NoDesktopShortcut -and $NoStartMenu) {
    Write-Host 'skipping the shortcuts'
}
else {
    Write-Step 'Creating the shortcuts'
    $wsh = New-Object -ComObject WScript.Shell
    foreach ($path in Get-ShortcutPaths) {
        # The Properties dialog can store the font and colors inside the .lnk, and those win over the registry. Saving over the
        # old file keeps them, so start from an empty file.
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
        $link = $wsh.CreateShortcut($path)
        $link.TargetPath = $exe
        $link.Arguments = $Shell
        $link.WorkingDirectory = $env:USERPROFILE
        $link.IconLocation = "$exe,0"
        $link.Description = 'OpenConsole - a console with Arabic and Hebrew text support'
        $link.Save()
        Write-Host $path
    }
}

if (-not $NoContextMenu) {
    Write-Step 'Adding "Open ... here" to the right-click menu'
    foreach ($parent in $verbParents) {
        $verb = $hkcu.CreateSubKey("Software\Classes\$parent\shell\$Name")
        try {
            $verb.SetValue('', "Open $Name here")
            $verb.SetValue('Icon', "`"$exe`",0")
            $cmd = $verb.CreateSubKey('command')
            try { $cmd.SetValue('', (Get-VerbCommand)) } finally { $cmd.Close() }
        }
        finally { $verb.Close() }
    }
    Write-Host "Open $Name here"
}

$hasExtensionPackage = [bool](Get-ChildItem -LiteralPath $root -Filter 'openconsole-terminal*.vsix' -File -ErrorAction SilentlyContinue)
if (-not $NoVSCode -and (Test-Path -LiteralPath $vscodeScript) -and ($hasExtensionPackage -or $VSCode)) {
    Write-Step 'Adding the OpenConsole tab to Visual Studio Code (skipped when it is not installed)'
    Invoke-VSCodeInstaller @{ SkipIfMissing = $true } 'The VS Code extension could not be installed'
}

Write-Host ''
$howToRemove = if ($isSourceTree) { '.\install.ps1 -Uninstall' } else { 'Uninstall.cmd (in the folder you extracted)' }
Write-Host "$Name is installed. To remove it: $howToRemove" -ForegroundColor Green
if ($isSourceTree -and -not $NoVSCode -and -not $VSCode -and -not $hasExtensionPackage) {
    Write-Host 'Tip: .\install-vscode.ps1 adds the OpenConsole tab (Arabic and Hebrew in a terminal panel) to Visual Studio Code.'
}
if ($Launch) {
    Start-Process -FilePath $exe -ArgumentList $Shell -WorkingDirectory $env:USERPROFILE
}
