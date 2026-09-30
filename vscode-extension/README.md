# OpenConsole Arabic Terminal for VS Code

A terminal in the panel of VS Code that shows **Arabic and Hebrew correctly**: connected letters, words in the right order,
diacritics, and mixed Arabic + English lines.

VS Code's own terminal (xterm.js) draws every character on its own, from left to right, so Arabic letters are not
connected and phrases read backwards. This extension adds a tab **OpenConsole** next to *Terminal* in the panel. It runs a
real shell (PowerShell by default) in a Windows pseudo console and draws the rows that contain right-to-left text with the same
layout that the OpenConsole console window uses (the project this extension belongs to).

[العربية](#بالعربية)

## Install

Windows 10 (1809) or later, VS Code 1.90 or later.

**The easy way:** download `OpenConsole-x64.zip` from the Releases page of the OpenConsole project, extract it, and double-click
`Install.cmd` (it installs the OpenConsole console and, when it finds VS Code, this extension) or `Install-VSCode.cmd` (only this
extension). Then reload the VS Code windows that are open.

**With the `.vsix` file alone** (`openconsole-terminal-<version>.vsix`, from the Releases page, or build it: [below](#build-it-yourself)):

1. Install it:

   ```powershell
   code --install-extension openconsole-terminal-0.1.0.vsix
   ```

   or, in VS Code: **Extensions** view, **...** menu, **Install from VSIX...**
2. Reload the window (**Developer: Reload Window**).
3. Open the panel (`Ctrl+J`) and choose the **OpenConsole** tab, or run **OpenConsole: Focus Terminal** from the Command Palette.

To remove it: `Install-VSCode.cmd -Uninstall`, or `code --uninstall-extension openconsole.openconsole-terminal`.

## Why an extension, and not just a setting

VS Code draws its terminal itself (xterm.js), so a console program such as OpenConsole cannot draw inside it. The closest setting is
`terminal.integrated.gpuAcceleration` = `off` (the DOM renderer): letters inside a word join, but the words stay in left-to-right
order (the first word of "السلام عليكم" ends up on the left), and programs that reorder right-to-left text themselves, such as
Claude Code, come out wrong. (Checked with the xterm.js that ships with VS Code 1.139.) The extension handles both.

If you would rather have the real console window than a tab, a terminal profile can open it from the `+` list of the terminal; see
the README of the OpenConsole project ("The console window from VS Code").

## What you get

- **Connected Arabic letters and the right order.** A phrase such as "السلام عليكم" starts on the right, letters join, numbers keep
  their own order, and box drawing characters end a run, so tables and text user interfaces are not swapped.
- **The cursor follows the text.** While you type Arabic, the cursor stays at the end where the next letter appears.
- **Programs that reorder the text themselves**, such as Claude Code, are detected automatically (`claude.exe` runs under the
  shell) and drawn correctly. The list is a setting.
- **Screenshots with `Ctrl+V`.** Take a screenshot and press `Ctrl+V`: the image is saved as a PNG file in `%TEMP%\OpenConsole` and its
  path is pasted, as when you drag a file into a console. Programs that read images by path, such as Claude Code, pick it up.
- **Icons.** Set `openconsole.iconFont` to a Nerd Font to draw the icons of tools such as starship, lazygit or `pi`.
- **Copy and paste.** `Ctrl+C` copies when text is selected (otherwise it is sent to the program), `Ctrl+Shift+C` always copies,
  `Ctrl+V`, `Ctrl+Shift+V` and `Shift+Insert` paste. They work on an Arabic keyboard layout too.
- It follows the colours and the font of VS Code.
- Extra terminals: **OpenConsole: New Terminal in Editor** opens one in an editor tab. **Restart** and **Clear** are in the toolbar.

Rows without right-to-left text are drawn by xterm.js exactly as in the terminal of VS Code.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `openconsole.shell` | `powershell.exe` | The program to start (`pwsh.exe`, `cmd.exe`, ...). Only in user settings. |
| `openconsole.shellArgs` | `["-NoLogo"]` | Its arguments. Only in user settings. |
| `openconsole.bidiMode` | `auto` | `auto`: switch to `visual` while a program of `visualBidiApps` runs. `implicit`: programs write text in reading order. `visual`: the program already reordered it. |
| `openconsole.visualBidiApps` | `["claude.exe"]` | Programs that reorder right-to-left text themselves. |
| `openconsole.fontFamily`, `openconsole.fontSize` | empty, `0` | Empty / 0: the terminal settings of VS Code, then the editor settings. |
| `openconsole.textFont` | `Segoe UI` | The font for Arabic and Hebrew letters. Fixed-width fonts that have Arabic letters of their own (Courier New, Nerd Fonts) draw them squeezed, so the letters are taken from this font instead. |
| `openconsole.iconFont` | empty | A font for the icons (private use area symbols), for example `CaskaydiaCove NFM`. |

The cursor style, the blinking, the scrollback and the line height are taken from `terminal.integrated.*`.

## How it works

- `bin/conpty-bridge.exe` (source in `native/`) starts the shell in a Windows pseudo console and exchanges the input, the output, the
  size and the list of running programs with the extension through a small binary protocol on its standard streams.
- The page in the webview is xterm.js (DOM renderer) plus two files: `media/arabic-layout.js` decides, with the Unicode
  Bidirectional Algorithm (bidi-js), which columns form right-to-left runs and where each run is drawn (mirrored **inside the
  columns it occupies**), and `media/row-patcher.js` rebuilds only the rows with right-to-left text: each run is one box that the
  browser shapes as a whole (this joins the letters) and fits into its columns.
- The design is the one of the renderer of the OpenConsole console window (`src/renderer/atlas` in this repository).

## Limits

- Windows only (x64). The shell needs a pseudo console, so Windows 10 version 1809 or later.
- This is not the built-in terminal: no tabs and splits of the terminal view, no links, shell integration, quick fixes, terminal
  profiles or task terminals. Some keys go to VS Code instead of the shell when they are not handled by the terminal.
- Selecting *part* of an Arabic run with the mouse highlights columns that do not line up with the letters (copying gives the right text).
- The DOM renderer is slower than the GPU renderer when a program writes very fast.
- Tested with VS Code 1.139 on Windows 11 with PowerShell 5.1, and with a stand-in for Claude Code. Hebrew uses the same code as Arabic.

## Build it yourself

You need Node.js and, for the helper program, the Visual Studio C++ build tools (as for the console window).

```powershell
cd vscode-extension
npm install
npm run build          # copies xterm.js and bidi-js into media/vendor
npm run build:native   # builds bin/conpty-bridge.exe
npm test               # layout, session and helper tests
npm run package        # writes openconsole-terminal-<version>.vsix
```

To try it without installing, open this folder in VS Code and press `F5` (Extension Development Host).

`test/e2e` has scripts that start a separate VS Code with the extension and take screenshots of it through the debugging port
(`run.ps1`, `send.ps1`, `cdp.js`); they were used to check the extension.

## License

MIT, see the file LICENSE. xterm.js and bidi-js are MIT licensed as well (texts in media/vendor/LICENSES.txt).

---

<div dir="rtl" align="right">

## بالعربية

إضافة لـ VS Code تضيف تبويب **OpenConsole** بجانب *Terminal* في اللوحة السفلية. فيه PowerShell (أو أي برنامج تختاره) يعرض **العربية
والعبرية بشكل صحيح**: حروف متصلة، وترتيب كلمات من اليمين إلى اليسار، وتشكيل، وأسطر تجمع العربي والإنجليزي.

طرفية VS Code المدمجة (xterm.js) ترسم كل حرف على حدة من اليسار إلى اليمين، فلا تتصل الحروف وتنعكس الجمل. هذه الإضافة تشغّل
الصدفة في وحدة تحكم افتراضية (ConPTY) وترسم الأسطر التي فيها نص من اليمين إلى اليسار بالتخطيط نفسه الذي تستعمله نافذة
OpenConsole (المشروع الذي تنتمي إليه هذه الإضافة).

**التثبيت** (ويندوز 10 الإصدار 1809 فأحدث، وVS Code 1.90 فأحدث):

</div>

```powershell
code --install-extension openconsole-terminal-0.1.0.vsix
```

<div dir="rtl" align="right">

ثم أعد تحميل النافذة (**Developer: Reload Window**)، وافتح اللوحة (`Ctrl+J`) واختر تبويب **OpenConsole**.

**ما تحصل عليه:**

- حروف عربية متصلة، وترتيب صحيح للعبارات (الكلمة الأولى إلى اليمين)، والأرقام تحتفظ بترتيبها، والجداول لا تنقلب أعمدتها.
- المؤشر يبقى عند نهاية النص أثناء الكتابة.
- البرامج التي ترتّب النص العربي بنفسها، مثل Claude Code، تُكتشف تلقائياً (تشغيل `claude.exe` تحت الصدفة) وتُعرض بشكل صحيح.
- لصق لقطة الشاشة بـ `Ctrl+V`: تُحفظ الصورة PNG في `%TEMP%\OpenConsole` ويُلصق مسارها.
- أيقونات Nerd Fonts عبر الإعداد `openconsole.iconFont`.
- `Ctrl+C` ينسخ عند وجود تحديد (وإلا يُرسل للبرنامج)، و`Ctrl+V` يلصق، وتعمل على لوحة المفاتيح العربية.
- يتبع ألوان VS Code وخطه.

**لماذا إضافة وليس إعداداً؟** VS Code يرسم طرفيته بنفسه. إيقاف تسريع GPU (`terminal.integrated.gpuAcceleration` = `off`) يصل الحروف داخل
الكلمة لكن يبقي الكلمات من اليسار إلى اليمين («السلام» تظهر على اليسار)، ويفسد البرامج التي ترتّب النص بنفسها مثل Claude Code.
الإضافة تعالج الأمرين. ولمن يفضّل نافذة الطرفية الحقيقية بدل التبويب: ملف تعريف (profile) يفتحها من قائمة زر `+`؛ انظر README
مشروع OpenConsole («نافذة الطرفية من VS Code»).

**القيود:** ويندوز فقط؛ ليست الطرفية المدمجة (لا روابط ولا تكامل صدفة ولا تقسيم)؛ تظليل التحديد الجزئي لأسطر عربية قد لا ينطبق
على الحروف (النسخ يعطي النص الصحيح)؛ محرك DOM أبطأ من محرك GPU عند الكتابة السريعة جداً.

</div>
