'use strict';
// What the terminals ask of the user, on the side of the extension (src/attention.js): the status bar item, the notifications and their
// cooldown, the order of the list. Everything the tracker needs from the editor is a stand-in here.
const test = require('node:test');
const assert = require('node:assert/strict');
const { AttentionTracker, label, COOLDOWN_MS } = require('../src/attention');

function make(settings = {}) {
    const log = { notices: [], shown: [], items: [] };
    let clock = 1_000_000;
    let answer;                                   // what the user clicks on the next notification
    const api = {
        now: () => clock,
        warningBackground: 'warning',
        settings: () => Object.assign({ notify: 'all', statusBar: true }, settings),
        createStatusBarItem: () => {
            const item = { text: '', tooltip: '', command: '', backgroundColor: undefined, visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() { this.disposed = true; } };
            log.items.push(item);
            return item;
        },
        notify: (kind, text, button) => { log.notices.push({ kind, text, button }); return Promise.resolve(answer); },
        show: (key) => log.shown.push(key),
    };
    const tracker = new AttentionTracker(api);
    return { tracker, log, api, advance: (ms) => { clock += ms; }, click: (what) => { answer = what; } };
}

const state = (over) => Object.assign({ name: 'claude', state: 'blocked', kind: 'claude', attention: true, since: 1_000_000, message: '', exitCode: null, evidence: 'rule' }, over);

test('the status bar item counts the terminals that need a look, and goes when none does', () => {
    const { tracker, log } = make();
    assert.equal(log.items.length, 0, 'nothing to show: no item is even made');
    tracker.state('1:1', state({ state: 'done', name: 'build' }));
    const item = log.items[0];
    assert.equal(item.visible, true);
    assert.equal(item.text, '$(bell) 1');
    assert.equal(item.command, 'openconsole.attentionList');
    assert.equal(item.backgroundColor, undefined, 'done is good news: no warning color');
    tracker.state('1:2', state({ state: 'blocked', name: 'claude' }));
    assert.equal(item.text, '$(bell) 2');
    assert.equal(item.backgroundColor, 'warning', 'a question that waits for you is a warning');
    assert.match(item.tooltip, /build: done/);
    assert.match(item.tooltip, /claude: needs you/);
    tracker.state('1:2', state({ state: 'working', attention: false }));
    assert.equal(item.text, '$(bell) 1');
    assert.equal(item.backgroundColor, undefined);
    tracker.state('1:1', state({ state: 'idle', attention: false }));
    assert.equal(item.visible, false, 'a terminal that was looked at: the item goes');
});

test('the setting statusBar = false keeps the item hidden', () => {
    const { tracker, log } = make({ statusBar: false });
    tracker.state('1:1', state());
    assert.ok(!log.items.length || log.items.every((i) => !i.visible));
});

test('a notification names the terminal and the program, and its button shows the terminal', async () => {
    const { tracker, log, click } = make();
    click('Show');
    assert.equal(tracker.event('2:7', { reason: 'blocked', name: 'claude', kind: 'claude', message: 'Run npm test?' }), 'told');
    assert.equal(log.notices.length, 1);
    assert.equal(log.notices[0].kind, 'warn');
    assert.equal(log.notices[0].text, 'claude (claude) needs you: Run npm test?');
    assert.equal(log.notices[0].button, 'Show');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(log.shown, ['2:7']);
});

test('closing the notification shows nothing', async () => {
    const { tracker, log, click } = make();
    click(undefined);
    tracker.event('2:7', { reason: 'done', name: 'build', kind: 'shell' });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(log.shown, []);
    assert.equal(log.notices[0].kind, 'info');
    assert.equal(log.notices[0].text, 'build is done');
});

test('the same reason for the same terminal is told again only after the cooldown; another reason or terminal at once', () => {
    const { tracker, log, advance } = make();
    assert.equal(tracker.event('1:1', { reason: 'blocked', name: 'a' }), 'told');
    advance(COOLDOWN_MS - 1000);
    assert.equal(tracker.event('1:1', { reason: 'blocked', name: 'a' }), 'cooldown');
    assert.equal(tracker.event('1:1', { reason: 'done', name: 'a' }), 'told', 'another reason');
    assert.equal(tracker.event('1:2', { reason: 'blocked', name: 'b' }), 'told', 'another terminal');
    advance(2000);
    assert.equal(tracker.event('1:1', { reason: 'blocked', name: 'a' }), 'told', 'the cooldown is over');
    assert.equal(log.notices.length, 4);
});

test('the level: off tells nothing, important leaves out "done"', () => {
    const off = make({ notify: 'off' });
    assert.equal(off.tracker.event('1:1', { reason: 'blocked', name: 'a' }), 'off');
    assert.equal(off.log.notices.length, 0);
    const important = make({ notify: 'important' });
    assert.equal(important.tracker.event('1:1', { reason: 'done', name: 'a' }), 'quiet');
    assert.equal(important.tracker.event('1:1', { reason: 'blocked', name: 'a' }), 'told');
    assert.equal(important.tracker.event('1:1', { reason: 'bell', name: 'a', kind: 'claude' }), 'told');
    assert.equal(important.tracker.event('1:1', { reason: 'error', name: 'a' }), 'told');
    assert.equal(important.log.notices.length, 3);
    const odd = make({ notify: 'whatever' });
    assert.equal(odd.tracker.event('1:1', { reason: 'done', name: 'a' }), 'told', 'an unknown level is the default');
});

test('what a program writes is only text in a notification: cut, and unknown reasons are not told', () => {
    const { tracker, log } = make();
    assert.equal(tracker.event('1:1', { reason: 'rm -rf', name: 'a' }), 'quiet');
    tracker.event('1:1', { reason: 'blocked', name: 'x'.repeat(500), message: 'y'.repeat(500) });
    assert.ok(log.notices[0].text.length < 260, log.notices[0].text.length + ' characters');
    assert.equal(tracker.event('1:1', null), 'quiet');
    tracker.state('1:1', null);
    tracker.state('1:1', 'nonsense');
});

test('exit codes: a clean end is information, a failed one a warning', () => {
    const { tracker, log } = make();
    tracker.event('1:1', { reason: 'exited', name: 'shell', exitCode: 0 });
    tracker.event('1:2', { reason: 'exited', name: 'shell', exitCode: 3 });
    assert.deepEqual(log.notices.map((n) => [n.kind, n.text]), [['info', 'shell ended'], ['warn', 'shell ended with code 3']]);
});

test('the list: the terminals that need you come first, those that are blocked before the others, the oldest first', () => {
    const { tracker } = make();
    tracker.state('1:1', state({ name: 'running server', state: 'running', attention: false, since: 10 }));
    tracker.state('1:2', state({ name: 'finished', state: 'done', attention: true, since: 50 }));
    tracker.state('1:3', state({ name: 'asks', state: 'blocked', attention: true, since: 90 }));
    tracker.state('1:4', state({ name: 'asked before', state: 'blocked', attention: true, since: 40 }));
    assert.deepEqual(tracker.all().map((t) => t.name), ['asked before', 'asks', 'finished', 'running server']);
    assert.deepEqual(tracker.needing().map((t) => t.name), ['asked before', 'asks', 'finished']);
    assert.equal(tracker.next(), '1:4');
    tracker.remove('1:4');
    assert.equal(tracker.next(), '1:3');
    tracker.remove('1:3');
    tracker.remove('1:2');
    assert.equal(tracker.next(), null, 'a terminal that only runs does not need you');
});

test('a terminal that is closed is forgotten, with its cooldowns', () => {
    const { tracker, log } = make();
    tracker.state('1:1', state());
    tracker.event('1:1', { reason: 'blocked', name: 'a' });
    tracker.remove('1:1');
    assert.equal(tracker.needing().length, 0);
    assert.equal(log.items[0].visible, false);
    assert.equal(tracker.event('1:1', { reason: 'blocked', name: 'a' }), 'told', 'a new terminal can have the same key: no old cooldown');
});

test('the words for the states', () => {
    assert.equal(label('blocked'), 'needs you');
    assert.equal(label('exited', 2), 'ended (2)');
    assert.equal(label('exited', 0), 'ended');
    assert.equal(label('idle'), '');
});
