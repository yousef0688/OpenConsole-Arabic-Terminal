'use strict';
// The suggestion of what you are going to type, and the menu "..." of the view, with the whole extension without VS Code (see
// browser-rig.js): the real extension code, real PowerShell shells in real pseudo consoles, the real page in headless Chrome or Edge.
// The shells of these tests have an APPDATA of their own, so the real history of PowerShell is not read and not changed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startRig } = require('./browser-rig');
const { browser, withPage, waitUntil, sleep } = require('./browser-helper');

const bridge = path.join(__dirname, '..', 'bin', 'conpty-bridge.exe');
const skipReason = (!browser && 'no Chrome or Edge found') || (!fs.existsSync(bridge) && 'bin/conpty-bridge.exe is not built') || false;

/** The lines of a terminal of the page (only the ones that have text), as "row:text". */
const lines = (page, id = 1) => page.evaluate(`(() => { const t = window.__openconsole.terminals.get(${id}); if (!t) return []; const b = t.term.buffer.active; const out = [];
    for (let i = 0; i < b.length; i++) { const s = b.getLine(i).translateToString(true); if (s) out.push(i + ':' + s); } return out; })()`);
const hasPrompt = async (page, id = 1) => (await lines(page, id)).some((l) => /PS .*>/.test(l));

/** A key that is pressed in the page (modifiers: Alt 1, Ctrl 2, Meta 4, Shift 8). */
async function press(page, init) {
    await page.send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, init));
    await page.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, init));
}
const ARROW_RIGHT = { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 };
const ENTER = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 };
/** The grey suggestions that are drawn in a terminal of the page. */
const ghosts = (page) => page.evaluate("Array.from(document.querySelectorAll('.xterm-decoration')).map((d) => d.textContent).filter(Boolean)");
const focusTerminal = (page) => page.evaluate('window.__openconsole.term.focus()');

test('the suggestion: the rest of an older command is shown in grey, the Right Arrow types it, Enter runs it and it is remembered', { skip: skipReason, timeout: 90000 }, async () => {
    // the history file of PowerShell (in an APPDATA of the test) has the older commands
    const rig = await startRig({ historyLines: ['echo older_unrelated', 'echo history_two_xyz', 'dir'] });
    try {
        await withPage(rig.url('panel'), async (page) => {
            await waitUntil(() => hasPrompt(page), 'the prompt');
            assert.ok(rig.messages.some((m) => m.message.t === 'history' && m.message.replace && m.message.commands.includes('echo history_two_xyz')), 'the history went to the page when it said hello');
            await focusTerminal(page);
            await rig.command('openconsole.sendText', 'echo history_t');
            await waitUntil(async () => (await ghosts(page)).join('|') === 'wo_xyz', 'the grey rest of the command');
            assert.ok((await lines(page)).some((l) => /PS .*> echo history_t$/.test(l)), 'the grey rest is not text of the terminal: ' + JSON.stringify(await lines(page)));

            await press(page, ARROW_RIGHT);
            await waitUntil(async () => (await lines(page)).some((l) => /PS .*> echo history_two_xyz$/.test(l)), 'the shell to show the typed rest');
            assert.deepEqual(await ghosts(page), [], 'the grey text is gone once it is typed');

            await press(page, ENTER);
            await waitUntil(async () => (await lines(page)).some((l) => l.endsWith(':history_two_xyz')), 'the command to run');
            await waitUntil(() => (rig.state['openconsole.commands'] || []).includes('echo history_two_xyz'), 'the command to be remembered');
            const promptFolder = (await lines(page)).map((l) => /^\d+:PS (.+?)> echo history_two_xyz$/.exec(l)).filter(Boolean)[0][1];
            assert.deepEqual(rig.state['openconsole.directories'], [promptFolder], 'the folder of the prompt is remembered too');
            assert.ok(rig.messages.some((m) => m.message.t === 'history' && !m.message.replace && m.message.commands.join() === 'echo history_two_xyz'), 'the other terminals hear about the new command');

            // and it is suggested again
            await rig.command('openconsole.sendText', 'echo history_two');
            await waitUntil(async () => (await ghosts(page)).join('|') === '_xyz', 'the grey rest again');
        }, { width: 900, height: 320 });
    }
    finally { rig.close(); }
});

test('openconsole.suggestions off: nothing is shown, nothing is remembered, the Right Arrow is a normal key', { skip: skipReason, timeout: 90000 }, async () => {
    const rig = await startRig({ settings: { suggestions: false }, historyLines: ['echo history_two_xyz'] });
    try {
        await withPage(rig.url('panel'), async (page) => {
            await waitUntil(() => hasPrompt(page), 'the prompt');
            await focusTerminal(page);
            await rig.command('openconsole.sendText', 'echo history_t');
            await waitUntil(async () => (await lines(page)).some((l) => /PS .*> echo history_t$/.test(l)), 'the typed text');
            await sleep(700);
            assert.deepEqual(await ghosts(page), []);
            await press(page, ARROW_RIGHT);                                   // nothing to type: the cursor is already at the end
            await sleep(300);
            assert.ok(!(await lines(page)).some((l) => /history_two_xyz/.test(l)), 'the Right Arrow typed nothing');
            await press(page, ENTER);
            await waitUntil(async () => (await lines(page)).some((l) => /^\d+:history_t\b|not recognized/.test(l)), 'the command to run');
            await sleep(500);
            assert.deepEqual(rig.state['openconsole.commands'] || [], [], 'no command is remembered');
            assert.deepEqual(rig.state['openconsole.directories'] || [], [], 'no folder is remembered');
        }, { width: 900, height: 320 });
    }
    finally { rig.close(); }
});

test('the menu "...": run active file, run selected text, recent directory, recent command, scroll, and forgetting', { skip: skipReason, timeout: 120000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-menu-'));
    const script = path.join(dir, 'run me.cmd');
    fs.writeFileSync(script, '@echo RAN_FILE_' + 'OK\r\n');            // the marker is only in the file: the typed command line does not have it
    const rig = await startRig({ state: { 'openconsole.directories': [dir], 'openconsole.commands': ['echo RECENT_OK'] }, pick: (items) => items[0] });
    try {
        await withPage(rig.url('panel'), async (page) => {
            await waitUntil(() => hasPrompt(page), 'the prompt');
            const outputLine = (marker) => waitUntil(async () => (await lines(page)).some((l) => l.endsWith(':' + marker)), 'the output ' + marker);

            // Run Active File: a file of the disk runs (here a .cmd file with a space in its name), anything else says so
            rig.setEditor({ document: { uri: { scheme: 'untitled' } } });
            await rig.command('openconsole.panel.runActiveFile');
            assert.ok(rig.shown.some((s) => s.kind === 'information' && /file of the disk/.test(s.text)), JSON.stringify(rig.shown));
            rig.setEditor({ document: { uri: { scheme: 'file', fsPath: script } } });
            await rig.command('openconsole.panel.runActiveFile');
            await outputLine('RAN_FILE_OK');

            // Run Selected Text: the selection, or the line of the cursor when nothing is selected
            rig.setEditor({ document: { uri: { scheme: 'untitled' }, getText: () => 'echo SELECTED_OK', lineAt: () => ({ text: 'echo wrong_line' }) }, selection: { active: { line: 0 } } });
            await rig.command('openconsole.panel.runSelectedText');
            await outputLine('SELECTED_OK');
            rig.setEditor({ document: { uri: { scheme: 'untitled' }, getText: () => '', lineAt: () => ({ text: 'echo LINE_FALLBACK_OK' }) }, selection: { active: { line: 0 } } });
            await rig.command('openconsole.panel.runSelectedText');
            await outputLine('LINE_FALLBACK_OK');

            // Go to Recent Directory: a quick pick of the folders that were used, then "cd" into the one that was picked
            await rig.command('openconsole.panel.recentDirectory');
            const dirPick = rig.picks[rig.picks.length - 1];
            assert.match(dirPick.options.placeHolder, /recent directory/i);
            assert.deepEqual(dirPick.items.map((i) => i.description), [dir]);
            await waitUntil(async () => (await lines(page)).some((l) => l.toLowerCase().includes(('PS ' + dir + '>').toLowerCase())), 'the prompt of the folder');

            // Run Recent Command: the newest first
            await rig.command('openconsole.panel.recentCommand');
            const commandPick = rig.picks[rig.picks.length - 1];
            assert.match(commandPick.options.placeHolder, /recent command/i);
            assert.equal(commandPick.items[0].label, 'echo RECENT_OK');
            await outputLine('RECENT_OK');

            // Scroll to Previous / Next Command: the page is told (what it does with it is checked in webview-multi)
            await rig.command('openconsole.panel.scrollToPreviousCommand');
            await rig.command('openconsole.panel.scrollToNextCommand');
            assert.deepEqual(rig.messages.filter((m) => m.message.t === 'scrollCommand').map((m) => m.message.dir), [-1, 1]);

            // Clear Terminal of the menu is the Clear button
            await rig.command('openconsole.panel.clear');
            await waitUntil(async () => { const now = await lines(page); return now.length === 1 && /PS .*>/.test(now[0]); }, 'an empty terminal');

            // forgetting what was remembered
            await rig.command('openconsole.clearCommandHistory');
            assert.deepEqual(rig.state['openconsole.commands'], []);
            assert.deepEqual(rig.state['openconsole.directories'], []);
            assert.ok(rig.messages.some((m) => m.message.t === 'history' && m.message.replace && m.message.commands.length === 0), 'the pages forget too');
            const shownBefore = rig.shown.length;
            await rig.command('openconsole.panel.recentDirectory');
            assert.ok(rig.shown.slice(shownBefore).some((s) => /No folders yet/.test(s.text)), 'nothing to pick from: a message instead');
        }, { width: 900, height: 320 });
    }
    finally { rig.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the shell may still be in it */ } }
});

test('the keys Ctrl+G and Ctrl+Alt+R in the terminal open the recent directories and the recent commands', { skip: skipReason, timeout: 90000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-keys-'));
    const rig = await startRig({ state: { 'openconsole.directories': [dir], 'openconsole.commands': ['echo RECENT_OK'] }, pick: () => undefined });
    try {
        await withPage(rig.url('panel'), async (page) => {
            await waitUntil(() => hasPrompt(page), 'the prompt');
            await focusTerminal(page);
            await press(page, { key: 'g', code: 'KeyG', windowsVirtualKeyCode: 71, modifiers: 2 });
            await waitUntil(() => rig.picks.some((p) => /recent directory/i.test(p.options.placeHolder)), 'the list of directories');
            await press(page, { key: 'r', code: 'KeyR', windowsVirtualKeyCode: 82, modifiers: 3 });
            await waitUntil(() => rig.picks.some((p) => /recent command/i.test(p.options.placeHolder)), 'the list of commands');
            // the same keys are not typed into the shell
            await sleep(300);
            assert.ok(!(await lines(page)).some((l) => /[\u0007\u0012]/.test(l)));
        }, { width: 900, height: 320 });
    }
    finally { rig.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* not there */ } }
});
