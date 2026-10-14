'use strict';
// What a terminal is doing (media/agent-state.js) and what its screen says (media/agent-rules.js): the stories are played with a clock
// that the test moves by hand.
const test = require('node:test');
const assert = require('node:assert/strict');
const { OCAgentState, kindOfPrograms, kindOfTitle } = require('../media/agent-state.js');
const { classify, RULES } = require('../media/agent-rules.js');

const SECOND = 1000;
const reasons = (events) => events.map((e) => e.reason);

test('the agent that runs is told from the programs under the shell, or from the title', () => {
    assert.equal(kindOfPrograms(['node.exe', 'claude.exe']), 'claude');
    assert.equal(kindOfPrograms(['OpenCode.EXE']), 'opencode');
    assert.equal(kindOfPrograms(['node.exe', 'git.exe']), null);
    assert.equal(kindOfPrograms([]), null);
    assert.equal(kindOfPrograms(undefined), null);
    assert.equal(kindOfTitle('π - Desktop'), 'pi');
    assert.equal(kindOfTitle('✳ Claude Code'), 'claude');
    assert.equal(kindOfTitle('OpenCode'), 'opencode');
    assert.equal(kindOfTitle('npm run dev'), null);
    assert.equal(kindOfTitle(''), null);
});

test('a plain program: running while it runs, "done" when a long one ends and nobody looked, nothing for a short one', () => {
    const a = new OCAgentState({ minWorkMs: 15 * SECOND });
    assert.equal(a.view().state, 'idle');
    assert.equal(a.view().attention, false);

    a.program(true, null, 0);
    assert.equal(a.view().state, 'running');
    a.output(2 * SECOND);
    assert.equal(a.view().state, 'running', 'a program that is quiet is still running (a server)');
    const events = a.program(false, null, 20 * SECOND);
    assert.deepEqual(reasons(events), ['done'], 'it ran 20 s: worth a notification');
    assert.equal(a.view().state, 'done');
    assert.equal(a.view().attention, true);
    assert.equal(a.tick(60 * SECOND).length, 0, 'told once');
    a.looked(61 * SECOND);
    assert.equal(a.view().state, 'idle');
    assert.equal(a.view().attention, false);

    // a short one
    a.program(true, null, 100 * SECOND);
    const short = a.program(false, null, 103 * SECOND);
    assert.deepEqual(short, []);
    assert.equal(a.view().state, 'idle');
    assert.equal(a.view().attention, false);
});

test('an agent: working while its output flows, waiting for you when it is quiet, "done" when it worked long', () => {
    const a = new OCAgentState({ minWorkMs: 15 * SECOND });
    a.program(true, 'claude', 0);
    for (let t = 0; t <= 30 * SECOND; t += 200) a.output(t);          // the spinner of the agent
    assert.equal(a.view().state, 'working');
    assert.equal(a.view().kind, 'claude');

    assert.deepEqual(a.tick(31 * SECOND), [], 'a moment of quiet is not the end');
    assert.equal(a.view().state, 'working');
    const events = a.tick(32 * SECOND);                              // 2 s without output
    assert.deepEqual(reasons(events), ['done']);
    assert.equal(a.view().state, 'done', 'it worked for 30 s and nobody looked: done');
    assert.equal(a.view().attention, true);

    a.looked(33 * SECOND);
    assert.equal(a.view().state, 'waiting', 'now it only waits for you');
    assert.equal(a.view().attention, false);

    // it works again, but briefly
    a.output(40 * SECOND);
    assert.equal(a.view().state, 'working');
    assert.deepEqual(a.tick(45 * SECOND), []);
    assert.equal(a.view().state, 'waiting', 'a short job is not worth a notification');
    assert.equal(a.view().attention, false);
});

test('a question on the screen: blocked after a short dwell, told once, and gone when the screen changes', () => {
    const a = new OCAgentState();
    a.program(true, 'claude', 0);
    a.output(0);
    const question = { state: 'blocked', id: 'claude-permission' };
    assert.deepEqual(a.observe(question, 1000), []);
    assert.notEqual(a.view().state, 'blocked', 'not yet: it must stay for 300 ms');
    assert.deepEqual(reasons(a.tick(1400)), ['blocked']);
    assert.equal(a.view().state, 'blocked');
    assert.equal(a.view().attention, true);
    assert.match(a.view().evidence, /claude-permission/);
    assert.deepEqual(a.observe(question, 2000), [], 'the same question again: no second event');
    assert.deepEqual(a.tick(5000), []);

    a.looked(5100);
    assert.equal(a.view().state, 'blocked', 'the question is still there');
    assert.equal(a.view().attention, false, 'but it has been seen');

    a.observe(null, 6000);
    a.output(6000);
    assert.equal(a.view().state, 'working');
    // a new question is a new event
    a.observe(question, 7000);
    assert.deepEqual(reasons(a.tick(7500)), ['blocked']);
    assert.equal(a.view().attention, true);
});

test('what the screen says about work counts when no report speaks: "esc to interrupt" is working even when the output is quiet', () => {
    const a = new OCAgentState();
    a.program(true, 'opencode', 0);
    a.output(0);
    a.observe({ state: 'working', id: 'opencode-interrupt' }, 100);
    a.tick(10 * SECOND);
    assert.equal(a.view().state, 'working');
    a.observe(null, 11 * SECOND);
    assert.equal(a.view().state, 'waiting');
});

test('a report of the program (OSC 7501, 9;4, 133) is trusted before the screen and the silence, for a while', () => {
    const a = new OCAgentState({ minWorkMs: 1 * SECOND });
    a.program(true, 'pi', 0);
    a.osc(7501, 'state=working', 1000);
    assert.equal(a.view().state, 'working');
    a.tick(20 * SECOND);
    assert.equal(a.view().state, 'working', 'quiet, but the program said that it works');
    assert.match(a.view().evidence, /report/);
    assert.deepEqual(reasons(a.osc(7501, 'state=done', 21 * SECOND)), ['done']);
    assert.equal(a.view().state, 'done');
    a.looked(22 * SECOND);
    assert.equal(a.view().state, 'waiting');

    a.osc(7501, 'state=blocked:kind=permission', 30 * SECOND);
    assert.equal(a.view().state, 'blocked');
    assert.equal(a.view().attention, true);
    a.osc(7501, 'state=clear', 31 * SECOND);
    assert.notEqual(a.view().state, 'blocked');

    // a report that was never followed is not trusted for ever
    a.osc(7501, 'state=working', 40 * SECOND);
    a.tick(40 * SECOND + 100 * SECOND);
    assert.equal(a.view().state, 'done', 'after 90 s without a word the quiet screen decides: the work that was reported is over, and nobody looked');
    a.looked(40 * SECOND + 101 * SECOND);
    assert.equal(a.view().state, 'waiting');

    // the progress bar of the terminal and the end of a command
    const b = new OCAgentState({ minWorkMs: 1 * SECOND });
    b.program(true, 'claude', 0);
    b.osc(9, '4;3', 100);
    assert.equal(b.view().state, 'working');
    assert.deepEqual(reasons(b.osc(9, '4;0', 5 * SECOND)), ['done']);
    b.osc(133, 'C', 6 * SECOND);
    assert.equal(b.view().state, 'working');
    b.osc(133, 'D;0', 9 * SECOND);
    assert.equal(b.view().state, 'done');
    // an error
    assert.deepEqual(reasons(b.osc(7501, 'state=error', 10 * SECOND)), ['error']);
    assert.equal(b.view().state, 'error');
    assert.equal(b.view().attention, true);
    // the message of a report (base64)
    b.osc(7501, 'state=done:msg=' + Buffer.from('All tests pass').toString('base64'), 11 * SECOND);
    assert.equal(b.view().message, 'All tests pass');
    // other sequences are none of our business
    assert.deepEqual(b.osc(9, 'a notification', 12 * SECOND), []);
});

test('the process of the shell ends: exited, and told when it ran long or failed', () => {
    const a = new OCAgentState({ minWorkMs: 10 * SECOND });
    a.program(true, null, 0);
    const events = a.exit(1, 30 * SECOND);
    assert.deepEqual(reasons(events), ['exited']);
    assert.equal(a.view().state, 'exited');
    assert.equal(a.view().exitCode, 1);
    assert.equal(a.view().attention, true);

    const quiet = new OCAgentState({ minWorkMs: 10 * SECOND });
    assert.deepEqual(quiet.exit(0, 2 * SECOND), [], 'a shell that was never busy and ends cleanly: nothing to tell');
    assert.equal(quiet.view().state, 'exited');

    a.reset(40 * SECOND);
    assert.equal(a.view().state, 'idle', 'a restart starts again');
    assert.equal(a.view().attention, false);
});

test('a program that ends takes its agent and its reports with it', () => {
    const a = new OCAgentState({ minWorkMs: 1 * SECOND });
    a.program(true, 'claude', 0);
    a.osc(7501, 'state=blocked', 100);
    a.observe({ state: 'working', id: 'x' }, 100);
    a.program(false, null, 5 * SECOND);
    assert.equal(a.view().kind, 'shell');
    assert.notEqual(a.view().state, 'blocked');
    assert.notEqual(a.view().state, 'working');
});

// ---- the rules of the screen -------------------------------------------------------------------------------------------------------

const rows = (text) => text.split('\n');

test('rules: Claude Code works while "esc to interrupt" is on the screen and asks when it shows the numbered question', () => {
    const working = rows('✻ Pondering… (12s · ↓ 1.2k tokens · esc to interrupt)\n\n╭────╮\n│ > │\n╰────╯');
    assert.deepEqual(classify('claude', working), { state: 'working', id: 'claude-interrupt' });

    const asks = rows([
        ' Bash command', '', '   npm test', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. Yes, and don\'t ask again for npm test commands', '   3. No, and tell Claude what to do differently (esc)',
    ].join('\n'));
    assert.deepEqual(classify('claude', asks), { state: 'blocked', id: 'claude-permission' });

    const idle = rows('╭──╮\n│ > │\n╰──╯\n  ? for shortcuts');
    assert.equal(classify('claude', idle), null);
    assert.equal(classify('claude', []), null);
});

test('rules: a question outranks the work, and old text far above the bottom does not count', () => {
    const both = rows('esc to interrupt\n\nDo you want to proceed?\n❯ 1. Yes\n  2. No');
    assert.equal(classify('claude', both).state, 'blocked');

    const old = ['Do you want to proceed?', '❯ 1. Yes', '  2. No'];
    for (let i = 0; i < 40; i++) old.push('log line ' + i);
    assert.equal(classify('claude', old), null, 'the question scrolled away: more than 30 rows above the bottom');
});

test('rules: opencode, Codex and Gemini', () => {
    assert.equal(classify('opencode', rows('△ Permission required\n  Edit src/app.js')).state, 'blocked');
    assert.equal(classify('opencode', rows('  esc interrupt  ctrl+p commands')).state, 'working');
    assert.equal(classify('codex', rows('Allow command? [y/n]')).state, 'blocked');
    assert.equal(classify('codex', rows('• Working (3s • esc to interrupt)')).state, 'working');
    assert.equal(classify('gemini', rows('│ Apply this change?\n│ 1. Yes')).state, 'blocked');
    assert.equal(classify('gemini', rows('⠋ Thinking... (esc to cancel, 4s)')).state, 'working');
});

test('rules: the rules of an agent do not apply to another one', () => {
    assert.equal(classify('shell', rows('✻ Pondering… esc to interrupt')), null, 'a shell has no agent rules');
    assert.equal(classify('gemini', rows('△ Permission required')), null);
});

test('rules: any program that asks on its last line is blocked', () => {
    assert.equal(classify('shell', rows('Install the package? [y/N]')).state, 'blocked');
    assert.equal(classify('shell', rows('Do you want to continue? (y/n)')).state, 'blocked');
    assert.equal(classify('shell', rows('Press any key to continue . . .')).state, 'blocked');
    assert.equal(classify('shell', rows('Overwrite file (yes/no)?')).state, 'blocked');
    assert.equal(classify('shell', rows('Proceed?')).state, 'blocked');
    assert.equal(classify('shell', rows('compiling...\nwatching for changes')), null);
    assert.equal(classify('shell', rows('the [y/n] option is explained here, and more text follows it\nnext line\nthird line')), null, 'only the last two rows');
});

test('rules: the rules of the user come first, and one that is not a regular expression is skipped', () => {
    const mine = [{ id: 'my-wait', state: 'blocked', any: ['waiting for review'] }, { id: 'broken', state: 'blocked', any: ['(unclosed'] }];
    assert.deepEqual(classify('pi', rows('...\nWaiting for review'), mine), { state: 'blocked', id: 'my-wait' });
    assert.equal(classify('pi', rows('nothing special'), mine), null);
    const override = [{ id: 'not-really', kind: 'claude', state: 'working', priority: 2000, any: ['do you want'] }];
    assert.equal(classify('claude', rows('Do you want to proceed?\n❯ 1. Yes'), override).id, 'not-really');
    assert.equal(classify('claude', rows('esc to interrupt'), 'not a list').id, 'claude-interrupt');
});

test('rules: every rule is well formed and its expressions compile', () => {
    for (const rule of RULES) {
        assert.ok(rule.id && rule.kind && ['working', 'blocked'].includes(rule.state) && rule.priority > 0 && rule.region > 0, JSON.stringify(rule));
        for (const source of [...(rule.all || []), ...(rule.any || [])]) assert.doesNotThrow(() => new RegExp(source, 'i'), rule.id + ': ' + source);
        assert.ok((rule.all || []).length + (rule.any || []).length > 0, rule.id + ' has no expression');
    }
    assert.equal(new Set(RULES.map((r) => r.id)).size, RULES.length, 'the ids are unique');
});
