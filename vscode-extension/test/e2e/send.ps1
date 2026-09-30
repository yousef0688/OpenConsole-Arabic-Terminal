<#
.SYNOPSIS
    Asks the running test instance to execute a VS Code command (see driver\extension.js). No quoting problems: the arguments
    are written to the command file as JSON.
.EXAMPLE
    .\test\e2e\send.ps1 openconsole.sendText "dir`r"
    .\test\e2e\send.ps1 workbench.action.toggleMaximizedPanel
#>
param(
    [Parameter(Mandatory, Position = 0)][string]$Command,
    [Parameter(Position = 1, ValueFromRemainingArguments)][string[]]$Arguments = @()
)
$file = Join-Path ([IO.Path]::GetTempPath()) 'oc-e2e\commands.jsonl'
[IO.Directory]::CreateDirectory((Split-Path $file)) | Out-Null
$line = ConvertTo-Json -Compress -InputObject @{ command = $Command; args = @($Arguments) }
[IO.File]::AppendAllText($file, $line + "`n", [Text.UTF8Encoding]::new($false))
