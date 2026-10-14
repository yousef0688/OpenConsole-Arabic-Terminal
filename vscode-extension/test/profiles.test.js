'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { detectProfiles, findOnPath } = require('../src/profiles');

test('the kinds of terminal of Windows are found', async () => {
    const profiles = await detectProfiles({ wsl: [] });
    const byName = Object.fromEntries(profiles.map((p) => [p.name, p]));
    assert.ok(byName['PowerShell'], 'Windows PowerShell');
    assert.equal(byName['PowerShell'].path, 'powershell.exe');
    assert.deepEqual(byName['PowerShell'].args, ['-NoLogo']);
    assert.ok(byName['Command Prompt'], 'Command Prompt');
    assert.match(byName['Command Prompt'].path, /cmd\.exe$/i);
    assert.deepEqual(byName['Command Prompt'].args, []);
    for (const p of profiles) assert.ok(p.name && p.path && Array.isArray(p.args), JSON.stringify(p));
    assert.equal(new Set(profiles.map((p) => p.name.toLowerCase())).size, profiles.length, 'no name twice');
});

test('WSL distributions become profiles that start that distribution', async () => {
    const profiles = await detectProfiles({ wsl: ['Ubuntu', 'Debian'] });
    const ubuntu = profiles.find((p) => p.name === 'Ubuntu (WSL)');
    assert.ok(ubuntu);
    assert.match(ubuntu.path, /wsl\.exe$/i);
    assert.deepEqual(ubuntu.args, ['-d', 'Ubuntu']);
    assert.deepEqual(profiles.find((p) => p.name === 'Debian (WSL)').args, ['-d', 'Debian']);
});

test('the profiles of the user in VS Code: those with a path are kept, the others are left out', async () => {
    const cmd = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
    const profiles = await detectProfiles({
        wsl: [],
        custom: {
            'My Shell': { path: cmd, args: ['/k', 'echo hi'] },
            'Listed Twice': { path: [path.join(os.tmpdir(), 'does-not-exist.exe'), cmd] },
            'Command Prompt': { path: cmd, args: ['/q'] },                              // the name is taken: the found one stays
            'PowerShell': { source: 'PowerShell' },                                     // VS Code finds it itself
            'OpenConsole (new window)': { path: 'C:\\Tools\\OpenConsole.exe' },         // it would only open another window
            'JavaScript Debug Terminal': { extensionIdentifier: 'ms-vscode.js-debug' },  // made by an extension, no path
            'Broken': null,
        },
    });
    const names = profiles.map((p) => p.name);
    assert.ok(names.includes('My Shell'));
    assert.deepEqual(profiles.find((p) => p.name === 'My Shell').args, ['/k', 'echo hi']);
    assert.equal(profiles.find((p) => p.name === 'Listed Twice').path, cmd, 'the first path that exists is used');
    assert.deepEqual(profiles.find((p) => p.name === 'Command Prompt').args, [], 'the detected Command Prompt was not replaced');
    for (const left of ['OpenConsole (new window)', 'JavaScript Debug Terminal', 'Broken']) assert.ok(!names.includes(left), left + ' is not offered');
    assert.equal(names.filter((n) => n === 'PowerShell').length, 1);
});

test('a program is looked up in PATH', () => {
    const dir = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    assert.equal(findOnPath('cmd.exe', { PATH: ['', 'C:\\does\\not\\exist', `"${dir}"`].join(path.delimiter) }), path.join(dir, 'cmd.exe'));
    assert.equal(findOnPath('no-such-program.exe', { PATH: dir }), null);
});
