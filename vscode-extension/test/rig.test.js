'use strict';
// The whole extension without VS Code (see browser-rig.js): the real extension code, real PowerShell shells in real pseudo consoles,
// and the real page in headless Chrome or Edge.
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
const cursorRow = (page, id = 1) => page.evaluate(`(() => { const b = window.__openconsole.terminals.get(${id}).term.buffer.active; return b.baseY + b.cursorY; })()`);
const hasPrompt = async (page, id = 1) => (await lines(page, id)).some((l) => /PS .*>/.test(l));

test('Clear that only empties the screen (openconsole.clearRestartsTerminal off): the cleared lines do not come back when the panel is resized', { skip: skipReason, timeout: 90000 }, async (t) => {
    const rig = await startRig({ settings: { clearRestartsTerminal: false } });
    try {
        if (!rig.settings.appRoot && !fs.existsSync(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code'))) return t.skip('VS Code (with its conpty.dll) is not installed');
        await withPage(rig.url('panel'), async (page) => {
            await waitUntil(() => hasPrompt(page), 'the prompt');
            await rig.command('openconsole.sendText', '1..12 | % { "line $_" }\r');
            await waitUntil(async () => (await lines(page)).some((l) => l.endsWith(':line 12')), 'the output');
            await sleep(500);

            await rig.command('openconsole.panel.clear');
            await sleep(800);
            let now = await lines(page);
            assert.deepEqual(now.map((l) => l.replace(/^\d+:/, '').trim()), ['PS C:\\Users\\pc>'.replace('pc', require('node:os').userInfo().username)], 'only the prompt is left: ' + JSON.stringify(now));

            // a resize makes the pseudo console draw again whatever it still has
            await page.send('Emulation.setDeviceMetricsOverride', { width: 760, height: 300, deviceScaleFactor: 1, mobile: false });
            await sleep(1500);
            now = await lines(page);
            assert.ok(!now.some((l) => /line \d+$/.test(l)), 'the cleared lines came back after a resize: ' + JSON.stringify(now));
            assert.equal(await cursorRow(page), 0, 'the prompt stays on the first row');

            // and what is typed afterwards lands under the prompt
            await rig.command('openconsole.sendText', 'echo AFTER\r');
            await waitUntil(async () => (await lines(page)).some((l) => l.endsWith(':AFTER')), 'the new output');
            now = await lines(page);
            assert.match(now[0], /^0:PS .*> echo AFTER$/, JSON.stringify(now));
            assert.match(now[1], /^1:AFTER$/, JSON.stringify(now));
        }, { width: 900, height: 320 });
    }
    finally { rig.close(); }
});

test('Clear starts the terminal again (the default): a new shell, an empty screen, nothing comes back', { skip: skipReason, timeout: 90000 }, async () => {
    const rig = await startRig();
    try {
        await withPage(rig.url('panel'), async (page) => {
            await waitUntil(() => hasPrompt(page), 'the prompt');
            await rig.command('openconsole.sendText', '$env:OC_MARK = "old shell"; 1..10 | % { "line $_" }\r');
            await waitUntil(async () => (await lines(page)).some((l) => l.endsWith(':line 10')), 'the output');
            await sleep(400);

            await rig.command('openconsole.panel.clear');
            await waitUntil(async () => { const now = await lines(page); return now.length === 1 && /PS .*>/.test(now[0]); }, 'an empty terminal with a new prompt');
            await sleep(500);

            await page.send('Emulation.setDeviceMetricsOverride', { width: 760, height: 300, deviceScaleFactor: 1, mobile: false });
            await sleep(1200);
            const now = await lines(page);
            assert.ok(!now.some((l) => /line \d+$/.test(l)), 'nothing comes back after a resize: ' + JSON.stringify(now));

            await rig.command('openconsole.sendText', '"mark=[" + $env:OC_MARK + "]"\r');
            await waitUntil(async () => (await lines(page)).some((l) => l.endsWith(':mark=[]')), 'the new shell to answer');
            assert.ok(!(await lines(page)).some((l) => l.includes('old shell') && l.includes('mark=[old')), 'the shell is a new one: it does not know the variable of the old one');
        }, { width: 900, height: 320 });
    }
    finally { rig.close(); }
});

test('the buttons of the panel act on the panel, whatever terminal was used last', { skip: skipReason, timeout: 90000 }, async () => {
    const rig = await startRig();
    try {
        await withPage(rig.url('panel'), async (page) => {
            await waitUntil(() => hasPrompt(page), 'the prompt of the panel');
            // a terminal in an editor tab, used after the panel (so it is "the last one")
            await rig.command('openconsole.newEditorTerminal');
            const editor = rig.hosts().find((h) => h.startsWith('editor'));
            assert.ok(editor, 'the editor terminal was created');
            rig.receive(editor, { t: 'ready', id: 1, cols: 80, rows: 24 });
            rig.receive(editor, { t: 'input', id: 1, data: 'echo EDITOR_ONE\r' });
            await waitUntil(() => rig.messages.some((m) => m.host === editor && m.message.t === 'output' && m.message.data.includes('EDITOR_ONE')), 'the editor terminal to answer');

            const before = rig.messages.length;
            await rig.command('openconsole.panel.clear');
            await rig.command('openconsole.panel.restart');
            const after = rig.messages.slice(before);
            // Clear starts the terminal again, as Restart does: the page is told to reset
            assert.equal(after.filter((m) => m.host === 'panel' && m.message.t === 'reset').length, 2, 'the panel was started again by Clear and by Restart');
            assert.ok(!after.some((m) => m.host === editor && (m.message.t === 'clear' || m.message.t === 'reset')), 'the editor terminal was left alone');

            // the Command Palette commands do act on the terminal that was used last
            const beforePalette = rig.messages.length;
            await rig.command('openconsole.clear');
            const palette = rig.messages.slice(beforePalette);
            assert.ok(palette.some((m) => m.host === editor && m.message.t === 'reset'), 'the palette command acted on the terminal used last');
            assert.ok(!palette.some((m) => m.host === 'panel' && (m.message.t === 'clear' || m.message.t === 'reset')));
        }, { width: 900, height: 320 });
    }
    finally { rig.close(); }
});

test('the old extension (openconsole-terminal) next to this one is reported, and can be removed from the message', async () => {
    // this one needs no browser and no shell
    const quiet = await startRig({ legacyInstalled: false });
    assert.equal(quiet.shown.length, 0, 'no message when the old extension is not installed');
    quiet.close();

    const rig = await startRig({ legacyInstalled: true, answer: 'Remove it', answer2: 'Reload Window' });
    try {
        await sleep(300);
        assert.equal(rig.shown[0].kind, 'warning');
        assert.match(rig.shown[0].text, /openconsole\.openconsole-terminal/);
        assert.deepEqual(rig.shown[0].buttons, ['Remove it']);
        assert.ok(rig.executed.some((c) => c.id === 'workbench.extensions.uninstallExtension' && c.args[0] === 'openconsole.openconsole-terminal'), 'the old extension is uninstalled');
        assert.ok(rig.executed.some((c) => c.id === 'workbench.action.reloadWindow'), 'the window is reloaded after that');
    }
    finally { rig.close(); }

    // declining the message removes nothing
    const declined = await startRig({ legacyInstalled: true, answer: undefined });
    try {
        await sleep(300);
        assert.ok(!declined.executed.some((c) => c.id === 'workbench.extensions.uninstallExtension'));
    }
    finally { declined.close(); }
});

/** Opens the menu next to "+" (a dropdown that the page draws) and returns its entries: the names, "---" for a separator. */
async function openMenu(rig, page) {
    await rig.command('openconsole.panel.newTerminalMenu');
    await waitUntil(() => page.evaluate("!document.getElementById('menu').hidden"), 'the menu');
    return page.evaluate("Array.from(document.querySelectorAll('#menu > div')).map((e) => (e.className === 'separator' ? '---' : e.textContent))");
}

/** Opens the menu next to "+" and clicks one of its entries, as a user does. */
async function chooseFromMenu(rig, page, label) {
    await openMenu(rig, page);
    const clicked = await page.evaluate(`(() => { const e = Array.from(document.querySelectorAll('#menu .entry')).find((x) => x.textContent === ${JSON.stringify(label)}); if (!e) return false; e.click(); return true; })()`);
    assert.ok(clicked, label + ' is in the menu');
}

test('the menu next to "+" is a dropdown (not a search box) and starts a terminal of a chosen kind (Command Prompt), named after it', { skip: skipReason, timeout: 90000 }, async () => {
    const rig = await startRig();
    try {
        await withPage(rig.url('panel'), async (page) => {
            await waitUntil(() => hasPrompt(page, 1), 'the first prompt');
            const menu = await openMenu(rig, page);

            assert.deepEqual(menu.slice(0, 4), ['New Terminal', 'New Terminal in Editor', 'Split Terminal', '---'], JSON.stringify(menu));
            for (const wanted of ['PowerShell', 'Command Prompt']) assert.ok(menu.includes(wanted), wanted + ' is in the menu: ' + JSON.stringify(menu));
            assert.deepEqual(menu.slice(-3), ['---', 'Configure Terminal Settings', 'Select Default Profile'], JSON.stringify(menu));
            assert.equal(rig.picks.length, 0, 'no search box (quick pick) was shown');
            assert.equal(await page.evaluate("document.querySelector('#menu .entry.selected').textContent"), 'New Terminal', 'the first entry is marked');

            // Escape closes it without starting anything
            await page.evaluate("document.getElementById('menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))");
            assert.equal(await page.evaluate("document.getElementById('menu').hidden"), true);
            assert.equal(await page.evaluate('window.__openconsole.terminals.size'), 1);

            await chooseFromMenu(rig, page, 'Command Prompt');
            assert.equal(await page.evaluate("document.getElementById('menu').hidden"), true, 'the menu closes when an entry is picked');

            await waitUntil(async () => (await page.evaluate('window.__openconsole.terminals.size')) === 2, 'the second terminal');
            await waitUntil(async () => (await lines(page, 2)).some((l) => /^\d+:[A-Z]:\\.*>/.test(l)), 'the prompt of Command Prompt');
            assert.ok(!(await lines(page, 2)).some((l) => /PS .*>/.test(l)), 'it is not PowerShell');
            assert.deepEqual(await page.evaluate("Array.from(document.querySelectorAll('#list .item')).map((i) => i.textContent.trim())"), ['powershell', 'Command Prompt']);

            await rig.command('openconsole.sendText', 'echo CMD_SAYS_HELLO\r');
            await waitUntil(async () => (await lines(page, 2)).some((l) => l.endsWith(':CMD_SAYS_HELLO')), 'the Command Prompt to answer');
            assert.ok(!(await lines(page, 1)).some((l) => l.includes('CMD_SAYS_HELLO')));

            // a restart keeps the kind of the terminal
            await rig.command('openconsole.panel.restart');
            await waitUntil(async () => { const now = await lines(page, 2); return now.length >= 1 && now.every((l) => !l.includes('CMD_SAYS_HELLO')) && now.some((l) => /^\d+:[A-Z]:\\.*>/.test(l)); }, 'Command Prompt again');
        }, { width: 900, height: 320 });
    }
    finally { rig.close(); }
});

test('Split: a second real terminal opens next to the first, of the same kind, and typing goes where the focus is', { skip: skipReason, timeout: 120000 }, async () => {
    const rig = await startRig();
    try {
        await withPage(rig.url('panel'), async (page) => {
            await waitUntil(() => hasPrompt(page, 1), 'the first prompt');
            await chooseFromMenu(rig, page, 'Command Prompt');                                   // a Command Prompt, terminal 2
            await waitUntil(async () => (await lines(page, 2)).some((l) => /^\d+:[A-Z]:\\.*>/.test(l)), 'the prompt of Command Prompt');

            // the split button of the row of terminal 2
            await page.evaluate("document.querySelector('#list .item[data-id=\"2\"] .split').click()");
            await waitUntil(async () => (await lines(page, 3)).some((l) => /^\d+:[A-Z]:\\.*>/.test(l)), 'the prompt of the split terminal (Command Prompt too)');
            assert.deepEqual(await page.evaluate("Array.from(document.querySelectorAll('#list .item')).map((i) => i.textContent.trim())"), ['powershell', 'Command Prompt', 'Command Prompt']);
            assert.ok(!(await lines(page, 3)).some((l) => /PS .*>/.test(l)), 'the split is a Command Prompt, not the default shell');

            const geometry = await page.evaluate(`(() => { const r = (id) => { const b = window.__openconsole.terminals.get(id).el.getBoundingClientRect(); return { left: Math.round(b.left), width: Math.round(b.width) }; };
                return { two: r(2), three: r(3), shown: Array.from(window.__openconsole.terminals.values()).filter((t) => t.el.classList.contains('active')).map((t) => t.id) }; })()`);
            assert.deepEqual(geometry.shown, [2, 3], 'the two are shown together');
            assert.ok(Math.abs(geometry.two.width - geometry.three.width) <= 2 && Math.abs(geometry.two.left + geometry.two.width - geometry.three.left) <= 2, 'side by side: ' + JSON.stringify(geometry));

            await rig.command('openconsole.sendText', 'echo RIGHT_ONE\r');                       // the new (right) terminal has the focus
            await waitUntil(async () => (await lines(page, 3)).some((l) => l.endsWith(':RIGHT_ONE')), 'the right terminal to answer');
            assert.ok(!(await lines(page, 2)).some((l) => l.includes('RIGHT_ONE')));

            await page.evaluate('window.__openconsole.terminals.get(2).term.focus()');         // what a click in the left one does
            await sleep(300);
            await rig.command('openconsole.sendText', 'echo LEFT_ONE\r');
            await waitUntil(async () => (await lines(page, 2)).some((l) => l.endsWith(':LEFT_ONE')), 'the left terminal to answer');
            assert.ok(!(await lines(page, 3)).some((l) => l.includes('LEFT_ONE')));

            // Split Terminal of the Command Palette splits the terminal that has the focus
            await rig.command('openconsole.splitTerminal');
            await waitUntil(async () => (await page.evaluate('window.__openconsole.terminals.size')) === 4, 'the third terminal of the group');
            await waitUntil(async () => (await lines(page, 4)).some((l) => /^\d+:[A-Z]:\\.*>/.test(l)), 'its prompt');
            assert.deepEqual(await page.evaluate("Array.from(document.querySelectorAll('#list .item')).map((i) => i.dataset.id)"), ['1', '2', '4', '3'], 'the new one is right after the one that was split');

            // killing one of them: the others share the width again
            await page.evaluate("document.querySelector('#list .item[data-id=\"4\"] .close').click()");
            await waitUntil(async () => (await page.evaluate('window.__openconsole.terminals.size')) === 3, 'the terminal to close');
        }, { width: 900, height: 320 });
    }
    finally { rig.close(); }
});

test('"Select Default Profile" changes the shell that "+" starts', { skip: skipReason, timeout: 60000 }, async () => {
    const rig = await startRig({ pick: (items) => items.find((i) => i.label === 'Command Prompt') });
    try {
        await rig.command('openconsole.selectDefaultProfile');
        assert.match(rig.picks[0].options.placeHolder, /default profile/i);
        const shell = rig.updates.find((u) => u.key === 'shell');
        const args = rig.updates.find((u) => u.key === 'shellArgs');
        assert.match(shell.value, /cmd\.exe$/i);
        assert.deepEqual(args.value, []);
        assert.equal(shell.target, 1, 'in the settings of the user');
        assert.equal(rig.settings.shell, shell.value);

        // nothing is chosen: nothing changes
        const before = rig.updates.length;
        const none = await startRig({ pick: () => undefined });
        await none.command('openconsole.selectDefaultProfile');
        assert.equal(none.updates.length, 0);
        none.close();
        assert.equal(rig.updates.length, before);
    }
    finally { rig.close(); }
});

test('"+" adds a second real terminal in the panel, and each keeps its own shell', { skip: skipReason, timeout: 90000 }, async () => {
    const rig = await startRig();
    try {
        await withPage(rig.url('panel'), async (page) => {
            await waitUntil(() => hasPrompt(page, 1), 'the first prompt');
            await rig.command('openconsole.sendText', 'echo ONLY_IN_ONE\r');
            await waitUntil(async () => (await lines(page, 1)).some((l) => l.endsWith(':ONLY_IN_ONE')), 'the first terminal to answer');

            await rig.command('openconsole.panel.newTerminal');
            await waitUntil(() => hasPrompt(page, 2), 'the prompt of the second terminal');
            assert.equal(await page.evaluate('window.__openconsole.terminals.size'), 2);
            assert.equal(await page.evaluate("document.getElementById('list').hidden"), false, 'the list of terminals is shown');
            assert.deepEqual(await page.evaluate("Array.from(document.querySelectorAll('#list .item')).map((i) => i.textContent.trim())"), ['powershell', 'powershell']);

            await rig.command('openconsole.sendText', 'echo ONLY_IN_TWO\r');       // goes to the terminal that is shown: the new one
            await waitUntil(async () => (await lines(page, 2)).some((l) => l.endsWith(':ONLY_IN_TWO')), 'the second terminal to answer');
            assert.ok(!(await lines(page, 1)).some((l) => l.includes('ONLY_IN_TWO')), 'the first terminal did not get it');
            assert.ok(!(await lines(page, 2)).some((l) => l.includes('ONLY_IN_ONE')), 'the second terminal is a fresh shell');

            // click the first one in the list: typing goes there again
            await page.evaluate("document.querySelectorAll('#list .item')[0].click()");
            await sleep(200);
            await rig.command('openconsole.sendText', 'echo BACK_IN_ONE\r');
            await waitUntil(async () => (await lines(page, 1)).some((l) => l.endsWith(':BACK_IN_ONE')), 'the first terminal to answer again');
            assert.ok(!(await lines(page, 2)).some((l) => l.includes('BACK_IN_ONE')));

            // kill the second one with the x of its row
            await page.evaluate("document.querySelectorAll('#list .item')[1].querySelector('.close').click()");
            await waitUntil(async () => (await page.evaluate('window.__openconsole.terminals.size')) === 1, 'the terminal to close');
            assert.equal(await page.evaluate("document.getElementById('list').hidden"), true, 'the list is gone with one terminal');
        }, { width: 900, height: 320 });
    }
    finally { rig.close(); }
});

test('the menu next to "+": Split Terminal, Select Default Profile and Configure Terminal Settings do what they say', { skip: skipReason, timeout: 90000 }, async () => {
    const rig = await startRig({ pick: (items) => items.find((i) => i.label === 'Command Prompt') });
    try {
        await withPage(rig.url('panel'), async (page) => {
            await waitUntil(() => hasPrompt(page, 1), 'the first prompt');

            await chooseFromMenu(rig, page, 'Configure Terminal Settings');
            await waitUntil(() => rig.executed.some((e) => e.id === 'workbench.action.openSettings' && e.args[0] === '@ext:openconsole.openconsole'), 'the settings to open');

            await chooseFromMenu(rig, page, 'Select Default Profile');                  // the list of kinds is the quick pick of that command
            await waitUntil(() => rig.picks.length === 1 && /default profile/i.test(rig.picks[0].options.placeHolder), 'the list of profiles');
            await waitUntil(() => rig.updates.some((u) => u.key === 'shell' && /cmd\.exe$/i.test(u.value)), 'the default shell to change');

            await chooseFromMenu(rig, page, 'Split Terminal');
            await waitUntil(async () => (await page.evaluate('window.__openconsole.terminals.size')) === 2, 'the split terminal');
            assert.equal(await page.evaluate("document.getElementById('menu').hidden"), true);
        }, { width: 900, height: 320 });
    }
    finally { rig.close(); }
});

test('the line between the terminals and the list follows a real mouse drag, and the shell gets the new width', { skip: skipReason, timeout: 90000 }, async () => {
    const rig = await startRig();
    try {
        await withPage(rig.url('panel'), async (page) => {
            await waitUntil(() => hasPrompt(page, 1), 'the first prompt');
            await rig.command('openconsole.panel.newTerminal');
            await waitUntil(() => hasPrompt(page, 2), 'the prompt of the second terminal');
            await sleep(400);

            const geometry = () => page.evaluate(`(() => { const s = document.getElementById('sash').getBoundingClientRect(); const l = document.getElementById('list').getBoundingClientRect();
                return { x: s.left + s.width / 2, y: s.top + 60, list: Math.round(l.width), cols: window.__openconsole.terminals.get(2).term.cols, cursor: getComputedStyle(document.getElementById('sash')).cursor }; })()`);
            const mouse = (type, x, y, extra) => page.send('Input.dispatchMouseEvent', Object.assign({ type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 }, extra));
            const start = await geometry();
            assert.equal(start.list, 184);
            assert.equal(start.cursor, 'col-resize');

            await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y });
            await mouse('mousePressed', start.x, start.y);
            const widths = [];
            for (let step = 1; step <= 8; step++) {                                    // 8 small moves to the left: the list follows every one
                await mouse('mouseMoved', start.x - step * 10, start.y);
                await sleep(60);
                widths.push((await geometry()).list);
            }
            assert.deepEqual(widths, [194, 204, 214, 224, 234, 244, 254, 264], 'the list is 10px wider after every 10px of the mouse');
            await mouse('mouseReleased', start.x - 80, start.y);
            await sleep(300);

            const after = await geometry();
            assert.equal(after.list, 264);
            assert.ok(after.cols < start.cols, 'the terminal has fewer columns: ' + start.cols + ' -> ' + after.cols);
            // the shell of that terminal knows the new width
            await rig.command('openconsole.sendText', '"cols=" + $Host.UI.RawUI.WindowSize.Width\r');
            await waitUntil(async () => (await lines(page, 2)).some((l) => l.endsWith(':cols=' + after.cols)), 'the shell to report ' + after.cols + ' columns: ' + JSON.stringify(await lines(page, 2)));

            // dragged back to the right and past the end: the list keeps 80px; a double click gives the usual width back
            const second = await geometry();
            await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: second.x, y: second.y });
            await mouse('mousePressed', second.x, second.y);
            await mouse('mouseMoved', second.x + 600, second.y);
            await mouse('mouseReleased', second.x + 600, second.y);
            await sleep(300);
            assert.equal((await geometry()).list, 80);
            const third = await geometry();
            await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: third.x, y: third.y, button: 'left', buttons: 1, clickCount: 2 });
            await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: third.x, y: third.y, button: 'left', buttons: 0, clickCount: 2 });
            await sleep(300);
            assert.equal((await geometry()).list, 184);
        }, { width: 900, height: 320 });
    }
    finally { rig.close(); }
});

test('Ctrl + click on an address that PowerShell printed opens it in the browser of VS Code; a click without Ctrl does not', { skip: skipReason, timeout: 90000 }, async () => {
    const rig = await startRig();
    try {
        await withPage(rig.url('panel'), async (page) => {
            await waitUntil(() => hasPrompt(page, 1), 'the prompt');
            const url = 'https://example.com/from-powershell?x=1';
            await rig.command('openconsole.sendText', "Write-Output ('https' + '://example.com/from-powershell?x=1')\r");        // the typed line does not contain the address whole
            const where = () => page.evaluate(`(() => { const t = window.__openconsole.terminals.get(1); const b = t.term.buffer.active; const r = t.el.querySelector('.xterm-screen').getBoundingClientRect();
                for (let y = 0; y < t.term.rows; y++) { if (b.getLine(b.viewportY + y).translateToString(true) === ${JSON.stringify(url)}) return { x: r.left + 8.5 * r.width / t.term.cols, y: r.top + (y + 0.5) * r.height / t.term.rows, farY: r.top + ((y + 4) % t.term.rows + 0.5) * r.height / t.term.rows }; }
                return null; })()`);
            await waitUntil(async () => !!(await where()), 'the address on the screen');
            const spot = await where();
            const mouse = (type, x, y, extra) => page.send('Input.dispatchMouseEvent', Object.assign({ type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 }, extra));

            // pointed at: the hint comes up
            await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x, y: spot.farY });
            await sleep(80);
            await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x, y: spot.y });
            await waitUntil(() => page.evaluate("!document.getElementById('linktip').hidden"), 'the hint');

            // a click without Ctrl: nothing is opened
            await mouse('mousePressed', spot.x, spot.y);
            await mouse('mouseReleased', spot.x, spot.y);
            await sleep(400);
            assert.deepEqual(rig.opened, []);

            // Ctrl + click: opened, through the extension, whole
            await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x, y: spot.farY, modifiers: 2 });
            await sleep(80);
            await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x, y: spot.y, modifiers: 2 });
            await sleep(250);
            await mouse('mousePressed', spot.x, spot.y, { modifiers: 2 });
            await mouse('mouseReleased', spot.x, spot.y, { modifiers: 2 });
            await waitUntil(() => rig.opened.length === 1, 'the address to be opened');
            assert.deepEqual(rig.opened, [url]);
            assert.equal(await page.evaluate("document.getElementById('linktip').hidden"), true, 'the hint is gone after the click');
        }, { width: 900, height: 320 });
    }
    finally { rig.close(); }
});

test('text follows the width: a long line that is being typed wraps again when the terminal gets narrower, and is one row again when it gets wider', { skip: skipReason, timeout: 120000 }, async () => {
    const rig = await startRig();
    try {
        await withPage(rig.url('panel'), async (page) => {
            await waitUntil(() => hasPrompt(page, 1), 'the first prompt');
            await rig.command('openconsole.panel.newTerminal');
            await waitUntil(() => hasPrompt(page, 2), 'the prompt of the second terminal');
            await sleep(600);
            const address = 'https://github.com/yousef0688/OpenConsole-Arabic-Terminal';
            await rig.command('openconsole.sendText', address);
            const rows = () => page.evaluate(`(() => { const t = window.__openconsole.terminals.get(2); const b = t.term.buffer.active; const out = [];
                for (let y = 0; y < b.length; y++) { const l = b.getLine(y); const s = l.translateToString(true); if (s) out.push({ wrapped: l.isWrapped, text: s }); }
                return { cols: t.term.cols, rows: out }; })()`);
            const joined = (r) => r.rows.map((x) => x.text).join('');
            await waitUntil(async () => joined(await rows()).endsWith(address), 'the typed address');

            const sashX = () => page.evaluate("(() => { const s = document.getElementById('sash').getBoundingClientRect(); return s.left + s.width / 2; })()");
            const drag = async (to) => {                                                       // a real drag of the line, in small steps
                const from = await sashX();
                await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from, y: 100 });
                await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from, y: 100, button: 'left', buttons: 1, clickCount: 1 });
                for (let i = 1; i <= 12; i++) { await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from + (to - from) * i / 12, y: 100, button: 'left', buttons: 1 }); await sleep(25); }
                await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to, y: 100, button: 'left', buttons: 0, clickCount: 1 });
            };

            const start = await rows();
            assert.equal(start.rows.length, 1, 'wide: one row: ' + JSON.stringify(start));
            for (let round = 1; round <= 2; round++) {                                         // twice, so that it is not luck
                await drag(280);                                                                // the list gets wide: the terminal is narrow
                await waitUntil(async () => { const r = await rows(); return r.cols < 40 && r.rows.length >= 3 && joined(r).endsWith(address); }, 'the line to wrap at the narrow width (round ' + round + '): ' + JSON.stringify(await rows()));
                const narrow = await rows();
                assert.ok(narrow.rows.slice(1).every((x) => x.wrapped), 'the rest is the continuation of the first row: ' + JSON.stringify(narrow));
                assert.ok(narrow.rows.every((x) => x.text.length <= narrow.cols), 'no row is longer than the terminal');

                await drag(5000);                                                               // the list gets narrow again: the terminal is wide
                await waitUntil(async () => { const r = await rows(); return r.cols > 70 && r.rows.length === 1 && joined(r).endsWith(address); }, 'the line to be one row again (round ' + round + '): ' + JSON.stringify(await rows()));
            }
            // and what is typed after that goes on where it was
            await rig.command('openconsole.sendText', '/more');
            await waitUntil(async () => joined(await rows()).endsWith(address + '/more'), 'typing to go on');
        }, { width: 800, height: 240 });
    }
    finally { rig.close(); }
});

test('the right mouse button pastes what was copied last into a real shell, and a program that uses the mouse gets the right button', { skip: skipReason, timeout: 90000 }, async () => {
    const rig = await startRig({ clipboardText: 'echo RIGHT_CLICK_PASTED' });
    try {
        await withPage(rig.url('panel'), async (page) => {
            await waitUntil(() => hasPrompt(page, 1), 'the first prompt');
            await sleep(500);
            const spot = await page.evaluate(`(() => { const r = window.__openconsole.term.element.querySelector('.xterm-screen').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
            const rightClick = async (extra) => {
                await page.send('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed', x: spot.x, y: spot.y, button: 'right', buttons: 2, clickCount: 1 }, extra));
                await page.send('Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased', x: spot.x, y: spot.y, button: 'right', buttons: 0, clickCount: 1 }, extra));
            };

            await rightClick();
            await waitUntil(async () => (await lines(page, 1)).some((l) => /PS .*> echo RIGHT_CLICK_PASTED$/.test(l)), 'the clipboard text to be typed at the prompt: ' + JSON.stringify(await lines(page, 1)));
            assert.ok(!(await lines(page, 1)).some((l) => l.endsWith(':RIGHT_CLICK_PASTED')), 'it is typed, not run');

            // the right button again: the same text again (the clipboard is not emptied)
            await rightClick();
            await waitUntil(async () => (await lines(page, 1)).some((l) => /echo RIGHT_CLICK_PASTEDecho RIGHT_CLICK_PASTED$/.test(l)), 'the second paste');

            // a program that uses the mouse gets the right button, not the paste (the shell has just been told to ask for it)
            await page.evaluate('window.__openconsole.term.write("\\u001b[?1000h")');       // as if the program had asked for the mouse
            await sleep(200);
            const count = async () => (await lines(page, 1)).join('').split('echo RIGHT_CLICK_PASTED').length - 1;
            assert.equal(await count(), 2);
            const sentBefore = await page.evaluate('window.__sent.length');
            await rightClick();
            await sleep(500);
            const sent = await page.evaluate(`window.__sent.slice(${sentBefore})`);
            assert.ok(sent.some((m) => (m.t === 'binary' || m.t === 'input') && m.data.startsWith('\u001b[M')), 'the program got the right button as a mouse report: ' + JSON.stringify(sent));
            assert.ok(!sent.some((m) => m.t === 'pasteRequest'), 'no paste was asked for');
            assert.equal(await count(), 2, 'nothing was pasted');

            // Shift + right button pastes then
            await rightClick({ modifiers: 8 });
            await waitUntil(async () => (await count()) === 3, 'the paste with Shift');
        }, { width: 900, height: 320 });
    }
    finally { rig.close(); }
});

test('Backspace right behind a pasted screenshot removes the whole path from the real PowerShell line at once', { skip: skipReason, timeout: 90000 }, async () => {
    const rig = await startRig();
    try {
        await withPage(rig.url('panel'), async (page) => {
            await waitUntil(() => hasPrompt(page, 1), 'the prompt');
            await sleep(500);
            await page.evaluate('window.__openconsole.term.focus()');
            const key = async (name, code, windowsVirtualKeyCode) => {
                await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code, windowsVirtualKeyCode });
                await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode });
            };
            const prompt = async () => ((await lines(page, 1)).filter((l) => /PS .*>/.test(l)).pop() || '').trimEnd();       // PSReadLine leaves a blank cell after an erased letter
            const path = 'C:\\Users\\pc\\AppData\\Local\\Temp\\OpenConsole\\clipboard-20991231-235959-001.png';     // a path only: nothing opens it
            const pasteImagePath = () => page.evaluate(`window.dispatchEvent(new MessageEvent('message', { data: { t: 'paste', id: 1, text: ${JSON.stringify(path)}, image: true } }))`);

            // one Backspace: the path is gone
            await pasteImagePath();
            await waitUntil(async () => (await prompt()).endsWith('> ' + path), 'the path at the prompt: ' + (await prompt()));
            await waitUntil(() => page.evaluate("document.querySelectorAll('.xterm-decoration').length > 0"), 'the label over the path');
            await key('Backspace', 'Backspace', 8);
            await waitUntil(async () => /^\d+:PS .*>$/.test(await prompt()), 'the whole path to be removed by one key: ' + (await prompt()));
            await waitUntil(() => page.evaluate("document.querySelectorAll('.xterm-decoration').length === 0"), 'the label to go');

            // a letter after the label: Backspace removes the letter only, the next one the path
            await pasteImagePath();
            await waitUntil(async () => (await prompt()).endsWith('> ' + path), 'the path again');
            await rig.command('openconsole.sendText', 'x');
            await waitUntil(async () => (await prompt()).endsWith('> ' + path + 'x'), 'the letter');
            await key('Backspace', 'Backspace', 8);
            await waitUntil(async () => (await prompt()).endsWith('> ' + path), 'only the letter to be removed: ' + (await prompt()));
            await key('Backspace', 'Backspace', 8);
            await waitUntil(async () => /^\d+:PS .*>$/.test(await prompt()), 'then the whole path: ' + (await prompt()));
        }, { width: 1100, height: 320 });
    }
    finally { rig.close(); }
});

test('a program that reports that it needs you marks its terminal, fills the status bar, notifies once, and "Next Terminal That Needs You" shows it', { skip: skipReason, timeout: 120000 }, async () => {
    const rig = await startRig({ settings: { 'attention.minWorkingSeconds': 1 } });
    const script = path.join(os.tmpdir(), 'oc-report-' + process.pid + '.js');
    fs.writeFileSync(script, [
        "const w = (s) => process.stdout.write(s);",
        "w('\x1b]7501;state=working\x07');",
        "setTimeout(() => w('\x1b]7501;state=blocked:msg=' + Buffer.from('Run the tests?').toString('base64') + '\x07'), 1500);",
        "setTimeout(() => w('\x1b]7501;state=working\x07'), 9000);",
        "setTimeout(() => process.exit(0), 11000);",
    ].join('\n'));
    try {
        await withPage(rig.url('panel'), async (page) => {
            await waitUntil(() => hasPrompt(page, 1), 'the prompt');
            await page.evaluate('window.__openconsoleLooking = false');          // nobody looks at it
            await rig.command('openconsole.sendText', `node "${script}"\r`);
            // a second terminal, so that the list shows (and the first is not the one that is shown)
            await rig.command('openconsole.newTerminal');
            await waitUntil(() => page.evaluate('window.__openconsole.terminals.size === 2'), 'the second terminal');
            await waitUntil(() => hasPrompt(page, 2), 'the prompt of the second terminal');
            assert.equal(await page.evaluate('window.__openconsole.activeId'), 2);
            const mark = () => page.evaluate("(() => { const m = document.querySelector('#list .item[data-id=\"1\"] .status'); return m ? m.dataset.state + '|' + m.parentElement.title : ''; })()");
            await waitUntil(async () => (await mark()).startsWith('blocked'), 'the first terminal to be marked "needs you" (' + await mark() + ')', 20000);
            assert.match(await mark(), /needs you/);
            assert.match(await mark(), /Run the tests\?/, 'the message of the report is in the tooltip');
            const item = rig.statusItems[0];
            assert.ok(item && item.visible, 'the status bar item is shown');
            assert.equal(item.text, '$(bell) 1');
            assert.equal(item.command, 'openconsole.attentionList');
            const told = rig.shown.filter((m) => /needs you/.test(m.text));
            assert.equal(told.length, 1, 'told once: ' + JSON.stringify(rig.shown));
            assert.equal(told[0].kind, 'warning');
            assert.deepEqual(told[0].buttons, ['Show']);
            assert.match(told[0].text, /Run the tests\?/);

            await rig.command('openconsole.nextAttention');
            await waitUntil(async () => (await page.evaluate('window.__openconsole.activeId')) === 1, 'the terminal that needs you to be shown');
            assert.ok(rig.executed.some((e) => e.id === 'openconsole.terminal.focus'), 'the view was opened first');

            // the program goes on and ends: told as done
            await waitUntil(() => rig.shown.some((m) => /is done/.test(m.text)), 'the end of the program', 30000);
            assert.equal(rig.shown.filter((m) => /is done/.test(m.text)).length, 1);
            // "explain" says what it saw
            await rig.command('openconsole.explainState');
            await waitUntil(() => rig.channels.length === 1 && rig.channels[0].lines.length > 0, 'the explanation');
            assert.match(rig.channels[0].lines[0], /^.+: \w+/);
            assert.equal(rig.channels[0].shown, true);
            // the list of the command
            rig.picks.length = 0;
            await rig.command('openconsole.attentionList');
            assert.ok(rig.picks.length <= 1);
        }, { width: 900, height: 360 });
    }
    finally { rig.close(); try { fs.unlinkSync(script); } catch { /* gone */ } }
});

test('Ctrl + click on a file path that PowerShell printed opens that file at its line and column; a click without Ctrl does not', { skip: skipReason, timeout: 90000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-filelink-'));
    const file = path.join(dir, 'sample.ts');
    fs.writeFileSync(file, 'one\ntwo\nthree\n');
    const shown = file + ':3:2';
    const rig = await startRig();
    try {
        await withPage(rig.url('panel'), async (page) => {
            await waitUntil(() => hasPrompt(page, 1), 'the prompt');
            await rig.command('openconsole.sendText', `Write-Output ('${file.slice(0, -3)}' + '${file.slice(-3)}:3:2')\r`);        // the typed line does not hold the path whole
            const where = () => page.evaluate(`(() => { const t = window.__openconsole.terminals.get(1); const b = t.term.buffer.active; const r = t.el.querySelector('.xterm-screen').getBoundingClientRect();
                for (let y = 0; y < t.term.rows; y++) { if (b.getLine(b.viewportY + y).translateToString(true) === ${JSON.stringify(shown)}) return { x: r.left + 8.5 * r.width / t.term.cols, y: r.top + (y + 0.5) * r.height / t.term.rows, farY: r.top + ((y + 4) % t.term.rows + 0.5) * r.height / t.term.rows }; }
                return null; })()`);
            await waitUntil(async () => !!(await where()), 'the path on the screen');
            const spot = await where();
            const mouse = (type, x, y, extra) => page.send('Input.dispatchMouseEvent', Object.assign({ type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 }, extra));
            const opened = () => rig.executed.filter((e) => e.id === 'vscode.open');

            await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x, y: spot.farY });
            await sleep(80);
            await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x, y: spot.y });
            await waitUntil(() => page.evaluate("!document.getElementById('linktip').hidden && /Open file/.test(document.getElementById('linktip').textContent)"), 'the hint "Open file"');

            await mouse('mousePressed', spot.x, spot.y);
            await mouse('mouseReleased', spot.x, spot.y);
            await sleep(400);
            assert.equal(opened().length, 0, 'a click without Ctrl only selects');

            await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x, y: spot.farY, modifiers: 2 });
            await sleep(80);
            await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x, y: spot.y, modifiers: 2 });
            await sleep(250);
            await mouse('mousePressed', spot.x, spot.y, { modifiers: 2 });
            await mouse('mouseReleased', spot.x, spot.y, { modifiers: 2 });
            await waitUntil(() => opened().length === 1, 'the file to be opened');
            const [call] = opened();
            assert.equal(call.args[0].fsPath, file);
            assert.deepEqual(JSON.parse(JSON.stringify(call.args[1].selection)), { start: { line: 2, character: 1 }, end: { line: 2, character: 1 } });
            assert.equal(await page.evaluate("document.getElementById('linktip').hidden"), true, 'the hint is gone after the click');
        }, { width: 900, height: 320 });
    }
    finally { rig.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('"Run package.json Scripts in Parallel": each script gets its own terminal named after it, at most N at a time, and the next starts when one ends', { skip: skipReason, timeout: 150000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-scripts-'));
    const script = (mark) => `node -e "console.log('${mark}');setTimeout(()=>{},3500)"`;
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo-app', version: '1.0.0', scripts: { one: script('MARK_ONE'), two: script('MARK_TWO'), three: script('MARK_THREE') } }));
    const rig = await startRig({ folders: [dir], settings: { 'scripts.maxParallel': 2 }, pick: (items) => items });
    try {
        await withPage(rig.url('panel'), async (page) => {
            await waitUntil(() => hasPrompt(page, 1), 'the prompt');
            const titles = () => page.evaluate('Array.from(window.__openconsole.terminals.values()).map((t) => t.title)');
            await rig.command('openconsole.runScripts');
            assert.equal(rig.picks.length, 1);
            assert.deepEqual(rig.picks[0].items.map((i) => i.label), ['demo-app: one', 'demo-app: two', 'demo-app: three']);
            await waitUntil(async () => (await titles()).length === 3, 'two terminals for the first two scripts');
            assert.deepEqual((await titles()).slice(1), ['demo-app: one', 'demo-app: two']);
            await sleep(1200);
            assert.equal((await titles()).length, 3, 'the third waits: at most two run at a time');
            const text = (id) => page.evaluate(`(() => { const b = window.__openconsole.terminals.get(${id}).term.buffer.active; let s = ''; for (let i = 0; i < b.length; i++) s += b.getLine(i).translateToString(true) + ' | '; return s; })()`);
            const ids = await page.evaluate('Array.from(window.__openconsole.terminals.keys())');
            await waitUntil(async () => /MARK_ONE/.test(await text(ids[1])), 'the output of the first script', 30000);
            await waitUntil(async () => /MARK_TWO/.test(await text(ids[2])), 'the output of the second script', 30000);
            await waitUntil(async () => (await titles()).length === 4, 'the third terminal, when one of the two has ended', 40000);
            assert.equal((await titles())[3], 'demo-app: three');
            const third = (await page.evaluate('Array.from(window.__openconsole.terminals.keys())'))[3];
            await waitUntil(async () => /MARK_THREE/.test(await text(third)), 'the output of the third script', 30000);
        }, { width: 1000, height: 400 });
    }
    finally { rig.close(); await sleep(800); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a shell still holds the folder: the temp folder stays */ } }
});

test('a saved group (.openconsole/groups.json): its commands are shown first, each terminal starts in its folder with its command, an approved group is not asked again, a group that leaves the workspace is refused', { skip: skipReason, timeout: 150000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-group-'));
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.mkdirSync(path.join(dir, '.openconsole'));
    fs.writeFileSync(path.join(dir, '.openconsole', 'groups.json'), JSON.stringify({ groups: [
        { name: 'dev', terminals: [{ name: 'api', cwd: '.', command: 'echo MARK_API' }, { name: 'web', cwd: 'sub', command: 'echo MARK_WEB', color: 'green' }] },
        { name: 'evil', terminals: [{ name: 'x', cwd: '../../elsewhere', command: 'echo MARK_EVIL' }] },
    ] }));
    let answer;                                                      // what the user clicks in the question
    const rig = await startRig({ folders: [dir], pick: (items) => items.find((i) => i.label === 'dev'), answer: () => answer });
    try {
        await withPage(rig.url('panel'), async (page) => {
            await waitUntil(() => hasPrompt(page, 1), 'the prompt');
            const titles = () => page.evaluate('Array.from(window.__openconsole.terminals.values()).map((t) => t.title)');
            const text = (id) => page.evaluate(`(() => { const b = window.__openconsole.terminals.get(${id}).term.buffer.active; let s = ''; for (let i = 0; i < b.length; i++) s += b.getLine(i).translateToString(true) + ' | '; return s; })()`);
            const questions = () => rig.shown.filter((m) => m.kind === 'warning');

            // the user says no: nothing starts
            answer = undefined;
            await rig.command('openconsole.launchGroup');
            assert.equal(questions().length, 1, 'the commands are shown before they run');
            assert.match(questions()[0].text, /"dev"/);
            assert.match(questions()[0].text, /api: echo MARK_API/);
            assert.match(questions()[0].text, /web: echo MARK_WEB/);
            assert.ok(!/MARK_EVIL/.test(questions()[0].text), 'the group that leaves the workspace is not offered');
            assert.equal(rig.picks[0].items.length, 1, 'only the good group is listed');
            assert.deepEqual(questions()[0].buttons.slice(1), ['Start', 'Start and do not ask again for this group']);
            assert.equal((await titles()).length, 1, 'no answer: no terminal');

            // Start and do not ask again
            answer = 'Start and do not ask again for this group';
            await rig.command('openconsole.launchGroup');
            await waitUntil(async () => (await titles()).length === 3, 'the two terminals of the group');
            assert.deepEqual((await titles()).slice(1), ['api', 'web']);
            const ids = await page.evaluate('Array.from(window.__openconsole.terminals.keys())');
            await waitUntil(async () => /MARK_API/.test(await text(ids[1])) && /MARK_WEB/.test(await text(ids[2])), 'the commands to run', 40000);
            assert.match(await text(ids[2]), /sub> /, 'the second terminal started in its folder');
            assert.equal(await page.evaluate(`document.querySelector('#list .item[data-id="${ids[2]}"]').dataset.color`), 'green', 'and wears its colour');

            // the same group again: not asked again
            const before = questions().length;
            await rig.command('openconsole.launchGroup');
            await waitUntil(async () => (await titles()).length === 5, 'the group started again');
            assert.equal(questions().length, before, 'an approved group is not asked about again');

            // a changed command is a new question
            fs.writeFileSync(path.join(dir, '.openconsole', 'groups.json'), JSON.stringify({ groups: [{ name: 'dev', terminals: [{ name: 'api', cwd: '.', command: 'echo MARK_CHANGED' }] }] }));
            answer = undefined;
            await rig.command('openconsole.launchGroup');
            assert.equal(questions().length, before + 1, 'the commands of the group changed: the user is asked again');
            assert.match(questions()[before].text, /MARK_CHANGED/);
        }, { width: 1000, height: 400 });
    }
    finally { rig.close(); await sleep(800); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a shell holds it */ } }
});

test('a fresh git worktree for an agent: a new branch and folder, a terminal named after it that starts in that folder with the start command; it can be removed again', { skip: skipReason, timeout: 150000 }, async (t) => {
    const { execFileSync } = require('node:child_process');
    try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { return t.skip('git is not installed'); }
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-wt-'));
    const repo = path.join(base, 'repo');
    fs.mkdirSync(repo);
    const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', env: Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: path.join(base, 'empty-gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }) });
    fs.writeFileSync(path.join(base, 'empty-gitconfig'), '');
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git('add', '.');
    git('commit', '-q', '-m', 'first');
    const rig = await startRig({ folders: [repo], settings: { 'worktree.startCommand': 'echo MARK_WT' }, input: () => 'Agent One', pick: (items) => items[0] });
    try {
        await withPage(rig.url('panel'), async (page) => {
            await waitUntil(() => hasPrompt(page, 1), 'the prompt');
            const titles = () => page.evaluate('Array.from(window.__openconsole.terminals.values()).map((t) => t.title)');
            const text = (id) => page.evaluate(`(() => { const b = window.__openconsole.terminals.get(${id}).term.buffer.active; let s = ''; for (let i = 0; i < b.length; i++) s += b.getLine(i).translateToString(true) + ' | '; return s; })()`);
            await rig.command('openconsole.newWorktreeTerminal');
            await waitUntil(async () => (await titles()).length === 2, 'the terminal of the worktree');
            assert.equal((await titles())[1], 'wt agent-one');
            const listed = git('worktree', 'list', '--porcelain');
            assert.match(listed, /branch refs\/heads\/oc\/agent-one/);
            const folder = /worktree (.*agent-one)\r?\n/.exec(listed)[1].replace(/\//g, path.sep);
            assert.ok(fs.existsSync(path.join(folder, 'a.txt')), 'the worktree has the files of the repository');
            const id = (await page.evaluate('Array.from(window.__openconsole.terminals.keys())'))[1];
            await waitUntil(async () => /MARK_WT/.test(await text(id)), 'the start command to run', 40000);
            assert.ok((await text(id)).toLowerCase().includes('agent-one>'), 'the shell is in the folder of the worktree: ' + (await text(id)).slice(0, 200));
            assert.ok(rig.shown.some((m) => /branch oc\/agent-one/.test(m.text)), 'the user is told where it is');

            // not a repository: said so
            // remove it: first end the terminal that is in that folder (Windows cannot delete a folder that a process is in)
            await page.evaluate(`document.querySelector('#list .item[data-id="${id}"] .close').click()`);
            await waitUntil(async () => (await titles()).length === 1, 'the terminal to close');
            await sleep(1500);
            rig.picks.length = 0;
            await rig.command('openconsole.removeWorktree');
            assert.equal(rig.picks.length, 1);
            assert.equal(rig.picks[0].items[0].label, 'oc/agent-one');
            assert.equal(rig.picks[0].items[0].description, 'no changes');
            await waitUntil(() => !/agent-one/.test(git('worktree', 'list', '--porcelain')), 'the worktree to be removed', 20000);
            assert.ok(!fs.existsSync(folder), 'its folder is gone');
            assert.ok(!/oc\/agent-one/.test(git('branch', '--list')), 'and its branch');
        }, { width: 1000, height: 400 });
    }
    finally { rig.close(); await sleep(800); try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* a shell holds it */ } }
});

test('the same terminal in a browser: the real extension, the real server, the real page and a real PowerShell; the owner approves, both sides see and type', { skip: skipReason, timeout: 150000 }, async () => {
    const rig = await startRig({
        pick: (items) => items,
        answer: (text) => (/Share terminals on the web/.test(text) ? 'Continue' : (/wants to open your terminals/.test(text) ? 'Allow typing' : undefined)),
        answer2: 'Copy link',
    });
    const typeInto = async (page, text) => {
        await page.evaluate('window.__ocRemote.term.focus()');
        for (const ch of text) {
            const init = { key: ch, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) };
            await page.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown' }, init));
            await page.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, init));
        }
        await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    };
    const webLines = (page) => page.evaluate("(() => { const b = window.__ocRemote.term.buffer.active; const out = []; for (let i = 0; i < b.length; i++) out.push(b.getLine(i).translateToString(true)); return out.join(' | '); })()");
    try {
        await withPage(rig.url('panel'), async (owner) => {
            await waitUntil(() => hasPrompt(owner, 1), 'the prompt of the owner');
            await rig.command('openconsole.web.share');
            const warned = rig.shown.filter((m) => m.kind === 'warning' && /Share terminals on the web/.test(m.text));
            assert.equal(warned.length, 1, 'the first time the owner is told what sharing means');
            assert.ok(rig.statusItems.some((i) => /broadcast/.test(i.text) && i.visible), 'the status bar shows that something is shared');
            const link = rig.clipboardWrites[0];
            assert.match(link, /^http:\/\/127\.0\.0\.1:\d+\/#p=[A-Za-z0-9_-]{40,}$/);
            assert.ok(!rig.shown.some((m) => link.split('#p=')[1] && m.text.includes(link.split('#p=')[1])), 'the secret is never shown in a message');

            await withPage(link, async (web) => {
                await waitUntil(async () => /PS .*>/.test(await webLines(web)), 'the prompt, replayed to the browser', 30000);
                const approvals = rig.shown.filter((m) => /wants to open your terminals/.test(m.text));
                assert.equal(approvals.length, 1, 'the owner was asked');
                assert.deepEqual(approvals[0].buttons, ['Allow viewing', 'Allow typing', 'Deny']);
                assert.equal(await web.evaluate('window.__ocRemote.canWrite'), true, 'the owner allowed typing');
                assert.ok(rig.shown.some((m) => /is connected \(it can type\)/.test(m.text)), 'the owner is told that it connected');
                assert.equal(await web.evaluate('location.hash'), '', 'the secret left the address bar');

                // typed in the browser: runs in the real shell, both see it
                await typeInto(web, 'echo FROM_WEB_' + (1000 + (process.pid % 1000)));
                const mark = 'FROM_WEB_' + (1000 + (process.pid % 1000));
                await waitUntil(async () => (await lines(owner, 1)).some((l) => l.endsWith(':' + mark) || l === mark), 'the owner sees the output of what the browser typed', 30000);
                await waitUntil(async () => (await webLines(web)).split(' | ').some((l) => l === mark), 'the browser sees its own output');

                // typed by the owner: the browser sees it
                await rig.command('openconsole.sendText', 'echo FROM_OWNER_4242\r');
                await waitUntil(async () => (await webLines(web)).split(' | ').some((l) => l === 'FROM_OWNER_4242'), 'the browser sees what the owner typed', 30000);

                // the size is the owner's
                const ownerSize = await owner.evaluate('window.__openconsole.term.cols + "x" + window.__openconsole.term.rows');
                assert.equal(await web.evaluate('window.__ocRemote.term.cols + "x" + window.__ocRemote.term.rows'), ownerSize);

                // the link is used up: a second browser with the same link is refused
                const again = await fetch(link.split('#')[0] + 'api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(link).origin }, body: JSON.stringify({ secret: link.split('#p=')[1], label: 'again' }) });
                assert.equal(again.status, 403, 'the link works once');

                // stop: the browser is cut off and the port is closed
                await rig.command('openconsole.web.stop');
                await waitUntil(async () => !(await web.evaluate('window.__ocRemote.connection.socket === 1')), 'the browser to be disconnected', 20000);
                let refused = false;
                try { await fetch(new URL(link).origin + '/', { signal: AbortSignal.timeout(3000) }); } catch { refused = true; }
                assert.equal(refused, true, 'nothing listens any more');
            }, { width: 900, height: 420 });
        }, { width: 1000, height: 400 });
    }
    finally { rig.close(); }
});

test('the web button of the toolbar: the first click starts sharing, the next one opens the menu of the sharing', { skip: skipReason, timeout: 90000 }, async () => {
    const rig = await startRig({
        pick: (items, o) => (o && /Which terminals/.test(o.placeHolder) ? items : undefined),
        answer: (text) => (/Share terminals on the web/.test(text) ? 'Continue' : undefined),
    });
    try {
        await withPage(rig.url('panel'), async (page) => {
            await waitUntil(() => hasPrompt(page, 1), 'the prompt');
            await rig.command('openconsole.panel.web');
            assert.ok(rig.shown.some((m) => m.kind === 'warning' && /Share terminals on the web/.test(m.text)), 'the first click asks and starts the sharing');
            assert.ok(rig.statusItems.some((i) => /broadcast/.test(i.text) && i.visible), 'and the status bar says that it is on');
            rig.picks.length = 0;
            await rig.command('openconsole.panel.web');
            assert.equal(rig.picks.length, 1, 'the next click opens a menu');
            assert.match(rig.picks[0].options.placeHolder, /Sharing terminals on the web/);
            assert.deepEqual(rig.picks[0].items.map((i) => i.id), ['openconsole.web.newLink', 'openconsole.web.devices', 'openconsole.web.share', 'openconsole.web.stop']);
            await rig.command('openconsole.web.stop');
        }, { width: 900, height: 320 });
    }
    finally { rig.close(); }
});
