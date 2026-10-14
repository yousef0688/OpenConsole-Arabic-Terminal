'use strict';
// The page of the extension (media/main.js + xterm.js) with several terminals, in headless Chrome or Edge (real time, so
// requestAnimationFrame runs as it does in VS Code). test/webview-multi.html plays a scenario against a stand-in for the API of
// VS Code and writes the result into #result; this test starts the browser, waits for the result and reads it through the
// debugging protocol.
// Set OC_SCREENSHOT=<file.png> to also keep a screenshot of two terminals with the list, and OC_SCREENSHOT_CHIP=<file.png> for
// the labels "[Image #1]".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const browser = [
    process.env.CHROME,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => p && fs.existsSync(p));

const page = pathToFileURL(path.join(__dirname, 'webview-multi.html')).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
    });
}

/** Opens the page in a browser of its own (own profile, own debugging port), gives fn a way to talk to it, and closes it again. */
async function withPage(hash, fn) {
    const port = await freePort();
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-browser-'));
    const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', `--user-data-dir=${profile}`,
        '--window-size=900,320', `--remote-debugging-port=${port}`, page + hash], { stdio: 'ignore' });
    let socket;
    try {
        let target;
        for (let i = 0; i < 100 && !target; i++) {
            try {
                const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
                target = list.find((t) => t.type === 'page' && t.url.startsWith('file:'));
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
        return await fn({ send });
    }
    finally {
        try { if (socket) socket.close(); } catch { /* closed */ }
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });     // this browser and its helpers only
        for (let i = 0; i < 10; i++) {
            try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(300); }
        }
    }
}

/** Waits until the scenario has written its result, and returns it. */
async function readResult({ send }) {
    for (let i = 0; i < 300; i++) {
        const r = await send('Runtime.evaluate', { expression: "(document.getElementById('result') || {}).textContent || ''", returnByValue: true });
        if (r.result.value) return JSON.parse(r.result.value);
        await sleep(200);
    }
    throw new Error('the page wrote no result within 60 seconds');
}

async function screenshot(session, file) {
    const shot = await session.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
}

test('the page keeps several terminals apart, shows the list, closes them, and draws [Image #n] over pasted paths', { skip: !browser && 'no Chrome or Edge found' }, async () => {
    const result = await withPage('', readResult);
    const failed = result.results.filter((c) => !c.ok);
    assert.deepEqual(failed.map((c) => `${c.name} [${c.detail}]`), [], 'failed checks');
    assert.equal(result.done, 'all');
    assert.ok(result.results.length >= 251, 'the scenario ran to the end (' + result.results.length + ' checks)');
});

test('a screenshot with two terminals and the list', { skip: (!browser && 'no Chrome or Edge found') || (!process.env.OC_SCREENSHOT && 'set OC_SCREENSHOT to keep it') }, async () => {
    const out = path.resolve(process.env.OC_SCREENSHOT);
    await withPage('#shot', async (session) => { await readResult(session); await sleep(300); await screenshot(session, out); });
    assert.ok(fs.existsSync(out), 'no screenshot was written');
});

test('a screenshot of the list with the icons of what runs', { skip: (!browser && 'no Chrome or Edge found') || (!process.env.OC_SCREENSHOT_ICONS && 'set OC_SCREENSHOT_ICONS to keep it') }, async () => {
    const out = path.resolve(process.env.OC_SCREENSHOT_ICONS);
    await withPage('#icons', async (session) => { await readResult(session); await sleep(300); await screenshot(session, out); });
    assert.ok(fs.existsSync(out), 'no screenshot was written');
});

test('a screenshot of pasted screenshots drawn as [Image #n]', { skip: (!browser && 'no Chrome or Edge found') || (!process.env.OC_SCREENSHOT_CHIP && 'set OC_SCREENSHOT_CHIP to keep it') }, async () => {
    const out = path.resolve(process.env.OC_SCREENSHOT_CHIP);
    await withPage('#chip', async (session) => { await readResult(session); await sleep(300); await screenshot(session, out); });
    assert.ok(fs.existsSync(out), 'no screenshot was written');
});
