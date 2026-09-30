'use strict';
// OpenConsole Arabic Terminal: a terminal in the panel of VS Code that shows Arabic and Hebrew text correctly.
// The shell runs in a pseudo console (bin/conpty-bridge.exe); the text is drawn by xterm.js in a webview, with the
// right-to-left layer of media/arabic-layout.js + media/row-patcher.js.

const vscode = require('vscode');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TerminalSession } = require('./session');
const { getHtml } = require('./webview-html');

const VIEW_ID = 'openconsole.terminal';
const IMAGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const CURSOR_STYLES = { line: 'bar', block: 'block', underline: 'underline' };

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
        windowsBuildNumber: Number.isFinite(build) ? build : 22621,
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

/** One terminal in one webview (the panel view, or an editor tab). */
class TerminalHost {
    constructor(webview, extensionPath, hosts) {
        this.webview = webview;
        this.extensionPath = extensionPath;
        this.hosts = hosts;
        this.session = null;
        this.mode = 'implicit';
        this.procs = [];
        this.columns = 80;
        this.rows = 24;
        this.disposed = false;
        hosts.add(this);
    }

    post(message) {
        if (!this.disposed) this.webview.postMessage(message);
    }

    handle(m) {
        switch (m.t) {
            case 'hello': this.post({ t: 'config', config: readConfig() }); break;
            case 'ready': this.columns = m.cols; this.rows = m.rows; this.start(); break;
            case 'input': if (this.session) this.session.write(m.data); break;
            case 'binary': if (this.session) this.session.writeBytes(Buffer.from(m.data, 'latin1')); break;
            case 'resize': this.columns = m.cols; this.rows = m.rows; if (this.session) this.session.resize(m.cols, m.rows); break;
            case 'restart': this.columns = m.cols || this.columns; this.rows = m.rows || this.rows; this.restart(); break;
            case 'pasteImage': this.pasteImage(m.data); break;
            default: break;
        }
    }

    start() {
        if (process.platform !== 'win32') {
            this.post({ t: 'error', message: 'OpenConsole Arabic Terminal works on Windows only.' });
            return;
        }
        const bridge = path.join(this.extensionPath, 'bin', 'conpty-bridge.exe');
        if (!fs.existsSync(bridge)) {
            this.post({ t: 'error', message: 'bin/conpty-bridge.exe is missing. Build it with native/build.ps1 (see the README of the extension).' });
            return;
        }
        const oc = vscode.workspace.getConfiguration('openconsole');
        const shell = oc.get('shell') || 'powershell.exe';
        const args = oc.get('shellArgs') || [];
        const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
        let cwd = folder && folder.uri.scheme === 'file' ? folder.uri.fsPath : os.homedir();
        if (!fs.existsSync(cwd)) cwd = os.homedir();

        const session = new TerminalSession({
            bridgePath: bridge, shell, args, cwd, columns: this.columns, rows: this.rows,
            env: { TERM_PROGRAM: 'OpenConsole', COLORTERM: 'truecolor' },
        });
        this.session = session;
        session.on('output', (data) => this.post({ t: 'output', data }));
        session.on('exit', (code) => { if (this.session === session) this.post({ t: 'exit', code }); });
        session.on('procs', (names) => { this.procs = names; this.updateMode(); });
        session.on('error', (message) => this.post({ t: 'error', message }));
        session.start();
    }

    restart() {
        if (this.session) { this.session.dispose(); this.session = null; }
        this.post({ t: 'reset' });
        this.mode = 'implicit';
        this.post({ t: 'mode', mode: 'implicit' });
        this.start();
    }

    /** The mode of the layout: the programs that reorder Arabic text themselves (Claude Code) need the "visual" mode. */
    updateMode() {
        const oc = vscode.workspace.getConfiguration('openconsole');
        const setting = oc.get('bidiMode');
        let mode = 'implicit';
        if (setting === 'visual') mode = 'visual';
        else if (setting !== 'implicit') {
            const apps = (oc.get('visualBidiApps') || []).map((s) => String(s).toLowerCase());
            if (this.procs.some((p) => apps.includes(p))) mode = 'visual';
        }
        if (mode !== this.mode) {
            this.mode = mode;
            this.post({ t: 'mode', mode });
        }
    }

    pasteImage(base64) {
        try {
            const file = saveImage(base64);
            this.post({ t: 'paste', text: /\s/.test(file) ? `"${file}"` : file });
        } catch (e) {
            this.post({ t: 'error', message: 'Cannot save the pasted image: ' + e.message });
        }
    }

    sendText(text) {
        if (this.session) this.session.write(text);
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.hosts.delete(this);
        if (this.session) this.session.dispose();
    }
}

function activate(context) {
    const hosts = new Set();
    let last = null;      // the terminal that was used last, for the commands
    const localRoots = [vscode.Uri.joinPath(context.extensionUri, 'media')];

    function attach(webview, disposeSignal) {
        webview.options = { enableScripts: true, localResourceRoots: localRoots };
        webview.html = getHtml(webview, context.extensionUri, vscode.Uri.joinPath);
        const host = new TerminalHost(webview, context.extensionPath, hosts);
        last = host;
        webview.onDidReceiveMessage((m) => { last = host; host.handle(m); });
        disposeSignal(() => { host.dispose(); if (last === host) last = null; });
        return host;
    }

    context.subscriptions.push(vscode.window.registerWebviewViewProvider(VIEW_ID, {
        resolveWebviewView(view) {
            const host = attach(view.webview, (cb) => view.onDidDispose(cb));
            view.onDidChangeVisibility(() => { if (view.visible) host.post({ t: 'focus' }); });
        },
    }, { webviewOptions: { retainContextWhenHidden: true } }));

    context.subscriptions.push(vscode.commands.registerCommand('openconsole.focus', async () => {
        await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
        if (last) last.post({ t: 'focus' });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('openconsole.newEditorTerminal', () => {
        const panel = vscode.window.createWebviewPanel('openconsole.editor', 'OpenConsole', vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: localRoots });
        panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');
        const host = attach(panel.webview, (cb) => panel.onDidDispose(cb));
        panel.onDidChangeViewState((e) => { if (e.webviewPanel.visible) host.post({ t: 'focus' }); });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('openconsole.restart', () => { if (last) last.restart(); }));
    context.subscriptions.push(vscode.commands.registerCommand('openconsole.clear', () => { if (last) last.post({ t: 'clear' }); }));
    context.subscriptions.push(vscode.commands.registerCommand('openconsole.sendText', (text) => {
        if (last && typeof text === 'string') last.sendText(text);
    }));

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('openconsole') && !e.affectsConfiguration('terminal.integrated') && !e.affectsConfiguration('editor.font')) return;
        for (const host of hosts) { host.post({ t: 'config', config: readConfig() }); host.updateMode(); }
    }));
}

function deactivate() { }

module.exports = { activate, deactivate };
