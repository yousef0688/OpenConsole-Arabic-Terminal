'use strict';
// The logic of media/suggest.js that does not need a terminal: where the typed text starts, which command is suggested.
const test = require('node:test');
const assert = require('node:assert/strict');
require('../media/suggest.js');
const { typedCandidates, findSuggestion, promptDirectory, continuesRtlRun } = globalThis.OCSuggest;

test('what was typed starts after the prompt: PowerShell, cmd, bash', () => {
    assert.deepEqual(typedCandidates('PS C:\\Users\\me> echo he').map((c) => c.typed), ['echo he']);
    assert.deepEqual(typedCandidates('C:\\Users\\me>dir /b').map((c) => c.typed), ['dir /b'], 'cmd has no space after the >');
    assert.deepEqual(typedCandidates('me@pc:~/src$ git st').map((c) => c.typed), ['git st']);
    assert.deepEqual(typedCandidates('root@pc:/# ls').map((c) => c.typed), ['ls']);
    assert.deepEqual(typedCandidates('PS C:\\> ').map((c) => c.typed), [], 'nothing typed yet');
    assert.deepEqual(typedCandidates('no prompt here').map((c) => c.typed), []);
    // a > that is part of the command gives one more candidate, after the first one
    assert.deepEqual(typedCandidates('PS C:\\> echo hi > out').map((c) => c.typed), ['echo hi > out', 'out']);
});

test('the newest command that starts with what was typed is suggested, the rest of it', () => {
    const history = ['git status', 'echo hello world', 'dir', 'echo hello there'];
    assert.deepEqual(findSuggestion('PS C:\\> echo he', history), { typed: 'echo he', suffix: 'llo there', command: 'echo hello there' });
    assert.equal(findSuggestion('PS C:\\> echo hello w', history).suffix, 'orld');
    assert.equal(findSuggestion('PS C:\\> git', history).suffix, ' status');
    assert.equal(findSuggestion('PS C:\\> ECHO he', history).suffix, 'llo there', 'capitals do not matter for the match');
    assert.equal(findSuggestion('PS C:\\> dir', history), null, 'a command that is complete already is not suggested again');
    assert.equal(findSuggestion('PS C:\\> nothing like it', history), null);
    assert.equal(findSuggestion('PS C:\\> ', history), null);
    assert.equal(findSuggestion('PS C:\\> echo he', []), null);
    assert.equal(findSuggestion('PS C:\\> e', ['echo a']).suffix, 'cho a', 'one letter is enough');
});

test('the first prompt character wins, so a > inside the command does not confuse it', () => {
    const history = ['echo hi > out.txt', 'out something'];
    assert.equal(findSuggestion('PS C:\\> echo hi > ou', history).suffix, 't.txt');
    assert.equal(findSuggestion('PS C:\\> echo hi > ', history).suffix, 'out.txt', 'after "> " the first candidate is the whole text, so the command is found');
});

test('Arabic commands are suggested too', () => {
    const history = ['echo "\u0627\u0644\u0633\u0644\u0627\u0645 \u0639\u0644\u064a\u0643\u0645"'];
    const found = findSuggestion('PS C:\\> echo "\u0627\u0644\u0633', history);
    assert.equal(found.suffix, '\u0644\u0627\u0645 \u0639\u0644\u064a\u0643\u0645"');
});

test('no suggestion that goes on in an Arabic or Hebrew word: it would be on the wrong side of the cursor', () => {
    const mar = 'مر', haba = 'حبا';
    assert.equal(continuesRtlRun('echo "' + mar, haba + ' بالعالم"'), true, 'the word goes on');
    assert.equal(continuesRtlRun('echo "' + mar + ' ', haba), true, 'a new word after a space is the same right-to-left run');
    assert.equal(continuesRtlRun('echo "' + mar, '" hello'), false, 'the quote and the English after the word are to its right');
    assert.equal(continuesRtlRun('echo he', 'llo ' + mar), false, 'English typed: the rest is laid out to its right');
    assert.equal(continuesRtlRun('echo "' + mar + '" he', 'llo'), false);
    assert.equal(continuesRtlRun('dir', ' /b'), false);
    assert.equal(continuesRtlRun('echo 123', ' ' + mar), false, 'digits have no direction of their own');
    assert.equal(continuesRtlRun('echo "של', 'ום"'), true, 'Hebrew too');
});

test('the folder that a prompt shows', () => {
    assert.equal(promptDirectory('PS C:\\Users\\me\\My Documents> '), 'C:\\Users\\me\\My Documents');
    assert.equal(promptDirectory('PS C:\\> '), 'C:\\');
    assert.equal(promptDirectory('C:\\Users\\me>'), 'C:\\Users\\me');
    assert.equal(promptDirectory('PS \\\\server\\share\\x> '), '\\\\server\\share\\x');
    assert.equal(promptDirectory('PS Registry::HKEY_CURRENT_USER> '), null, 'not a folder');
    assert.equal(promptDirectory('me@pc:~$ '), null);
});
