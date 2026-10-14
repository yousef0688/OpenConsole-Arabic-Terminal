'use strict';
// The page that opens the terminals of VS Code in a browser (media/remote.html + remote.js + remote.css), in headless Chrome or Edge,
// against a FAKE server that is written in this file: Node's http for the files and /api/pair, and a minimal RFC 6455 handshake and
// framing for /ws (it does not use src/web/ws.js, so that the page is tested on its own). The fake sends the headers of the contract
// (Content-Security-Policy: script-src 'self'; style-src 'self' ...), serves only the files of the URL map, and records everything that
// the page sends.
// Set OC_SCREENSHOT_REMOTE=<folder> to also keep screenshots (desktop and a 390 px phone) in that folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { browser, withPage, waitUntil, sleep, screenshot } = require('./browser-helper');

const media = path.join(__dirname, '..', 'media');
const skipReason = !browser && 'no Chrome or Edge found (set CHROME=<path to chrome.exe>)';
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ---- the fake server --------------------------------------------------------------------------------------------------------------

const APP_FILES = new Set(['remote.js', 'remote.css', 'arabic-layout.js', 'row-patcher.js']);
const VENDOR_FILES = new Set(['xterm.js', 'xterm.css', 'addon-fit.js', 'addon-unicode11.js', 'bidi.js']);
const MIME = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8' };
const HEADERS = {
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
};

/** One WebSocket of the fake server: reads the masked frames of the browser, writes plain ones. */
class FakeSocket {
    constructor(socket, head, url) {
        this.socket = socket;
        this.url = url;
        this.buffer = Buffer.from(head || []);
        this.messages = [];
        this.authed = false;
        this.closedByPeer = null;
        this.alive = true;
        this.onMessage = () => { };
        socket.on('data', (chunk) => { this.buffer = Buffer.concat([this.buffer, chunk]); this.parse(); });
        socket.on('close', () => { this.alive = false; });
        socket.on('error', () => { });
        if (this.buffer.length) this.parse();
    }

    parse() {
        for (;;) {
            const b = this.buffer;
            if (b.length < 2) return;
            const op = b[0] & 0x0f;
            const masked = (b[1] & 0x80) !== 0;
            let length = b[1] & 0x7f;
            let offset = 2;
            if (length === 126) { if (b.length < 4) return; length = b.readUInt16BE(2); offset = 4; }
            else if (length === 127) { if (b.length < 10) return; length = Number(b.readBigUInt64BE(2)); offset = 10; }
            const need = offset + (masked ? 4 : 0) + length;
            if (b.length < need) return;
            const mask = masked ? b.subarray(offset, offset + 4) : null;
            if (masked) offset += 4;
            const payload = Buffer.from(b.subarray(offset, offset + length));
            if (mask) for (let i = 0; i < length; i++) payload[i] ^= mask[i & 3];
            this.buffer = b.subarray(need);
            if (!masked) { this.drop(); return; }               // a browser always masks
            if (op === 1) {
                let message;
                try { message = JSON.parse(payload.toString('utf8')); } catch { continue; }
                this.messages.push(message);
                this.onMessage(message);
            } else if (op === 8) {
                this.closedByPeer = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
                try {
                    if (!this.sentClose) this.socket.write(this.frame(8, payload.subarray(0, 2)));      // answer a close once; after our own close the answer is the end
                    this.socket.end();
                } catch { /* gone */ }
            } else if (op === 9) {
                this.socket.write(this.frame(10, payload));
            }
        }
    }

    frame(op, payload) {
        const n = payload.length;
        let head;
        if (n < 126) head = Buffer.from([0x80 | op, n]);
        else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(n, 2); }
        else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
        return Buffer.concat([head, payload]);
    }

    send(message) {
        if (this.alive) this.socket.write(this.frame(1, Buffer.from(JSON.stringify(message), 'utf8')));
    }

    close(code) {
        const payload = Buffer.alloc(2);
        payload.writeUInt16BE(code);
        if (this.alive) this.socket.write(this.frame(8, payload));
        this.sentClose = true;
        setTimeout(() => this.socket.destroy(), 200).unref();
    }

    /** The connection breaks without a close frame. */
    drop() { this.socket.destroy(); }

    of(type) { return this.messages.filter((m) => m.t === type); }
}

async function startFake(options = {}) {
    const fake = {
        role: options.role || 'write',
        token: crypto.randomBytes(32).toString('base64url'),
        pairResult: options.pairResult || 'approve',         // 'approve' | 'deny' | 'expired' | 'rate'
        pairDelay: options.pairDelay || 0,
        autoPong: true,
        refuseAuth: false,
        terminals: options.terminals || [{ id: 1, name: 'PowerShell', cols: 80, rows: 24 }, { id: 2, name: 'Claude Code', cols: 100, rows: 30 }],
        snapshots: options.snapshots || { 1: '\x1b[32mPS C:\\Users\\pc>\x1b[0m echo hi\r\nhi\r\n', 2: 'second terminal\r\n' },
        pairRequests: [],
        urls: [],                                            // every address that was asked for
        notFound: [],
        conns: [],
        rejected: [],
    };
    fake.hello = () => ({ t: 'hello', role: fake.role, terminals: fake.terminals, limits: { input: 16384 }, readOnly: fake.role !== 'write' });
    fake.last = () => fake.conns[fake.conns.length - 1];
    fake.inputs = (conn = fake.last()) => (conn ? conn.of('input').map((m) => m.data) : []);
    fake.allInputs = () => fake.conns.flatMap((c) => c.of('input'));
    fake.broadcast = (message) => { for (const c of fake.conns) if (c.alive && c.authed) c.send(message); };

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        fake.urls.push(req.method + ' ' + req.url);
        const origin = `http://127.0.0.1:${fake.port}`;
        const send = (status, type, body) => { res.writeHead(status, Object.assign({ 'Content-Type': type }, HEADERS)); res.end(body); };
        if (req.method === 'GET' && url.pathname === '/') return send(200, MIME['.html'], fs.readFileSync(path.join(media, 'remote.html')));
        const file = /^\/app\/([^/]+)$/.exec(url.pathname);
        const vendor = /^\/vendor\/([^/]+)$/.exec(url.pathname);
        if (req.method === 'GET' && file && APP_FILES.has(file[1])) return send(200, MIME[path.extname(file[1])], fs.readFileSync(path.join(media, file[1])));
        if (req.method === 'GET' && vendor && VENDOR_FILES.has(vendor[1])) return send(200, MIME[path.extname(vendor[1])], fs.readFileSync(path.join(media, 'vendor', vendor[1])));
        if (req.method === 'POST' && url.pathname === '/api/pair') {
            let body = '';
            req.on('data', (c) => { body += c; if (body.length > 1024) req.destroy(); });
            req.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(body); } catch { /* recorded as null */ }
                fake.pairRequests.push({ body: parsed, raw: body, origin: req.headers.origin, contentType: req.headers['content-type'], cookie: req.headers.cookie, referer: req.headers.referer });
                if (req.headers.origin !== origin) return send(403, 'application/json', JSON.stringify({ error: 'origin' }));
                setTimeout(() => {
                    if (fake.pairResult === 'approve') send(200, 'application/json', JSON.stringify({ token: fake.token, deviceId: 'dev-1', role: fake.role }));
                    else if (fake.pairResult === 'deny') send(403, 'application/json', JSON.stringify({ error: 'denied' }));
                    else if (fake.pairResult === 'expired') send(403, 'application/json', JSON.stringify({ error: 'expired or already used' }));
                    else if (fake.pairResult === 'rate') send(429, 'application/json', JSON.stringify({ error: 'rate limited' }));
                    else if (fake.pairResult === 'hangup') req.socket.destroy();
                }, fake.pairDelay);
            });
            return;
        }
        if (url.pathname !== '/favicon.ico') fake.notFound.push(req.method + ' ' + req.url);
        send(404, 'text/plain', 'not found');
    });

    server.on('upgrade', (req, socket, head) => {
        const origin = `http://127.0.0.1:${fake.port}`;
        const key = req.headers['sec-websocket-key'];
        if (req.url !== '/ws' || req.headers.origin !== origin || !key) { fake.rejected.push(req.url + ' ' + req.headers.origin); socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
            crypto.createHash('sha1').update(key + GUID).digest('base64') + '\r\n\r\n');
        const conn = new FakeSocket(socket, head, req.url);
        fake.conns.push(conn);
        conn.onMessage = (m) => {
            if (fake.handler && fake.handler(conn, m) === true) return;
            if (m.t === 'auth') {
                if (m.token === fake.token && !fake.refuseAuth) { conn.authed = true; conn.send(fake.hello()); }
                else conn.close(4401);
            } else if (m.t === 'attach' && conn.authed) {
                for (const id of m.ids) {
                    const t = fake.terminals.find((x) => x.id === id);
                    if (t) conn.send({ t: 'snapshot', id, cols: t.cols, rows: t.rows, data: fake.snapshots[id] || '' });
                }
            } else if (m.t === 'ping' && conn.authed && fake.autoPong) conn.send({ t: 'pong', n: m.n });
        };
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    fake.port = server.address().port;
    fake.url = `http://127.0.0.1:${fake.port}/`;
    fake.close = () => { for (const c of fake.conns) c.socket.destroy(); server.closeAllConnections(); server.close(); };
    return fake;
}

// ---- driving the page --------------------------------------------------------------------------------------------------------------

/**
 * Opens the page of the fake server in a browser, with a listener for every violation of the Content-Security-Policy and for errors, and
 * (seed) a saved session, so that the page does not need a pairing. Gives fn { page, fake }.
 */
async function scenario(options, fn) {
    const fake = options.server ? await options.server() : await startFake(options);
    try {
        await withPage('about:blank', async (page) => {
            await page.send('Page.enable');
            await page.send('Runtime.enable');
            if (options.metrics) {
                await page.send('Emulation.setDeviceMetricsOverride', options.metrics);
                if (options.metrics.mobile) await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
            }
            if (options.acceptLanguage) {
                const version = await page.send('Browser.getVersion');
                await page.send('Emulation.setUserAgentOverride', { userAgent: version.userAgent, acceptLanguage: options.acceptLanguage });
            }
            const seed = options.seed === false || options.server ? null : options.seed || { token: fake.token, deviceId: 'dev-1', role: fake.role };
            const source = `(() => {
                window.__csp = []; window.__errors = [];
                document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' | ' + e.blockedURI + ' | ' + (e.sample || '')), true);
                window.addEventListener('error', (e) => window.__errors.push(String(e.message)));
                window.addEventListener('unhandledrejection', (e) => window.__errors.push('rejection: ' + (e.reason && e.reason.message || e.reason)));
                const original = console.error.bind(console);
                console.error = (...a) => { window.__errors.push(a.map(String).join(' ')); original(...a); };
                ${options.timing ? 'window.__ocRemoteTiming = ' + JSON.stringify(options.timing) + ';' : ''}
                ${options.noStorage ? "Storage.prototype.getItem = Storage.prototype.setItem = Storage.prototype.removeItem = () => { throw new Error('storage is blocked'); };" : ''}
                ${seed && !options.noStorage ? `try { if (!localStorage.getItem('oc.remote.session')) localStorage.setItem('oc.remote.session', ${JSON.stringify(JSON.stringify(seed))}); } catch (e) { }` : ''}
            })();`;
            await page.send('Page.addScriptToEvaluateOnNewDocument', { source });
            await page.send('Page.navigate', { url: fake.url + (options.hash || fake.hash || '') });
            await fn({ page, fake });
            const csp = await page.evaluate('window.__csp');
            assert.deepEqual(csp, [], 'the page broke the Content-Security-Policy: ' + JSON.stringify(csp));
            const errors = await page.evaluate('window.__errors');
            assert.deepEqual(errors.filter((e) => !(options.allowErrors || []).some((a) => e.includes(a))), [], 'errors in the page');
            assert.deepEqual(fake.notFound, [], 'the page asked for files that the server does not serve');
        }, { width: (options.metrics && options.metrics.width) || 1000, height: (options.metrics && options.metrics.height) || 700 });
    } finally {
        fake.close();
    }
}

const lines = (page) => page.evaluate(`(() => { const b = window.__ocRemote.term.buffer.active; const out = []; for (let i = 0; i < b.length; i++) out.push(b.getLine(i).translateToString(true)); return out; })()`);
const screenText = async (page) => (await lines(page)).join('\n');
const connected = (fake, n = 1) => waitUntil(() => fake.conns.length >= n && fake.conns[n - 1].of('attach').length >= 1, `connection ${n} with an attach`);
const ready = async (page, fake, needle) => {
    await connected(fake);
    if (needle) await waitUntil(async () => (await screenText(page)).includes(needle), 'the text ' + needle);
};

async function key(page, k, extra = {}) {
    const init = Object.assign({ key: k, windowsVirtualKeyCode: k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0 }, extra);
    if (k.length === 1) { init.text = k; init.unmodifiedText = k; }
    await page.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown' }, init));
    await page.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, init));
}
const typeText = async (page, text) => { for (const ch of text) await key(page, ch); };
const enter = async (page) => {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
};
const focusTerminal = (page) => page.evaluate('window.__ocRemote.term.focus()');

async function center(page, selector) {
    return page.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
}
async function click(page, selector) {
    const { x, y } = await center(page, selector);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

const base64url = () => crypto.randomBytes(32).toString('base64url');

// ---- pairing -----------------------------------------------------------------------------------------------------------------------

test('pairing: the secret leaves the address bar, is sent once, the page waits for the owner, then connects with the token', { skip: skipReason, timeout: 90000 }, async () => {
    const secret = base64url();
    await scenario({ hash: '#p=' + secret, seed: false, pairDelay: 1200 }, async ({ page, fake }) => {
        // while the owner has not answered
        await waitUntil(async () => /Waiting for approval in VS Code/.test(await page.evaluate("document.getElementById('pair-text').textContent")), 'the waiting text');
        assert.equal(await page.evaluate("document.getElementById('pair-spinner').hidden"), false, 'a spinner is shown while waiting');
        assert.equal(await page.evaluate('location.hash'), '', 'the fragment is removed at once');
        assert.ok(!(await page.evaluate('location.href')).includes(secret), 'the secret is not in the address any more');
        await ready(page, fake, 'hi');

        assert.equal(fake.pairRequests.length, 1, 'one pairing request');
        const request = fake.pairRequests[0];
        assert.equal(request.body.secret, secret);
        assert.ok(typeof request.body.label === 'string' && request.body.label.length > 0 && request.body.label.length <= 80, 'a label of at most 80 characters: ' + request.body.label);
        assert.match(request.contentType, /^application\/json/);
        assert.equal(request.origin, `http://127.0.0.1:${fake.port}`);
        assert.equal(request.cookie, undefined, 'no cookies');
        assert.ok(!request.referer, 'no referrer');

        // the token travels in the first WebSocket message only
        const conn = fake.conns[0];
        assert.deepEqual(conn.messages[0], { t: 'auth', token: fake.token });
        assert.ok(!conn.url.includes(fake.token) && !conn.url.includes(secret), 'nothing secret in the address of the socket');
        assert.ok(fake.urls.every((u) => !u.includes(secret) && !u.includes(fake.token)), 'nothing secret in any address that was asked for');
        const saved = JSON.parse(await page.evaluate("localStorage.getItem('oc.remote.session')"));
        assert.equal(saved.token, fake.token);
        assert.equal(await page.evaluate("document.getElementById('pair').hidden"), true);
        assert.equal(await page.evaluate("document.getElementById('main').hidden"), false);

        // a reload needs no new link: the saved token is used
        await page.send('Page.reload');
        await connected(fake, 2);
        assert.equal(fake.pairRequests.length, 1, 'no second pairing');
        assert.deepEqual(fake.conns[1].messages[0], { t: 'auth', token: fake.token });
    });
});

test('pairing: a denied, expired or rate-limited link is explained in plain words, and nothing connects', { skip: skipReason, timeout: 90000 }, async () => {
    await scenario({ hash: '#p=' + base64url(), seed: false, pairResult: 'deny' }, async ({ page, fake }) => {
        const text = () => page.evaluate("document.getElementById('pair-text').textContent");
        await waitUntil(async () => /did not allow/.test(await text()), 'the denied message');
        assert.equal(await page.evaluate("document.getElementById('pair').classList.contains('error')"), true);
        assert.equal(await page.evaluate("localStorage.getItem('oc.remote.session')"), null, 'nothing is saved');
        for (const [result, pattern] of [['expired', /expired or was already used/], ['rate', /Too many attempts/], ['hangup', /Cannot reach/]]) {
            fake.pairResult = result;
            await page.send('Page.navigate', { url: fake.url + '?again=' + result + '#p=' + base64url() });
            await waitUntil(async () => pattern.test(await text()), 'the message for ' + result);
        }
        assert.equal(fake.conns.length, 0, 'no WebSocket');
        assert.ok(fake.pairRequests.length >= 4, 'one request per link (the browser may repeat one that was cut off)');
    });
});

test('pairing: a page without a link and without a saved session says what to do, and a damaged link is refused without asking the server', { skip: skipReason, timeout: 90000 }, async () => {
    await scenario({ seed: false }, async ({ page, fake }) => {
        await waitUntil(async () => /Open the link that VS Code shows/.test(await page.evaluate("document.getElementById('pair-text').textContent")), 'the hint');
        await page.send('Page.navigate', { url: fake.url + '?again=1#p=short' });
        await waitUntil(async () => /not valid/.test(await page.evaluate("document.getElementById('pair-text').textContent")), 'the invalid link message');
        assert.equal(await page.evaluate('location.hash'), '');
        assert.equal(fake.pairRequests.length, 0);
        assert.equal(fake.conns.length, 0);
    });
});

test('pairing: without localStorage the page still pairs and connects', { skip: skipReason, timeout: 90000 }, async () => {
    await scenario({ hash: '#p=' + base64url(), seed: false, noStorage: true }, async ({ page, fake }) => {
        await ready(page, fake, 'hi');
        assert.deepEqual(fake.conns[0].messages[0], { t: 'auth', token: fake.token });
        assert.equal(await page.evaluate('window.__ocRemote.session.token === ' + JSON.stringify(fake.token)), true);
    });
});

test('Arabic browser language: the frame is in Arabic and right to left, the terminal is not', { skip: skipReason, timeout: 90000 }, async () => {
    await scenario({ seed: false, acceptLanguage: 'ar-SA', hash: '#p=' + base64url(), pairDelay: 3000 }, async ({ page }) => {
        await waitUntil(async () => /بانتظار الموافقة/.test(await page.evaluate("document.getElementById('pair-text').textContent")), 'the Arabic waiting text');
        assert.equal(await page.evaluate("document.documentElement.lang"), 'ar');
        assert.equal(await page.evaluate("document.getElementById('pair').getAttribute('dir')"), 'rtl');
        assert.equal(await page.evaluate("getComputedStyle(document.getElementById('stage')).direction"), 'ltr', 'the terminal is never right to left');
        assert.equal(await page.evaluate("document.getElementById('keys').getAttribute('dir')"), 'ltr');
    });
});

// ---- terminals ---------------------------------------------------------------------------------------------------------------------

test('hello gives the tabs, only the shown terminal is attached, snapshot then output (Arabic too) is drawn at the size of the owner', { skip: skipReason, timeout: 90000 }, async () => {
    await scenario({ role: 'read' }, async ({ page, fake }) => {
        await ready(page, fake, 'hi');
        const names = () => page.evaluate("Array.from(document.querySelectorAll('#tabs .tab')).map((t) => t.querySelector('.name').textContent)");
        assert.deepEqual(await names(), ['PowerShell', 'Claude Code']);
        assert.equal(await page.evaluate("document.querySelector('#tabs .tab[aria-selected=true] .name').textContent"), 'PowerShell');
        assert.deepEqual(fake.conns[0].of('attach'), [{ t: 'attach', ids: [1] }], 'only the shown terminal is attached');
        assert.equal(await page.evaluate('window.__ocRemote.term.cols + "x" + window.__ocRemote.term.rows'), '80x24', 'the size of the owner');
        assert.match(await screenText(page), /PS C:\\Users\\pc> echo hi\nhi/);

        // live output, with Arabic
        fake.broadcast({ t: 'output', id: 1, data: 'مرحبا بالعالم\r\nmixed: abc ثم def\r\n' });
        await waitUntil(async () => (await screenText(page)).includes('مرحبا بالعالم'), 'the Arabic output');
        assert.ok((await screenText(page)).includes('mixed: abc ثم def'));
        // the right-to-left layer draws the row: a box for the Arabic word, shaped by the browser
        await waitUntil(() => page.evaluate("document.querySelectorAll('#term-host .xterm-rows .oc-box').length > 0"), 'the right-to-left layer');
        assert.equal(await page.evaluate("getComputedStyle(document.querySelector('#term-host .oc-box[style*=\"direction: rtl\"]')).direction"), 'rtl');
        // output of a terminal that is not shown is ignored
        const before = await screenText(page);
        fake.broadcast({ t: 'output', id: 2, data: 'NOT-HERE\r\n' });
        await sleep(300);
        assert.equal(await screenText(page), before);

        // the tab of the other terminal: detach, attach, snapshot at its size
        await click(page, '#tabs .tab:nth-child(2)');
        await waitUntil(async () => (await screenText(page)).includes('second terminal'), 'the second terminal');
        assert.deepEqual(fake.conns[0].of('detach'), [{ t: 'detach', ids: [1] }]);
        assert.deepEqual(fake.conns[0].of('attach').map((m) => m.ids), [[1], [2]]);
        assert.equal(await page.evaluate('window.__ocRemote.term.cols + "x" + window.__ocRemote.term.rows'), '100x30');
        assert.ok(!(await screenText(page)).includes('mixed: abc'), 'the old terminal is gone from the screen');
        assert.equal(await page.evaluate("document.querySelector('#tabs .tab[aria-selected=true] .name').textContent"), 'Claude Code');
    });
});

test('title, state and exit change the tab, and nothing from the server is ever parsed as HTML', { skip: skipReason, timeout: 90000 }, async () => {
    await scenario({ role: 'read' }, async ({ page, fake }) => {
        await ready(page, fake, 'hi');
        const evil = '<img src=x onerror="window.__pwned=1">\u202eRTL\u0007';
        fake.broadcast({ t: 'title', id: 1, name: evil });
        await waitUntil(async () => /<img/.test(await page.evaluate("document.querySelector('#tabs .tab .name').textContent")), 'the title');
        const name = await page.evaluate("document.querySelector('#tabs .tab .name').textContent");
        assert.equal(name, '<img src=x onerror="window.__pwned=1">RTL', 'the title is text, without control characters and direction overrides');
        assert.equal(await page.evaluate("document.querySelectorAll('img').length"), 0);
        assert.equal(await page.evaluate('window.__pwned'), undefined);

        fake.broadcast({ t: 'state', id: 1, state: 'working', attention: false });
        await waitUntil(() => page.evaluate("document.querySelector('#tabs .tab .dot').getAttribute('data-state') === 'working'"), 'the state');
        fake.broadcast({ t: 'state', id: 1, state: '" onmouseover="x', attention: true });
        await waitUntil(() => page.evaluate("document.querySelector('#tabs .tab').classList.contains('attention')"), 'the attention');
        assert.equal(await page.evaluate("document.querySelector('#tabs .tab .dot').hasAttribute('data-state')"), false, 'an odd state name is not used');

        fake.broadcast({ t: 'exit', id: 1, code: 3 });
        await waitUntil(() => page.evaluate("document.querySelector('#tabs .tab').classList.contains('exited')"), 'the exit');
        await waitUntil(async () => (await screenText(page)).includes('The process ended with code 3.'), 'the line in the terminal');

        // the list changes: a terminal opens, the other one closes
        fake.terminals = [{ id: 2, name: 'Claude Code', cols: 100, rows: 30 }, { id: 3, name: 'new', cols: 90, rows: 20 }];
        fake.broadcast({ t: 'terminals', terminals: fake.terminals });
        await waitUntil(async () => (await page.evaluate("document.querySelectorAll('#tabs .tab').length")) === 2, 'two tabs');
        await waitUntil(async () => (await screenText(page)).includes('second terminal'), 'the first terminal that is left is shown');
        assert.deepEqual(fake.conns[0].of('attach').map((m) => m.ids), [[1], [2]]);
        // nothing is shared any more
        fake.terminals = [];
        fake.broadcast({ t: 'terminals', terminals: [] });
        await waitUntil(() => page.evaluate("!document.getElementById('empty').hidden && /No terminals are shared/.test(document.getElementById('empty').textContent)"), 'the empty state');
    });
});

test('resize of the owner: the page draws exactly cols x rows, scales its font, and never asks for a size', { skip: skipReason, timeout: 90000 }, async () => {
    await scenario({ role: 'write', metrics: { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false } }, async ({ page, fake }) => {
        await ready(page, fake, 'hi');
        const geometry = () => page.evaluate(`(() => { const t = window.__ocRemote.term; const s = document.querySelector('#term-host .xterm-screen').getBoundingClientRect(); const st = document.getElementById('stage').getBoundingClientRect();
            return { cols: t.cols, rows: t.rows, font: window.__ocRemote.fontSize, w: s.width, h: s.height, stageW: st.width, stageH: st.height, pan: document.getElementById('stage').classList.contains('pan') }; })()`);
        let g = await geometry();
        assert.equal(g.cols + 'x' + g.rows, '80x24');
        assert.ok(g.w <= g.stageW && g.h <= g.stageH, 'everything fits: ' + JSON.stringify(g));
        assert.equal(g.pan, false);

        fake.broadcast({ t: 'resize', id: 1, cols: 160, rows: 40 });
        await waitUntil(async () => (await geometry()).cols === 160, 'the new size');
        g = await geometry();
        assert.equal(g.rows, 40);
        assert.ok(g.w <= g.stageW + 1 && g.h <= g.stageH + 1, 'the font was scaled so that 160 x 40 fits: ' + JSON.stringify(g));
        assert.ok(g.font >= 10 && g.font <= 18, 'a readable font: ' + g.font);

        // too big for the font that is still readable: the stage is panned, not the terminal squeezed
        fake.broadcast({ t: 'resize', id: 1, cols: 400, rows: 60 });
        await waitUntil(async () => (await geometry()).cols === 400, 'a huge size');
        g = await geometry();
        assert.equal(g.pan, true, 'the stage can be panned: ' + JSON.stringify(g));
        assert.equal(g.font, 10);

        // a list update with new sizes is the same
        fake.terminals[0].cols = 90; fake.terminals[0].rows = 25;
        fake.broadcast({ t: 'terminals', terminals: fake.terminals });
        await waitUntil(async () => (await geometry()).cols === 90, 'the size from the list');
        // snapshots carry their own size
        fake.broadcast({ t: 'snapshot', id: 1, cols: 70, rows: 20, data: 'fresh\r\n' });
        await waitUntil(async () => (await geometry()).cols === 70, 'the size of a snapshot');
        assert.equal((await screenText(page)).trim(), 'fresh');

        assert.deepEqual(fake.conns[0].of('resize'), [], 'the page never asks the pty to resize');
    });
});

// ---- input -------------------------------------------------------------------------------------------------------------------------

test('read-only: no extra keys, no stdin, and nothing is sent for keys, paste or the answers of the terminal', { skip: skipReason, timeout: 90000 }, async () => {
    await scenario({ role: 'read' }, async ({ page, fake }) => {
        await ready(page, fake, 'hi');
        assert.equal(await page.evaluate("document.getElementById('badge').textContent"), 'Read-only');
        assert.equal(await page.evaluate("getComputedStyle(document.getElementById('keys')).display"), 'none', 'the extra keys are hidden');
        assert.equal(await page.evaluate('window.__ocRemote.term.options.disableStdin'), true);
        assert.equal(await page.evaluate('window.__ocRemote.canWrite'), false);
        assert.equal(await page.evaluate("window.__ocRemote.term.textarea.getAttribute('inputmode')"), 'none');

        await focusTerminal(page);
        await typeText(page, 'rm -rf /');
        await enter(page);
        await page.send('Input.insertText', { text: 'pasted' });
        fake.broadcast({ t: 'output', id: 1, data: '\x1b[c\x1b[6n\x1b]11;?\x07' });       // questions that xterm.js answers when it may
        await sleep(700);
        assert.deepEqual(fake.conns[0].of('input'), [], 'a read-only page sends no input');
        assert.deepEqual(await page.evaluate('window.__ocRemote.stats.dropped'), [], 'xterm.js has no stdin: it does not even answer');
        assert.equal(await page.evaluate('window.__ocRemote.stats.inputSent'), 0);
        // the bar cannot be reached either
        await page.evaluate("document.querySelector('#keys [data-k=esc]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }))");
        await sleep(200);
        assert.deepEqual(fake.conns[0].of('input'), []);
    });
});

test('write: typed keys, Enter and Arabic text are sent as input; the answers of the terminal to DA1, CPR and colour queries are not', { skip: skipReason, timeout: 90000 }, async () => {
    await scenario({ role: 'write' }, async ({ page, fake }) => {
        await ready(page, fake, 'hi');
        assert.equal(await page.evaluate("document.getElementById('badge').textContent"), 'Can type');
        assert.equal(await page.evaluate('window.__ocRemote.term.options.disableStdin'), false);
        assert.notEqual(await page.evaluate("getComputedStyle(document.getElementById('keys')).display"), 'none');

        await focusTerminal(page);
        await typeText(page, 'ls');
        await enter(page);
        await waitUntil(() => fake.inputs().join('') === 'ls\r', 'the typed keys');
        assert.ok(fake.conns[0].of('input').every((m) => m.id === 1), 'the input names the terminal');
        await page.send('Input.insertText', { text: 'مرحبا' });
        await waitUntil(() => fake.inputs().join('') === 'ls\rمرحبا', 'Arabic text passes through unchanged');

        // arrow keys are real keys, not answers
        await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 });
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 });
        await waitUntil(() => fake.inputs().join('') === 'ls\rمرحبا\x1b[A', 'the arrow');

        // the program asks questions: device attributes (two kinds), cursor position, colour, terminal name; xterm.js answers each of them
        const sent = fake.inputs().length;
        fake.broadcast({ t: 'output', id: 1, data: '\x1b[c\x1b[>c\x1b[6n\x1b]11;?\x07\x1b[>q\x1b[?2004$p\r\n' });
        await waitUntil(async () => (await page.evaluate('window.__ocRemote.stats.dropped.length')) >= 3, 'xterm.js answering');
        // a snapshot that contains old questions is replayed: nothing goes out for them either
        fake.broadcast({ t: 'snapshot', id: 1, cols: 80, rows: 24, data: 'old\r\n\x1b[c\x1b[6n\r\n' });
        await waitUntil(async () => (await screenText(page)).includes('old'), 'the snapshot');
        await sleep(600);
        assert.equal(fake.inputs().length, sent, 'nothing that xterm.js answered was sent: ' + JSON.stringify(fake.inputs().slice(sent)));
        const dropped = await page.evaluate('window.__ocRemote.stats.dropped');
        assert.ok(dropped.some((d) => /^\x1b\[\?[\d;]*c$/.test(d)), 'a DA1 answer was produced and dropped: ' + JSON.stringify(dropped));
        assert.ok(dropped.some((d) => /^\x1b\[\d+;\d+R$/.test(d)), 'a cursor position answer was produced and dropped');

        // and real keys still go out afterwards
        await typeText(page, 'x');
        await waitUntil(() => fake.inputs().slice(sent).join('') === 'x', 'a key after the questions');
    });
});

test('write: keys typed while a lot of output is being drawn are not lost', { skip: skipReason, timeout: 120000 }, async () => {
    await scenario({ role: 'write' }, async ({ page, fake }) => {
        await ready(page, fake, 'hi');
        await focusTerminal(page);
        // about 3 MB of output in 48 messages, sent at once
        const chunk = Array.from({ length: 800 }, (_, i) => 'line ' + i + ' ' + 'x'.repeat(70)).join('\r\n') + '\r\n';
        for (let i = 0; i < 48; i++) fake.broadcast({ t: 'output', id: 1, data: chunk });
        await sleep(20);
        const typed = 'abcdef';
        for (const ch of typed) { await key(page, ch); await sleep(15); }
        await waitUntil(() => fake.inputs().join('') === typed, 'the typed keys during the output: ' + JSON.stringify(fake.inputs()));
        const busy = await page.evaluate('window.__ocRemote.term.buffer.active.length');
        assert.ok(busy > 1000, 'the output was drawn');
    });
});

test('the extra keys: Esc, Tab, arrows (also in application mode), Home/End/PgUp/PgDn, | / - ~, sticky Ctrl and Alt, and an arrow repeats while held', { skip: skipReason, timeout: 120000 }, async () => {
    await scenario({ role: 'write' }, async ({ page, fake }) => {
        await ready(page, fake, 'hi');
        const taken = () => fake.inputs().length;
        const expectAfter = async (action, expected, what) => {
            const n = taken();
            await action();
            await waitUntil(() => fake.inputs().length >= n + 1, what);
            await sleep(60);
            assert.deepEqual(fake.inputs().slice(n), expected, what);
        };
        const press = (name) => click(page, `#keys [data-k="${name}"]`);
        const char = (ch) => click(page, `#keys [data-ch="${ch}"]`);

        await expectAfter(() => press('esc'), ['\x1b'], 'Esc');
        await expectAfter(() => press('tab'), ['\t'], 'Tab');
        await expectAfter(() => press('up'), ['\x1b[A'], 'Up');
        await expectAfter(() => press('down'), ['\x1b[B'], 'Down');
        await expectAfter(() => press('right'), ['\x1b[C'], 'Right');
        await expectAfter(() => press('left'), ['\x1b[D'], 'Left');
        await expectAfter(() => press('home'), ['\x1b[H'], 'Home');
        await expectAfter(() => press('end'), ['\x1b[F'], 'End');
        await expectAfter(() => press('pgup'), ['\x1b[5~'], 'PgUp');
        await expectAfter(() => press('pgdn'), ['\x1b[6~'], 'PgDn');
        for (const ch of ['|', '/', '-', '~']) await expectAfter(() => char(ch), [ch], 'the key ' + ch);

        // application cursor keys mode (a program like vim asks for it)
        fake.broadcast({ t: 'output', id: 1, data: '\x1b[?1h' });
        await waitUntil(() => page.evaluate('window.__ocRemote.term.modes.applicationCursorKeysMode'), 'application mode');
        await expectAfter(() => press('up'), ['\x1bOA'], 'Up in application mode');
        await expectAfter(() => press('home'), ['\x1bOH'], 'Home in application mode');
        fake.broadcast({ t: 'output', id: 1, data: '\x1b[?1l' });
        await waitUntil(async () => !(await page.evaluate('window.__ocRemote.term.modes.applicationCursorKeysMode')), 'normal mode');

        // sticky Ctrl: the next key from the keyboard becomes a control character, then it is off again
        await focusTerminal(page);
        await press('ctrl');
        assert.equal(await page.evaluate("document.querySelector('#keys [data-k=ctrl]').getAttribute('aria-pressed')"), 'true');
        await expectAfter(() => key(page, 'c'), ['\x03'], 'Ctrl + C');
        assert.equal(await page.evaluate("document.querySelector('#keys [data-k=ctrl]').getAttribute('aria-pressed')"), 'false');
        await expectAfter(() => key(page, 'c'), ['c'], 'a plain c afterwards');
        // Ctrl + a key of the bar, Ctrl + arrow
        await press('ctrl');
        await expectAfter(() => char('/'), ['\x1f'], 'Ctrl + /');
        await press('ctrl');
        await expectAfter(() => press('up'), ['\x1b[1;5A'], 'Ctrl + Up');
        // Alt: ESC before the key
        await press('alt');
        await expectAfter(() => key(page, 'x'), ['\x1bx'], 'Alt + x');
        // two taps in a row lock it
        await press('ctrl');
        await press('ctrl');
        assert.equal(await page.evaluate("document.querySelector('#keys [data-k=ctrl]').classList.contains('locked')"), true);
        await expectAfter(() => key(page, 'a'), ['\x01'], 'Ctrl + A (locked)');
        await expectAfter(() => key(page, 'e'), ['\x05'], 'Ctrl + E (still locked)');
        await sleep(700);
        await press('ctrl');                    // a third tap releases it
        assert.equal(await page.evaluate("document.querySelector('#keys [data-k=ctrl]').getAttribute('aria-pressed')"), 'false');

        // an arrow that is held repeats
        const n = taken();
        const { x, y } = await center(page, '#keys [data-k="right"]');
        await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
        await sleep(900);
        await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
        const count = taken() - n;
        assert.ok(count >= 4, 'an arrow that is held repeats: ' + count);
        await sleep(300);
        assert.equal(taken() - n, count, 'and stops when it is released');
    });
});

// ---- connection --------------------------------------------------------------------------------------------------------------------

test('reconnect: after the server closes the socket the page shows the banner, authenticates again, attaches again and gets a fresh snapshot', { skip: skipReason, timeout: 90000 }, async () => {
    await scenario({ role: 'write', timing: { backoff: [150, 150, 150], jitter: 0 } }, async ({ page, fake }) => {
        await ready(page, fake, 'hi');
        await waitUntil(() => page.evaluate("document.getElementById('banner').hidden"), 'no banner while connected');
        fake.snapshots[1] = 'AFTER THE RECONNECT\r\n';
        fake.conns[0].close(1001);
        await connected(fake, 2);
        assert.deepEqual(fake.conns[1].messages[0], { t: 'auth', token: fake.token }, 're-auth with the same token');
        assert.deepEqual(fake.conns[1].of('attach'), [{ t: 'attach', ids: [1] }], 're-attach');
        await waitUntil(async () => (await screenText(page)).includes('AFTER THE RECONNECT'), 'the new snapshot');
        assert.ok(!(await screenText(page)).includes('PS C:'), 'the old screen is replaced, not appended to');
        await waitUntil(() => page.evaluate("document.getElementById('banner').hidden"), 'the banner goes away');
        // typing works again on the new socket
        await focusTerminal(page);
        await typeText(page, 'q');
        await waitUntil(() => fake.inputs(fake.conns[1]).join('') === 'q', 'input on the new socket');
        assert.deepEqual(fake.conns[0].of('input'), []);
    });
});

test('reconnect: the banner says so while it is down, and coming back to the page (visibilitychange) reconnects at once', { skip: skipReason, timeout: 90000 }, async () => {
    await scenario({ role: 'read', timing: { backoff: [60000], jitter: 0 } }, async ({ page, fake }) => {
        await ready(page, fake, 'hi');
        fake.refuseAuth = false;
        fake.conns[0].drop();                    // no close frame at all: the network went away
        await waitUntil(async () => /Reconnecting in \d+ s/.test(await page.evaluate("document.getElementById('banner-text').textContent")), 'the banner with the countdown');
        assert.equal(await page.evaluate("document.getElementById('banner').hidden"), false);
        assert.equal(await page.evaluate("document.getElementById('banner-retry').hidden"), false, 'a button to retry now');
        assert.equal(await page.evaluate("document.getElementById('conn').className"), 'conn bad');
        await sleep(500);
        assert.equal(fake.conns.length, 1, 'the backoff has not run out');
        await page.evaluate("document.dispatchEvent(new Event('visibilitychange'))");
        await connected(fake, 2);
        await waitUntil(() => page.evaluate("document.getElementById('banner').hidden"), 'the banner goes away');
        // the button does the same
        fake.conns[1].drop();
        await waitUntil(() => page.evaluate("!document.getElementById('banner-retry').hidden"), 'the button');
        await click(page, '#banner-retry');
        await connected(fake, 3);
    });
});

test('a revoked or signed-out device does not reconnect: it explains and forgets the token', { skip: skipReason, timeout: 90000 }, async () => {
    await scenario({ role: 'write', timing: { backoff: [100], jitter: 0 } }, async ({ page, fake }) => {
        await ready(page, fake, 'hi');
        fake.conns[0].close(4430);
        await waitUntil(async () => /The owner removed this device/.test(await page.evaluate("document.getElementById('pair-text').textContent")), 'the revoked message');
        assert.equal(await page.evaluate("localStorage.getItem('oc.remote.session')"), null, 'the token is forgotten');
        await sleep(600);
        assert.equal(fake.conns.length, 1, 'no new connection');
        assert.equal(await page.evaluate("document.getElementById('main').hidden"), true);
    });
    await scenario({ role: 'write', timing: { backoff: [100], jitter: 0 }, seed: { token: 'not-the-token', deviceId: 'x', role: 'write' } }, async ({ page, fake }) => {
        await waitUntil(async () => /no longer signed in/.test(await page.evaluate("document.getElementById('pair-text').textContent")), 'the signed-out message');
        assert.equal(fake.conns.length, 1, 'tried once, was told 4401, stopped');
        assert.equal(await page.evaluate("localStorage.getItem('oc.remote.session')"), null);
    });
});

test('heartbeat: a ping every interval is answered; a socket that stops answering is replaced', { skip: skipReason, timeout: 90000 }, async () => {
    await scenario({ role: 'read', timing: { ping: 250, pongTimeout: 400, backoff: [100], jitter: 0 } }, async ({ page, fake }) => {
        await ready(page, fake, 'hi');
        await waitUntil(() => fake.conns[0].of('ping').length >= 3, 'three pings');
        const pings = fake.conns[0].of('ping').map((m) => m.n);
        assert.deepEqual(pings, pings.slice().sort((a, b) => a - b));
        assert.equal(new Set(pings).size, pings.length, 'every ping has its own number');
        assert.equal(fake.conns.length, 1, 'answered pings keep the connection');
        fake.autoPong = false;                    // the link is dead: no answer
        await connected(fake, 2);
        assert.ok(fake.conns[1].alive);
    });
});

// ---- safety, CSP, links ------------------------------------------------------------------------------------------------------------

test('under style-src \'self\' the terminal is still coloured (true colour and the palette), and no policy is violated', { skip: skipReason, timeout: 90000 }, async () => {
    await scenario({ role: 'read' }, async ({ page, fake }) => {
        await ready(page, fake, 'hi');
        fake.broadcast({ t: 'output', id: 1, data: '\x1b[38;2;255;0;0mTRUECOLOR\x1b[0m \x1b[31mPALETTE\x1b[0m \x1b[48;2;0;0;255m BLUEBG \x1b[0m\r\n' });
        await waitUntil(async () => (await screenText(page)).includes('TRUECOLOR'), 'the colours');
        const color = (word, property) => page.evaluate(`(() => { const span = Array.from(document.querySelectorAll('#term-host .xterm-rows span')).find((s) => s.textContent.includes(${JSON.stringify(word)})); return span ? getComputedStyle(span)[${JSON.stringify(property)}] : null; })()`);
        await waitUntil(async () => (await color('TRUECOLOR', 'color')) === 'rgb(255, 0, 0)', 'a true colour cell: ' + await color('TRUECOLOR', 'color'));
        assert.equal(await color('PALETTE', 'color'), 'rgb(205, 49, 49)', 'a palette colour from the style sheet of the theme');
        assert.equal(await color('BLUEBG', 'backgroundColor'), 'rgb(0, 0, 255)');
        assert.ok((await page.evaluate('document.adoptedStyleSheets.length')) > 0, 'the style of xterm.js came by CSSOM');
        assert.equal(await page.evaluate("document.querySelectorAll('style').length"), 0, 'no <style> element, the policy would refuse it');
    });
});

test('links: a http(s) address in the output can be opened (rel noopener noreferrer), anything else cannot, and OSC 52 does nothing', { skip: skipReason, timeout: 90000 }, async () => {
    await scenario({ role: 'read' }, async ({ page, fake }) => {
        await ready(page, fake, 'hi');
        fake.broadcast({ t: 'output', id: 1, data: 'Open https://example.com/login?code=ab12 now, or (https://example.org/x).\r\n' });
        await waitUntil(async () => (await screenText(page)).includes('example.org'), 'the output');
        const info = await page.evaluate(`(() => {
            const b = window.__ocRemote.term.buffer.active; let row = -1;
            for (let i = 0; i < b.length; i++) if (b.getLine(i).translateToString(true).includes('example.com')) row = i + 1;
            const links = window.__ocRemote.findLinks(row) || [];
            return links.map((l) => ({ text: l.text, start: l.range.start.x, end: l.range.end.x, y: l.range.start.y, row }));
        })()`);
        assert.equal(info.length, 2, JSON.stringify(info));
        assert.equal(info[0].text, 'https://example.com/login?code=ab12');
        assert.equal(info[0].start, 6, 'it starts where the address starts');
        assert.equal(info[0].end, 6 + 'https://example.com/login?code=ab12'.length - 1);
        assert.equal(info[1].text, 'https://example.org/x', 'the closing bracket and the dot are not part of the address');

        const opened = await page.evaluate(`(() => {
            const seen = [];
            const click = HTMLAnchorElement.prototype.click;
            HTMLAnchorElement.prototype.click = function () { seen.push({ href: this.href, rel: this.rel, target: this.target }); };
            const results = ['https://example.com/a', 'http://example.com/b', 'javascript:alert(1)', 'data:text/html,x', 'file:///c:/x', 'ftp://example.com', 'not an address'].map((u) => window.__ocRemote.openExternal(u));
            HTMLAnchorElement.prototype.click = click;
            return { results, seen };
        })()`);
        assert.deepEqual(opened.results, [true, true, false, false, false, false, false]);
        assert.equal(opened.seen.length, 2);
        for (const a of opened.seen) { assert.equal(a.rel, 'noopener noreferrer'); assert.equal(a.target, '_blank'); }

        // a program that tries to put text into the clipboard of the viewer (OSC 52): nothing happens, nothing is sent
        await page.evaluate("window.__clip = []; navigator.clipboard && (navigator.clipboard.writeText = (t) => { window.__clip.push(t); return Promise.resolve(); });");
        fake.broadcast({ t: 'output', id: 1, data: '\x1b]52;c;aGVsbG8=\x07after-osc52\r\n' });
        await waitUntil(async () => (await screenText(page)).includes('after-osc52'), 'the output after OSC 52');
        assert.deepEqual(await page.evaluate('window.__clip'), []);
        assert.ok(!(await screenText(page)).includes('aGVsbG8'), 'the sequence is not printed');
    });
});

// ---- against the real server (src/web/server.js) ---------------------------------------------------------------------------------

const realServerFile = path.join(__dirname, '..', 'src', 'web', 'server.js');

/** The real WebShareServer on a loopback port, a fake bridge to "the terminals of VS Code", and the real files of media/. */
async function startReal(role) {
    const { WebShareServer, CSP } = require(realServerFile);
    const bridge = {
        terms: new Map([[1, { id: 1, name: 'PowerShell', cols: 80, rows: 24, ring: 'PS C:\\> real server snapshot\r\n' }]]),
        writes: [],
        list() { return Array.from(this.terms.values()).map(({ id, name, cols, rows }) => ({ id, name, cols, rows })); },
        snapshot(id) { const t = this.terms.get(id); return t ? { cols: t.cols, rows: t.rows, data: t.ring } : null; },
        write(id, data) { if (!this.terms.has(id)) return false; this.writes.push(data); return true; },
    };
    const assets = (urlPath) => {
        if (urlPath === '/') return path.join(media, 'remote.html');
        const m = /^\/(app|vendor)\/([^/]+)$/.exec(urlPath);
        return m ? path.join(media, m[1] === 'vendor' ? 'vendor' : '.', m[2]) : null;
    };
    const server = new WebShareServer({ bridge, assets });
    const approvals = [];
    server.on('approval', (request) => { approvals.push(request); request.approve(role); });
    const { port } = await server.start({ port: 0 });
    const { secret } = server.newPairing();
    return { server, bridge, approvals, CSP, port, url: `http://127.0.0.1:${port}/`, hash: '#p=' + secret, notFound: [], close: () => server.stop() };
}

for (const role of ['write', 'read']) {
    test(`the real server (${role}): pairing, owner approval, snapshot, live output, resize, input and revocation`, { skip: skipReason || (!fs.existsSync(realServerFile) && 'src/web/server.js does not exist'), timeout: 90000 }, async () => {
        let real;
        await scenario({ server: async () => (real = await startReal(role)) }, async ({ page }) => {
            assert.equal(HEADERS['Content-Security-Policy'], real.CSP, 'the fake server of this test sends the same policy as the real one');
            await waitUntil(async () => (await screenText(page)).includes('real server snapshot'), 'the snapshot of the real server');
            assert.equal(real.approvals.length, 1);
            assert.ok(real.approvals[0].label.length > 0 && real.approvals[0].label.length <= 80, 'the label: ' + real.approvals[0].label);
            assert.equal(await page.evaluate('location.hash'), '');
            const badge = await page.evaluate("document.getElementById('badge').textContent");
            assert.equal(badge, role === 'write' ? 'Can type' : 'Read-only');

            real.server.output(1, 'live مرحبا\r\n');
            await waitUntil(async () => (await screenText(page)).includes('live مرحبا'), 'live output');
            real.bridge.terms.get(1).cols = 100;
            real.server.resize(1, 100, 30);
            await waitUntil(async () => (await page.evaluate('window.__ocRemote.term.cols')) === 100, 'the resize');
            real.server.title(1, 'renamed');
            await waitUntil(async () => (await page.evaluate("document.querySelector('#tabs .tab .name').textContent")) === 'renamed', 'the title');

            await page.evaluate('window.__ocRemote.term.focus()');
            await typeText(page, 'ok');
            real.server.output(1, '\x1b[c\x1b[6n');                      // xterm.js answers these when the page may type
            await sleep(500);
            if (role === 'write') {
                await waitUntil(() => real.bridge.writes.join('') === 'ok', 'the keys at the bridge: ' + JSON.stringify(real.bridge.writes));
                assert.deepEqual(await page.evaluate('window.__ocRemote.stats.dropped.length > 0'), true, 'the answers were produced and dropped by the page');
            } else assert.deepEqual(real.bridge.writes, [], 'a read-only device writes nothing');

            // the owner removes the device: the page explains and stays away
            const [device] = real.server.devices();
            assert.equal(device.role, role);
            real.server.revoke(device.deviceId);
            await waitUntil(async () => /The owner removed this device/.test(await page.evaluate("document.getElementById('pair-text').textContent")), 'the revoked message');
        });
    });
}

// ---- the phone ---------------------------------------------------------------------------------------------------------------------

const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };

async function touch(page, type, points) {
    await page.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: i + 1 })) });
}

test('phone: no sideways scroll, extra keys at the bottom of the screen, pinch changes the font, one finger scrolls the history', { skip: skipReason, timeout: 120000 }, async () => {
    await scenario({ role: 'write', metrics: PHONE }, async ({ page, fake }) => {
        await ready(page, fake, 'hi');
        // 200 lines of history
        fake.broadcast({ t: 'output', id: 1, data: Array.from({ length: 200 }, (_, i) => 'history line ' + i).join('\r\n') + '\r\n' });
        await waitUntil(async () => (await screenText(page)).includes('history line 199'), 'the history');
        const layout = await page.evaluate(`(() => {
            const rect = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; };
            const vv = window.visualViewport;
            return { scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, vvBottom: vv.offsetTop + vv.height, keys: rect('keys'), bar: rect('bar'), stage: rect('stage'), font: window.__ocRemote.fontSize,
                keyRects: Array.from(document.querySelectorAll('#keys button')).map((b) => { const r = b.getBoundingClientRect(); return [r.left, r.right, r.height]; }) };
        })()`);
        assert.ok(layout.scrollW <= layout.innerW, 'no sideways scroll: ' + JSON.stringify(layout));
        assert.ok(Math.abs(layout.keys.b - layout.vvBottom) <= 1, 'the keys are at the bottom of the visual viewport: ' + JSON.stringify(layout));
        assert.ok(layout.keyRects.every(([l, r, h]) => l >= 0 && r <= 390.5 && h >= 32), 'every key is inside the screen and big enough to tap');
        assert.ok(layout.font >= 10, 'a readable font: ' + layout.font);
        assert.ok(layout.stage.b <= layout.keys.t + 1, 'the stage does not run under the keys');

        // one finger drags the history (finger down = older lines)
        const top = () => page.evaluate('window.__ocRemote.term.buffer.active.viewportY');
        const bottomY = await top();
        const start = { x: 200, y: 250 };
        await touch(page, 'touchStart', [start]);
        for (let i = 1; i <= 10; i++) await touch(page, 'touchMove', [{ x: 200, y: 250 + i * 25 }]);
        await touch(page, 'touchEnd', []);
        await waitUntil(async () => (await top()) < bottomY - 5, 'the history scrolled back: ' + await top() + ' from ' + bottomY);
        // and forward again
        const scrolled = await top();
        await touch(page, 'touchStart', [{ x: 200, y: 500 }]);
        for (let i = 1; i <= 10; i++) await touch(page, 'touchMove', [{ x: 200, y: 500 - i * 25 }]);
        await touch(page, 'touchEnd', []);
        await waitUntil(async () => (await top()) > scrolled + 3, 'the history scrolled forward');

        // two fingers apart: a larger font, and the choice is kept
        const before = await page.evaluate('window.__ocRemote.fontSize');
        await touch(page, 'touchStart', [{ x: 150, y: 400 }, { x: 240, y: 400 }]);
        for (let i = 1; i <= 8; i++) await touch(page, 'touchMove', [{ x: 150 - i * 12, y: 400 }, { x: 240 + i * 12, y: 400 }]);
        await touch(page, 'touchEnd', []);
        await waitUntil(async () => (await page.evaluate('window.__ocRemote.fontSize')) > before + 3, 'a larger font after the pinch');
        const larger = await page.evaluate('window.__ocRemote.fontSize');
        assert.ok(larger <= 32);
        assert.equal(await page.evaluate("localStorage.getItem('oc.remote.font')"), String(larger));
        // fingers together: smaller
        await touch(page, 'touchStart', [{ x: 60, y: 400 }, { x: 330, y: 400 }]);
        for (let i = 1; i <= 8; i++) await touch(page, 'touchMove', [{ x: 60 + i * 20, y: 400 }, { x: 330 - i * 20, y: 400 }]);
        await touch(page, 'touchEnd', []);
        await waitUntil(async () => (await page.evaluate('window.__ocRemote.fontSize')) < larger - 3, 'a smaller font after the pinch');
        // the fit button gives the automatic size back
        await click(page, '#font-fit');
        await waitUntil(async () => (await page.evaluate('window.__ocRemote.fontSize')) === 10, 'the automatic size');
        assert.equal(await page.evaluate("localStorage.getItem('oc.remote.font')"), null);

        // a tap on the terminal focuses it (the soft keyboard of a phone comes up)
        await page.evaluate('window.__ocRemote.term.blur()');
        await touch(page, 'touchStart', [{ x: 200, y: 300 }]);
        await touch(page, 'touchEnd', []);
        await waitUntil(() => page.evaluate("document.activeElement === window.__ocRemote.term.textarea"), 'the focus after a tap');
    });
});

test('phone: a read-only page has no keys bar and no soft keyboard', { skip: skipReason, timeout: 90000 }, async () => {
    await scenario({ role: 'read', metrics: PHONE }, async ({ page, fake }) => {
        await ready(page, fake, 'hi');
        assert.equal(await page.evaluate("getComputedStyle(document.getElementById('keys')).display"), 'none');
        const layout = await page.evaluate(`(() => { const s = document.getElementById('stage').getBoundingClientRect(); const vv = window.visualViewport; return { b: s.bottom, vv: vv.offsetTop + vv.height }; })()`);
        assert.ok(Math.abs(layout.b - layout.vv) <= 1, 'the terminal takes the room of the keys: ' + JSON.stringify(layout));
        await page.evaluate('window.__ocRemote.term.blur()');
        await touch(page, 'touchStart', [{ x: 200, y: 300 }]);
        await touch(page, 'touchEnd', []);
        await sleep(200);
        assert.equal(await page.evaluate("window.__ocRemote.term.textarea.getAttribute('inputmode')"), 'none');
    });
});

// ---- screenshots -------------------------------------------------------------------------------------------------------------------

const shots = process.env.OC_SCREENSHOT_REMOTE;
test('screenshots of the page (OC_SCREENSHOT_REMOTE=<folder>)', { skip: skipReason || (!shots && 'set OC_SCREENSHOT_REMOTE=<folder> to keep screenshots'), timeout: 180000 }, async () => {
    fs.mkdirSync(shots, { recursive: true });
    const screen = [
        '\x1b[38;2;215;119;87m\u256d\u2500\u2500\u2500 Claude Code \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256e\x1b[0m',
        '\x1b[38;2;215;119;87m\u2502\x1b[0m \x1b[1mWelcome back!\x1b[0m                                \x1b[38;2;215;119;87m\u2502\x1b[0m',
        '\x1b[38;2;215;119;87m\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256f\x1b[0m',
        '',
        '\x1b[32mPS C:\\Users\\pc\\project>\x1b[0m git status',
        'On branch \x1b[36mmain\x1b[0m',
        '\x1b[31m\tmodified:   src/extension.js\x1b[0m',
        '\x1b[32m\tnew file:   media/remote.js\x1b[0m',
        '',
        '\x1b[1;34m>\x1b[0m \u0627\u0643\u062a\u0628 \u0644\u064a \u062f\u0627\u0644\u0629 \u062a\u0642\u0644\u0628 \u0627\u0644\u0646\u0635',
        '\u0627\u0644\u0646\u062a\u064a\u062c\u0629: \u062a\u0645 \u0625\u0646\u0634\u0627\u0621 \u0627\u0644\u062f\u0627\u0644\u0629 \x1b[33mreverse(text)\x1b[0m \u0628\u0646\u062c\u0627\u062d',
        'mixed: abc \u062b\u0645 def 123',
        '',
        '\x1b[32mPS C:\\Users\\pc\\project>\x1b[0m ',
    ].join('\r\n');
    const run = async (name, options) => {
        await scenario(Object.assign({ snapshots: { 1: screen, 2: 'second\r\n', 3: 'third\r\n' }, terminals: [{ id: 1, name: 'PowerShell', cols: 80, rows: 24 }, { id: 2, name: 'claude', cols: 100, rows: 30 }, { id: 3, name: 'pi', cols: 90, rows: 24 }] }, options), async ({ page, fake }) => {
            await ready(page, fake, 'git status');
            fake.broadcast({ t: 'state', id: 2, state: 'working', attention: false });
            fake.broadcast({ t: 'state', id: 3, state: 'blocked', attention: true });
            await sleep(900);
            await screenshot(page, path.join(shots, name + '.png'));
        });
    };
    await run('remote-desktop-write', { role: 'write', metrics: { width: 1100, height: 720, deviceScaleFactor: 1, mobile: false } });
    await run('remote-desktop-read', { role: 'read', metrics: { width: 1100, height: 720, deviceScaleFactor: 1, mobile: false } });
    await run('remote-phone-write', { role: 'write', metrics: PHONE });
    await run('remote-phone-read', { role: 'read', metrics: PHONE });
    await run('remote-phone-arabic', { role: 'write', metrics: PHONE, acceptLanguage: 'ar-SA' });
    await scenario({ seed: false, hash: '#p=' + base64url(), pairDelay: 6000, metrics: PHONE }, async ({ page }) => {
        await waitUntil(async () => /Waiting/.test(await page.evaluate("document.getElementById('pair-text').textContent")), 'the waiting screen');
        await sleep(1200);
        await screenshot(page, path.join(shots, 'remote-phone-pairing.png'));
    });
    await scenario({ role: 'write', metrics: PHONE, timing: { backoff: [60000], jitter: 0 }, snapshots: { 1: screen } }, async ({ page, fake }) => {
        await ready(page, fake, 'git status');
        fake.conns[0].drop();
        await waitUntil(async () => /Reconnecting/.test(await page.evaluate("document.getElementById('banner-text').textContent")), 'the banner');
        await sleep(300);
        await screenshot(page, path.join(shots, 'remote-phone-disconnected.png'));
    });
});
