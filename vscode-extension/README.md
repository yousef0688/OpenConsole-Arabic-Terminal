# OpenConsole for VS Code

A terminal in the panel of VS Code that shows **Arabic and Hebrew correctly**: connected letters, words in the right order,
diacritics, and mixed Arabic + English lines.

VS Code's own terminal (xterm.js) draws every character on its own, from left to right, so Arabic letters are not
connected and phrases read backwards. This extension adds a tab **OpenConsole** next to *Terminal* in the panel. It runs a
real shell (PowerShell by default) in a Windows pseudo console and draws the rows that contain right-to-left text with the same
layout that the OpenConsole console window uses (the project this extension belongs to).

[العربية](#بالعربية)

## Install

Windows 10 (1809) or later, VS Code 1.90 or later.

**From the Marketplace (easiest):** open the **Extensions** view in VS Code (`Ctrl+Shift+X`), search for **OpenConsole** and install it,
or run `code --install-extension openconsole.openconsole`. Then reload the window.

**With the installer:** download `OpenConsole-x64.zip` from the Releases page of the OpenConsole project, extract it, and double-click
`Install.cmd` (it installs the OpenConsole console and, when it finds VS Code, this extension) or `Install-VSCode.cmd` (only this
extension). Then reload the VS Code windows that are open.

**With the `.vsix` file alone** (`openconsole-<version>.vsix`, from the Releases page, or build it: [below](#build-it-yourself)):

1. Install it:

   ```powershell
   code --install-extension openconsole-<version>.vsix
   ```

   or, in VS Code: **Extensions** view, **...** menu, **Install from VSIX...**
2. Reload the window (**Developer: Reload Window**).
3. Open the panel (`Ctrl+J`) and choose the **OpenConsole** tab, or run **OpenConsole: Focus Terminal** from the Command Palette.

To remove it: `Install-VSCode.cmd -Uninstall`, or `code --uninstall-extension openconsole.openconsole`. (Version 0.1.0 was called `openconsole.openconsole-terminal`; the installer removes it.)

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
  shell) and drawn correctly. The list is a setting. While you type Arabic at the end of the text box of Claude Code, the cursor is drawn at
  the left end of the word, where the next letter appears, and the word stays joined (Claude Code itself parks the cursor of the terminal on the
  first letter of the word, which cut that letter off).
- **Text boxes that do not move.** In the **words** mode every Arabic or Hebrew word is joined and mirrored on its own, and the words
  keep the order you typed them in. Nothing before the word you are typing moves, and a long text that wraps reads from top to
  bottom, instead of being reordered as one stretch that grows at its right end and is cut where the row wraps. The mode is for
  coding agents that redraw their text box on every key. It is chosen by itself while a program from `openconsole.wordsBidiApps`
  (`opencode.exe`) runs in the terminal. pi is a Node.js program and cannot be told by its name here, so for pi set
  `openconsole.bidiMode` to `words`. (The OpenConsole console window, not this tab, finds pi by itself.) The price: the words of an Arabic
  sentence follow each other from left to right; digits always stay left to right.
- **Screenshots with `Ctrl+V`.** Take a screenshot and press `Ctrl+V`: the image is saved as a PNG file in `%TEMP%\OpenConsole` and its
  path is pasted, as when you drag a file into a console. Programs that read images by path, such as Claude Code, pick it up.
  The terminal draws a small **[Image #1]** over the long path, so the line stays readable. The text is still there: the program
  receives the real path, and copying the line gives it back. The label counts as one character: **Backspace** right behind it
  removes the whole path at once (and **Delete** right in front of it), not letter by letter; after any other character Backspace is
  a normal Backspace.
- **Icons.** Set `openconsole.iconFont` to a Nerd Font to draw the icons of tools such as starship, lazygit or `pi`.
- **Copy and paste.** `Ctrl+C` copies when text is selected (otherwise it is sent to the program), `Ctrl+Shift+C` always copies,
  `Ctrl+V`, `Ctrl+Shift+V` and `Shift+Insert` paste. They work on an Arabic keyboard layout too, and pasting an item from the
  clipboard history of Windows (`Win+V`) works as well (Windows sends that paste as a `Ctrl+V` without a scan code).
- **Right mouse button pastes.** Click the right button in the terminal and what you copied last is pasted, as in the console window
  and in Windows Terminal, instead of the menu of VS Code (`openconsole.rightClickPaste`, turn it off to get the menu). A program that
  uses the mouse (pi, opencode, vim) gets the right button itself: hold **Shift** to paste then. A screenshot in the clipboard is pasted
  as a file path, as with `Ctrl+V`, when the page is allowed to read it; if not, use `Ctrl+V`.
- **Links.** An address (`http://` or `https://`) in the output is underlined when you point at it, with the hint "Follow link
  (Ctrl + click)". **Ctrl + click** opens it in your browser (VS Code asks first for sites it does not know). It also works for an
  address that wraps onto the next row, and in programs that use the mouse, such as pi, opencode or vim: there the Ctrl + click is kept
  from the program when it is on an address, and every other click still goes to it. Only `http` and `https` are opened.
- **File paths.** A path in the output (`src/app.ts:12:5`, `C:\proj\lib\a.js:7`, `.\x\y.cs(10,3)`) is underlined when you point at
  it, with the hint "Open file (Ctrl + click)". **Ctrl + click** opens the file in the editor at that line and column. A relative path
  is looked for in the folder where that shell started, then in the folders of the workspace; a file that does not exist is only
  reported. A path on a network share (`\\server\share`) is never opened, because Windows would send your credentials to that server.
  A name without a folder counts only when it has a line (`index.js:10`), so "node.js" in a sentence is not a link.
- **Find in the terminal.** `Ctrl+F` opens a small search box at the top right of the terminal (the text of the rows, including the
  scrollback): `Enter` / `Shift+Enter` or `F3` go to the next / previous match, the buttons switch case, whole word and regular
  expression, the box shows "3 of 12", `Esc` closes it. Also **OpenConsole: Find in Terminal**.
- **What every terminal is doing.** When there is more than one terminal, each row of the list shows a small mark: a green dot (a
  program runs), a turning ring (an agent works), an empty ring (it waits for you), an amber pulse (**it needs you**: a question, a
  permission), a check (done), a cross (failed), a grey square (the shell ended), with the time next to it. The agent (Claude Code,
  Codex, opencode, Gemini, Aider, pi) is told from the programs under the shell or from the title it sets. The state comes, in this
  order, from what the program reports itself (the sequences `OSC 7501;state=working|blocked|done|error`, `OSC 9;4` progress and
  `OSC 133`), from the bottom rows of the screen ("esc to interrupt", a numbered permission question, `[y/n]`), and from how
  long the output has been quiet. **OpenConsole: Explain the State of This Terminal** shows which of them decided and the rows that
  were read. A terminal that you are looking at is never reported.
- **Notifications.** When a terminal you are not looking at needs you, calls you with the bell, fails, ends, or an agent / program that
  worked at least `openconsole.attention.minWorkingSeconds` (15) is done, a message tells you, with a **Show** button that opens
  that terminal. The same thing about the same terminal is told again after 30 seconds at the earliest. The status bar shows
  `$(bell) 2` (with a warning colour when something is blocked): click it for the list, or use **OpenConsole: Go to the Next
  Terminal That Needs You**. `openconsole.attention.notify` is `all`, `important` (questions, bell, failures) or `off`;
  `openconsole.agentRules` adds your own rules for what a program's screen means.
- **Names and colours.** Double click a row to rename that terminal (an empty name gives the name of its kind back; the name is also
  used in the notifications), or right click a row for **Rename**, a colour for its icon, **Split** and **Kill**. Also **OpenConsole:
  Rename Terminal...** and **Change Terminal Colour...**.
- **Icons for what runs.** With more than one terminal, each row of the list wears the icon of what runs in it: the agent (Claude Code,
  Gemini, opencode, Copilot), else the program under the shell (Node.js, npm, Yarn, pnpm, Bun, Deno, Python, Git, Docker, Go, Rust,
  Java, C#, PHP, Ruby, Vim), else its kind of shell (PowerShell, Git Bash, Command Prompt and WSL), and it changes by itself when the
  program changes. A terminal that you gave a colour keeps the plain icon in that colour. The pictures are the icons of
  [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme) by Material Extensions (MIT licence, kept in
  `media/vendor/LICENSES.txt`).
- **Run several scripts at once.** **OpenConsole: Run package.json Scripts in Parallel...** lists the scripts of the `package.json` files of
  the workspace (the root and one level of workspaces: npm, Yarn, pnpm, bun; the manager is told from the lockfile or `packageManager`).
  Tick the ones you want: each runs in its own terminal, named `<package>: <script>`, in the folder of its package, at most
  `openconsole.scripts.maxParallel` (4) at a time; the next one starts when a running one ends (`0` starts them all at once, for
  servers that never end). A script name that is not one plain word (spaces, `;`, `&&`, quotes) is never typed into a shell.
- **Saved groups of terminals.** Put `.openconsole/groups.json` in the workspace
  (`{ "groups": [ { "name": "dev", "terminals": [ { "name": "api", "cwd": "packages/api", "command": "npm run dev", "color": "green" } ] } ] }`;
  **OpenConsole: Edit Saved Groups** makes the file) and **Start a Saved Group of Terminals...** opens one terminal per entry with its
  folder, name, colour and command. The commands are text of the repository, so they are shown in a question before they run
  (you can approve a group; a changed command asks again), a `cwd` may not leave the workspace, and a command may not contain
  control characters.
- **One work tree per agent.** **New Terminal in a Fresh Git Worktree...** makes a new branch `oc/<name>` in its own folder next to
  the repository (`git worktree`), and opens a terminal there, typing `openconsole.worktree.startCommand` (for example `claude`).
  Several agents can then work on the same project at the same time without touching each other's files. **Remove an Agent
  Worktree...** removes one again (it warns when it has changes that are not committed). Close the terminals that are in the folder
  first: Windows cannot delete a folder that a program is in.
- **Log messages in the editor.** Select a variable (or put the cursor on it) and press `Ctrl+Alt+L` then `L`: a line such as
  `console.log("▶ › Cart › add › item:", item)` is inserted after the statement that gives the variable its value (before an `if`
  or `return`, at the top of the body for a parameter), indented like its neighbours, with the class and function it is in. In
  Python it is `print(...)` (`logging.*` for the info, debug and warn kinds, with `import logging` added when it is missing). Other
  keys, after `Ctrl+Alt+L`: `I` info, `D` debug, `T` table, `W` warn, `E` error, `M` your own function, then `C` comment all, `U`
  uncomment all, `X` delete all, `R` correct all (the file name and line numbers of the messages that moved). The last four act on
  the log messages of OpenConsole in the active file only (a message counts when it holds both the prefix and the delimiter), and each
  is one undo step. Several cursors work at once. The finder is heuristic (a tokenizer and a statement scanner, not a parser): when
  it cannot tell, it puts the line after the statement, and in odd places (a field of a class without a constructor) it says no
  instead of writing a wrong line. The `openconsole.log.*` settings change the prefix, the delimiter, the quote, the function, the file
  name and line number, semicolons and blank lines. The idea comes from the extension Turbo Console Log (by Chakroun Anas); this
  one is written independently, without its code.
- **Your terminals in a browser.** **OpenConsole: Share Terminals on the Web...** (or the broadcast button in the toolbar of the view, which opens the sharing menu once it is on; off until you ask) lets you open the same terminals,
  not copies, in a browser on a phone or another computer. You choose which terminals; a small server starts on this computer only
  (`127.0.0.1`) and you get a link that works once, for ten minutes, with its secret after the `#` (which a browser never sends
  to a server). Open it in the browser: VS Code asks you to **Allow viewing**, **Allow typing** or **Deny** that browser, so a
  link that leaks is worth nothing without your click. The browser then shows the terminals at the size of your panel, with a bar
  of keys for a phone (Esc, Tab, Ctrl, arrows...), and Arabic is drawn as in VS Code. The status bar shows `$(broadcast) Web` while
  anything is shared (click it: new link, browsers that are paired, stop). To reach it from outside this computer you run a tunnel
  yourself (for example `cloudflared tunnel --url http://127.0.0.1:<port>`, or Tailscale Serve) and put its address in
  `openconsole.web.publicUrl`: only that host is then accepted. There is no relay server and no account. Security: random 256-bit
  secrets, only hashes are kept, no cookies, exact Host and Origin checks, at most `openconsole.web.maxClients` browsers, a limit on
  tries, strict WebSocket parsing, the terminals' own answers to terminal queries are never typed back, and a browser that can only
  view can never type. Sharing ends with **Stop Sharing on the Web** or when VS Code closes. Remember that a browser that may type
  can do whatever you can do in that terminal.
- **Motion.** The buttons that the page draws move smoothly: the two buttons of a row spring in, one after the other, when the row is
  pointed at; they grow when pointed at and sink when pressed; the line of **Split Terminal** divides in two and the lid of the bin
  lifts (and the bin turns red, as it ends a terminal); a new terminal slides into the list; the entries of the menu next to **+** come
  in one after the other. `openconsole.motionSpeed` sets how long it takes (`1` normal, `2` twice as long, `0.5` half, `0` none). With "reduce motion" on in Windows, none of it moves. (The buttons of the toolbar of the view, the **+**
  and the others, are drawn by VS Code itself and cannot be animated by an extension.)
- It follows the colours and the font of VS Code.
- **Several terminals.** The **+** in the toolbar adds another terminal to the panel, each with its own shell. As in the built-in
  terminal, a list appears on the right as soon as there is more than one: click a name to switch. The row that is pointed at or
  has the focus shows two buttons: **Split Terminal** (the icon with two panes) and the **trash**, which kills that terminal (the last
  one starts again instead). The line between the terminal and the list can be dragged to the left or to the right to change the
  width of the list (it lights up when it is pointed at; a double click gives the usual width back, the arrow keys move it when it has
  the focus, and the width is kept). **Restart** and **Clear** in the toolbar act on the terminal that is shown in the
  panel, even when you used a terminal in an editor tab last. **Clear** starts the terminal again: a new shell and an empty screen, so
  whatever ran in it ends (turn this off with `openconsole.clearRestartsTerminal` for a Clear that only empties the screen and keeps
  the shell; that one also clears the pseudo console, so the lines do not come back when the panel is resized, and it needs the
  `conpty.dll` that VS Code ships, see `openconsole.useVSCodeConpty`). **Text follows the width.** Drag the line between the terminal
  and the list, or resize the panel: what is on the screen, and the long line that you are typing, wrap again at the new width, both
  when the terminal gets narrower and when it gets wider.
- **Terminals of a chosen kind.** The arrow next to the **+** opens a dropdown menu, as the arrow next to the **+** of the built-in terminal
  does (it is drawn at the top right of the terminal, in the colours of VS Code's menus: an extension cannot open a menu from the toolbar
  with entries that are only known at run time, and the profiles are): a new terminal with a profile (PowerShell, PowerShell 7, Command Prompt, Git Bash, every WSL distribution, and the profiles
  with a path in `terminal.integrated.profiles.windows`), **New Terminal in Editor**, **Select Default Profile** (the shell that **+**
  starts), **Split Terminal** and **Configure Terminal Settings**. The list shows the name of the kind.
- **Split Terminal.** The split button of a row (or **Split Terminal** in that menu, or in the Command Palette) opens a new terminal
  at the right side of the one that has the focus, of the same kind, and both are shown side by side with a line between them. In
  the list the terminals of such a group hang together under one another. Click in a terminal to give it the focus. A terminal that is
  killed leaves the others the whole width. Splits are side by side only (no split one above the other).
- **OpenConsole: New Terminal in Editor** (Command Palette, or the **...** menu of the view) opens a terminal in an editor tab.
- **A suggestion of what you are going to type.** While you type at a prompt, the rest of the newest command of your history that
  starts with what you typed is shown in grey after the cursor. The **Right Arrow** (or **End**) types it; any other key ignores it.
  The history is the one of PowerShell (its `ConsoleHost_history.txt`) plus the commands you enter in these terminals. It is left out
  while another program runs in the terminal, on the alternate screen (vim, less), when there is text after the cursor, and when it
  would go on in an Arabic or Hebrew word that you typed (such a word is laid out from the right, so the grey text would be on the
  wrong side). Turn it off with `openconsole.suggestions`.
  Privacy: the commands you enter here (at most 300) and the folders of their prompts (at most 40) are kept in the state of this
  extension inside VS Code, on your computer only; with `openconsole.suggestions` off nothing is read or kept. **OpenConsole: Forget
  the Remembered Commands and Folders** deletes them (the history file of PowerShell is never changed).
- **The "..." menu of the view**, as in the built-in terminal: **Scroll to Previous Command** and **Scroll to Next Command**
  (`Ctrl+Up Arrow` and `Ctrl+Down Arrow` in the terminal; they go to the commands that you entered in this terminal), **Clear Terminal**,
  **Run Active File** (types the path of the file of the editor), **Run Selected Text** (types the selection, or the line of the
  cursor), **Go to Recent Directory...** (`Ctrl+G` in the terminal) and **Run Recent Command...** (`Ctrl+Alt+R`). The menu does not
  print the keys next to the items, but they work inside the terminal. The same items are in the Command Palette as **OpenConsole: ...**.
  **Start Dictation** of the built-in terminal is not here: it needs the speech extension of VS Code, which only serves its own terminal.

Rows without right-to-left text are drawn by xterm.js exactly as in the terminal of VS Code.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `openconsole.shell` | `powershell.exe` | The program to start (`pwsh.exe`, `cmd.exe`, ...). Only in user settings. |
| `openconsole.shellArgs` | `["-NoLogo"]` | Its arguments. Only in user settings. |
| `openconsole.bidiMode` | `auto` | `auto`: switch to `visual` while a program of `visualBidiApps` runs, to `words` while one of `wordsBidiApps` runs. `implicit`: programs write text in reading order. `visual`: the program already reordered it. `words`: every word on its own, the words keep the order they were typed in (for pi and other coding agents). |
| `openconsole.visualBidiApps` | `["claude.exe"]` | Programs that reorder right-to-left text themselves. |
| `openconsole.wordsBidiApps` | `["opencode.exe"]` | Programs that redraw a text box while you type: the words mode is used while one runs. |
| `openconsole.fontFamily`, `openconsole.fontSize` | empty, `0` | Empty / 0: the terminal settings of VS Code, then the editor settings. |
| `openconsole.textFont` | `Segoe UI` | The font for Arabic and Hebrew letters. Fixed-width fonts that have Arabic letters of their own (Courier New, Nerd Fonts) draw them squeezed, so the letters are taken from this font instead. |
| `openconsole.iconFont` | empty | A font for the icons (private use area symbols), for example `CaskaydiaCove NFM`. |
| `openconsole.suggestions` | `true` | The grey rest of a command from your history while you type (the **Right Arrow** types it), and remembering the commands and folders for it, for **Run Recent Command** and **Go to Recent Directory**. Off: nothing is shown, read or kept. |
| `openconsole.motionSpeed` | `1` | How long the motion of the buttons, the list and the menu takes: `2` twice as long, `0.5` half as long, `0` none. |
| `openconsole.rightClickPaste` | `true` | The right mouse button pastes what was copied last (with Shift when a program uses the mouse) instead of opening the menu of VS Code. |
| `openconsole.attention.notify` | `all` | A message when a terminal that you are not looking at needs you, calls you, fails, ends or is done: `all`, `important` (questions, bell, failures) or `off`. |
| `openconsole.attention.minWorkingSeconds` | `15` | A program or agent is reported as done only when it worked at least this many seconds. Questions are always reported. |
| `openconsole.attention.statusBar` | `true` | `$(bell) N` in the status bar while terminals need you. |
| `openconsole.agentRules` | `[]` | Your own rules (regular expressions over the bottom rows of the screen) for telling that a program is working or blocked on a question. |
| `openconsole.scripts.maxParallel` | `4` | How many scripts of **Run package.json Scripts in Parallel** run at once (`0`: all at once). |
| `openconsole.worktree.startCommand` | empty | A command typed in the terminal of a new agent worktree, for example `claude`. |
| `openconsole.web.publicUrl` | empty | The address of your own tunnel to the sharing server (`https://...`). Empty: the link works on this computer only. |
| `openconsole.web.maxClients` | `5` | Browsers connected at the same time. |
| `openconsole.web.sessionHours` | `8` | How long a paired browser stays paired. |
| `openconsole.log.*` | see Settings | Prefix (`▶`), delimiter (`›`), quote, log function, file name, line number, semicolon and blank lines of the log messages. |
| `openconsole.clearRestartsTerminal` | `true` | **Clear** starts the terminal again (a new shell; whatever ran in it ends). Off: Clear only empties the screen. |
| `openconsole.useVSCodeConpty` | `true` | Only matters while `clearRestartsTerminal` is off: then the terminal runs in the pseudo console that VS Code ships for its own terminal (`conpty.dll` with its `OpenConsole.exe`), because only that one can be cleared by **Clear**. It does not repaint after a resize, so the line that you are typing is cut off when the terminal gets narrower. By default the pseudo console of Windows is used, and text wraps again at every width. |

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
- This is not the built-in terminal: no shell integration, quick fixes or task terminals, and splits are side by side only.
  Some keys go to VS Code instead of the shell when they are not handled by the terminal.
- With an Arabic keyboard layout active, PSReadLine (the command line editor of PowerShell) types the Arabic letter of the key for
  shortcuts such as `Ctrl+L`, `Ctrl+A` or `Ctrl+E`, instead of running them. We saw this with the shortcut arriving correctly at the
  pseudo console, so it is how PSReadLine reads it, and it is not specific to this extension. Switch to the English layout for these
  shortcuts. Pasting (`Ctrl+V`, also from the clipboard history of Windows, `Win+V`) and copying a selection with `Ctrl+C` work in any layout.
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
npm run package        # writes openconsole-<version>.vsix
```

To try it without installing, open this folder in VS Code and press `F5` (Extension Development Host).

`test/e2e` has scripts that start a separate VS Code with the extension and take screenshots of it through the debugging port
(`run.ps1`, `send.ps1`, `cdp.js`); they were used to check the extension.

## License

MIT, see the file LICENSE. xterm.js and bidi-js are MIT licensed as well (texts in media/vendor/LICENSES.txt).

## Who made this

I'm [yousef0688](https://github.com/yousef0688), and I work at
[Software House for System Development](https://softwarehouse.com.jo/) (Arabic: دار البرمجيات لتطوير الأنظمة), a Jordanian
software company based in Amman. The source code, and the console window that this extension belongs to, are at
[github.com/yousef0688/OpenConsole-Arabic-Terminal](https://github.com/yousef0688/OpenConsole-Arabic-Terminal).

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
code --install-extension openconsole.openconsole
```

<div dir="rtl" align="right">

ثم أعد تحميل النافذة (**Developer: Reload Window**)، وافتح اللوحة (`Ctrl+J`) واختر تبويب **OpenConsole**.

**ما تحصل عليه:**

- حروف عربية متصلة، وترتيب صحيح للعبارات (الكلمة الأولى إلى اليمين)، والأرقام تحتفظ بترتيبها، والجداول لا تنقلب أعمدتها.
- المؤشر يبقى عند نهاية النص أثناء الكتابة.
- البرامج التي ترتّب النص العربي بنفسها، مثل Claude Code، تُكتشف تلقائياً (تشغيل `claude.exe` تحت الصدفة) وتُعرض بشكل صحيح. وأثناء كتابة العربية في آخر مربع النص في Claude Code يُرسم المؤشر عند الطرف الأيسر للكلمة، حيث يظهر الحرف التالي، وتبقى الكلمة متصلة (Claude Code نفسه يضع مؤشر الطرفية على الحرف الأول من الكلمة فكان يفصله عنها).
- لصق لقطة الشاشة بـ `Ctrl+V`: تُحفظ الصورة PNG في `%TEMP%\OpenConsole` ويُلصق مسارها، وترسم الطرفية شريطاً صغيراً **[Image #1]** فوق المسار الطويل ليبقى السطر مقروءاً (النص الحقيقي موجود: البرنامج يستلم المسار كاملاً، ونسخ السطر يعيده). والشريط يُعامل كحرف واحد: **Backspace** خلفه مباشرة يحذف المسار كاملاً دفعة واحدة (و**Delete** أمامه كذلك) لا حرفاً حرفاً، وبعد أي حرف آخر يبقى Backspace عادياً.
- أيقونات Nerd Fonts عبر الإعداد `openconsole.iconFont`.
- `Ctrl+C` ينسخ عند وجود تحديد (وإلا يُرسل للبرنامج)، و`Ctrl+V` يلصق، وتعمل على لوحة المفاتيح العربية.
- يتبع ألوان VS Code وخطه.
- **الحركة:** الأزرار التي ترسمها الصفحة تتحرك بسلاسة: زرّا الصف (التقسيم والحذف) يقفزان إلى مكانيهما واحداً بعد الآخر عند المرور على الصف، ويكبران عند المرور عليهما ويغوصان عند الضغط؛ وخط **تقسيم الطرفية** ينقسم نصفين، وغطاء سلة المهملات يرتفع وتحمرّ السلة لأنها تُنهي الطرفية؛ والطرفية الجديدة تنزلق إلى القائمة، وبنود القائمة بجانب **+** تدخل واحداً بعد الآخر. ومدّتها بالإعداد `openconsole.motionSpeed` (`1` عادي، `2` ضعف المدة، `0.5` النصف، `0` بلا حركة). وإذا فعّلتَ «تقليل الحركة» في ويندوز فلا شيء يتحرك. (أزرار شريط أدوات اللوحة، مثل **+** وغيره، يرسمها VS Code نفسه ولا تستطيع الإضافة تحريكها.)
- **زر الفأرة الأيمن يلصق:** انقر بالزر الأيمن في الطرفية فيُلصق آخر ما نسخته، كما في نافذة الطرفية وWindows Terminal، بدل قائمة VS Code (الإعداد `openconsole.rightClickPaste`، أطفئه لتعود القائمة). والبرنامج الذي يستعمل الفأرة (pi وopencode وvim) يستلم الزر الأيمن بنفسه: اضغط **Shift** معه لتلصق. ولقطة الشاشة في الحافظة تُلصق مساراً كما مع `Ctrl+V` إن سمحت الصفحة بقراءتها، وإلا فاستعمل `Ctrl+V`.
- **الروابط:** أي عنوان (`http://` أو `https://`) في الناتج يُرسم تحته خط عند المرور عليه مع التلميح «Follow link (Ctrl + click)»، و**Ctrl + نقرة** تفتحه في المتصفح (يسألك VS Code أولاً عن المواقع التي لا يعرفها). ويعمل أيضاً مع العنوان الذي يلتف على السطر التالي، ومع البرامج التي تستعمل الفأرة مثل pi وopencode وvim (تُحجب النقرة عن البرنامج إن كانت على عنوان، وكل نقرة أخرى تصله كما كانت). تُفتح عناوين `http` و`https` فقط.
- **مسارات الملفات:** أي مسار في الناتج (`src/app.ts:12:5` أو `C:\proj\lib\a.js:7` أو `.\x\y.cs(10,3)`) يُرسم تحته خط عند المرور عليه مع التلميح «Open file (Ctrl + click)»، و**Ctrl + نقرة** تفتح الملف في المحرر عند ذلك السطر والعمود. المسار النسبي يُبحث عنه في المجلد الذي بدأ فيه الشيل ثم في مجلدات مساحة العمل؛ والملف غير الموجود يُبلَّغ عنه فقط. ومسار مشاركة الشبكة (`\\server\share`) لا يُفتح أبداً لأن ويندوز سيرسل بيانات اعتمادك إلى ذلك الخادم. والاسم بلا مجلد (`index.js:10`) لا يُعدّ رابطاً إلا مع رقم سطر.
- **البحث في الطرفية:** `Ctrl+F` يفتح مربع بحث صغيراً أعلى يمين الطرفية (يبحث في نص الأسطر مع ما خرج من الشاشة): `Enter` و`Shift+Enter` أو `F3` للانتقال إلى النتيجة التالية أو السابقة، وأزرار لمطابقة حالة الأحرف والكلمة الكاملة والتعبير النمطي، ويظهر «3 of 12»، و`Esc` يغلقه. وفي لوحة الأوامر: **OpenConsole: Find in Terminal**.
- **ماذا تفعل كل طرفية:** عند وجود أكثر من طرفية يظهر بجانب كل صف في القائمة رمز صغير: نقطة خضراء (برنامج يعمل)، حلقة تدور (وكيل يعمل)، حلقة فارغة (ينتظرك)، نبض كهرماني (**يحتاجك**: سؤال أو إذن)، علامة صح (انتهى)، علامة x (فشل)، مربع رمادي (انتهى الشيل)، ومعه الوقت. الوكيل (Claude Code وCodex وopencode وGemini وAider وpi) يُعرف من البرامج التي تحت الشيل أو من العنوان الذي يضعه. والحالة تأتي بالترتيب من: ما يخبرنا به البرنامج نفسه (المتواليات `OSC 7501;state=working|blocked|done|error` و`OSC 9;4` و`OSC 133`)، ثم من الأسطر السفلية في الشاشة («esc to interrupt» أو سؤال إذن مرقّم أو `[y/n]`)، ثم من مدة هدوء الناتج. والأمر **OpenConsole: Explain the State of This Terminal** يبيّن ما الذي حسم الحالة والأسطر التي قُرئت. والطرفية التي تنظر إليها لا يُبلَّغ عنها.
- **الإشعارات:** عندما تحتاجك طرفية لا تنظر إليها (سؤال أو إذن)، أو تنادي بالجرس، أو تفشل، أو تنتهي، أو ينتهي وكيل/برنامج عمل مدة لا تقل عن `openconsole.attention.minWorkingSeconds` (15 ثانية)، تظهر رسالة فيها زر **Show** يفتح تلك الطرفية. ولا يتكرر الإشعار نفسه عن الطرفية نفسها قبل 30 ثانية. وشريط الحالة يعرض `$(bell) 2` (بلون تحذير عند وجود سؤال ينتظرك): اضغط عليه لترى القائمة، أو استعمل **OpenConsole: Go to the Next Terminal That Needs You**. والإعداد `openconsole.attention.notify` قيمه `all` و`important` (الأسئلة والجرس والفشل) و`off`؛ و`openconsole.agentRules` يضيف قواعدك الخاصة لمعنى شاشة البرنامج.
- **الأسماء والألوان:** انقر نقراً مزدوجاً على صف لتغيير اسم تلك الطرفية (الاسم الفارغ يعيد اسم نوعها، والاسم الجديد يظهر في الإشعارات أيضاً)، أو انقر بالزر الأيمن على صف لـ **Rename** ولون لأيقونته و**Split** و**Kill**. وفي لوحة الأوامر: **OpenConsole: Rename Terminal...** و**Change Terminal Colour...**.
- **أيقونات لما يعمل:** عند وجود أكثر من طرفية يلبس كل صف في القائمة أيقونة ما يعمل فيه: الوكيل (Claude Code وGemini وopencode وCopilot)، وإلا البرنامج الذي تحت الشيل (Node.js وnpm وYarn وpnpm وBun وDeno وPython وGit وDocker وGo وRust وJava وC# وPHP وRuby وVim)، وإلا نوع الشيل (PowerShell وGit Bash وCommand Prompt وWSL)، وتتغير وحدها عند تغيّر البرنامج. والطرفية التي أعطيتها لوناً تبقى بأيقونتها العادية بذلك اللون. والصور هي أيقونات [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme) لـ Material Extensions (رخصة MIT، محفوظة في `media/vendor/LICENSES.txt`).
- **تشغيل عدة سكربتات معاً:** الأمر **OpenConsole: Run package.json Scripts in Parallel...** يعرض سكربتات ملفات `package.json` في مساحة العمل (الجذر ومستوى واحد من workspaces؛ npm وYarn وpnpm وbun، ويُعرف المدير من ملف القفل أو `packageManager`). علّم ما تريد: كل سكربت في طرفية خاصة باسم `<الحزمة>: <السكربت>` وفي مجلد حزمته، وعلى الأكثر `openconsole.scripts.maxParallel` (4) في الوقت نفسه؛ وعندما ينتهي واحد يبدأ التالي (`0` يبدأ الكل دفعة واحدة، للخوادم التي لا تنتهي). واسم السكربت الذي ليس كلمة واحدة عادية (مسافات أو `;` أو `&&` أو علامات اقتباس) لا يُكتب في أي شيل أبداً.
- **مجموعات طرفيات محفوظة:** ضع الملف `.openconsole/groups.json` في مساحة العمل (`{ "groups": [ { "name": "dev", "terminals": [ { "name": "api", "cwd": "packages/api", "command": "npm run dev", "color": "green" } ] } ] }`؛ والأمر **OpenConsole: Edit Saved Groups** ينشئ الملف) ثم **Start a Saved Group of Terminals...** يفتح طرفية لكل بند بمجلدها واسمها ولونها وأمرها. الأوامر نص من المستودع فتُعرض في سؤال قبل أن تعمل (يمكنك اعتماد مجموعة؛ وإذا تغيّر أمر فيها يُسأل من جديد)، ولا يجوز لـ `cwd` أن يخرج من مساحة العمل، ولا أن يحوي الأمر رموز تحكم.
- **شجرة عمل (worktree) لكل وكيل:** **New Terminal in a Fresh Git Worktree...** ينشئ فرعاً جديداً `oc/<الاسم>` في مجلد خاص بجانب المستودع (`git worktree`) ويفتح فيه طرفية ويكتب الأمر الموجود في `openconsole.worktree.startCommand` (مثلاً `claude`). فيعمل عدة وكلاء على المشروع نفسه في الوقت نفسه دون أن يلمس أحدهم ملفات الآخر. و**Remove an Agent Worktree...** يحذف واحدة (ويحذّرك إن كان فيها تغييرات غير مثبّتة). أغلق الطرفيات الموجودة داخل المجلد أولاً: ويندوز لا يحذف مجلداً يوجد فيه برنامج.
- **رسائل log داخل المحرر:** حدّد متغيراً (أو ضع المؤشر عليه) واضغط `Ctrl+Alt+L` ثم `L`: يُدرج سطر مثل `console.log("▶ › Cart › add › item:", item)` بعد العبارة التي تعطي المتغير قيمته (وقبل `if` و`return`، وفي أول الدالة للمعامل)، بإزاحة جيرانه، مع اسم الصنف والدالة. وفي بايثون يكون `print(...)` (و`logging.*` للأنواع info وdebug وwarn مع إضافة `import logging` إن لم يوجد). المفاتيح الأخرى بعد `Ctrl+Alt+L`: `I` معلومة، `D` تنقيح، `T` جدول، `W` تحذير، `E` خطأ، `M` دالتك أنت، ثم `C` لتعليق الكل، `U` لإلغاء التعليق، `X` لحذف الكل، `R` لتصحيح الكل (اسم الملف وأرقام الأسطر للرسائل التي انتقلت). وتعمل الأربعة الأخيرة على رسائل OpenConsole في الملف الحالي فقط (الرسالة تُحسب إذا احتوت البادئة والفاصل معاً)، وكل واحدة خطوة تراجع واحدة. ومع عدة مؤشرات يعمل كلها معاً. المحدّد تقريبي (محلّل رموز ومسح للعبارات، وليس مُحلِّلاً كاملاً): إذا لم يعرف وضع السطر بعد العبارة، وفي الأماكن الغريبة يقول لا بدل أن يكتب سطراً خاطئاً. والإعدادات `openconsole.log.*` تغيّر البادئة والفاصل وعلامة الاقتباس والدالة واسم الملف ورقم السطر والفاصلة المنقوطة والأسطر الفارغة. فكرتها من إضافة Turbo Console Log (لـ Chakroun Anas)؛ وهذه مكتوبة باستقلال دون شيفرتها.
- **طرفياتك في المتصفح:** الأمر **OpenConsole: Share Terminals on the Web...** (أو زر البث في شريط أدوات اللوحة، وهو يفتح قائمة المشاركة بعد تشغيلها؛ مطفأ حتى تطلبه) يتيح لك فتح الطرفيات نفسها، لا نسخاً عنها، في متصفح على هاتف أو حاسوب آخر. تختار الطرفيات؛ ويبدأ خادم صغير على هذا الحاسوب فقط (`127.0.0.1`) وتحصل على رابط يعمل مرة واحدة ولعشر دقائق، وسرّه بعد علامة `#` (التي لا يرسلها المتصفح إلى أي خادم). افتحه في المتصفح: فيسألك VS Code **Allow viewing** أو **Allow typing** أو **Deny** لذلك المتصفح، فالرابط الذي يتسرّب لا قيمة له دون ضغطتك. ثم يعرض المتصفح الطرفيات بمقاس لوحتك، مع شريط مفاتيح للهاتف (Esc وTab وCtrl والأسهم...)، والعربية تُرسم كما في VS Code. وشريط الحالة يعرض `$(broadcast) Web` طالما شيء مشترك (اضغط عليه: رابط جديد، المتصفحات المقترنة، إيقاف). وللوصول من خارج هذا الحاسوب تشغّل أنت نفقاً (مثلاً `cloudflared tunnel --url http://127.0.0.1:<port>` أو Tailscale Serve) وتضع عنوانه في `openconsole.web.publicUrl`: فلا يُقبل عندئذ إلا ذلك المضيف. لا يوجد خادم وسيط ولا حساب. الأمان: أسرار عشوائية 256 بت ولا يُحفظ إلا ما يُشتق منها، بلا كوكيز، فحص دقيق للـ Host والـ Origin، حدّ أعلى `openconsole.web.maxClients` للمتصفحات، وحدّ للمحاولات، وتحليل صارم لـ WebSocket، وردود الطرفية على استعلامات الطرفية لا تُكتب أبداً، والمتصفح المسموح له بالمشاهدة فقط لا يستطيع الكتابة أبداً. ينتهي الاشتراك بـ **Stop Sharing on the Web** أو بإغلاق VS Code. وتذكّر أن متصفحاً يُسمح له بالكتابة يفعل في تلك الطرفية كل ما تفعله أنت.
- **عدة طرفيات:** زر **+** في شريط الأدوات يضيف طرفية أخرى إلى اللوحة، ولكل واحدة شيلها الخاص. وتظهر قائمة على اليمين عند وجود أكثر من طرفية، كما في الطرفية المدمجة: اضغط على اسم للتبديل. والصف الذي تشير إليه أو الذي عليه التركيز يُظهر زرين: **تقسيم الطرفية** (أيقونة الفتحتين) و**سلة المهملات** التي تُنهي تلك الطرفية (وآخر طرفية تُعاد تشغيلها بدل حذفها). زرا **Restart** و**Clear** يعملان على الطرفية المعروضة في اللوحة. و**Clear** يعيد تشغيل الطرفية (شيل جديد وشاشة فارغة، فينتهي ما كان يعمل فيها)، ويمكن إيقاف ذلك بالإعداد `openconsole.clearRestartsTerminal`. **والنص يتبع العرض:** عند سحب الخط بين الطرفية والقائمة أو تغيير حجم اللوحة يُعاد لفّ ما على الشاشة والسطر الطويل الذي تكتبه على العرض الجديد، عند التضييق وعند التوسيع.
- **طرفيات من نوع تختاره:** السهم بجانب **+** يفتح قائمة منسدلة كما في الطرفية المدمجة (تُرسم أعلى يمين الطرفية بألوان قوائم VS Code): طرفية جديدة بنوع تختاره (PowerShell وPowerShell 7 وCommand Prompt وGit Bash وكل توزيعة WSL والأنواع التي لها مسار في `terminal.integrated.profiles.windows`)، و**New Terminal in Editor**، و**Select Default Profile** (الشيل الذي يبدأه **+**)، و**Split Terminal**، و**Configure Terminal Settings**.
- **تقسيم الطرفية:** زر التقسيم في الصف (أو **Split Terminal** في تلك القائمة أو في لوحة الأوامر) يفتح طرفية جديدة عن يمين التي عليها التركيز، من النوع نفسه، وتظهر الاثنتان جنباً إلى جنب بينهما خط. وفي القائمة تتدلى طرفيات المجموعة تحت بعضها. اضغط داخل طرفية لينتقل التركيز إليها. وعند إنهاء واحدة تأخذ الأخرى العرض كله. والخط الفاصل بين الطرفية والقائمة يُسحب يميناً ويسارًا لتغيير عرض القائمة (يضيء عند المرور عليه، والنقر المزدوج يعيد العرض المعتاد، ويُحفظ العرض). التقسيم جنباً إلى جنب فقط (لا تقسيم فوق وتحت).
- **توقّع ما ستكتبه:** أثناء الكتابة عند الـ prompt يظهر بالرمادي بعد المؤشر باقي أحدث أمر من سجلّك يبدأ بما كتبته، و**السهم الأيمن** (أو **End**) يكتبه، وأي مفتاح آخر يتجاهله. السجل هو سجل PowerShell (ملف `ConsoleHost_history.txt`) مع الأوامر التي تنفّذها في هذه الطرفيات. لا يظهر أثناء تشغيل برنامج آخر في الطرفية، ولا في الشاشة البديلة (vim وless)، ولا إذا كان بعد المؤشر نص، ولا إذا كانت التكملة ستكمل كلمة عربية أو عبرية كتبتها (الكلمة تُرسم من اليمين فستقع التكملة الرمادية في الجهة الخطأ). يُطفأ بالإعداد `openconsole.suggestions`. الخصوصية: الأوامر التي تنفّذها هنا (حتى 300) ومجلدات الـ prompt (حتى 40) تُحفظ في حالة الإضافة داخل VS Code على جهازك فقط؛ وعند إطفاء الإعداد لا يُقرأ ولا يُحفظ شيء. والأمر **OpenConsole: Forget the Remembered Commands and Folders** يحذفها (ملف سجل PowerShell لا يُغيَّر أبداً).
- **قائمة النقاط الثلاث في اللوحة** كما في الطرفية المدمجة: **Scroll to Previous Command** و**Scroll to Next Command** (`Ctrl+↑` و`Ctrl+↓` داخل الطرفية؛ تنتقل بين الأوامر التي نفّذتها في هذه الطرفية)، و**Clear Terminal**، و**Run Active File** (يكتب مسار ملف المحرر)، و**Run Selected Text** (يكتب النص المحدد أو سطر المؤشر)، و**Go to Recent Directory...** (`Ctrl+G` داخل الطرفية)، و**Run Recent Command...** (`Ctrl+Alt+R`). القائمة لا تعرض المفاتيح بجانب البنود لكنها تعمل داخل الطرفية، والبنود نفسها في لوحة الأوامر باسم **OpenConsole: ...**. أما **Start Dictation** فليست هنا: تحتاج إضافة الكلام في VS Code وهي تخدم طرفيته المدمجة فقط.

**لماذا إضافة وليس إعداداً؟** VS Code يرسم طرفيته بنفسه. إيقاف تسريع GPU (`terminal.integrated.gpuAcceleration` = `off`) يصل الحروف داخل
الكلمة لكن يبقي الكلمات من اليسار إلى اليمين («السلام» تظهر على اليسار)، ويفسد البرامج التي ترتّب النص بنفسها مثل Claude Code.
الإضافة تعالج الأمرين. ولمن يفضّل نافذة الطرفية الحقيقية بدل التبويب: ملف تعريف (profile) يفتحها من قائمة زر `+`؛ انظر README
مشروع OpenConsole («نافذة الطرفية من VS Code»).

**القيود:** ويندوز فقط؛ ليست الطرفية المدمجة (لا تكامل صدفة، والتقسيم جنباً إلى جنب فقط)؛ تظليل التحديد الجزئي لأسطر عربية قد لا ينطبق
على الحروف (النسخ يعطي النص الصحيح)؛ محرك DOM أبطأ من محرك GPU عند الكتابة السريعة جداً.

## من وراء المشروع

أنا [yousef0688](https://github.com/yousef0688)، وأعمل في [دار البرمجيات لتطوير الأنظمة](https://softwarehouse.com.jo/)
(Software House for System Development)، وهي شركة برمجة أردنية في عمّان. الكود المصدري ونافذة الطرفية التي تنتمي إليها هذه
الإضافة في [github.com/yousef0688/OpenConsole-Arabic-Terminal](https://github.com/yousef0688/OpenConsole-Arabic-Terminal).

</div>
