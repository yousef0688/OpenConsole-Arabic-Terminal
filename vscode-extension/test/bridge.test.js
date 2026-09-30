'use strict';
// Run with:  node --test test/bridge.test.js      (needs bin/conpty-bridge.exe, see native/build.ps1)
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ToParent, encodeInput, encodeResize, FrameReader } = require('../src/frames');

const bridge = path.join(__dirname, '..', 'bin', 'conpty-bridge.exe');

/** Starts a command in the bridge; returns helpers to send input and to wait for output. */
function start(commandLine, cwd = os.homedir(), columns = 100, rows = 30) {
    const child = spawn(bridge, [String(columns), String(rows), cwd, commandLine], { stdio: ['pipe', 'pipe', 'pipe'] });
    const reader = new FrameReader();
    const state = { output: '', procs: [], exitCode: null, ready: null, error: null, waiters: [] };
    const decoder = new (require('node:string_decoder').StringDecoder)('utf8');
    child.stdout.on('data', (chunk) => {
        for (const f of reader.feed(chunk)) {
            if (f.type === ToParent.OUTPUT) state.output += decoder.write(f.payload);
            else if (f.type === ToParent.EXIT) state.exitCode = f.payload.readUInt32LE(0);
            else if (f.type === ToParent.PROCS) state.procs.push(f.payload.toString('utf8').split('\n').filter(Boolean));
            else if (f.type === ToParent.READY) state.ready = f.payload.readUInt32LE(0);
            else if (f.type === ToParent.ERROR) state.error = f.payload.toString('utf8');
        }
        state.waiters = state.waiters.filter((w) => !w());
    });
    const api = {
        child, state,
        send: (text) => child.stdin.write(encodeInput(text)),
        resize: (c, r) => child.stdin.write(encodeResize(c, r)),
        until(predicate, ms = 15000) {
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('timed out; output so far: ' + JSON.stringify(state.output.slice(-400)))), ms);
                const check = () => { if (predicate(state)) { clearTimeout(timer); resolve(state); return true; } return false; };
                if (!check()) state.waiters.push(check);
            });
        },
        kill: () => child.kill(),
    };
    return api;
}

test('the bridge exists', () => {
    assert.ok(fs.existsSync(bridge), 'build it first: native/build.ps1');
});

test('runs a command, delivers its output and its exit code', async () => {
    const t = start('cmd.exe /c echo hello-from-bridge & exit 7');
    await t.until((s) => s.exitCode !== null);
    assert.ok(t.state.ready > 0, 'READY frame with the process id');
    assert.match(t.state.output, /hello-from-bridge/);
    assert.equal(t.state.exitCode, 7);
});

test('input reaches the program and UTF-8 output comes back intact', async () => {
    const t = start('powershell.exe -NoLogo -NoProfile');
    await t.until((s) => /PS [A-Z]:\\/.test(s.output));
    // write "السلام" through the pipeline: a script that prints it from code points, to be independent of console code pages
    t.send('[Console]::OutputEncoding = [Text.Encoding]::UTF8; -join ([char[]](0x627,0x644,0x633,0x644,0x627,0x645)); exit 3\r');
    await t.until((s) => s.exitCode !== null);
    assert.ok(t.state.output.includes('السلام'), 'the Arabic word arrives as UTF-8');
    assert.equal(t.state.exitCode, 3);
});

test('reports which programs run under the shell, and when they end', async () => {
    // a copy of cmd.exe named claude.exe stands in for the real program
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-bridge-'));
    const fake = path.join(dir, 'claude.exe');
    fs.copyFileSync(path.join(process.env.SystemRoot, 'System32', 'cmd.exe'), fake);
    try {
        const t = start('powershell.exe -NoLogo -NoProfile');
        await t.until((s) => /PS [A-Z]:\\/.test(s.output));
        assert.ok(t.state.procs.some((names) => names.includes('powershell.exe')), 'the shell itself is listed');
        t.send(`& '${fake}' /c "ping -n 4 127.0.0.1 >nul"\r`);
        await t.until((s) => s.procs.some((names) => names.includes('claude.exe')));
        await t.until((s) => { const last = s.procs[s.procs.length - 1]; return last && !last.includes('claude.exe'); }, 20000);
        t.send('exit\r');
        await t.until((s) => s.exitCode !== null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('resizing the pseudo console changes the size the program sees', async () => {
    const t = start('powershell.exe -NoLogo -NoProfile', os.homedir(), 100, 30);
    await t.until((s) => /PS [A-Z]:\\/.test(s.output));
    t.resize(72, 25);
    await new Promise((r) => setTimeout(r, 500));
    t.send('"SIZE=" + $Host.UI.RawUI.WindowSize.Width + "x" + $Host.UI.RawUI.WindowSize.Height; exit\r');
    await t.until((s) => s.exitCode !== null);
    assert.match(t.state.output, /SIZE=72x25/);
});

test('closing the pipe ends the shell and everything below it', async () => {
    const t = start('powershell.exe -NoLogo -NoProfile');
    await t.until((s) => /PS [A-Z]:\\/.test(s.output));
    const pid = t.state.ready;
    t.child.stdin.end();
    await new Promise((resolve) => t.child.once('exit', resolve));
    await new Promise((r) => setTimeout(r, 500));
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    assert.equal(alive, false, 'the shell is gone');
});

test('a command that cannot start is reported', async () => {
    const t = start('this-program-does-not-exist.exe');
    await new Promise((resolve) => t.child.once('exit', resolve));
    assert.match(t.state.error || '', /cannot start the command/);
});
