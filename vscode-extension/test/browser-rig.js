'use strict';
// Runs the whole extension without VS Code: the real extension code (src/extension.js, with a stand-in for the "vscode" module),
// real shells in real pseudo consoles (bin/conpty-bridge.exe), and the real page (media/*) in a browser that this file serves.
//   const rig = await startRig({ shell: 'powershell.exe', shellArgs: ['-NoLogo', '-NoProfile'] });
//   rig.url('panel')  -> the address of the page of the panel view;  rig.url('editor') -> the page of a terminal in an editor tab
//   await rig.command('openconsole.clear')       -> what a click on a button or the Command Palette does
//   rig.close()
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const root = path.join(__dirname, '..');
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png' };

/** The folder "resources/app" of the newest VS Code installation that has the conpty.dll (null when there is none). */
function findVSCodeAppRoot() {
    const base = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code');
    if (!fs.existsSync(base)) return null;
    const candidates = fs.readdirSync(base, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(base, d.name, 'resources', 'app'))
        .filter((p) => fs.existsSync(path.join(p, 'node_modules.asar.unpacked', 'node-pty', 'build', 'Release', 'conpty', 'conpty.dll')))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return candidates[0] || null;
}

async function startRig(options = {}) {
    // The shells of the tests get an APPDATA of their own: PSReadLine writes its history file there (the suggestions read it), so the
    // real history of the user is neither read nor changed by a test.
    const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-appdata-'));
    const previousAppData = process.env.APPDATA;
    process.env.APPDATA = appData;
    const historyFile = path.join(appData, 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt');
    if (options.historyLines) { fs.mkdirSync(path.dirname(historyFile), { recursive: true }); fs.writeFileSync(historyFile, options.historyLines.join('\r\n') + '\r\n'); }
    const state = Object.assign({}, options.state || {});          // the state of the extension (context.globalState)
    let editor = options.editor;                                   // window.activeTextEditor
    const settings = Object.assign({
        shell: 'powershell.exe', shellArgs: ['-NoLogo', '-NoProfile'], bidiMode: 'auto', visualBidiApps: ['claude.exe'],
        textFont: 'Segoe UI', iconFont: '', fontFamily: 'Consolas, monospace', fontSize: 14,
    }, options.settings || {});

    const commands = new Map();
    const webviews = new Map();          // name -> fake webview
    let viewProvider = null;
    const messages = [];                 // what the extension posted to the pages: { host, message }
    const shown = [];                    // the messages that it showed to the user: { kind, text, buttons }
    const executed = [];                 // the commands that it ran: { id, args }
    const picks = [];                    // the quick picks that it showed: { items, options }
    const updates = [];                  // the settings that it changed: { section, key, value, target }
    const opened = [];                   // the addresses that it asked VS Code to open in the browser
    const clipboardWrites = [];          // what the extension put into the clipboard (never the real one)
    const statusItems = [];              // the items that it put in the status bar
    const channels = [];                 // the output channels that it made: { name, lines, shown }

    function makeWebview(name) {
        const w = {
            name, options: {}, cspSource: "'self'", _html: '', _listeners: [], _clients: new Set(),
            set html(value) { this._html = value; },
            get html() { return this._html; },
            asWebviewUri: (uri) => ({ toString: () => '/media/' + uri.parts.slice(1).join('/') }),
            _queue: [],
            postMessage(m) {
                messages.push({ host: name, message: m });
                // a page that has not connected yet gets the messages when it does (a real webview does not lose them either)
                if (!this._clients.size) this._queue.push(m);
                else for (const res of this._clients) res.write('data: ' + JSON.stringify(m) + '\n\n');
                return Promise.resolve(true);
            },
            onDidReceiveMessage(cb) { this._listeners.push(cb); return { dispose() { } }; },
        };
        webviews.set(name, w);
        return w;
    }

    const fakeVscode = {
        workspace: {
            getConfiguration: (section) => ({
                get: (key) => (section === 'openconsole' ? settings[key] : (section === 'terminal.integrated' && key === 'profiles.windows' ? options.profilesWindows : undefined)),
                update: async (key, value, target) => { if (section === 'openconsole') settings[key] = value; updates.push({ section, key, value, target }); },
            }),
            workspaceFolders: options.folders ? options.folders.map((fsPath) => ({ uri: { scheme: 'file', fsPath }, name: fsPath })) : undefined,
            onDidChangeConfiguration: () => ({ dispose() { } }),
        },
        window: {
            get activeTextEditor() { return editor; },
            registerWebviewViewProvider: (id, provider) => { viewProvider = provider; return { dispose() { } }; },
            createWebviewPanel: () => {
                const name = 'editor' + (webviews.size);
                const webview = makeWebview(name);
                const panel = { webview, iconPath: null, reveal() { }, onDidDispose: () => ({ dispose() { } }), onDidChangeViewState: () => ({ dispose() { } }) };
                return panel;
            },
            showQuickPick: async (items, pickOptions) => { picks.push({ items, options: pickOptions }); return options.pick ? options.pick(items, pickOptions) : undefined; },
            showWarningMessage: (text, ...buttons) => { shown.push({ kind: 'warning', text, buttons }); return Promise.resolve(typeof options.answer === 'function' ? options.answer(text, buttons) : options.answer); },
            showInformationMessage: (text, ...buttons) => { shown.push({ kind: 'information', text, buttons }); return Promise.resolve(typeof options.answer2 === 'function' ? options.answer2(text, buttons) : options.answer2); },
            showErrorMessage: (text, ...buttons) => { shown.push({ kind: 'error', text, buttons }); return Promise.resolve(undefined); },
            showInputBox: async (inputOptions) => (options.input ? options.input(inputOptions) : undefined),
            createStatusBarItem: (alignment, priority) => { const item = { alignment, priority, text: '', tooltip: '', command: '', backgroundColor: undefined, visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() { this.disposed = true; } }; statusItems.push(item); return item; },
            createOutputChannel: (name) => { const channel = { name, lines: [], shown: false, clear() { this.lines = []; }, appendLine(line) { this.lines.push(line); }, show() { this.shown = true; }, dispose() { } }; channels.push(channel); return channel; },
        },
        commands: {
            registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() { } }; },
            executeCommand: async (id, ...args) => {
                executed.push({ id, args });
                if (/\.focus$/.test(id) || id.startsWith('workbench.') || id.startsWith('vscode.')) return undefined;        // VS Code's own commands: nothing to do here
                const fn = commands.get(id);
                if (!fn) throw new Error('command not found: ' + id);
                return fn(...args);
            },
        },
        Uri: {
            joinPath: (base, ...parts) => ({ base, parts: [].concat(...parts.map((p) => String(p).split('/'))) }),
            parse: (text) => { const m = /^([a-z][a-z0-9+.-]*):/i.exec(text); if (!m) throw new Error('not an address'); return { scheme: m[1].toLowerCase(), text }; },
            file: (fsPath) => ({ scheme: 'file', fsPath }),
        },
        Range: class { constructor(a, b, c, d) { this.start = { line: a, character: b }; this.end = { line: c, character: d }; } },
        ViewColumn: { Active: -1 },
        StatusBarAlignment: { Left: 1, Right: 2 },
        ThemeColor: class { constructor(id) { this.id = id; } },
        QuickPickItemKind: { Separator: -1 },
        ConfigurationTarget: { Global: 1 },
        extensions: { getExtension: (id) => (options.legacyInstalled && id === 'openconsole.openconsole-terminal' ? { id } : undefined) },
        env: { clipboard: { readText: async () => (options.clipboardText === undefined ? '' : options.clipboardText), writeText: async (text) => { clipboardWrites.push(text); } }, appRoot: options.appRoot === undefined ? findVSCodeAppRoot() : options.appRoot, openExternal: async (uri) => { opened.push(uri.text); return true; } },
    };
    // panel views: parts are ['media', ...]; the same joinPath is used for the roots
    const originalLoad = Module._load;
    Module._load = function (request, ...rest) { return request === 'vscode' ? fakeVscode : originalLoad.call(this, request, ...rest); };
    for (const key of Object.keys(require.cache)) { if (key.startsWith(path.join(root, 'src'))) delete require.cache[key]; }
    const extension = require('../src/extension');
    Module._load = originalLoad;

    const globalState = { get: (key, fallback) => (key in state ? state[key] : fallback), update: (key, value) => { state[key] = value; return Promise.resolve(); } };
    const workspaceState = Object.assign({}, options.workspaceState || {});
    const context = { subscriptions: [], extensionUri: { parts: ['ext'] }, extensionPath: root, globalState, workspaceState: { get: (key, fallback) => (key in workspaceState ? workspaceState[key] : fallback), update: (key, value) => { workspaceState[key] = value; return Promise.resolve(); } } };
    extension.activate(context);
    if (!viewProvider) throw new Error('the extension did not register its view');

    // the panel view
    const panel = makeWebview('panel');
    viewProvider.resolveWebviewView({ webview: panel, onDidDispose: () => ({ dispose() { } }), onDidChangeVisibility: () => ({ dispose() { } }), visible: true });

    const stub = `<script nonce="NONCE">
        window.__host = new URLSearchParams(location.search).get('h');
        window.acquireVsCodeApi = () => ({ postMessage: (m) => { fetch('/msg?h=' + window.__host, { method: 'POST', body: JSON.stringify(m) }); window.__sent = window.__sent || []; window.__sent.push(m); } });
        window.__sent = [];
        const events = new EventSource('/events?h=' + window.__host);
        events.onmessage = (e) => window.dispatchEvent(new MessageEvent('message', { data: JSON.parse(e.data) }));
        </script>`;

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        const name = url.searchParams.get('h');
        if (url.pathname === '/page') {
            const w = webviews.get(name);
            if (!w) { res.writeHead(404); return res.end('no such host'); }
            // the real page has no connection to anything (VS Code brings the messages); this rig needs one, so it allows the
            // connections to itself, and only that
            const html = w.html
                .replace("default-src 'none';", "default-src 'none'; connect-src 'self';")
                .replace(/<script nonce="([^"]+)" src="\/media\/vendor\/xterm\.js">/, (m, nonce) => stub.replace('NONCE', nonce) + m);
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            return res.end(html);
        }
        if (url.pathname.startsWith('/media/')) {
            const file = path.join(root, 'media', decodeURIComponent(url.pathname.slice('/media/'.length)));
            if (!file.startsWith(path.join(root, 'media')) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
            res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
            return res.end(fs.readFileSync(file));
        }
        if (url.pathname === '/events') {
            const w = webviews.get(name);
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
            res.write('\n');
            w._clients.add(res);
            for (const m of w._queue.splice(0)) res.write('data: ' + JSON.stringify(m) + '\n\n');
            req.on('close', () => w._clients.delete(res));
            return;
        }
        if (url.pathname === '/msg' && req.method === 'POST') {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                const w = webviews.get(name);
                try { const m = JSON.parse(body); for (const cb of w._listeners) cb(m); } catch (e) { console.error('bad message', e); }
                res.writeHead(204); res.end();
            });
            return;
        }
        res.writeHead(404); res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    return {
        port,
        settings,
        state,
        appData,
        historyFile,
        setEditor: (value) => { editor = value; },
        messages,
        shown,
        executed,
        picks,
        updates,
        opened,
        statusItems,
        clipboardWrites,
        workspaceState,
        channels,
        url: (name) => `http://127.0.0.1:${port}/page?h=${name}`,
        hosts: () => Array.from(webviews.keys()),
        /** A message from a page to the extension (what main.js posts), for a page that is not open in a browser. */
        receive: (name, message) => { for (const cb of webviews.get(name)._listeners) cb(message); },
        /** Runs a command of the extension, as a click on a button or the Command Palette does. */
        command: (id, ...args) => fakeVscode.commands.executeCommand(id, ...args),
        registeredCommands: () => Array.from(commands.keys()),
        close: () => {
            for (const c of context.subscriptions) { try { c.dispose(); } catch { } }
            server.closeAllConnections(); server.close();
            if (previousAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = previousAppData;
            setTimeout(() => { try { fs.rmSync(appData, { recursive: true, force: true }); } catch { /* a shell may still hold the file */ } }, 2000).unref();
        },
    };
}

module.exports = { startRig };
