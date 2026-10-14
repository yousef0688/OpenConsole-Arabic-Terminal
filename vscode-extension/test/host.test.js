'use strict';
// The terminals of one webview, on the side of the extension: several shells, messages that carry the id of their terminal.
// The "vscode" module is replaced by a small stand-in, the shells are real (cmd.exe in a pseudo console).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const root = path.join(__dirname, '..');
const settings = { shell: 'cmd.exe', shellArgs: ['/q'], bidiMode: 'auto', visualBidiApps: ['claude.exe'], wordsBidiApps: ['opencode.exe'], textFont: 'Segoe UI', iconFont: '' };
const fakeVscode = {
    workspace: {
        getConfiguration: (section) => ({ get: (key) => (section === 'openconsole' ? settings[key] : undefined) }),
        workspaceFolders: undefined,
    },
    // what the extension asks VS Code to open in the browser (see the test of openLink)
    Uri: { parse: (text) => { const m = /^([a-z][a-z0-9+.-]*):/i.exec(text); if (!m) throw new Error('not an address'); return { scheme: m[1].toLowerCase(), text }; }, file: (fsPath) => ({ scheme: 'file', fsPath }) },
    Range: class { constructor(a, b, c, d) { this.start = { line: a, character: b }; this.end = { line: c, character: d }; } },
    window: { showInformationMessage: (text) => { infos.push(text); return Promise.resolve(); }, showInputBox: (options) => { inputs.push(options); return Promise.resolve(inputAnswer.value); } },
    commands: { executeCommand: (id, ...args) => { ran.push({ id, args }); return Promise.resolve(); } },
    env: {
        clipboard: { readText: () => (clipboard.fail ? Promise.reject(new Error('no clipboard')) : Promise.resolve(clipboard.text)) },
        openExternal: (uri) => { openedLinks.push(uri.text); return uri.text.includes('refused') ? Promise.reject(new Error('refused')) : Promise.resolve(true); } },
};
const openedLinks = [];
const inputs = [];                   // the questions that it asked the user
const inputAnswer = { value: undefined };
const infos = [];                    // what the extension told the user
const ran = [];                      // the commands of VS Code that it ran: { id, args }
const clipboard = { text: '', fail: false };            // what vscode.env.clipboard holds in these tests (never the real clipboard)
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
    return request === 'vscode' ? fakeVscode : originalLoad.call(this, request, ...rest);
};
const { TerminalHost, shellName, openLink, openFile, resolveFile } = require('../src/extension');
Module._load = originalLoad;

function makeHost() {
    const posted = [];
    const webview = { postMessage: (m) => posted.push(m) };
    const host = new TerminalHost(webview, root, new Set());
    return { host, posted };
}

async function waitFor(check, what, ms = 15000) {
    const start = Date.now();
    while (Date.now() - start < ms) {
        if (check()) return;
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('timed out waiting for ' + what);
}

const outputOf = (posted, id) => posted.filter((m) => m.t === 'output' && m.id === id).map((m) => m.data).join('');

test('the shell name of the list: powershell.exe -> powershell', () => {
    assert.equal(shellName('powershell.exe'), 'powershell');
    assert.equal(shellName('C:\\Program Files\\PowerShell\\7\\pwsh.exe'), 'pwsh');
    assert.equal(shellName('cmd.exe'), 'cmd');
    assert.equal(shellName(''), 'powershell');
    assert.equal(shellName('C:\\Tools\\my shell.exe'), 'my shell');
});

test('hello answers with the configuration, including the name of the shell', () => {
    const { host, posted } = makeHost();
    host.handle({ t: 'hello' });
    assert.equal(posted[0].t, 'config');
    assert.equal(posted[0].config.shellName, 'cmd');
    host.dispose();
});

test('every terminal has its own shell: input and output stay with their id', async (t) => {
    if (!fs.existsSync(path.join(root, 'bin', 'conpty-bridge.exe'))) return t.skip('bin/conpty-bridge.exe is not built');
    const { host, posted } = makeHost();
    try {
        host.handle({ t: 'ready', id: 1, cols: 80, rows: 24 });
        assert.equal(host.terminals.size, 1);
        assert.equal(host.activeId, 1);
        host.handle({ t: 'ready', id: 2, cols: 100, rows: 30 });
        assert.equal(host.terminals.size, 2, 'the second terminal exists next to the first');
        assert.equal(host.activeId, 2, 'a new terminal becomes the shown one');
        assert.notEqual(host.terminals.get(1).session, host.terminals.get(2).session);

        await waitFor(() => outputOf(posted, 1).length > 0 && outputOf(posted, 2).length > 0, 'the first output of both shells');
        host.handle({ t: 'input', id: 1, data: 'echo ONE_MARK_1\r' });
        host.handle({ t: 'input', id: 2, data: 'echo TWO_MARK_2\r' });
        await waitFor(() => /ONE_MARK_1[\s\S]*ONE_MARK_1/.test(outputOf(posted, 1)) && /TWO_MARK_2[\s\S]*TWO_MARK_2/.test(outputOf(posted, 2)), 'both shells to answer');
        assert.ok(!outputOf(posted, 1).includes('TWO_MARK_2'), 'terminal 1 never sees what was typed in terminal 2');
        assert.ok(!outputOf(posted, 2).includes('ONE_MARK_1'), 'terminal 2 never sees what was typed in terminal 1');

        host.handle({ t: 'resize', id: 1, cols: 60, rows: 20 });
        assert.equal(host.terminals.get(1).columns, 60);
        assert.equal(host.terminals.get(2).columns, 100, 'resizing one terminal does not resize the other');

        host.handle({ t: 'active', id: 1 });
        assert.equal(host.activeId, 1);
        assert.equal(host.active().id, 1);

        const second = host.terminals.get(2);
        host.handle({ t: 'close', id: 2 });
        assert.equal(host.terminals.size, 1, 'a closed terminal is removed');
        assert.equal(second.session, null, 'and its shell is stopped');
        assert.equal(host.activeId, 1);

        host.handle({ t: 'restart', id: 1, cols: 80, rows: 24 });
        assert.ok(posted.some((m) => m.t === 'reset' && m.id === 1), 'restart resets the screen of that terminal');
        host.handle({ t: 'input', id: 99, data: 'x' });        // an unknown id is ignored, not a crash
        host.handle({ t: 'close', id: 99 });
    }
    finally { host.dispose(); }
    assert.equal(host.terminals.size, 0);
});

test('the bidi mode follows the programs of one terminal only', () => {
    const { host, posted } = makeHost();
    host.handle({ t: 'ready', id: 1, cols: 80, rows: 24 });      // process.platform is win32 here, the shells start
    host.handle({ t: 'ready', id: 2, cols: 80, rows: 24 });
    try {
        const first = host.terminals.get(1), second = host.terminals.get(2);
        first.procs = ['claude.exe'];
        first.updateMode();
        second.updateMode();
        assert.equal(first.mode, 'visual');
        assert.equal(second.mode, 'implicit');
        const modes = posted.filter((m) => m.t === 'mode');
        assert.deepEqual(modes.map((m) => [m.id, m.mode]), [[1, 'visual']], 'only terminal 1 was told');
    }
    finally { host.dispose(); }
});

test('the words mode: opencode is detected, a setting forces it, claude still wins', () => {
    const { host, posted } = makeHost();
    host.handle({ t: 'ready', id: 1, cols: 80, rows: 24 });
    try {
        const terminal = host.terminals.get(1);
        terminal.procs = ['opencode.exe'];
        terminal.updateMode();
        assert.equal(terminal.mode, 'words');
        terminal.procs = ['opencode.exe', 'claude.exe'];
        terminal.updateMode();
        assert.equal(terminal.mode, 'visual', 'a program that reorders the text itself wins');
        terminal.procs = [];
        terminal.updateMode();
        assert.equal(terminal.mode, 'implicit');
        settings.bidiMode = 'words';
        terminal.updateMode();
        assert.equal(terminal.mode, 'words', 'the setting forces it, whatever runs in the terminal');
        settings.bidiMode = 'implicit';
        terminal.procs = ['opencode.exe'];
        terminal.updateMode();
        assert.equal(terminal.mode, 'implicit', 'the setting implicit is never overridden');
        assert.deepEqual(posted.filter((m) => m.t === 'mode').map((m) => m.mode), ['words', 'visual', 'implicit', 'words', 'implicit']);
    }
    finally { settings.bidiMode = 'auto'; host.dispose(); }
});

test('package.json: every command of a menu is declared, and every declared command is registered', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const declared = new Set(pkg.contributes.commands.map((c) => c.command));
    const source = fs.readFileSync(path.join(root, 'src', 'extension.js'), 'utf8');
    const registered = new Set(Array.from(source.matchAll(/(?:registerCommand|register)\('(openconsole\.[^']+)'/g), (m) => m[1]));
    // the log helper registers its own commands in loops (src/turbolog-commands.js): the ids it declares
    const logModule = require('../src/turbolog-commands');
    for (const id of Object.keys(logModule.INSERT_KINDS)) registered.add(id);
    const massIds = Array.from(fs.readFileSync(path.join(root, 'src', 'turbolog-commands.js'), 'utf8').matchAll(/'(openconsole\.log\.(?:commentAll|uncommentAll|deleteAll|correctAll))'/g), (m) => m[1]);
    assert.equal(massIds.length >= 4, true, 'the four commands on all the logs of a file are in the module');
    for (const id of massIds) registered.add(id);
    // the commands of the menu of the view are registered in a loop, as "openconsole.panel.<name>" and "openconsole.<name>"
    const actionNames = /const actions = \{([\s\S]*?)\n    \};/.exec(source)[1];
    for (const m of actionNames.matchAll(/^        (?:async )?(\w+)\(/gm)) { registered.add(`openconsole.panel.${m[1]}`); registered.add(`openconsole.${m[1]}`); }
    for (const items of Object.values(pkg.contributes.menus)) {
        for (const item of items) assert.ok(declared.has(item.command), `${item.command} is used in a menu but not declared`);
    }
    for (const command of declared) assert.ok(registered.has(command), `${command} is declared but not registered in extension.js`);
    const plus = pkg.contributes.menus['view/title'].find((i) => i.command === 'openconsole.panel.newTerminal');
    assert.ok(plus && /navigation/.test(plus.group), 'the "+" of the view adds a terminal in the panel');
    assert.equal(pkg.contributes.commands.find((c) => c.command === 'openconsole.panel.newTerminal').icon, '$(add)');
    // the buttons of the panel act on the panel, not on the terminal that was used last (that one can be in an editor tab)
    const buttons = pkg.contributes.menus['view/title'].filter((i) => /navigation/.test(i.group)).map((i) => i.command);
    assert.deepEqual(buttons.sort(), ['openconsole.panel.clear', 'openconsole.panel.newTerminal', 'openconsole.panel.newTerminalMenu', 'openconsole.panel.restart', 'openconsole.panel.web']);
    assert.equal(pkg.contributes.commands.find((c) => c.command === 'openconsole.panel.web').icon, '$(broadcast)', 'the button for the web');
    const order = pkg.contributes.menus['view/title'].filter((i) => /navigation/.test(i.group)).sort((a, b) => parseInt(a.group.split('@')[1], 10) - parseInt(b.group.split('@')[1], 10)).map((i) => i.command);
    assert.deepEqual(order.slice(0, 2), ['openconsole.panel.newTerminal', 'openconsole.panel.newTerminalMenu'], 'the menu is right next to the "+"');
    assert.equal(pkg.contributes.commands.find((c) => c.command === 'openconsole.panel.newTerminalMenu').icon, '$(chevron-down)');
    const hidden = pkg.contributes.menus.commandPalette.filter((i) => i.when === 'false').map((i) => i.command);
    for (const command of buttons) assert.ok(hidden.includes(command), `${command} is only for the button, not for the Command Palette`);
});

test('a Ctrl + click on an address in the output: only http and https are opened, in the browser of VS Code', async () => {
    openedLinks.length = 0;
    assert.equal(openLink('https://example.com/a?b=1#c'), true);
    assert.equal(openLink('http://localhost:3000/'), true);
    assert.equal(openLink('HTTPS://EXAMPLE.COM/UPPER'), true, 'capitals in the scheme are fine');
    assert.deepEqual(openedLinks, ['https://example.com/a?b=1#c', 'http://localhost:3000/', 'HTTPS://EXAMPLE.COM/UPPER']);

    // what a program prints is not to be trusted: these must not reach VS Code
    openedLinks.length = 0;
    for (const bad of ['file:///C:/Windows/System32/cmd.exe', 'command:workbench.action.reloadWindow', 'javascript:alert(1)', 'vscode://file/C:/x', 'ftp://example.com/x',
        'example.com/no-scheme', '', ' https://example.com/leading-space', 'https://', '//example.com', 'https://example.com/' + 'a'.repeat(5000), null, undefined, 42, { uri: 'https://example.com' }]) {
        assert.equal(openLink(bad), false, 'not opened: ' + String(bad).slice(0, 40));
    }
    assert.deepEqual(openedLinks, [], 'nothing reached VS Code');

    // the message of the page goes the same way; a refusal of the user (or no browser) is not an error
    const { host } = makeHost();
    try {
        host.handle({ t: 'openLink', uri: 'https://example.org/from-the-page' });
        host.handle({ t: 'openLink', uri: 'file:///C:/secret.txt' });
        host.handle({ t: 'openLink' });
        host.handle({ t: 'openLink', uri: 'https://refused.example.com/' });
        await new Promise((r) => setTimeout(r, 30));            // the refusal is a rejected promise: it must be caught
        assert.deepEqual(openedLinks, ['https://example.org/from-the-page', 'https://refused.example.com/']);
    }
    finally { host.dispose(); }
});

test('the right mouse button (and Ctrl+Shift+V): the extension reads the clipboard and answers the page with the text', async (t) => {
    if (!fs.existsSync(path.join(root, 'bin', 'conpty-bridge.exe'))) return t.skip('bin/conpty-bridge.exe is not built');
    const { host, posted } = makeHost();
    try {
        host.handle({ t: 'ready', id: 1, cols: 80, rows: 24 });
        const answers = () => posted.filter((m) => m.t === 'paste' || m.t === 'pasteEmpty');

        clipboard.text = 'echo what was copied last';
        host.handle({ t: 'pasteRequest', id: 1 });
        await waitFor(() => answers().length === 1, 'the answer');
        assert.deepEqual(answers()[0], { t: 'paste', text: 'echo what was copied last', id: 1 });

        clipboard.text = 'line one\nline two';
        host.handle({ t: 'pasteRequest', id: 1 });
        await waitFor(() => answers().length === 2, 'the answer with two lines');
        assert.equal(answers()[1].text, 'line one\nline two', 'the text is handed over as it is (the terminal decides how it is typed)');

        clipboard.text = '';                                                            // a screenshot, or nothing: only the page can tell
        host.handle({ t: 'pasteRequest', id: 1 });
        await waitFor(() => answers().length === 3, 'the answer for an empty clipboard');
        assert.deepEqual(answers()[2], { t: 'pasteEmpty', id: 1 });

        clipboard.fail = true;                                                          // the clipboard cannot be read: not an error
        host.handle({ t: 'pasteRequest', id: 1 });
        await waitFor(() => answers().length === 4, 'the answer when the clipboard fails');
        assert.equal(answers()[3].t, 'pasteEmpty');
        clipboard.fail = false;

        host.handle({ t: 'pasteRequest', id: 99 });                                     // an unknown terminal is ignored
        host.handle({ t: 'pasteRequest' });
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(answers().length, 4);
    }
    finally { clipboard.text = ''; clipboard.fail = false; host.dispose(); }
});

test('the setting motionSpeed reaches the page as a number between 0 and 4', () => {
    const ask = (value) => {
        settings.motionSpeed = value;
        const { host, posted } = makeHost();
        host.handle({ t: 'hello' });
        host.dispose();
        return posted[0].config.motionSpeed;
    };
    try {
        assert.equal(ask(undefined), 1, 'not set: the normal speed');
        assert.equal(ask(1.5), 1.5);
        assert.equal(ask(0), 0);
        assert.equal(ask(99), 4, 'at most four times as long');
        assert.equal(ask(-2), 0, 'not less than none');
        assert.equal(ask('fast'), 1, 'not a number: the normal speed');
    }
    finally { delete settings.motionSpeed; }
});

test('the page is told which programs run under the shell (to tell an agent from a build), also when they change', () => {
    const { host, posted } = makeHost();
    host.handle({ t: 'ready', id: 1, cols: 80, rows: 24 });
    try {
        const terminal = host.terminals.get(1);
        terminal.shellPath = 'cmd.exe';
        const busyOf = () => posted.filter((m) => m.t === 'busy' && m.id === 1).map((m) => [m.busy, m.programs]);
        terminal.procs = ['cmd.exe', 'conhost.exe', 'node.exe'];
        terminal.updateBusy();
        terminal.updateBusy();                                  // nothing changed: nothing is sent again
        terminal.procs = ['cmd.exe', 'node.exe', 'claude.exe'];
        terminal.updateBusy();
        terminal.procs = ['cmd.exe'];
        terminal.updateBusy();
        assert.deepEqual(busyOf(), [[true, ['node.exe']], [true, ['node.exe', 'claude.exe']], [false, []]]);
    }
    finally { host.dispose(); }
});

test('what the page says about the state of a terminal goes to the tracker, with a key that tells the view and the terminal', () => {
    const { host } = makeHost();
    const states = [], events = [], removed = [];
    host.attention = { state: (key, m) => states.push([key, m.state]), event: (key, m) => events.push([key, m.reason]), remove: (key) => removed.push(key) };
    host.handle({ t: 'ready', id: 4, cols: 80, rows: 24 });
    try {
        host.handle({ t: 'agentState', id: 4, state: 'working', attention: false });
        host.handle({ t: 'attention', id: 4, reason: 'blocked' });
        host.handle({ t: 'agentState', id: 99, state: 'working' });         // a terminal that does not exist is not reported
        host.handle({ t: 'attention', id: 99, reason: 'blocked' });
        assert.deepEqual(states, [[host.hostId + ':4', 'working']]);
        assert.deepEqual(events, [[host.hostId + ':4', 'blocked']]);
        const other = makeHost().host;
        assert.notEqual(other.key(4), host.key(4), 'two views with the same terminal id are two terminals');
        other.dispose();
        host.handle({ t: 'close', id: 4 });
        assert.deepEqual(removed, [host.hostId + ':4'], 'a closed terminal leaves the list');
    }
    finally { host.dispose(); }
});

test('showing a terminal: the view is revealed, then the page chooses it', () => {
    const { host, posted } = makeHost();
    host.handle({ t: 'ready', id: 1, cols: 80, rows: 24 });
    host.handle({ t: 'ready', id: 2, cols: 80, rows: 24 });
    const order = [];
    host.reveal = () => order.push('reveal');
    const post = host.post.bind(host);
    host.post = (m) => { if (m.t === 'show') order.push('show ' + m.id); post(m); };
    try {
        assert.equal(host.showTerminal(1), true);
        assert.equal(host.showTerminal(77), false, 'a terminal that was closed');
        assert.deepEqual(order, ['reveal', 'show 1']);
        assert.ok(posted.some((m) => m.t === 'show' && m.id === 1));
    }
    finally { host.dispose(); }
});

test('the settings of the attention reach the page: the rules of the user and the minimum time', () => {
    const ask = () => { const { host, posted } = makeHost(); host.handle({ t: 'hello' }); host.dispose(); return posted[0].config; };
    try {
        let config = ask();
        assert.deepEqual(config.agentRules, []);
        assert.equal(config.attentionMinSeconds, 15, 'not set: 15 seconds');
        settings.agentRules = [{ id: 'mine', state: 'blocked', any: ['wait'] }];
        settings['attention.minWorkingSeconds'] = 0;
        config = ask();
        assert.deepEqual(config.agentRules, [{ id: 'mine', state: 'blocked', any: ['wait'] }]);
        assert.equal(config.attentionMinSeconds, 0);
        settings['attention.minWorkingSeconds'] = 99999;
        assert.equal(ask().attentionMinSeconds, 3600, 'at most an hour');
        settings.agentRules = 'not a list';
        assert.deepEqual(ask().agentRules, []);
    }
    finally { delete settings.agentRules; delete settings['attention.minWorkingSeconds']; }
});

test('package.json: the settings of the attention are declared with their defaults', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const props = pkg.contributes.configuration.properties;
    assert.equal(props['openconsole.attention.notify'].default, 'all');
    assert.deepEqual(props['openconsole.attention.notify'].enum, ['all', 'important', 'off']);
    assert.equal(props['openconsole.attention.minWorkingSeconds'].default, 15);
    assert.equal(props['openconsole.attention.statusBar'].default, true);
    assert.deepEqual(props['openconsole.agentRules'].default, []);
    for (const command of ['openconsole.nextAttention', 'openconsole.attentionList', 'openconsole.explainState']) assert.ok(pkg.contributes.commands.some((c) => c.command === command), command);
});

const norm = (file) => String(file).replace(/\\/g, '/');

test('a file path from the output: network paths and drive-relative paths are refused, a relative path is looked for in the folders, ~ is the home folder', () => {
    const home = path.join(require('node:os').homedir(), 'notes', 'x.md');
    const files = new Set(['C:/work/proj/src/a.ts', 'C:/other/lib/b.js', norm(home)]);
    const exists = (file) => files.has(norm(file));
    const folders = ['C:\\work\\proj', 'C:\\other'];
    assert.equal(norm(resolveFile('src/a.ts', folders, exists)), 'C:/work/proj/src/a.ts');
    assert.equal(norm(resolveFile('lib/b.js', folders, exists)), 'C:/other/lib/b.js', 'the second folder');
    assert.equal(norm(resolveFile('.\\src\\a.ts', folders, exists)), 'C:/work/proj/src/a.ts');
    assert.equal(norm(resolveFile('C:\\other\\lib\\b.js', [], exists)), 'C:/other/lib/b.js', 'an absolute path needs no folder');
    assert.equal(norm(resolveFile('~/notes/x.md', [], exists)), norm(home));
    assert.equal(resolveFile('src/missing.ts', folders, exists), null, 'a file that is not there');
    const asked = [];
    const spy = (file) => { asked.push(file); return true; };
    for (const bad of ['\\\\server\\share\\x.ts', '//server/share/x.ts', '\\\\?\\C:\\x.ts', 'C:x.ts', '', 'a\0b.ts', 'x'.repeat(2000) + '.ts', undefined, 42, null]) {
        assert.equal(resolveFile(bad, folders, spy), null, 'refused: ' + String(bad).slice(0, 40));
    }
    assert.deepEqual(asked, [], 'nothing was even looked at: a network path would make Windows send credentials');
});

test('Ctrl + click on a path opens the file at its line and column, and says so when there is no such file', () => {
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'oc-openfile-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'one\ntwo\n');
    try {
        ran.length = 0; infos.length = 0;
        assert.equal(openFile({ path: 'src/a.ts', line: 12, col: 5 }, dir), true);
        assert.equal(ran.length, 1);
        assert.equal(ran[0].id, 'vscode.open');
        assert.equal(ran[0].args[0].fsPath, path.join(dir, 'src', 'a.ts'));
        assert.deepEqual(JSON.parse(JSON.stringify(ran[0].args[1].selection)), { start: { line: 11, character: 4 }, end: { line: 11, character: 4 } });
        assert.equal(ran[0].args[1].preview, true);
        assert.equal(openFile({ path: 'src/a.ts', line: 0, col: 0 }, dir), true);
        assert.equal(ran[1].args[1].selection, undefined, 'no line: the file opens where it was');
        assert.equal(openFile({ path: 'src/a.ts', line: 'x', col: -3 }, dir), true, 'a line that is not a number is no line');
        assert.equal(ran[2].args[1].selection, undefined);
        assert.equal(openFile({ path: 'src/nope.ts', line: 1 }, dir), false);
        assert.equal(infos.length, 1);
        assert.match(infos[0], /nope\.ts/);
        assert.equal(ran.length, 3, 'nothing was opened for the missing file');
        assert.equal(openFile(null, dir), false);
        assert.equal(openFile({ path: '\\\\evil\\share\\x.ts', line: 1 }, dir), false, 'a network path is not opened');
        assert.equal(ran.length, 3);
    }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the page asks for a file with openFile: the extension answers from the folder where that shell started', () => {
    const { host } = makeHost();
    host.handle({ t: 'ready', id: 1, cols: 80, rows: 24 });
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'oc-openfile2-'));
    try {
        const terminal = host.terminals.get(1);
        assert.ok(terminal.cwd, 'the folder where the shell started is known');
        fs.writeFileSync(path.join(dir, 'b.txt'), 'x');
        terminal.cwd = dir;
        ran.length = 0;
        host.handle({ t: 'openFile', id: 1, path: 'b.txt', line: 2, col: 1 });
        host.handle({ t: 'openFile', id: 99, path: 'b.txt', line: 2, col: 1 });        // no such terminal: nothing
        assert.equal(ran.length, 1);
        assert.equal(ran[0].args[0].fsPath, path.join(dir, 'b.txt'));
    }
    finally { host.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the double click on a row asks for a name; what is typed comes back as setName, an empty answer too, Escape sends nothing', async () => {
    const { host, posted } = makeHost();
    host.handle({ t: 'ready', id: 1, cols: 80, rows: 24 });
    try {
        inputs.length = 0;
        inputAnswer.value = 'build server';
        host.handle({ t: 'renameAsk', id: 1, name: 'powershell' });
        host.handle({ t: 'renameAsk', id: 99, name: 'nothing' });                      // no such terminal: no question
        await waitFor(() => posted.some((m) => m.t === 'setName'), 'the name');
        assert.equal(inputs.length, 1);
        assert.equal(inputs[0].value, 'powershell', 'the question starts with the current name');
        assert.deepEqual(posted.filter((m) => m.t === 'setName'), [{ t: 'setName', name: 'build server', id: 1 }]);
        inputAnswer.value = '';
        host.handle({ t: 'renameAsk', id: 1, name: 'x' });
        await waitFor(() => posted.filter((m) => m.t === 'setName').length === 2, 'the empty name');
        assert.equal(posted.filter((m) => m.t === 'setName')[1].name, '');
        inputAnswer.value = undefined;                                                 // Escape
        host.handle({ t: 'renameAsk', id: 1, name: 'x' });
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(posted.filter((m) => m.t === 'setName').length, 2, 'Escape changes nothing');
    }
    finally { host.dispose(); }
});
