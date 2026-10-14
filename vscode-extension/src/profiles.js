'use strict';
// The kinds of terminal that can be started: Windows PowerShell, PowerShell 7, Command Prompt, Git Bash, the WSL distributions, and the
// profiles of the user with a path in the setting terminal.integrated.profiles.windows of VS Code.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const exists = (p) => { try { return !!p && fs.existsSync(p); } catch { return false; } };

/** The first folder of PATH that has the file, or null. */
function findOnPath(name, env = process.env) {
    for (const dir of String(env.PATH || env.Path || '').split(path.delimiter)) {
        if (!dir) continue;
        const candidate = path.join(dir.replace(/^"|"$/g, ''), name);
        if (exists(candidate)) return candidate;
    }
    return null;
}

/** The names of the WSL distributions ("wsl.exe -l -q" writes UTF-16), without the helper ones of Docker. */
function listWslDistributions(system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')) {
    return new Promise((resolve) => {
        const wsl = path.join(system32, 'wsl.exe');
        if (!exists(wsl)) return resolve([]);
        execFile(wsl, ['-l', '-q'], { encoding: 'buffer', windowsHide: true, timeout: 4000 }, (error, stdout) => {
            if (error || !stdout || !stdout.length) return resolve([]);
            const names = stdout.toString('utf16le').replace(/\u0000|\uFEFF/g, '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
            resolve(names.filter((n) => !/^docker-desktop/i.test(n)));
        });
    });
}

/**
 * @param {{custom?: object, env?: object, wsl?: string[]}} [options]
 *   custom: the value of terminal.integrated.profiles.windows; wsl: the distributions (when not given they are asked from wsl.exe)
 * @returns {Promise<{name: string, path: string, args: string[]}[]>}
 */
async function detectProfiles(options = {}) {
    const env = options.env || process.env;
    const system32 = path.join(env.SystemRoot || 'C:\\Windows', 'System32');
    const programFiles = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')].filter(Boolean);
    const profiles = [];
    const add = (name, file, args = []) => {
        if (!file || profiles.some((p) => p.name.toLowerCase() === name.toLowerCase())) return;
        profiles.push({ name, path: file, args });
    };

    if (exists(path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'))) add('PowerShell', 'powershell.exe', ['-NoLogo']);
    const pwsh = [...programFiles.map((dir) => path.join(dir, 'PowerShell', '7', 'pwsh.exe')), findOnPath('pwsh.exe', env)].find(exists);
    if (pwsh) add('PowerShell 7', pwsh, ['-NoLogo']);
    add('Command Prompt', path.join(system32, 'cmd.exe'), []);
    const bash = programFiles.map((dir) => path.join(dir, 'Git', 'bin', 'bash.exe')).find(exists);
    if (bash) add('Git Bash', bash, ['--login', '-i']);
    const distributions = options.wsl || await listWslDistributions(system32);
    for (const name of distributions) add(`${name} (WSL)`, path.join(system32, 'wsl.exe'), ['-d', name]);

    // the profiles of the user in VS Code. The ones with a "source" (VS Code finds the program itself) or without a path, such as the
    // debug terminals of extensions, cannot be started here; OpenConsole itself would only open another window.
    for (const [name, definition] of Object.entries(options.custom || {})) {
        if (!definition || typeof definition !== 'object' || definition.source) continue;
        const candidates = [].concat(definition.path || []).filter((p) => typeof p === 'string');
        const file = candidates.find(exists) || (candidates.length === 1 && !/[\\/]/.test(candidates[0]) ? candidates[0] : null);
        if (!file || /openconsole[^\\/]*\.exe$/i.test(file)) continue;
        const args = Array.isArray(definition.args) ? definition.args.map(String) : (typeof definition.args === 'string' ? [definition.args] : []);
        add(name, file, args);
    }
    return profiles;
}

module.exports = { detectProfiles, listWslDistributions, findOnPath };
