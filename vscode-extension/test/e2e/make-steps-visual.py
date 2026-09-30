import json
import os
import shutil
import sys

# A stand-in for Claude Code: a copy of powershell.exe named claude.exe that prints Arabic text already reordered
# ("visual order"), the way Claude Code writes it for terminals that cannot do right-to-left text.
scratch = os.path.join(os.environ['TEMP'], 'oc-e2e')
fake_dir = os.path.join(scratch, 'fake')
workspace = os.path.join(scratch, 'workspace')
os.makedirs(fake_dir, exist_ok=True)
os.makedirs(workspace, exist_ok=True)
shutil.copyfile(os.path.join(os.environ['SystemRoot'], 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), os.path.join(fake_dir, 'claude.exe'))

script = """[Console]::OutputEncoding = [Text.Encoding]::UTF8
function Rev([string]$s) { $c = $s.ToCharArray(); [array]::Reverse($c); -join $c }
Clear-Host
Write-Host ('claude> ' + (Rev 'السلام عليكم ورحمة الله'))
Write-Host ('claude> ' + (Rev 'هذا اختبار للغة العربية'))
Write-Host ('claude> Hello ' + (Rev 'مرحبا') + ' world')
Start-Sleep -Seconds %d
""" % int(sys.argv[2] if len(sys.argv) > 2 else 16)
with open(os.path.join(workspace, 'fake-claude.ps1'), 'w', encoding='utf-8-sig') as f:
    f.write(script)

command = "& '%s' -NoProfile -File .\\fake-claude.ps1\r" % os.path.join(fake_dir, 'claude.exe')
steps = [
    {"delay": 3000, "command": "openconsole.focus"},
    {"delay": 9000, "command": "openconsole.sendText", "args": [command]},
]
with open(sys.argv[1], 'w', encoding='utf-8') as f:
    json.dump(steps, f, ensure_ascii=False, indent=1)
print('wrote', sys.argv[1])
