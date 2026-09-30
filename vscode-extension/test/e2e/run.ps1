<#
.SYNOPSIS
    Starts a separate VS Code (own user data, own extensions folder) with this extension and the test driver loaded, plays the
    steps of a JSON file, and leaves the window open with the debugging port on 9333 so that test\e2e\cdp.js can look at it.
.EXAMPLE
    .\test\e2e\run.ps1 -Steps test\e2e\steps-basic.json
    node test\e2e\cdp.js screenshot out.png
    .\test\e2e\run.ps1 -Stop
#>
param(
    [string]$Steps,
    [string]$Workspace,
    [int]$Port = 9333,
    [switch]$Stop,
    # install the packaged .vsix into the scratch extensions folder instead of loading the source folder
    [string]$Vsix
)
$ErrorActionPreference = 'Stop'
$ext = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$driver = (Resolve-Path (Join-Path $PSScriptRoot 'driver')).Path
$scratch = Join-Path ([IO.Path]::GetTempPath()) 'oc-e2e'
$code = Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin\code.cmd'

function Stop-TestVsCode {
    # only the Code.exe processes of the test instance (they carry the folder name of the scratch data in their command line)
    $mine = @(Get-CimInstance Win32_Process -Filter "Name='Code.exe'" | Where-Object { $_.CommandLine -like '*oc-e2e*' })
    $ids = @($mine | ForEach-Object { $_.ProcessId })
    # the terminal helpers that these processes started
    Get-CimInstance Win32_Process -Filter "Name='conpty-bridge.exe'" | Where-Object { $ids -contains $_.ParentProcessId } | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
    foreach ($id in $ids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
}

Stop-TestVsCode
if ($Stop) { return }
if (-not (Test-Path $code)) { throw "VS Code was not found at $code" }
if (-not $Workspace) { $Workspace = Join-Path $scratch 'workspace' }
New-Item -ItemType Directory -Force $Workspace | Out-Null
if ($Steps) {
    $Steps = (Resolve-Path $Steps).Path
    if (Test-Path "$Steps.log") { [IO.File]::Delete("$Steps.log") }
    $env:OPENCONSOLE_E2E_STEPS = $Steps
}

$commands = Join-Path $scratch 'commands.jsonl'
New-Item -ItemType Directory -Force $scratch | Out-Null
if (-not (Test-Path $commands)) { [IO.File]::WriteAllText($commands, '') }
$env:OPENCONSOLE_E2E_COMMANDS = $commands
$common = "--user-data-dir=`"$scratch\ud`" --extensions-dir=`"$scratch\ext`""
if ($Vsix) {
    $installOutput = & cmd.exe /c "`"$code`" $common --install-extension `"$((Resolve-Path $Vsix).Path)`" --force 2>&1"
    ($installOutput | Select-Object -Last 3) -join "`n"
    $dev = "--extensionDevelopmentPath=`"$driver`""
} else {
    $dev = "--extensionDevelopmentPath=`"$ext`" --extensionDevelopmentPath=`"$driver`""
}
# code.cmd is the command line tool of VS Code: it checks the options and starts the window (Code.exe itself refuses unknown options).
# It is started detached: the window must not hold on to the pipes of this script.
$line = "`"$code`" $common $dev --remote-debugging-port=$Port --disable-workspace-trust --skip-release-notes --skip-welcome --new-window `"$Workspace`""
Start-Process -FilePath cmd.exe -ArgumentList '/c', "`"$line`"" -WindowStyle Hidden
"started VS Code (test instance), debugging port $Port"
