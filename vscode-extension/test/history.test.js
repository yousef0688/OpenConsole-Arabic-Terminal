'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CommandHistory, parseHistoryText, readTail } = require('../src/history');

function fakeState(initial = {}) {
    const values = { ...initial };
    return { values, get: (key, fallback) => (key in values ? values[key] : fallback), update: (key, value) => { values[key] = value; return Promise.resolve(); } };
}

test('the history file of PowerShell: newest last, without empty or repeated lines, half commands left out', () => {
    const text = ['dir', '', 'cd C:\\temp', 'dir', 'echo "a" `', 'git status', '  ', 'x'.repeat(500), 'Get-Date'].join('\r\n');
    assert.deepEqual(parseHistoryText(text), ['cd C:\\temp', 'dir', 'git status', 'Get-Date'], 'the older copy of "dir" is dropped, the newer one stays');
});

test('only the last part of a big file is read, and it starts on a whole line', () => {
    const file = path.join(os.tmpdir(), 'oc-history-' + process.pid + '.txt');
    try {
        fs.writeFileSync(file, Array.from({ length: 4000 }, (_, i) => `command number ${i}`).join('\n'));
        const tail = readTail(file, 2000);
        const lines = tail.split('\n');
        assert.ok(lines.length > 50 && lines.length < 200, String(lines.length));
        assert.match(lines[0], /^command number \d+$/, 'no half line at the start');
        assert.equal(lines[lines.length - 1], 'command number 3999');
        assert.equal(readTail(path.join(os.tmpdir(), 'oc-no-such-file-' + process.pid)), '');
    }
    finally { try { fs.unlinkSync(file); } catch { /* not there */ } }
});

test('the commands typed here are the newest, are kept, and are not listed twice', () => {
    const file = path.join(os.tmpdir(), 'oc-history-b-' + process.pid + '.txt');
    try {
        fs.writeFileSync(file, 'old one\nshared\nold two\n');
        const state = fakeState();
        const history = new CommandHistory(state, { file });
        assert.deepEqual(history.all(), ['old one', 'shared', 'old two']);
        assert.equal(history.add('  shared  '), true);
        assert.equal(history.add('brand new'), true);
        assert.equal(history.add('   '), false, 'an empty line is not remembered');
        assert.equal(history.add('x'.repeat(401)), false, 'a pasted script is not remembered');
        assert.deepEqual(history.all(), ['old one', 'old two', 'shared', 'brand new'], 'the copy of the file goes, the typed one is newer');
        assert.deepEqual(state.values['openconsole.commands'], ['shared', 'brand new'], 'kept in the state of the extension');

        // a new session starts from the state
        const again = new CommandHistory(fakeState({ 'openconsole.commands': ['shared', 'brand new'] }), { file });
        assert.deepEqual(again.all(), ['old one', 'old two', 'shared', 'brand new']);

        history.clear();
        assert.deepEqual(history.all(), ['old one', 'shared', 'old two'], 'only what was typed here is forgotten, not the file of PowerShell');
        assert.deepEqual(state.values['openconsole.commands'], []);
    }
    finally { try { fs.unlinkSync(file); } catch { /* not there */ } }
});

test('the own commands are limited, the newest stay', () => {
    const history = new CommandHistory(fakeState(), { file: null });
    for (let i = 0; i < 350; i++) history.add('command ' + i);
    const all = history.all();
    assert.equal(all.length, 300);
    assert.equal(all[0], 'command 50');
    assert.equal(all[299], 'command 349');
});

test('the folders: the newest first, each once, only the ones that exist', () => {
    const real = os.tmpdir();
    const home = os.homedir();
    const state = fakeState();
    const history = new CommandHistory(state, { file: null });
    history.addDirectory(home);
    history.addDirectory('C:\\no\\such\\folder');
    history.addDirectory(real);
    history.addDirectory(home.toUpperCase());                   // the same folder with other capitals: once
    assert.equal(history.addDirectory('  '), false);
    const folders = history.directories();
    assert.equal(folders.length, 2);
    assert.equal(folders[0].toLowerCase(), home.toLowerCase(), 'the newest first');
    assert.equal(folders[1], real);
    assert.ok(!folders.includes('C:\\no\\such\\folder'));
    assert.equal(state.values['openconsole.directories'].length, 3, 'the one that does not exist is kept in the state, only not offered');
});
