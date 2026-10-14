'use strict';
// Starts headless Chrome or Edge (real time, so requestAnimationFrame runs as it does in VS Code) with a debugging port of its
// own and its own profile, and lets a test talk to a page through the debugging protocol.
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');

const browser = [
    process.env.CHROME,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => p && fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
    });
}

/**
 * Opens the address in a browser of its own, gives fn { send, evaluate } and closes the browser again.
 * send(method, params) is the debugging protocol; evaluate(expression) runs JavaScript in the page and returns its value.
 */
async function withPage(url, fn, { width = 900, height = 320 } = {}) {
    const port = await freePort();
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-browser-'));
    const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', `--user-data-dir=${profile}`,
        `--window-size=${width},${height}`, `--remote-debugging-port=${port}`, url], { stdio: 'ignore' });
    let socket;
    try {
        let target;
        for (let i = 0; i < 100 && !target; i++) {
            try {
                const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
                target = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools:'));
            }
            catch { /* not up yet */ }
            if (!target) await sleep(200);
        }
        assert.ok(target, 'the browser did not open the page');
        socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('cannot connect to the browser')); });
        let id = 0;
        const pending = new Map();
        socket.onmessage = (e) => {
            const m = JSON.parse(e.data);
            if (m.id && pending.has(m.id)) { const { ok, bad } = pending.get(m.id); pending.delete(m.id); m.error ? bad(new Error(JSON.stringify(m.error))) : ok(m.result); }
        };
        const send = (method, params = {}) => new Promise((ok, bad) => { const i = ++id; pending.set(i, { ok, bad }); socket.send(JSON.stringify({ id: i, method, params })); });
        const evaluate = async (expression) => {
            const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
            if (r.exceptionDetails) throw new Error('in the page: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
            return r.result.value;
        };
        return await fn({ send, evaluate });
    }
    finally {
        try { if (socket) socket.close(); } catch { /* closed */ }
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });     // this browser and its helpers only
        for (let i = 0; i < 10; i++) {
            try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(300); }
        }
    }
}

/** Waits until check() (a function that returns a promise) gives a truthy value. */
async function waitUntil(check, what, ms = 30000) {
    const start = Date.now();
    for (;;) {
        let value = false;
        try { value = await check(); } catch { /* the page is not ready yet */ }
        if (value) return value;
        if (Date.now() - start > ms) throw new Error('timed out waiting for ' + what);
        await sleep(150);
    }
}

async function screenshot({ send }, file) {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
}

module.exports = { browser, sleep, withPage, waitUntil, screenshot };
