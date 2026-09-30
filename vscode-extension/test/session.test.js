'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { quoteArgument, buildCommandLine, TerminalSession } = require('../src/session');

const BS = '\\';   // one backslash

test('command line quoting follows the rules of CreateProcess', () => {
    assert.equal(quoteArgument('powershell.exe'), 'powershell.exe');
    assert.equal(quoteArgument('-NoLogo'), '-NoLogo');
    assert.equal(quoteArgument(''), '""');
    const program = ['C:', 'Program Files', 'PowerShell', '7', 'pwsh.exe'].join(BS);
    assert.equal(quoteArgument(program), '"' + program + '"');
    assert.equal(quoteArgument('say "hi"'), '"say ' + BS + '"hi' + BS + '""');
    assert.equal(quoteArgument('ends with backslash' + BS), '"ends with backslash' + BS + BS + '"');
    assert.equal(quoteArgument('back' + BS + '"quote'), '"back' + BS + BS + BS + '"quote"');
    assert.equal(buildCommandLine(program, ['-a', 'b c']), '"' + program + '" -a "b c"');
});

test('a session runs a command and reports output, programs and exit', async () => {
    const bridgePath = path.join(__dirname, '..', 'bin', 'conpty-bridge.exe');
    const s = new TerminalSession({ bridgePath, shell: 'cmd.exe', args: ['/c', 'echo', 'from-a-session'], cwd: os.homedir(), columns: 80, rows: 24 });
    let output = '';
    const procs = [];
    s.on('output', (t) => { output += t; });
    s.on('procs', (n) => procs.push(n));
    const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out, output: ' + JSON.stringify(output))), 15000);
        s.on('exit', (c) => { clearTimeout(timer); resolve(c); });
        s.on('error', (e) => { clearTimeout(timer); reject(new Error(e)); });
        s.start();
    });
    assert.equal(code, 0);
    assert.match(output, /from-a-session/);
    assert.ok(procs.length >= 1);
    s.dispose();
});
