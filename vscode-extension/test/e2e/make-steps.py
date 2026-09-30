import json
import os
import sys

out = sys.argv[1]
salam = 'السلام'
alaykum = 'عليكم'
lines = [
    "Clear-Host",
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
    "Write-Host 'Hello %s world 123'" % 'مرحبا',
    "Write-Host '%s %s ورحمة الله'" % (salam, alaykum),
    "Write-Host 'هذا اختبار للغة العربية في الطرفية'",
    "Write-Host ('│ %s │ Hello │ %s │')" % ('مرحبا', 'عالم'),
    "Write-Host ('bold red') -ForegroundColor Red -NoNewline; Write-Host ' %s' -ForegroundColor Green" % alaykum,
]
steps = [
    {"delay": 3000, "command": "openconsole.focus"},
    {"delay": 9000, "command": "openconsole.sendText", "args": ["\r".join(lines) + "\r"]},
    # something typed at the prompt and left there, like a user typing: the cursor stays after the last letter
    {"delay": 2500, "command": "openconsole.sendText", "args": ["%s %s" % (salam, alaykum)]},
]
with open(out, 'w', encoding='utf-8') as f:
    json.dump(steps, f, ensure_ascii=False, indent=1)
print('wrote', out)
