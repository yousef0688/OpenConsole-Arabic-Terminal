'use strict';
// OpenConsole: a terminal in the panel of VS Code that shows Arabic and Hebrew text correctly.
// The shell runs in a pseudo console (bin/conpty-bridge.exe); the text is drawn by xterm.js in a webview, with the
// right-to-left layer of media/arabic-layout.js + media/row-patcher.js.
// One webview (the panel view, or an editor tab) holds one or more terminals; every terminal has its own shell.

const vscode = require('vscode');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TerminalSession } = require('./session');
const { getHtml } = require('./webview-html');
const { detectProfiles } = require('./profiles');
const { CommandHistory } = require('./history');
const { AttentionTracker, label } = require('./attention');
const scripts = require('./scripts');
const worktrees = require('./worktrees');
const { RunQueue } = require('./launcher');
const { WebShare, Ring } = require('./webshare');
const turboLog = require('./turbolog-commands');

const VIEW_ID = 'openconsole.terminal';
const IMAGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const CURSOR_STYLES = { line: 'bar', block: 'block', underline: 'underline' };

/**
 * The conpty.dll that VS Code ships for its own terminal (with the OpenConsole.exe of the same version, in the same folder), or
 * null. It is a newer pseudo console than the one in Windows, and it is the only one that can be cleared (see "Clear"), so it is
 * used only for a Clear that keeps the shell (openconsole.clearRestartsTerminal off). Otherwise the one of Windows is better: after a
 * resize it repaints the screen, which is what lets the line that you are typing (the row of the cursor, which xterm.js leaves to
 * the program) wrap again at the new width. The newer one sends nothing then, and the line is cut off at the narrower width and
 * does not come back when the terminal gets wider again.
 */
function findVSCodeConPty() {
    const oc = vscode.workspace.getConfiguration('openconsole');
    if (oc.get('useVSCodeConpty') === false || oc.get('clearRestartsTerminal') !== false) return null;
    const appRoot = vscode.env && vscode.env.appRoot;
    if (!appRoot) return null;
    const dir = path.join(appRoot, 'node_modules.asar.unpacked', 'node-pty', 'build', 'Release', 'conpty');
    const dll = path.join(dir, 'conpty.dll');
    return fs.existsSync(dll) && fs.existsSync(path.join(dir, 'OpenConsole.exe')) ? dll : null;
}

/** The name of the shell as the list of terminals shows it: powershell.exe -> powershell */
function shellName(shell) {
    return path.basename(String(shell || 'powershell.exe')).replace(/\.(exe|cmd|bat|com)$/i, '') || 'terminal';
}

function readConfig() {
    const oc = vscode.workspace.getConfiguration('openconsole');
    const terminal = vscode.workspace.getConfiguration('terminal.integrated');
    const editor = vscode.workspace.getConfiguration('editor');
    const build = parseInt((os.release().split('.')[2] || '22621'), 10);
    return {
        fontFamily: oc.get('fontFamily') || terminal.get('fontFamily') || editor.get('fontFamily') || 'Consolas, monospace',
        fontSize: oc.get('fontSize') || terminal.get('fontSize') || editor.get('fontSize') || 14,
        lineHeight: terminal.get('lineHeight') || 1,
        cursorStyle: CURSOR_STYLES[terminal.get('cursorStyle')] || 'bar',
        cursorBlink: terminal.get('cursorBlinking') === true,
        scrollback: terminal.get('scrollback') || 1000,
        textFont: oc.get('textFont'),
        iconFont: oc.get('iconFont'),
        shellName: shellName(oc.get('shell')),
        suggestions: oc.get('suggestions') !== false,
        rightClickPaste: oc.get('rightClickPaste') !== false,
        motionSpeed: Number.isFinite(oc.get('motionSpeed')) ? Math.min(Math.max(oc.get('motionSpeed'), 0), 4) : 1,
        windowsBuildNumber: Number.isFinite(build) ? build : 22621,
        agentRules: Array.isArray(oc.get('agentRules')) ? oc.get('agentRules').slice(0, 50) : [],
        attentionMinSeconds: Number.isFinite(oc.get('attention.minWorkingSeconds')) ? Math.min(Math.max(oc.get('attention.minWorkingSeconds'), 0), 3600) : 15,
    };
}

function pad(n, width = 2) {
    return String(n).padStart(width, '0');
}

/** Saves a pasted screenshot as a PNG file in %TEMP%\OpenConsole, removes the ones older than a week, returns the path. */
function saveImage(base64) {
    const dir = path.join(os.tmpdir(), 'OpenConsole');
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date();
    for (const name of fs.readdirSync(dir)) {
        if (!/^clipboard-.*\.png$/.test(name)) continue;
        try {
            const file = path.join(dir, name);
            if (now.getTime() - fs.statSync(file).mtimeMs > IMAGE_MAX_AGE_MS) fs.unlinkSync(file);
        } catch { /* in use or already gone */ }
    }
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`;
    const file = path.join(dir, `clipboard-${stamp}.png`);
    fs.writeFileSync(file, Buffer.from(base64, 'base64'), { flag: 'wx' });
    return file;
}

/** One terminal: a shell in a pseudo console, shown as one xterm.js instance of the webview (its id is the id of that instance). */
class ShellTerminal {
    /** @param {{name: string, path: string, args: string[]}} [profile] what to start; without it the shell of the settings */
    constructor(host, id, profile) {
        this.host = host;
        this.id = id;
        this.profile = profile || null;
        this.session = null;
        this.shellPath = '';
        this.busy = false;              // another program than the shell runs in it: the shell is not at its prompt
        this.mode = 'implicit';
        this.procs = [];
        this.programKey = '';
        this.sawBusy = false;           // a program has run in it
        this.onIdle = null;             // called once when what ran in it has ended (see launcher.js)
        this.cwd = '';                  // the folder where the shell was started
        this.columns = 80;
        this.rows = 24;
        this.webId = ++terminalCounter;   // the name of this terminal for a browser (the ids of the webviews repeat from view to view)
        this.ring = new Ring();           // what it wrote lately, to play back to a browser that joins late
        this.label = '';                  // the name that the list shows (the page tells it)
    }

    post(message) {
        this.host.post({ ...message, id: this.id });
    }

    start() {
        if (process.platform !== 'win32') {
            this.host.post({ t: 'error', message: 'OpenConsole works on Windows only.' });
            return;
        }
        const bridge = path.join(this.host.extensionPath, 'bin', 'conpty-bridge.exe');
        if (!fs.existsSync(bridge)) {
            this.host.post({ t: 'error', message: 'bin/conpty-bridge.exe is missing. Build it with native/build.ps1 (see the README of the extension).' });
            return;
        }
        const oc = vscode.workspace.getConfiguration('openconsole');
        const shell = this.profile ? this.profile.path : (oc.get('shell') || 'powershell.exe');
        const args = this.profile ? this.profile.args : (oc.get('shellArgs') || []);
        this.shellPath = shell;
        const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
        let cwd = folder && folder.uri.scheme === 'file' ? folder.uri.fsPath : os.homedir();
        if (!fs.existsSync(cwd)) cwd = os.homedir();
        if (this.profile && this.profile.cwd && fs.existsSync(this.profile.cwd)) cwd = this.profile.cwd;     // a script, a group, a worktree
        this.cwd = cwd;

        const conpty = findVSCodeConPty();
        const session = new TerminalSession({
            bridgePath: bridge, shell, args, cwd, columns: this.columns, rows: this.rows,
            env: Object.assign({ TERM_PROGRAM: 'OpenConsole', COLORTERM: 'truecolor' }, conpty ? { OC_CONPTY_DLL: conpty } : {}),
        });
        this.session = session;
        // a terminal that was started for a command (a script, a group, a worktree) types it once the shell has written its first output
        let pending = this.profile && typeof this.profile.initialText === 'string' && this.profile.initialText ? this.profile.initialText : '';
        session.on('output', (data) => {
            this.post({ t: 'output', data });
            this.ring.push(data);
            webTap('output', this, data);
            if (pending) {
                const text = pending;
                pending = '';
                setTimeout(() => { if (this.session === session) session.write(text); }, 600);
            }
        });
        session.on('exit', (code) => { if (this.session === session) { this.post({ t: 'exit', code }); webTap('exit', this, code); this.idle(); } });
        session.on('procs', (names) => { this.procs = names; this.updateMode(); this.updateBusy(); });
        session.on('error', (message) => this.host.post({ t: 'error', message }));
        session.start();
    }

    restart() {
        if (this.session) { this.session.dispose(); this.session = null; }
        this.ring.clear();
        webTap('output', this, String.fromCharCode(27) + 'c');            // a browser sees the screen start again
        this.post({ t: 'reset' });
        this.mode = 'implicit';
        this.post({ t: 'mode', mode: 'implicit' });
        this.procs = [];
        this.updateBusy();
        this.start();
    }

    /** The page is told when a program other than the shell runs in the terminal (it does not suggest commands then). */
    updateBusy() {
        const exe = path.basename(this.shellPath || '').toLowerCase();
        const shell = /\.(exe|com)$/.test(exe) ? exe : exe + '.exe';
        const programs = this.procs.filter((name) => name !== shell && name !== 'conhost.exe' && name !== 'openconsole.exe');
        const busy = programs.length > 0;
        const key = programs.join('|');
        // the page also learns which programs run (it tells an agent from a build by the name), so a change of them is told as well
        if (busy !== this.busy || key !== this.programKey) {
            const finished = this.busy && !busy;
            this.busy = busy;
            this.programKey = key;
            if (busy) this.sawBusy = true;
            this.post({ t: 'busy', busy, programs });
            if (finished) this.idle();
        }
    }

    /** What ran in this terminal (a command that was typed for a script, a group or a worktree) has ended: whoever waits for that is told once. */
    idle() {
        const callback = this.onIdle;
        this.onIdle = null;
        if (callback) callback();
    }

    /** What kind of shell it is, for the commands that are typed into it: powershell, cmd or other. */
    kind() {
        const shell = String(this.profile ? this.profile.path : (vscode.workspace.getConfiguration('openconsole').get('shell') || 'powershell.exe')).toLowerCase();
        if (/powershell|pwsh/.test(shell)) return 'powershell';
        return /(^|[\\/])cmd(\.exe)?$/.test(shell) ? 'cmd' : 'other';
    }

    /**
     * The mode of the layout: the programs that reorder Arabic text themselves (Claude Code) need the "visual" mode, and the
     * coding agents that redraw a text box while one types in it (opencode) the "words" mode.
     */
    updateMode() {
        const oc = vscode.workspace.getConfiguration('openconsole');
        const setting = oc.get('bidiMode');
        let mode = 'implicit';
        if (setting === 'visual' || setting === 'words') mode = setting;
        else if (setting !== 'implicit') {
            const names = (key) => (oc.get(key) || []).map((s) => String(s).toLowerCase());
            if (this.procs.some((p) => names('visualBidiApps').includes(p))) mode = 'visual';
            else if (this.procs.some((p) => names('wordsBidiApps').includes(p))) mode = 'words';
        }
        if (mode !== this.mode) {
            this.mode = mode;
            this.post({ t: 'mode', mode });
        }
    }

    /** The right mouse button, or Ctrl+Shift+V: what is in the clipboard goes to the terminal (the page cannot read it itself). */
    async pasteClipboard() {
        let text = '';
        try { text = await vscode.env.clipboard.readText(); }
        catch { /* no clipboard to read */ }
        // no text: maybe a screenshot, which only the page can read
        this.post(text ? { t: 'paste', text } : { t: 'pasteEmpty' });
    }

    pasteImage(base64) {
        try {
            const file = saveImage(base64);
            this.post({ t: 'paste', text: /\s/.test(file) ? `"${file}"` : file, image: true });
        } catch (e) {
            this.host.post({ t: 'error', message: 'Cannot save the pasted image: ' + e.message });
        }
    }

    sendText(text) {
        if (this.session) this.session.write(text);
    }

    /**
     * Clear. By default it starts the terminal again (a new shell, an empty screen), as the user asked: setting
     * openconsole.clearRestartsTerminal. Without that, it clears the screen and what scrolled off it, except the row of the prompt,
     * and the pseudo console has to forget its screen too, or it draws the cleared lines again at the next resize (and the prompt
     * jumps back down to its old row).
     */
    clear() {
        if (vscode.workspace.getConfiguration('openconsole').get('clearRestartsTerminal') !== false) {
            this.restart();
            return;
        }
        if (this.session) this.session.clearScreen(true);
        this.post({ t: 'clear' });
    }

    dispose() {
        if (this.session) { this.session.dispose(); this.session = null; }
        this.idle();
    }
}

/**
 * An address that the user opened with Ctrl + click in the output of a terminal. Only http and https are opened: what a program prints
 * is not to be trusted, so a "file:" or "command:" address (which could run something) is left alone. VS Code shows its own question
 * for addresses that it does not trust yet.
 */
function openLink(text) {
    if (typeof text !== 'string' || text.length > 4096 || !/^https?:\/\//i.test(text)) return false;
    try {
        if (!new URL(text).hostname) return false;                       // "https://" alone is not an address (a bad one throws)
        const uri = vscode.Uri.parse(text, true);
        if (uri.scheme !== 'http' && uri.scheme !== 'https') return false;
        Promise.resolve(vscode.env.openExternal(uri)).catch(() => { /* the user said no, or there is no browser */ });
        return true;
    }
    catch { return false; }
}

let hostCounter = 0;
let terminalCounter = 0;

/** What a terminal tells the web sharing (src/webshare.js), set by activate: output, resize, exit, title, state, forget. */
let webTap = () => { };

const TAB_COLORS = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink'];

/** Asks for the name of a terminal (the double click on its row, "Rename Terminal"); an empty answer gives its kind back. */
async function askName(terminal, current) {
    const value = await vscode.window.showInputBox({ prompt: 'Name of the terminal (empty: the name of its kind)', value: String(current || '').slice(0, 60) });
    if (value !== undefined) terminal.post({ t: 'setName', name: value });
}

/** "Change Terminal Colour": a list of colours, and the terminal wears the one that is picked. */
async function askColor(terminal) {
    const picked = await vscode.window.showQuickPick(
        [...TAB_COLORS.map((name) => ({ label: name[0].toUpperCase() + name.slice(1), color: name })), { label: 'No colour', color: '' }],
        { placeHolder: 'The colour of the icon of this terminal in the list' });
    if (picked) terminal.post({ t: 'setColor', color: picked.color });
}

/**
 * The file that a path from the output of a terminal means, or null. The path is text that a program printed: a network path
 * ("\\server\share") is refused (looking at it would make Windows send the credentials of the user to that server), so is a path
 * that is relative to a drive ("C:file"). A relative path is tried in the folder where the shell started, then in the folders of the
 * workspace. Only a file that exists counts.
 */
function resolveFile(rawPath, folders, exists = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } }) {
    const text = typeof rawPath === 'string' ? rawPath : '';
    if (!text || text.length > 1024 || text.includes('\0')) return null;
    if (/^[\\/]{2}/.test(text) || /^[A-Za-z]:(?![\\/])/.test(text)) return null;
    const expanded = /^~[\\/]/.test(text) ? path.join(os.homedir(), text.slice(2)) : text;
    const candidates = path.isAbsolute(expanded) && /^[A-Za-z]:/.test(expanded) ? [expanded] : folders.filter(Boolean).map((folder) => path.resolve(folder, expanded));
    return candidates.find((file) => !/^[\\/]{2}/.test(file) && exists(file)) || null;
}

/** Opens a file path that was opened with Ctrl + click ("src/app.ts:12:5") at its line and column. Returns whether a file was opened. */
function openFile(spec, cwd) {
    if (!spec || typeof spec !== 'object') return false;
    const folders = [cwd, ...(vscode.workspace.workspaceFolders || []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath)];
    const file = resolveFile(spec.path, folders);
    if (!file) {
        vscode.window.showInformationMessage('Cannot find the file: ' + String(spec.path).slice(0, 200));
        return false;
    }
    const line = Number.isInteger(spec.line) && spec.line > 0 ? spec.line - 1 : -1;
    const col = Number.isInteger(spec.col) && spec.col > 0 ? spec.col - 1 : 0;
    const options = line >= 0 ? { selection: new vscode.Range(line, col, line, col), preview: true } : { preview: true };
    Promise.resolve(vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file), options)).catch(() => { /* a file that cannot be shown (binary, too big): VS Code says so */ });
    return true;
}

/** One webview (the panel view, or an editor tab) with its terminals. */
class TerminalHost {
    constructor(webview, extensionPath, hosts) {
        this.webview = webview;
        this.extensionPath = extensionPath;
        this.hosts = hosts;
        this.terminals = new Map();     // id of the xterm.js instance in the webview -> ShellTerminal
        this.profiles = new Map();      // token of a terminal that was asked for -> its profile, until the webview reports it
        this.tokens = 0;
        this.history = null;            // the commands and folders that were used (shared by all the views), set by activate
        this.runAction = null;          // what a key of the page asks for (a recent directory, a recent command), set by activate
        this.runMenu = null;            // what an entry of the menu next to "+" asks for (it is drawn by the page), set by activate
        this.activeId = null;           // the terminal that is shown
        this.disposed = false;
        this.hostId = ++hostCounter;    // for the key of a terminal in the list of those that need the user
        this.attention = null;          // who is told what the terminals ask (src/attention.js), set by activate
        this.reveal = () => { };        // shows this view (the panel, or the editor tab), set by activate
        this.explained = null;          // where the explanation of a state goes, set by activate
        hosts.add(this);
    }

    post(message) {
        if (!this.disposed) this.webview.postMessage(message);
    }

    active() {
        return this.terminals.get(this.activeId) || null;
    }

    /** The name of a terminal of this view among all the views. */
    key(id) {
        return this.hostId + ':' + id;
    }

    /** Shows this view and chooses that terminal in it. */
    showTerminal(id) {
        if (!this.terminals.has(id)) return false;
        this.reveal();
        this.post({ t: 'show', id });
        return true;
    }

    handle(m) {
        const terminal = this.terminals.get(m.id);
        switch (m.t) {
            case 'hello':
                this.post({ t: 'config', config: readConfig() });
                if (this.history && readConfig().suggestions) this.post({ t: 'history', replace: true, commands: this.history.all() });
                break;
            case 'command':
                // a command was entered at a prompt: for the suggestions of all the terminals
                if (this.history && typeof m.text === 'string' && readConfig().suggestions && this.history.add(m.text)) {
                    if (m.directory) this.history.addDirectory(m.directory);
                    for (const host of this.hosts) host.post({ t: 'history', commands: [m.text.trim()] });
                }
                break;
            case 'action': if (terminal && this.runAction) this.runAction(m.action, terminal); break;
            case 'menuPick': if (this.runMenu && typeof m.id === 'string') this.runMenu(m.id); break;
            case 'openLink': openLink(m.uri); break;
            case 'openFile': if (terminal) openFile(m, terminal.cwd); break;
            case 'renameAsk': if (terminal) askName(terminal, m.name); break;
            case 'agentState':
                if (terminal) {
                    if (typeof m.name === 'string' && m.name !== terminal.label) { terminal.label = m.name.slice(0, 80); webTap('title', terminal, terminal.label); }
                    webTap('state', terminal, m.state, m.attention === true);
                    if (this.attention) this.attention.state(this.key(m.id), m);
                }
                break;
            case 'attention': if (terminal && this.attention) this.attention.event(this.key(m.id), m); break;
            case 'stateExplained': if (terminal && this.explained) this.explained(m); break;
            case 'ready': {
                // the webview created a terminal (the first one, or a new one): start its shell
                // a split is of the kind of the terminal that it splits; a terminal that was chosen from the menu has its token
                const source = m.splitOf ? this.terminals.get(m.splitOf) : null;
                // a split starts in the same folder and with the same shell, but does not run the command of the first one again
                const profile = source ? (source.profile ? Object.assign({}, source.profile, { initialText: '', onCreate: undefined }) : undefined) : (m.token ? this.profiles.get(m.token) : undefined);
                const created = new ShellTerminal(this, m.id, profile);
                this.profiles.delete(m.token);
                created.columns = m.cols;
                created.rows = m.rows;
                this.terminals.set(m.id, created);
                this.activeId = m.id;
                if (profile && typeof profile.onCreate === 'function') { try { profile.onCreate(created); } catch { /* the one who asked is gone */ } }
                created.start();
                break;
            }
            case 'active': if (terminal) this.activeId = m.id; break;
            case 'close':
                if (terminal) {
                    terminal.dispose();
                    webTap('forget', terminal);
                    this.terminals.delete(m.id);
                    if (this.attention) this.attention.remove(this.key(m.id));
                    if (this.activeId === m.id) this.activeId = null;
                }
                break;
            case 'input': if (terminal && terminal.session) terminal.session.write(m.data); break;
            case 'binary': if (terminal && terminal.session) terminal.session.writeBytes(Buffer.from(m.data, 'latin1')); break;
            case 'resize':
                if (terminal) { terminal.columns = m.cols; terminal.rows = m.rows; if (terminal.session) terminal.session.resize(m.cols, m.rows); webTap('resize', terminal); }
                break;
            case 'restart':
                if (terminal) { terminal.columns = m.cols || terminal.columns; terminal.rows = m.rows || terminal.rows; terminal.restart(); }
                break;
            case 'pasteImage': if (terminal) terminal.pasteImage(m.data); break;
            case 'pasteRequest': if (terminal) terminal.pasteClipboard(); break;
            default: break;
        }
    }

    /** Splits the terminal that is shown: the webview opens a new one at its right side and reports it with "ready". */
    splitShown() {
        const terminal = this.active();
        if (terminal) this.post({ t: 'split', id: terminal.id });
    }

    /** Adds a terminal: the webview creates it and reports it with "ready" (and the token it was given). */
    newTerminal(profile) {
        if (!profile) { this.post({ t: 'new' }); return; }
        const token = ++this.tokens;
        this.profiles.set(token, profile);
        this.post({ t: 'new', token, title: profile.name });
    }

    updateModes() {
        for (const terminal of this.terminals.values()) terminal.updateMode();
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.hosts.delete(this);
        for (const id of this.terminals.keys()) if (this.attention) this.attention.remove(this.key(id));
        for (const terminal of this.terminals.values()) terminal.dispose();
        this.terminals.clear();
    }
}

function activate(context) {
    // The first version of this extension had another name (openconsole.openconsole-terminal). Both together show every button twice.
    if (vscode.extensions.getExtension('openconsole.openconsole-terminal')) {
        vscode.window.showWarningMessage('The old OpenConsole extension (openconsole.openconsole-terminal) is still installed next to this one, so every button of the terminal shows twice. Remove it, then reload the window.', 'Remove it')
            .then((choice) => (choice ? vscode.commands.executeCommand('workbench.extensions.uninstallExtension', 'openconsole.openconsole-terminal') : undefined))
            .then(() => vscode.window.showInformationMessage('Reload the window to finish.', 'Reload Window'))
            .then((choice) => (choice ? vscode.commands.executeCommand('workbench.action.reloadWindow') : undefined), () => { /* the user closed the message, or the removal failed */ });
    }

    const hosts = new Set();
    context.subscriptions.push({ dispose() { for (const host of Array.from(hosts)) host.dispose(); } });    // no shell is left when the extension stops
    let last = null;      // the webview that was used last, for the commands
    let panelHost = null; // the one of the panel view
    const history = new CommandHistory(context.globalState);      // the commands and folders that were used, for all the views
    const localRoots = [vscode.Uri.joinPath(context.extensionUri, 'media')];

    // What the terminals ask of the user: the status bar item, the notifications, the commands to go to the one that needs you
    const settingsOf = () => {
        const oc = vscode.workspace.getConfiguration('openconsole');
        return { notify: oc.get('attention.notify'), statusBar: oc.get('attention.statusBar') !== false };
    };
    const hostOfKey = (key) => {
        const [hostId, id] = String(key).split(':').map(Number);
        for (const host of hosts) if (host.hostId === hostId) return { host, id };
        return null;
    };
    const attention = new AttentionTracker({
        createStatusBarItem: () => vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90),
        warningBackground: vscode.ThemeColor ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined,
        notify: (kind, text, button) => (kind === 'warn' ? vscode.window.showWarningMessage(text, button) : vscode.window.showInformationMessage(text, button)),
        settings: settingsOf,
        show: (key) => { const found = hostOfKey(key); if (found) found.host.showTerminal(found.id); },
    });
    context.subscriptions.push({ dispose() { attention.dispose(); } });
    let stateChannel = null;
    const explained = (m) => {
        if (!stateChannel) { stateChannel = vscode.window.createOutputChannel('OpenConsole state'); context.subscriptions.push(stateChannel); }
        stateChannel.clear();
        stateChannel.appendLine(`${m.name || 'terminal'}: ${m.state}${m.kind ? ' (program: ' + m.kind + ')' : ''}`);
        stateChannel.appendLine('evidence: ' + (m.evidence || 'none'));
        if (m.message) stateChannel.appendLine('message: ' + m.message);
        stateChannel.appendLine('the rows that were read (the bottom of the screen):');
        for (const row of m.rows || []) stateChannel.appendLine('  | ' + row);
        stateChannel.show(true);
    };
    // these messages come from a view that is in the background as well: they must not make it the "last used" view
    const PASSIVE = new Set(['agentState', 'attention', 'stateExplained']);

    function attach(webview, disposeSignal, reveal) {
        webview.options = { enableScripts: true, localResourceRoots: localRoots };
        webview.html = getHtml(webview, context.extensionUri, vscode.Uri.joinPath);
        const host = new TerminalHost(webview, context.extensionPath, hosts);
        host.attention = attention;
        host.explained = explained;
        if (reveal) host.reveal = reveal;
        host.history = history;
        host.runAction = (action, terminal) => { if (actions[action]) actions[action](terminal); };
        host.runMenu = (id) => { const run = menuActions.get(id); if (run) run(); };
        last = host;
        webview.onDidReceiveMessage((m) => { if (!PASSIVE.has(m && m.t)) last = host; host.handle(m); });
        disposeSignal(() => { host.dispose(); if (last === host) last = null; if (panelHost === host) panelHost = null; });
        return host;
    }

    context.subscriptions.push(vscode.window.registerWebviewViewProvider(VIEW_ID, {
        resolveWebviewView(view) {
            const host = attach(view.webview, (cb) => view.onDidDispose(cb), () => vscode.commands.executeCommand(`${VIEW_ID}.focus`));
            panelHost = host;
            view.onDidChangeVisibility(() => { if (view.visible) host.post({ t: 'focus' }); });
        },
    }, { webviewOptions: { retainContextWhenHidden: true } }));

    context.subscriptions.push(vscode.commands.registerCommand('openconsole.focus', async () => {
        await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
        if (last) last.post({ t: 'focus' });
    }));

    // One more terminal in the panel (of the given profile, or the default shell of the settings). When the view has not been opened
    // yet, opening it starts the first one. What the buttons of VS Code hand to a command is not a profile, so it is checked.
    const isProfile = (value) => !!value && typeof value === 'object' && typeof value.path === 'string' && Array.isArray(value.args);
    const newPanelTerminal = async (profile) => {
        const existing = panelHost;
        await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
        if (existing && !existing.disposed) existing.newTerminal(isProfile(profile) ? profile : undefined);
        else if (last) last.post({ t: 'focus' });
    };
    // The terminal that is shown in a view (undefined when there is none)
    const shownIn = (host) => (host && !host.disposed ? host.active() : null);
    const register = (id, run) => context.subscriptions.push(vscode.commands.registerCommand(id, run));

    // The kinds of terminal that can be started here: the ones of Windows, WSL and the profiles of the user in VS Code
    const availableProfiles = () => detectProfiles({ custom: vscode.workspace.getConfiguration('terminal.integrated').get('profiles.windows') });
    const describe = (profile) => [profile.path, ...profile.args].join(' ');
    /** Splits the terminal that is shown in a view (the view is shown first). */
    const split = async (host) => {
        if (!host || host.disposed) return;
        if (host === panelHost) await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
        host.splitShown();
    };
    const defaultShell = () => {
        const oc = vscode.workspace.getConfiguration('openconsole');
        return { path: oc.get('shell') || 'powershell.exe', args: oc.get('shellArgs') || [] };
    };

    /** "Select Default Profile": the shell that "+" starts (the settings openconsole.shell and openconsole.shellArgs). */
    const selectDefaultProfile = async () => {
        const profiles = await availableProfiles();
        const current = defaultShell();
        const picked = await vscode.window.showQuickPick(
            profiles.map((profile) => ({ label: profile.name, description: describe(profile), detail: profile.path.toLowerCase() === current.path.toLowerCase() ? 'the default now' : undefined, profile })),
            { placeHolder: 'Select the default profile: the shell that "+" starts', matchOnDescription: true });
        if (!picked) return;
        const oc = vscode.workspace.getConfiguration('openconsole');
        const target = vscode.ConfigurationTarget ? vscode.ConfigurationTarget.Global : true;
        await oc.update('shell', picked.profile.path, target);
        await oc.update('shellArgs', picked.profile.args, target);
    };

    /**
     * The menu next to the "+": a new terminal of a chosen kind, as the arrow next to the "+" of the terminal of VS Code. An extension
     * cannot open a menu from a button of the toolbar with entries that are only known at run time (the profiles), so the page draws it,
     * like the menus of VS Code, at the top right of the terminal; its entries come back as { t: 'menuPick', id }.
     */
    let menuActions = new Map();
    const showNewTerminalMenu = async () => {
        const profiles = await availableProfiles();
        const entries = [
            { id: 'new', label: 'New Terminal', run: () => newPanelTerminal() },
            { id: 'editor', label: 'New Terminal in Editor', run: () => vscode.commands.executeCommand('openconsole.newEditorTerminal') },
            { id: 'split', label: 'Split Terminal', run: () => split(panelHost) },
            { separator: true },
            ...profiles.map((profile, i) => ({ id: 'profile:' + i, label: profile.name, run: () => newPanelTerminal(profile) })),
            { separator: true },
            { id: 'settings', label: 'Configure Terminal Settings', run: () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:openconsole.openconsole') },
            { id: 'default', label: 'Select Default Profile', run: () => selectDefaultProfile() },
        ];
        menuActions = new Map(entries.filter((e) => e.run).map((e) => [e.id, e.run]));
        await vscode.commands.executeCommand(`${VIEW_ID}.focus`);        // shows the view (and starts its first terminal when it was never open)
        if (panelHost && !panelHost.disposed) panelHost.post({ t: 'menu', items: entries.map((e) => (e.separator ? { separator: true } : { id: e.id, label: e.label })) });
    };

    // The buttons of the panel (its "+", the menu next to it, restart and clear) always act on the panel. The terminal that was used
    // last can be one in an editor tab, and a click on the panel must not clear that one. The commands of the Command Palette act
    // on the last used.
    register('openconsole.panel.newTerminal', () => newPanelTerminal());
    register('openconsole.panel.newTerminalMenu', showNewTerminalMenu);
    register('openconsole.panel.restart', () => { const terminal = shownIn(panelHost); if (terminal) terminal.restart(); });
    register('openconsole.panel.clear', () => { const terminal = shownIn(panelHost); if (terminal) terminal.clear(); });
    register('openconsole.newTerminal', () => newPanelTerminal());
    register('openconsole.splitTerminal', () => split(last));
    register('openconsole.newTerminalWithProfile', async () => {
        const profiles = await availableProfiles();
        const picked = await vscode.window.showQuickPick(
            profiles.map((profile) => ({ label: profile.name, description: describe(profile), profile })),
            { placeHolder: 'New OpenConsole terminal with a profile', matchOnDescription: true });
        if (picked) await newPanelTerminal(picked.profile);
    });
    register('openconsole.selectDefaultProfile', selectDefaultProfile);

    context.subscriptions.push(vscode.commands.registerCommand('openconsole.newEditorTerminal', () => {
        const panel = vscode.window.createWebviewPanel('openconsole.editor', 'OpenConsole', vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: localRoots });
        panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');
        const host = attach(panel.webview, (cb) => panel.onDidDispose(cb), () => panel.reveal());
        panel.onDidChangeViewState((e) => { if (e.webviewPanel.visible) host.post({ t: 'focus' }); });
    }));

    // ---- the menu "..." of the view: what the terminal of VS Code has there --------------------------------------------------
    const cdCommand = (terminal, dir) => (terminal.kind() === 'cmd' ? `cd /d "${dir}"` : terminal.kind() === 'powershell' ? `cd '${dir.replace(/'/g, "''")}'` : `cd "${dir}"`);
    const info = (text) => vscode.window.showInformationMessage(text);

    const actions = {
        /** Types "cd" into the terminal with a folder that the terminals were in (they are remembered from the prompts). */
        async recentDirectory(terminal) {
            const folders = history.directories();
            if (!folders.length) { info('No folders yet: they are remembered as you use the terminal.'); return; }
            const picked = await vscode.window.showQuickPick(
                folders.map((dir) => ({ label: path.basename(dir) || dir, description: dir, dir })),
                { placeHolder: 'Go to a recent directory', matchOnDescription: true });
            if (picked) terminal.sendText(cdCommand(terminal, picked.dir) + '\r');
        },
        /** Runs a command that was used before. */
        async recentCommand(terminal) {
            const commands = history.all().slice(-400).reverse();
            if (!commands.length) { info('No commands yet.'); return; }
            const picked = await vscode.window.showQuickPick(commands.map((command) => ({ label: command })), { placeHolder: 'Run a recent command' });
            if (picked) terminal.sendText(picked.label + '\r');
        },
        /** Types the path of the file of the editor, to run it. */
        runActiveFile(terminal) {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.uri.scheme !== 'file') { info('Open a file of the disk in the editor first.'); return; }
            const file = editor.document.uri.fsPath;
            terminal.sendText((terminal.kind() === 'powershell' ? `& '${file.replace(/'/g, "''")}'` : `"${file}"`) + '\r');
        },
        /** Types the selected text of the editor (the current line when nothing is selected), to run it. */
        runSelectedText(terminal) {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { info('Open a file in the editor first.'); return; }
            const text = (editor.document.getText(editor.selection) || editor.document.lineAt(editor.selection.active.line).text).replace(/\r?\n/g, '\r');
            if (text.trim()) terminal.sendText(text + '\r');
        },
        scrollToPreviousCommand(terminal) { terminal.post({ t: 'scrollCommand', dir: -1 }); },
        scrollToNextCommand(terminal) { terminal.post({ t: 'scrollCommand', dir: 1 }); },
    };
    // the item of the menu of the panel acts on the terminal that is shown in the panel; the one of the Command Palette on the last used
    for (const name of Object.keys(actions)) {
        register(`openconsole.panel.${name}`, () => { const terminal = shownIn(panelHost); if (terminal) return actions[name](terminal); });
        register(`openconsole.${name}`, () => { const terminal = shownIn(last); if (terminal) return actions[name](terminal); });
    }
    register('openconsole.clearCommandHistory', () => {
        history.clear();
        for (const host of hosts) host.post({ t: 'history', replace: true, commands: history.all() });
        info('The commands and folders that this extension remembered are forgotten. The history file of PowerShell is not touched.');
    });

    // ---- terminals that run something: package.json scripts, saved groups, the work trees of agents -----------------------------------
    const workspacePaths = () => (vscode.workspace.workspaceFolders || []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
    const oneFolder = async () => {
        const folders = workspacePaths();
        if (!folders.length) { info('Open a folder first.'); return null; }
        if (folders.length === 1) return folders[0];
        const picked = await vscode.window.showQuickPick(folders.map((dir) => ({ label: path.basename(dir) || dir, description: dir, dir })), { placeHolder: 'Which folder of the workspace?' });
        return picked ? picked.dir : null;
    };

    /**
     * A terminal in the panel that starts in a folder and types a command when its shell is up. done() is called when that command has
     * ended (at once when there is none): the queue of launcher.js starts the next one then.
     */
    const startTerminal = async ({ name, cwd, text, kind, color, done }) => {
        const shell = kind || defaultShell();
        await newPanelTerminal({
            name, path: shell.path, args: shell.args, cwd,
            initialText: text ? text + '\r' : '',
            onCreate: (terminal) => {
                if (color && TAB_COLORS.includes(color)) terminal.post({ t: 'setColor', color });
                if (!done) return;
                if (!text) { done(); return; }
                terminal.onIdle = done;
                // a command that never ran a program (the shell was not ready, the command was refused): do not wait for it for ever
                const timer = setTimeout(() => { if (!terminal.sawBusy) terminal.idle(); }, 30000);
                if (timer.unref) timer.unref();
            },
        });
    };

    /** "Run package.json Scripts in Parallel...": choose several scripts of the workspace; each runs in its own terminal, at most N at a time. */
    register('openconsole.runScripts', async () => {
        const folders = workspacePaths();
        if (!folders.length) { info('Open a folder first.'); return; }
        const items = scripts.allItems(scripts.discoverScripts(folders));
        if (!items.length) { info('No package.json scripts were found in this workspace.'); return; }
        const picked = await vscode.window.showQuickPick(
            items.map((item) => ({ label: scripts.terminalName(item), description: item.manager, detail: item.command, item })),
            { canPickMany: true, matchOnDetail: true, placeHolder: 'Choose the scripts to run, each in its own terminal' });
        if (!picked || !picked.length) return;
        const plan = scripts.planRun(picked.map((p) => p.item), { maxParallel: scripts.LIMITS.MAX_PARALLEL });
        if (plan.skipped.length) info(`${plan.skipped.length} of the scripts were left out (a script twice, or more than ${scripts.LIMITS.MAX_RUN_ITEMS} at once).`);
        const cap = Number(vscode.workspace.getConfiguration('openconsole').get('scripts.maxParallel'));
        new RunQueue(plan.batches.flat(), {
            cap: Number.isFinite(cap) ? cap : scripts.LIMITS.DEFAULT_MAX_PARALLEL,
            start: (item, done) => {
                startTerminal({ name: scripts.terminalName(item), cwd: item.packageDir, text: scripts.commandLine(item, item.script), done })
                    .catch(() => done());
            },
        }).run();
    });

    // the groups whose commands the user has agreed to run (by the hash of what they run), kept per workspace
    const approvedGroups = () => new Set(context.workspaceState.get('approvedGroups', []));
    const approveGroup = (digest) => { const all = Array.from(approvedGroups()); if (!all.includes(digest)) all.push(digest); return context.workspaceState.update('approvedGroups', all.slice(-100)); };

    /** "Start a Saved Group of Terminals...": the groups of .openconsole/groups.json. The commands are text of the repository: they are shown first. */
    register('openconsole.launchGroup', async () => {
        const found = [];
        const problems = [];
        for (const dir of workspacePaths()) {
            const loaded = scripts.loadGroups(dir);
            for (const group of loaded.groups) found.push({ dir, group });
            problems.push(...loaded.errors);
        }
        if (!found.length) {
            info(problems.length ? 'The saved groups have a problem: ' + problems[0] : 'No saved groups yet: use "OpenConsole: Edit Saved Groups" to make .openconsole/groups.json.');
            return;
        }
        const picked = await vscode.window.showQuickPick(
            found.map((f) => ({ label: f.group.name, description: `${f.group.terminals.length} terminal${f.group.terminals.length === 1 ? '' : 's'}`, detail: f.group.terminals.map((t) => t.name).join(', '), found: f })),
            { placeHolder: 'Start a saved group of terminals' });
        if (!picked) return;
        const { dir, group } = picked.found;
        const digest = scripts.groupDigest(group);
        if (!approvedGroups().has(digest)) {
            const lines = group.terminals.map((t) => `${t.name}: ${t.command || '(a plain shell)'}  [${t.cwd}]`).join('\n');
            const answer = await vscode.window.showWarningMessage(`The group "${group.name}" of this repository will run:\n${lines}`, { modal: true }, 'Start', 'Start and do not ask again for this group');
            if (!answer) return;
            if (answer !== 'Start') await approveGroup(digest);
        }
        const profiles = await availableProfiles();
        for (const t of group.terminals) {
            let cwd;
            try { cwd = scripts.resolveCwd(dir, t.cwd); }
            catch (e) { vscode.window.showWarningMessage(`${t.name}: ${e.message}`); continue; }
            const wanted = t.profile ? profiles.find((p) => p.name.toLowerCase() === String(t.profile).toLowerCase()) : null;
            await startTerminal({ name: t.name, cwd, text: t.command, kind: wanted ? { path: wanted.path, args: wanted.args } : undefined, color: t.color });
        }
    });

    register('openconsole.editGroups', async () => {
        const dir = await oneFolder();
        if (!dir) return;
        const loaded = scripts.loadGroups(dir);
        let file = loaded.file;
        if (!loaded.exists) file = scripts.saveGroups(dir, [{ name: 'dev', terminals: [{ name: 'shell', cwd: '.', command: '' }] }]);
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
    });

    /** "New Terminal in a Fresh Git Worktree...": an agent gets its own copy of the repository (a new branch oc/<name>), so several can work at once. */
    register('openconsole.newWorktreeTerminal', async () => {
        const dir = await oneFolder();
        if (!dir) return;
        if (!(await worktrees.isGitRepo(dir))) { info('This folder is not a git repository.'); return; }
        const name = await vscode.window.showInputBox({ prompt: 'A name for the work tree (a new branch oc/<name> is made from the current commit)', value: 'agent', validateInput: (v) => (worktrees.sanitizeWorktreeName(v) ? undefined : 'Use letters, digits, - and _') });
        if (!name) return;
        let made;
        try { made = await worktrees.createWorktree(dir, { name }); }
        catch (e) { vscode.window.showErrorMessage('Cannot make the work tree: ' + e.message); return; }
        const command = String(vscode.workspace.getConfiguration('openconsole').get('worktree.startCommand') || '').trim();
        await startTerminal({ name: 'wt ' + made.name, cwd: made.path, text: command });
        info(`The work tree is ${made.path} (branch ${made.branch}).`);
    });

    register('openconsole.removeWorktree', async () => {
        const dir = await oneFolder();
        if (!dir) return;
        let list;
        try { list = (await worktrees.listWorktrees(dir)).filter((w) => !w.isMain && /^oc\//.test(w.branch || '')); }
        catch (e) { vscode.window.showErrorMessage(e.message); return; }
        if (!list.length) { info('There is no work tree made by OpenConsole (branch oc/...).'); return; }
        const withStatus = await Promise.all(list.map(async (w) => ({ w, status: await worktrees.worktreeStatus(w.path).catch(() => null) })));
        const picked = await vscode.window.showQuickPick(
            withStatus.map(({ w, status }) => ({ label: w.branch, description: status ? (status.clean ? 'no changes' : `${status.changed} changed`) : 'unknown', detail: w.path, w, status })),
            { placeHolder: 'Remove which work tree?' });
        if (!picked) return;
        const dirty = !!picked.status && !picked.status.clean;
        if (dirty) {
            const answer = await vscode.window.showWarningMessage(`${picked.w.branch} has ${picked.status.changed} changed file(s) that are not committed. Removing it loses them.`, { modal: true }, 'Remove and lose the changes');
            if (!answer) return;
        }
        try {
            await worktrees.removeWorktree(dir, picked.w.path, { force: dirty, deleteBranch: true });
            info(`Removed ${picked.w.path}.`);
        }
        catch (e) { vscode.window.showErrorMessage('Cannot remove it: ' + e.message + ' (close the terminals that are in that folder first)'); }
    });

    // ---- the web: the same terminals in a browser (phone, another computer) ---------------------------------------------------------
    // Off until the owner asks. The server listens on this computer only; a browser reaches it through a tunnel that the owner runs
    // (openconsole.web.publicUrl). Every browser pairs with a link that works once and needs the owner's approval here, and it gets only
    // the terminals that the owner chose. See src/webshare.js and src/web/.
    let webChannel = null;
    const webLog = (line) => {
        if (!webChannel) { webChannel = vscode.window.createOutputChannel('OpenConsole web sharing'); context.subscriptions.push(webChannel); }
        webChannel.appendLine(new Date().toISOString() + ' ' + line);
    };
    const webTerminals = () => {
        const out = [];
        for (const host of hosts) {
            for (const t of host.terminals.values()) {
                out.push({ webId: t.webId, name: t.label || shellName(t.shellPath), cols: t.columns, rows: t.rows, ring: t.ring, write: (data) => { if (!t.session) return false; t.session.write(data); return true; } });
            }
        }
        return out;
    };
    const web = new WebShare({ mediaDir: path.join(context.extensionPath, 'media'), terminals: webTerminals, log: webLog });
    context.subscriptions.push({ dispose() { web.stop().catch(() => { /* closing */ }); } });
    webTap = (kind, terminal, a, b) => {
        switch (kind) {
            case 'output': web.output(terminal.webId, a); break;
            case 'resize': web.resize(terminal.webId, terminal.columns, terminal.rows); break;
            case 'exit': web.exit(terminal.webId, a); break;
            case 'title': web.title(terminal.webId, a); break;
            case 'state': web.state(terminal.webId, a, b); break;
            case 'forget': web.forget(terminal.webId); break;
            default: break;
        }
    };

    let webItem = null;
    const refreshWebItem = () => {
        if (!web.active) { if (webItem) webItem.hide(); return; }
        if (!webItem) {
            webItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 95);
            webItem.command = 'openconsole.web.menu';
            context.subscriptions.push(webItem);
        }
        const stats = web.server.stats();
        webItem.text = `$(broadcast) Web: ${web.sharedTerminals().length} shared, ${stats.clients} connected`;
        webItem.tooltip = 'OpenConsole is sharing terminals on the web. Click for the link, the devices and Stop.';
        webItem.backgroundColor = vscode.ThemeColor ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
        webItem.show();
    };
    let webEvents = null;
    const attachWebEvents = () => {
        if (webEvents === web.server) return;
        webEvents = web.server;
        web.server.on('approval', (request) => {
            Promise.resolve(vscode.window.showWarningMessage(
                `A browser wants to open your terminals: ${request.label} (${request.remoteAddress || 'unknown address'}). Allow it only if you just opened the link yourself.`,
                'Allow viewing', 'Allow typing', 'Deny')).then((choice) => {
                if (choice === 'Allow viewing') request.approve('read');
                else if (choice === 'Allow typing') request.approve('write');
                else request.deny();
            }, () => request.deny());
        });
        web.server.on('approval-cancel', () => { /* the browser gave up: the question stays until it is answered, and an answer is then ignored */ });
        web.server.on('connect', (d) => { refreshWebItem(); info(`${d.label} is connected (${d.role === 'write' ? 'it can type' : 'view only'}).`); });
        web.server.on('disconnect', () => refreshWebItem());
        web.server.on('limit', (l) => webLog('limit ' + JSON.stringify(l)));
    };
    const webSettings = () => {
        const oc = vscode.workspace.getConfiguration('openconsole');
        const clients = Number(oc.get('web.maxClients'));
        const hours = Number(oc.get('web.sessionHours'));
        return { publicUrl: oc.get('web.publicUrl') || '', maxClients: Number.isInteger(clients) && clients > 0 ? Math.min(clients, 20) : 5, ttlMs: (Number.isFinite(hours) && hours > 0 ? Math.min(hours, 72) : 8) * 3600 * 1000 };
    };
    const stopWeb = async () => { await web.stop(); refreshWebItem(); };

    /** A link for one browser: it is copied, or opened on this computer; the secret is never shown in a message. */
    const showWebLink = async () => {
        const link = web.pairingLink();
        const where = web.base.startsWith('http://127.0.0.1') ? 'this computer only' : web.base;
        const choice = await vscode.window.showInformationMessage(
            `Sharing ${web.sharedTerminals().length} terminal(s) (${where}). The link works once, for 10 minutes, and you approve the browser here.`,
            'Copy link', 'Open here', 'Stop sharing');
        if (choice === 'Copy link') await vscode.env.clipboard.writeText(link.url);
        else if (choice === 'Open here') await vscode.env.openExternal(vscode.Uri.parse(link.local));
        else if (choice === 'Stop sharing') await stopWeb();
    };

    register('openconsole.web.share', async () => {
        const all = webTerminals();
        if (!all.length) { info('Open a terminal first.'); return; }
        if (!web.active) {
            const ok = await vscode.window.showWarningMessage(
                'Share terminals on the web?\n\nA browser that pairs with your link can see the terminals that you choose and, if you allow it, type into them with your rights on this computer. Nothing is shared until you choose terminals, every browser needs your approval, and sharing ends when you stop it or close VS Code. The server listens on this computer only: to reach it from a phone you run a tunnel yourself (see openconsole.web.publicUrl).',
                { modal: true }, 'Continue');
            if (ok !== 'Continue') return;
        }
        const picked = await vscode.window.showQuickPick(
            all.map((t) => ({ label: t.name, description: `${t.cols} x ${t.rows}`, picked: web.shared.has(t.webId), id: t.webId })),
            { canPickMany: true, placeHolder: 'Which terminals can the browser open?' });
        if (!picked || !picked.length) return;
        try { await web.start(webSettings()); }
        catch (e) { vscode.window.showErrorMessage('Cannot start sharing: ' + e.message); return; }
        attachWebEvents();
        web.setShared(picked.map((p) => p.id));
        refreshWebItem();
        await showWebLink();
    });
    register('openconsole.web.newLink', async () => {
        if (!web.active) { info('Nothing is shared yet: use "OpenConsole: Share Terminals on the Web...".'); return; }
        await showWebLink();
    });
    register('openconsole.web.devices', async () => {
        if (!web.active) { info('Nothing is shared.'); return; }
        const devices = web.server.devices();
        if (!devices.length) { info('No browser has been paired yet.'); return; }
        const picked = await vscode.window.showQuickPick(
            devices.map((d) => ({ label: d.label, description: `${d.role === 'write' ? 'can type' : 'view only'}, ${d.connections ? 'connected' : 'not connected'}`, detail: d.remoteAddress || '', id: d.deviceId })),
            { placeHolder: 'Choose a browser to disconnect and forget' });
        if (!picked) return;
        web.server.revoke(picked.id);
        refreshWebItem();
        info(`${picked.label} was disconnected and forgotten.`);
    });
    register('openconsole.web.stop', async () => {
        if (!web.active) { info('Nothing is shared.'); return; }
        await stopWeb();
        info('Sharing on the web has stopped.');
    });
    // the button of the toolbar: starts sharing, or (when it is on) opens the menu of the sharing
    register('openconsole.panel.web', () => vscode.commands.executeCommand(web.active ? 'openconsole.web.menu' : 'openconsole.web.share'));
    register('openconsole.web.menu', async () => {
        const picked = await vscode.window.showQuickPick([
            { label: '$(link) New pairing link', id: 'openconsole.web.newLink' },
            { label: '$(device-desktop) Browsers...', id: 'openconsole.web.devices' },
            { label: '$(checklist) Choose the shared terminals...', id: 'openconsole.web.share' },
            { label: '$(debug-stop) Stop sharing', id: 'openconsole.web.stop' },
        ], { placeHolder: 'Sharing terminals on the web' });
        if (picked) await vscode.commands.executeCommand(picked.id);
    });

    register('openconsole.renameTerminal', () => { const terminal = shownIn(last); if (terminal) terminal.post({ t: 'renameRequest' }); else info('There is no terminal to rename.'); });
    register('openconsole.changeTerminalColor', () => { const terminal = shownIn(last); if (terminal) return askColor(terminal); info('There is no terminal to change.'); });
    register('openconsole.restart', () => { const terminal = shownIn(last); if (terminal) terminal.restart(); });
    register('openconsole.clear', () => { const terminal = shownIn(last); if (terminal) terminal.clear(); });
    register('openconsole.find', async () => {
        if (last === panelHost) await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
        const terminal = shownIn(last);
        if (terminal) terminal.post({ t: 'find' });
    });
    // ---- what the terminals ask of the user ---------------------------------------------------------------------------------
    register('openconsole.nextAttention', () => {
        const key = attention.next();
        if (key === null) { info('No terminal needs you now.'); return; }
        const found = hostOfKey(key);
        if (found) found.host.showTerminal(found.id);
    });
    register('openconsole.attentionList', async () => {
        const items = attention.all();
        if (!items.length) { info('Nothing is running or waiting in the terminals now.'); return; }
        const picked = await vscode.window.showQuickPick(
            items.map((t) => ({ label: `${t.attention ? '$(bell) ' : ''}${t.name}`, description: [label(t.state, t.exitCode), t.kind && t.kind !== 'shell' ? t.kind : ''].filter(Boolean).join(' - '), detail: t.message || undefined, key: t.key })),
            { placeHolder: 'Terminals that run, wait for you or need you' });
        if (!picked) return;
        const found = hostOfKey(picked.key);
        if (found) found.host.showTerminal(found.id);
    });
    register('openconsole.explainState', async () => {
        if (last === panelHost) await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
        const terminal = shownIn(last);
        if (terminal) terminal.post({ t: 'explainState' });
        else info('There is no terminal to explain.');
    });
    context.subscriptions.push(vscode.commands.registerCommand('openconsole.sendText', (text) => {
        const terminal = last && last.active();
        if (terminal && typeof text === 'string') terminal.sendText(text);
    }));

    // the log helper: insert, comment, uncomment, delete and correct console.log / print messages in the editor
    turboLog.register(vscode, context);

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('openconsole') && !e.affectsConfiguration('terminal.integrated') && !e.affectsConfiguration('editor.font')) return;
        for (const host of hosts) { host.post({ t: 'config', config: readConfig() }); host.updateModes(); }
    }));
}

function deactivate() { }

module.exports = { activate, deactivate, TerminalHost, ShellTerminal, shellName, openLink, openFile, resolveFile, TAB_COLORS };
