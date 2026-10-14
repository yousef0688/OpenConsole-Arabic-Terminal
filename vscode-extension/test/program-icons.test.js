'use strict';
// Which icon a terminal gets in the list (media/program-icons.js), and that every icon it can name is in the theme that the build copies.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pick, shellIcon, programName, NAMES, CUSTOM, AGENTS, PROGRAMS } = require('../media/program-icons');

test('an agent wins over the programs, the programs over the shell', () => {
    assert.equal(pick({ agent: 'claude', programs: ['node.exe'], title: 'powershell' }), 'claude');
    assert.equal(pick({ agent: 'gemini', programs: [], title: 'powershell' }), 'gemini-ai');
    assert.equal(pick({ agent: 'opencode', programs: ['node.exe'] }), 'opencode');
    assert.equal(pick({ agent: 'pi', programs: ['node.exe'], title: 'powershell' }), 'pi', 'pi runs as node.exe: its own icon, not the one of Node.js');
    assert.equal(pick({ agent: 'shell', programs: ['node.exe'], title: 'powershell' }), 'nodejs');
    assert.equal(pick({ agent: 'shell', programs: ['PYTHON.EXE'], title: 'Git Bash' }), 'python');
    assert.equal(pick({ agent: 'shell', programs: ['ping.exe', 'git.exe'], title: 'powershell' }), 'git', 'the first program that has an icon');
    assert.equal(pick({ agent: 'shell', programs: ['ping.exe'], title: 'powershell' }), 'powershell', 'a program without an icon leaves the shell');
});

test('the kinds of shell', () => {
    assert.equal(shellIcon('powershell'), 'powershell');
    assert.equal(shellIcon('PowerShell 7'), 'powershell');
    assert.equal(shellIcon('pwsh'), 'powershell');
    assert.equal(shellIcon('Git Bash'), 'git');
    assert.equal(shellIcon('Command Prompt'), 'console');
    assert.equal(shellIcon('cmd'), 'console');
    assert.equal(shellIcon('Ubuntu (WSL)'), 'console');
    assert.equal(shellIcon('my shell'), null, 'a kind that is not known keeps the plain terminal icon');
    assert.equal(shellIcon(''), null);
    assert.equal(shellIcon(undefined), null);
});

test('programs are told by their name, without .exe or .cmd, in any case', () => {
    assert.equal(programName('Node.EXE'), 'node');
    assert.equal(programName('npm.cmd'), 'npm');
    assert.equal(programName(undefined), '');
    assert.equal(pick({ programs: ['npx.cmd'] }), 'npm');
    assert.equal(pick({ programs: ['docker-compose.exe'] }), 'docker');
    assert.equal(pick({ programs: ['cargo.exe'] }), 'rust');
    assert.equal(pick({ programs: ['dotnet.exe'] }), 'csharp');
    assert.equal(pick({ programs: ['nvim.exe'] }), 'vim');
});

test('nothing known: no icon, and odd input does not break it', () => {
    assert.equal(pick(), null);
    assert.equal(pick({}), null);
    assert.equal(pick({ programs: 'node.exe', title: 5 }), null);
    assert.equal(pick({ agent: 'toString', programs: ['constructor'], title: '__proto__' }), null, 'names of the object itself are not icons');
});

test('every icon that can be chosen is in the theme package, and the licence is kept', () => {
    const iconsDir = path.join(__dirname, '..', 'node_modules', 'material-icon-theme', 'icons');
    if (!fs.existsSync(iconsDir)) return;                                   // "npm install" has not run: the build says so
    const chosen = new Set([...Object.values(AGENTS), ...Object.values(PROGRAMS), 'powershell', 'git', 'console'].filter((name) => !CUSTOM.includes(name)));
    for (const name of chosen) {
        assert.ok(NAMES.includes(name), name + ' is in the list that the build copies');
        assert.ok(fs.existsSync(path.join(iconsDir, name + '.svg')), name + '.svg is in the theme');
    }
    const license = path.join(__dirname, '..', 'node_modules', 'material-icon-theme', 'LICENSE');
    assert.match(fs.readFileSync(license, 'utf8'), /MIT License/);
});

test('pi has an icon of its own (the theme has none), and it is a picture, not a script', () => {
    const file = fs.readFileSync(path.join(__dirname, '..', 'media', 'custom-icons.js'), 'utf8');
    const window = {};
    new Function('window', file)(window);
    for (const name of CUSTOM) {
        assert.ok(window.OCCustomIcons[name], name + ' is drawn');
        assert.match(window.OCCustomIcons[name], /^<svg viewBox="0 0 16 16">/);
        assert.ok(!/script|on\w+=/i.test(window.OCCustomIcons[name]), 'no script in the picture');
        assert.ok(!NAMES.includes(name), 'not asked from the theme package');
    }
});
