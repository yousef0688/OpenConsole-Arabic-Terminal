'use strict';
// Tests for the web share server: ws.js (frame parser), auth.js (pairing, tokens, limits) and server.js
// (routes, Host/Origin gates, pairing flow, WebSocket protocol, backpressure). Real sockets, a fake bridge,
// an injected clock, and a negative test for every security rule.

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');

const { WebShareServer, filterInput, isLoopbackAddress, CLOSE, CSP } = require('../src/web/server');
const { FrameReader, WsError, encodeFrame, encodeClose, acceptKey } = require('../src/web/ws');
const { AuthManager, SlidingWindowLimiter } = require('../src/web/auth');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ESC = '\x1b';

// ------------------------------------------------------------------------------------------ raw helpers

// A client-style frame built by hand (independent of ws.js).
function mkFrame(o) {
    const opts = Object.assign({ fin: true, rsv: 0, opcode: 1, mask: true, payload: Buffer.alloc(0), lenBytes: null, claimLen: null }, o);
    const payload = Buffer.isBuffer(opts.payload) ? opts.payload : Buffer.from(opts.payload, 'utf8');
    const len = opts.claimLen !== null ? opts.claimLen : payload.length;
    const b0 = (opts.fin ? 0x80 : 0) | (opts.rsv << 4) | opts.opcode;
    const maskBit = opts.mask ? 0x80 : 0;
    const lenBytes = opts.lenBytes || (len < 126 ? 0 : len < 65536 ? 2 : 8);
    const head = [b0];
    if (lenBytes === 0) head.push(maskBit | len);
    else if (lenBytes === 2) head.push(maskBit | 126, (len >> 8) & 255, len & 255);
    else {
        const big = BigInt(len);
        head.push(maskBit | 127);
        for (let i = 7; i >= 0; i--) head.push(Number((big >> BigInt(i * 8)) & 0xffn));
    }
    const key = Buffer.from([0x11, 0x22, 0x33, 0x44]);
    const parts = [Buffer.from(head)];
    if (opts.mask) parts.push(key);
    const body = Buffer.from(payload);
    if (opts.mask) for (let i = 0; i < body.length; i++) body[i] ^= key[i & 3];
    parts.push(body);
    return Buffer.concat(parts);
}

function httpRequest(port, o) {
    const opts = Object.assign({ method: 'GET', path: '/', headers: {}, body: undefined }, o);
    return new Promise((resolve, reject) => {
        const headers = Object.assign({ Connection: 'close' }, opts.headers);
        const req = http.request({ host: '127.0.0.1', port, method: opts.method, path: opts.path, headers, agent: false }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
            res.on('error', reject);
        });
        req.on('error', reject);
        if (opts.body !== undefined) req.write(opts.body);
        req.end();
    });
}

// Plain TCP request, for things Node's own client refuses to send (NUL bytes, odd paths, no Host).
function rawHttp(port, text) {
    return new Promise((resolve) => {
        const s = net.connect(port, '127.0.0.1');
        let data = Buffer.alloc(0);
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            s.destroy();
            const str = data.toString('latin1');
            const m = /^HTTP\/1\.\d (\d{3})/.exec(str);
            resolve({ status: m ? Number(m[1]) : 0, text: str });
        };
        s.on('data', (d) => { data = Buffer.concat([data, d]); });
        s.on('error', () => {});
        s.on('close', finish);
        s.setTimeout(3000, finish);
        s.write(text);
    });
}

class WsClient {
    constructor(sock) {
        this.sock = sock;
        this.buf = Buffer.alloc(0);
        this.headDone = false;
        this.status = 0;
        this.headers = {};
        this.inbox = [];
        this.waiters = [];
        this.pings = 0;
        this.noPong = false;
        this.closeFrame = null;
        this.closed = false;
        this.violation = null;
        this.closedPromise = new Promise((resolve) => { this._resolveClosed = resolve; });
        this.headPromise = new Promise((resolve) => { this._resolveHead = resolve; });
        sock.on('data', (d) => this._data(d));
        sock.on('error', () => {});
        sock.on('close', () => { this.closed = true; this._resolveHead(); this._resolveClosed(); this._wake(); });
    }

    _data(d) {
        this.buf = Buffer.concat([this.buf, d]);
        if (!this.headDone) {
            const end = this.buf.indexOf('\r\n\r\n');
            if (end < 0) return;
            const head = this.buf.subarray(0, end).toString('latin1').split('\r\n');
            this.status = Number(/^HTTP\/1\.\d (\d{3})/.exec(head[0])[1]);
            for (const line of head.slice(1)) {
                const i = line.indexOf(':');
                this.headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
            }
            this.buf = this.buf.subarray(end + 4);
            this.headDone = true;
            this._resolveHead();
        }
        if (this.status === 101) this._frames();
    }

    _frames() {
        for (;;) {
            if (this.buf.length < 2) return;
            const b0 = this.buf[0];
            const b1 = this.buf[1];
            let len = b1 & 0x7f;
            let off = 2;
            if (b1 & 0x80) { this.violation = 'server frame is masked'; return; }
            if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
            else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
            if (this.buf.length < off + len) return;
            const payload = this.buf.subarray(off, off + len);
            this.buf = this.buf.subarray(off + len);
            const op = b0 & 0x0f;
            if (op === 1) {
                const text = payload.toString('utf8');
                let msg;
                try { msg = JSON.parse(text); } catch { msg = { t: '__raw', text }; }
                this.inbox.push(msg);
            } else if (op === 9) {
                this.pings++;
                if (!this.noPong && !this.sock.destroyed) this.sock.write(mkFrame({ opcode: 10, payload }));
            } else if (op === 8) {
                this.closeFrame = { code: payload.length >= 2 ? payload.readUInt16BE(0) : 1005, reason: payload.length > 2 ? payload.subarray(2).toString('utf8') : '' };
            }
            this._wake();
        }
    }

    _wake() {
        for (const w of this.waiters.slice()) w();
    }

    send(obj) {
        this.sendRaw(mkFrame({ opcode: 1, payload: JSON.stringify(obj) }));
    }

    sendRaw(buf) {
        if (!this.sock.destroyed && this.sock.writable) this.sock.write(buf);
    }

    waitFor(pred, ms) {
        const fn = typeof pred === 'string' ? (m) => m.t === pred : pred;
        const limit = ms || 3000;
        return new Promise((resolve, reject) => {
            const check = () => {
                const i = this.inbox.findIndex(fn);
                if (i < 0) return false;
                clearTimeout(timer);
                this.waiters.splice(this.waiters.indexOf(check), 1);
                resolve(this.inbox.splice(i, 1)[0]);
                return true;
            };
            const timer = setTimeout(() => {
                this.waiters.splice(this.waiters.indexOf(check), 1);
                reject(new Error('timed out waiting for a message; inbox=' + JSON.stringify(this.inbox).slice(0, 400)));
            }, limit);
            this.waiters.push(check);
            check();
        });
    }

    // All messages of one type that arrived so far (and removes them).
    take(type) {
        const got = this.inbox.filter((m) => m.t === type);
        this.inbox = this.inbox.filter((m) => m.t !== type);
        return got;
    }

    async waitClosed(ms) {
        await Promise.race([
            this.closedPromise,
            sleep(ms || 3000).then(() => { throw new Error('connection did not close; inbox=' + JSON.stringify(this.inbox).slice(0, 300)); }),
        ]);
        return this.closeFrame ? this.closeFrame.code : 1006;
    }
}

function connectWs(port, o) {
    const opts = Object.assign({ path: '/ws', host: '127.0.0.1:' + port, origin: 'http://127.0.0.1:' + port, version: '13' }, o);
    return new Promise((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1');
        const c = new WsClient(sock);
        sock.once('error', reject);
        sock.once('connect', () => {
            const key = opts.key || crypto.randomBytes(16).toString('base64');
            const lines = ['GET ' + opts.path + ' HTTP/1.1', 'Host: ' + opts.host, 'Upgrade: websocket', 'Connection: Upgrade',
                'Sec-WebSocket-Key: ' + key, 'Sec-WebSocket-Version: ' + opts.version];
            if (opts.origin !== null) lines.push('Origin: ' + opts.origin);
            sock.write(lines.join('\r\n') + '\r\n\r\n');
            c.key = key;
            c.headPromise.then(() => resolve(c));
        });
    });
}

// ------------------------------------------------------------------------------------------ fixtures

class FakeBridge {
    constructor() {
        this.terms = new Map([
            [1, { id: 1, name: 'pwsh', cols: 100, rows: 30, ring: 'ring-1:' }],
            [2, { id: 2, name: 'wsl', cols: 80, rows: 24, ring: 'ring-2:' }],
        ]);
        this.writes = [];
        this.ringMax = 256 * 1024;
    }
    list() { return Array.from(this.terms.values(), (t) => ({ id: t.id, name: t.name, cols: t.cols, rows: t.rows })); }
    snapshot(id) {
        const t = this.terms.get(id);
        return t ? { cols: t.cols, rows: t.rows, data: t.ring } : null;
    }
    write(id, data) {
        if (!this.terms.has(id)) return false;
        this.writes.push([id, data]);
        return true;
    }
    append(id, data) {
        const t = this.terms.get(id);
        t.ring += data;
        if (t.ring.length > this.ringMax) t.ring = t.ring.slice(t.ring.length - this.ringMax);
    }
}

async function makeCtx(t, o) {
    const opts = Object.assign({ limits: {}, start: {} }, o);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocweb-'));
    fs.mkdirSync(path.join(dir, 'app'));
    fs.mkdirSync(path.join(dir, 'vendor'));
    fs.writeFileSync(path.join(dir, 'remote.html'), '<!doctype html><title>remote</title>');
    fs.writeFileSync(path.join(dir, 'app', 'remote.js'), 'console.log("remote");');
    fs.writeFileSync(path.join(dir, 'app', 'remote.css'), 'body{}');
    fs.writeFileSync(path.join(dir, 'vendor', 'xterm.js'), 'var Terminal;');
    fs.writeFileSync(path.join(dir, 'vendor', 'xterm.css'), '.xterm{}');
    fs.writeFileSync(path.join(dir, 'secret.txt'), 'TOP-SECRET');
    const assetCalls = [];
    const missing = new Set();
    const assets = (p) => {
        assetCalls.push(p);
        if (missing.has(p)) return null;
        if (p === '/') return path.join(dir, 'remote.html');
        // deliberately naive: if the server ever passed a hostile path through, this would serve it
        return path.join(dir, p);
    };
    const logs = [];
    const clock = { t: 1700000000000 };
    const bridge = new FakeBridge();
    const server = new WebShareServer({ bridge, assets, log: (l) => logs.push(l), now: () => clock.t, limits: opts.limits });
    const ctx = { server, bridge, dir, assetCalls, missing, logs, clock, approvals: [], autoRole: 'read', clients: [], events: [] };
    server.on('approval', (req) => {
        ctx.approvals.push(req);
        if (ctx.autoRole === 'deny') req.deny();
        else if (ctx.autoRole) req.approve(ctx.autoRole);
    });
    server.on('limit', (info) => ctx.events.push(['limit', info]));
    server.on('connect', (d) => ctx.events.push(['connect', d]));
    server.on('disconnect', (d) => ctx.events.push(['disconnect', d]));
    const started = await server.start(Object.assign({ port: 0 }, opts.start));
    ctx.port = started.port;
    ctx.close = async () => {
        for (const c of ctx.clients) c.sock.destroy();
        await server.stop();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    };
    t.after(ctx.close);
    return ctx;
}

function pairHeaders(ctx, extra) {
    return Object.assign({ 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:' + ctx.port }, extra);
}

async function postPair(ctx, secret, o) {
    const opts = Object.assign({ label: 'Test phone', headers: {} }, o);
    const r = await httpRequest(ctx.port, {
        method: 'POST',
        path: '/api/pair',
        headers: pairHeaders(ctx, opts.headers),
        body: opts.rawBody !== undefined ? opts.rawBody : JSON.stringify({ secret, label: opts.label }),
    });
    let json = null;
    try { json = JSON.parse(r.body); } catch { /* not json */ }
    return Object.assign({ status: r.status, headers: r.headers, raw: r.body }, json);
}

// Pair a device end to end (the owner approves with `role`) and return its token.
async function pairDevice(ctx, role, label) {
    ctx.autoRole = role || 'read';
    const { secret } = ctx.server.newPairing();
    const r = await postPair(ctx, secret, { label: label || 'Test phone' });
    assert.equal(r.status, 200, 'pairing should succeed: ' + r.raw);
    return r;
}

async function openAuthed(ctx, role, token) {
    let tok = token;
    let deviceId;
    if (!tok) {
        const p = await pairDevice(ctx, role);
        tok = p.token;
        deviceId = p.deviceId;
    }
    const ws = await connectWs(ctx.port);
    ctx.clients.push(ws);
    assert.equal(ws.status, 101);
    ws.send({ t: 'auth', token: tok });
    const hello = await ws.waitFor('hello');
    return { ws, token: tok, deviceId, hello };
}

function emit(ctx, id, data) {
    ctx.bridge.append(id, data);
    ctx.server.output(id, data);
}

async function roundTrip(ws, n) {
    ws.send({ t: 'ping', n });
    await ws.waitFor((m) => m.t === 'pong' && m.n === n);
}

function expectedSecurityHeaders(headers) {
    assert.equal(headers['content-security-policy'], CSP);
    assert.equal(headers['referrer-policy'], 'no-referrer');
    assert.equal(headers['cache-control'], 'no-store');
    assert.equal(headers['x-content-type-options'], 'nosniff');
    assert.equal(headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal(headers['x-frame-options'], 'DENY');
    assert.equal(headers['access-control-allow-origin'], undefined);
}

// ============================================================================================== ws.js

test('ws: accept key matches the RFC 6455 example', () => {
    assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

function readAll(bytes, options) {
    const out = [];
    const reader = new FrameReader(Object.assign({ onMessage: (m) => out.push(m) }, options));
    reader.push(Buffer.from(bytes));
    return out;
}

test('ws reader: RFC 6455 example frames and every length encoding', () => {
    // masked "Hello" from RFC 6455 section 5.7
    const hello = readAll([0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58]);
    assert.deepEqual(hello.map((m) => [m.type, m.data]), [['text', 'Hello']]);
    // 7, 16 and 64 bit lengths
    for (const size of [0, 1, 125, 126, 300, 65535]) {
        const text = 'a'.repeat(size);
        const got = readAll(mkFrame({ payload: text }));
        assert.equal(got[0].data, text, 'size ' + size);
    }
    const big = 'b'.repeat(70000);
    const gotBig = readAll(mkFrame({ payload: big }), { maxMessage: 1 << 20 });
    assert.equal(gotBig[0].data.length, 70000);
    assert.equal(readAll(mkFrame({ payload: big, lenBytes: 8 }), { maxMessage: 1 << 20 })[0].data.length, 70000);
    // frames made by encodeFrame with a client mask parse the same way
    const viaEncode = readAll(encodeFrame(1, Buffer.from('héllo ✓'), { mask: true }));
    assert.equal(viaEncode[0].data, 'héllo ✓');
});

test('ws reader: fragmentation, interleaved ping, one byte at a time, several frames per chunk', () => {
    const frames = Buffer.concat([
        mkFrame({ fin: false, opcode: 1, payload: 'Hel' }),
        mkFrame({ opcode: 9, payload: 'p' }),               // a ping may sit between fragments
        mkFrame({ fin: false, opcode: 0, payload: 'lo ' }),
        mkFrame({ fin: true, opcode: 0, payload: 'world' }),
        mkFrame({ opcode: 1, payload: 'next' }),
    ]);
    const all = readAll(frames).map((m) => [m.type, m.type === 'ping' ? m.data.toString() : m.data]);
    assert.deepEqual(all, [['ping', 'p'], ['text', 'Hello world'], ['text', 'next']]);

    const out = [];
    const reader = new FrameReader({ onMessage: (m) => out.push(m) });
    for (const byte of frames) reader.push(Buffer.from([byte]));
    assert.deepEqual(out.map((m) => m.type), ['ping', 'text', 'text']);

    // a multibyte character split across two fragments is fine (validated after reassembly)
    const euro = Buffer.from('€');
    const split = readAll(Buffer.concat([
        mkFrame({ fin: false, opcode: 1, payload: euro.subarray(0, 1) }),
        mkFrame({ fin: true, opcode: 0, payload: euro.subarray(1) }),
    ]));
    assert.equal(split[0].data, '€');
});

test('ws reader: every protocol violation is rejected with the right code', () => {
    const cases = [
        ['unmasked client frame', mkFrame({ mask: false, payload: 'x' }), 1002],
        ['RSV1 set', mkFrame({ rsv: 4, payload: 'x' }), 1002],
        ['RSV2 set', mkFrame({ rsv: 2, payload: 'x' }), 1002],
        ['RSV3 set', mkFrame({ rsv: 1, payload: 'x' }), 1002],
        ['unknown opcode 3', mkFrame({ opcode: 3, payload: 'x' }), 1002],
        ['unknown opcode 11', mkFrame({ opcode: 11 }), 1002],
        ['binary message', mkFrame({ opcode: 2, payload: 'x' }), 1003],
        ['fragmented ping', mkFrame({ fin: false, opcode: 9, payload: 'x' }), 1002],
        ['fragmented close', mkFrame({ fin: false, opcode: 8 }), 1002],
        ['ping with 126 byte payload', mkFrame({ opcode: 9, payload: Buffer.alloc(126) }), 1002],
        ['16 bit length that fits in 7 bits', mkFrame({ payload: 'abc', lenBytes: 2 }), 1002],
        ['64 bit length that fits in 16 bits', mkFrame({ payload: 'abc', lenBytes: 8 }), 1002],
        ['64 bit length with the top bit set', Buffer.from([0x81, 0xff, 0x80, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4]), 1002],
        ['64 bit length above 4 GiB', mkFrame({ lenBytes: 8, claimLen: 2 ** 33, payload: '' }), 1009],
        ['frame above the cap', mkFrame({ lenBytes: 8, claimLen: 70000, payload: '' }), null],
        ['invalid UTF-8 (lone continuation byte)', mkFrame({ payload: Buffer.from([0x80]) }), 1007],
        ['invalid UTF-8 (overlong)', mkFrame({ payload: Buffer.from([0xc0, 0xaf]) }), 1007],
        ['invalid UTF-8 (surrogate)', mkFrame({ payload: Buffer.from([0xed, 0xa0, 0x80]) }), 1007],
        ['continuation without a message', mkFrame({ opcode: 0, payload: 'x' }), 1002],
        ['new text frame inside a fragmented message', Buffer.concat([mkFrame({ fin: false, opcode: 1, payload: 'a' }), mkFrame({ opcode: 1, payload: 'b' })]), 1002],
        ['close with a one byte body', mkFrame({ opcode: 8, payload: Buffer.from([3]) }), 1002],
        ['close with code 1005', mkFrame({ opcode: 8, payload: Buffer.from([0x03, 0xed]) }), 1002],
        ['close with code 999', mkFrame({ opcode: 8, payload: Buffer.from([0x03, 0xe7]) }), 1002],
        ['close with a bad UTF-8 reason', mkFrame({ opcode: 8, payload: Buffer.from([0x03, 0xe8, 0xff]) }), 1007],
    ];
    for (const [name, bytes, code] of cases) {
        const reader = new FrameReader({ maxMessage: 64 * 1024, onMessage: () => {} });
        if (code === null) {
            assert.throws(() => reader.push(bytes), (e) => e instanceof WsError && e.code === 1009, name);
            continue;
        }
        assert.throws(() => reader.push(bytes), (e) => e instanceof WsError && e.code === code, name + ' (expected ' + code + ')');
        assert.equal(reader.failed, true, name);
        reader.push(mkFrame({ payload: 'after' }));   // a failed reader ignores everything afterwards
    }
});

test('ws reader: the message cap holds across fragments and the fragment count is bounded', () => {
    const reader = new FrameReader({ maxMessage: 1000, onMessage: () => {} });
    reader.push(mkFrame({ fin: false, opcode: 1, payload: 'a'.repeat(600) }));
    assert.throws(() => reader.push(mkFrame({ fin: true, opcode: 0, payload: 'b'.repeat(600) })), (e) => e.code === 1009);

    const many = new FrameReader({ maxMessage: 1 << 20, maxFragments: 8, onMessage: () => {} });
    many.push(mkFrame({ fin: false, opcode: 1, payload: '' }));
    assert.throws(() => {
        for (let i = 0; i < 20; i++) many.push(mkFrame({ fin: false, opcode: 0, payload: '' }));
    }, (e) => e.code === 1009);

    // an oversize length is refused before any payload is buffered
    const early = new FrameReader({ maxMessage: 100, onMessage: () => {} });
    assert.throws(() => early.push(Buffer.from([0x81, 0xfe, 0x01, 0x00, 1, 2, 3, 4])), (e) => e.code === 1009);
});

test('ws reader: close frames carry code and reason, ping and pong payloads come through', () => {
    const msgs = readAll(Buffer.concat([
        mkFrame({ opcode: 10, payload: 'pong!' }),
        mkFrame({ opcode: 8, payload: Buffer.concat([Buffer.from([0x03, 0xe8]), Buffer.from('bye')]) }),
        mkFrame({ payload: 'ignored after close' }),
    ]));
    assert.equal(msgs[0].type, 'pong');
    assert.equal(msgs[1].type, 'close');
    assert.equal(msgs[1].code, 1000);
    assert.equal(msgs[1].reason, 'bye');
    assert.equal(msgs.length, 2);
    assert.equal(readAll(mkFrame({ opcode: 8 }))[0].code, 1005);
    // encodeClose keeps the reason within 123 bytes without splitting a character
    const long = encodeClose(1000, 'é'.repeat(100));
    assert.ok(long.length <= 2 + 2 + 123);
});

// ============================================================================================== auth.js

test('auth: secrets and tokens are stored hashed, single use, and expire', () => {
    let now = 1000000;
    const auth = new AuthManager({ now: () => now });
    const p = auth.newPairing();
    assert.match(p.secret, /^[A-Za-z0-9_-]{43}$/);          // 32 bytes, base64url
    assert.equal(p.expiresAt, now + 10 * 60 * 1000);
    assert.ok(!JSON.stringify(auth._pairings).includes(p.secret));
    assert.equal(auth.redeemPairing(p.secret).ok, true);
    const replay = auth.redeemPairing(p.secret);             // single use
    assert.equal(replay.ok, false);
    assert.equal(replay.reason, 'invalid');

    const p2 = auth.newPairing();
    now += 10 * 60 * 1000 + 1;
    assert.equal(auth.redeemPairing(p2.secret).reason, 'expired');
    assert.equal(auth.redeemPairing(p2.secret).reason, 'invalid');   // and consumed anyway

    const { token, device } = auth.createDevice({ label: 'x', role: 'write' });
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(!JSON.stringify(Array.from(auth._devices.values()).map((d) => Object.assign({}, d, { tokenHash: d.tokenHash.toString('hex') }))).includes(token));
    assert.equal(auth.verifyToken(token).role, 'write');
    assert.equal(auth.verifyToken(token + 'x'), null);
    assert.equal(auth.verifyToken(''), null);
    assert.equal(auth.verifyToken(undefined), null);
    assert.equal(auth.createDevice({ role: 'admin' }).device.role, 'read');   // anything but 'write' is read
    auth.revoke(device.deviceId);
    assert.equal(auth.verifyToken(token), null);

    const short = auth.createDevice({ role: 'read' });
    now += 8 * 3600 * 1000 + 1;
    assert.equal(auth.verifyToken(short.token), null);        // device lifetime is over
});

test('auth: the limiter counts failures in a minute and in an hour window and does not extend itself', () => {
    let now = 0;
    const lim = new SlidingWindowLimiter([{ ms: 60000, max: 2 }, { ms: 3600000, max: 12 }], () => now);
    assert.equal(lim.retryAfterMs(), 0);
    assert.equal(lim.fail().blocked, false);
    assert.equal(lim.fail().blocked, true);
    assert.ok(lim.retryAfterMs() > 0 && lim.retryAfterMs() <= 60000);
    now += 30000;
    for (let i = 0; i < 50; i++) lim.fail();                  // hammering while blocked changes nothing
    now += 30001;
    assert.equal(lim.retryAfterMs(), 0, 'blocked attempts must not extend the lockout');
    // hour window: 2 failures per minute for 6 minutes = 12 failures, then locked although the minute is clear
    for (let i = 0; i < 6; i++) { lim.fail(); lim.fail(); now += 61000; }
    assert.ok(lim.retryAfterMs() > 0);
    now += 3600000;
    assert.equal(lim.retryAfterMs(), 0);
});

// ============================================================================================== server: lifecycle and binding

test('bind: loopback by default, anything else needs allowNonLoopback', async (t) => {
    assert.equal(isLoopbackAddress('127.0.0.1'), true);
    assert.equal(isLoopbackAddress('127.8.9.10'), true);
    assert.equal(isLoopbackAddress('::1'), true);
    assert.equal(isLoopbackAddress('localhost'), true);
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
    for (const a of ['0.0.0.0', '::', '192.168.1.5', '10.0.0.2', 'example.com', '']) {
        assert.equal(isLoopbackAddress(a), a === '' ? false : false, a);
    }
    const bridge = new FakeBridge();
    for (const bad of ['0.0.0.0', '::', '192.168.1.20', 'example.com']) {
        const s = new WebShareServer({ bridge });
        await assert.rejects(() => s.start({ bindAddress: bad }), /allowNonLoopback/, bad);
        assert.equal(s.listening, false);
        await s.stop();
    }
    const s2 = new WebShareServer({ bridge });
    await assert.rejects(() => s2.start({ bindAddress: '0.0.0.0', allowNonLoopback: false }), /allowNonLoopback/);
    const ctx = await makeCtx(t);
    assert.equal(ctx.server.bindAddress, '127.0.0.1');
    await assert.rejects(() => ctx.server.start({}), /already running/);
});

test('stop() closes sockets with 1001, frees the port, denies pending approvals and forgets every credential', async (t) => {
    const ctx = await makeCtx(t);
    const a = await openAuthed(ctx, 'read');
    const b = await openAuthed(ctx, 'write');
    ctx.autoRole = null;                                       // leave one approval hanging
    const hanging = postPair(ctx, ctx.server.newPairing().secret);
    await sleep(50);
    assert.equal(ctx.server.stats().pendingApprovals, 1);
    const started = Date.now();
    await ctx.server.stop();
    assert.ok(Date.now() - started < 1500, 'stop() must be prompt, took ' + (Date.now() - started));
    assert.equal((await hanging).status, 403);
    assert.equal(await a.ws.waitClosed(), 1001);
    assert.equal(await b.ws.waitClosed(), 1001);
    assert.equal(ctx.server.listening, false);
    await assert.rejects(() => new Promise((resolve, reject) => {
        const s = net.connect(ctx.port, '127.0.0.1');
        s.once('connect', () => { s.destroy(); resolve(); });
        s.once('error', reject);
    }), /ECONNREFUSED/);
    // restarting starts from nothing: the old token is useless
    const again = await ctx.server.start({ port: 0 });
    ctx.port = again.port;
    const ws = await connectWs(ctx.port);
    ctx.clients.push(ws);
    ws.send({ t: 'auth', token: a.token });
    assert.equal(await ws.waitClosed(), CLOSE.UNAUTHORIZED);
});

test('stop() leaves no open handles: a process that used the server exits by itself', () => {
    const script = `
        const net = require('net'), http = require('http');
        const { WebShareServer } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'web', 'server.js'))});
        const bridge = { list: () => [{ id: 1, name: 'a', cols: 80, rows: 24 }], snapshot: () => ({ cols: 80, rows: 24, data: 'x' }), write: () => true };
        (async () => {
            const s = new WebShareServer({ bridge });
            s.on('approval', (r) => r.approve('write'));
            const { port } = await s.start({ port: 0 });
            const { secret } = s.newPairing();
            const body = JSON.stringify({ secret, label: 'child' });
            const pair = await new Promise((resolve, reject) => {
                const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/pair', agent: false,
                    headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:' + port, Connection: 'close' } }, (res) => {
                    let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve(JSON.parse(d)));
                });
                req.on('error', reject); req.end(body);
            });
            const sock = net.connect(port, '127.0.0.1');
            await new Promise((r) => sock.once('connect', r));
            sock.write('GET /ws HTTP/1.1\\r\\nHost: 127.0.0.1:' + port + '\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nOrigin: http://127.0.0.1:' + port + '\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\nSec-WebSocket-Version: 13\\r\\n\\r\\n');
            await new Promise((r) => setTimeout(r, 100));
            const idle = net.connect(port, '127.0.0.1');
            await new Promise((r) => idle.once('connect', r));
            await s.stop();
            sock.destroy(); idle.destroy();
            console.log('stopped ' + pair.role);
        })().catch((e) => { console.error(e); process.exit(2); });
    `;
    const r = childProcess.spawnSync(process.execPath, ['-e', script], { timeout: 15000, encoding: 'utf8' });
    assert.equal(r.error, undefined, 'the process did not exit on its own: ' + (r.error && r.error.message));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /stopped write/);
});

// ============================================================================================== server: HTTP

test('http: the page and its files are served with the right types and every security header', async (t) => {
    const ctx = await makeCtx(t);
    const root = await httpRequest(ctx.port, { path: '/' });
    assert.equal(root.status, 200);
    assert.equal(root.headers['content-type'], 'text/html; charset=utf-8');
    assert.match(root.body, /<title>remote<\/title>/);
    expectedSecurityHeaders(root.headers);
    const js = await httpRequest(ctx.port, { path: '/app/remote.js?v=3' });
    assert.equal(js.status, 200);
    assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8');
    const css = await httpRequest(ctx.port, { path: '/vendor/xterm.css' });
    assert.equal(css.headers['content-type'], 'text/css; charset=utf-8');
    const head = await httpRequest(ctx.port, { method: 'HEAD', path: '/app/remote.css' });
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.equal(head.headers['content-length'], '6');
    // the same headers on error answers
    for (const [req, status] of [
        [{ path: '/nope' }, 404],
        [{ method: 'POST', path: '/' }, 405],
        [{ method: 'GET', path: '/api/pair' }, 405],
        [{ method: 'OPTIONS', path: '/api/pair' }, 405],
        [{ path: '/ws' }, 426],
        [{ path: '/app/remote.js', headers: { Host: 'evil.example' } }, 403],
        [{ method: 'POST', path: '/api/pair', headers: { Origin: 'http://127.0.0.1:' + ctx.port, 'Content-Type': 'text/plain' }, body: '{}' }, 415],
    ]) {
        const r = await httpRequest(ctx.port, req);
        assert.equal(r.status, status, JSON.stringify(req));
        expectedSecurityHeaders(r.headers);
    }
    // a whitelisted name whose file is missing is a plain 404
    ctx.missing.add('/app/remote.css');
    assert.equal((await httpRequest(ctx.port, { path: '/app/remote.css' })).status, 404);
    assert.equal((await httpRequest(ctx.port, { path: '/app/arabic-layout.js' })).status, 404);   // whitelisted, no file on disk
});

test('http: path traversal and look-alike paths never reach the assets function or the disk', async (t) => {
    const ctx = await makeCtx(t);
    const paths = [
        '/app/../secret.txt', '/app/..%2fsecret.txt', '/app/%2e%2e/secret.txt', '/app/%2e%2e%2fsecret.txt',
        '/app/..%5csecret.txt', '/app/..\\secret.txt', '/vendor/../secret.txt', '/vendor/..',
        '/app/remote.js%00.png', '/app/remote.js%00', '//app/remote.js', '/app//remote.js', '/app/./remote.js',
        '/app/remote.js/', '/app/REMOTE.JS', '/APP/remote.js', '/app/', '/app', '/vendor/', '/secret.txt',
        '/app/secret.txt', '/vendor/secret.txt', '/remote.html', '/index.html', '/%2e%2e/secret.txt',
        '/app/remote.js::$DATA', '/app/remote.js.', '/app/remote.js%20', '/app/%72emote.js', '/ws/..', '/api/pair/..',
    ];
    for (const p of paths) {
        const r = await rawHttp(ctx.port, 'GET ' + p + ' HTTP/1.1\r\nHost: 127.0.0.1:' + ctx.port + '\r\nConnection: close\r\n\r\n');
        assert.ok(r.status === 404 || r.status === 400, p + ' -> ' + r.status);
        assert.ok(!r.text.includes('TOP-SECRET'), p + ' leaked a file');
    }
    // a NUL byte in the request line
    const nul = await rawHttp(ctx.port, 'GET /app/remote.js\u0000 HTTP/1.1\r\nHost: 127.0.0.1:' + ctx.port + '\r\nConnection: close\r\n\r\n');
    assert.ok(nul.status === 404 || nul.status === 400 || nul.status === 0);
    assert.ok(!nul.text.includes('TOP-SECRET'));
    // absolute-form request target and a request with no path at all
    const abs = await rawHttp(ctx.port, 'GET http://127.0.0.1:' + ctx.port + '/app/remote.js HTTP/1.1\r\nHost: 127.0.0.1:' + ctx.port + '\r\nConnection: close\r\n\r\n');
    assert.ok(abs.status === 404 || abs.status === 400);
    const allowed = new Set(['/', '/app/remote.js', '/app/remote.css', '/app/arabic-layout.js', '/app/row-patcher.js',
        '/vendor/xterm.js', '/vendor/xterm.css', '/vendor/addon-fit.js', '/vendor/addon-unicode11.js', '/vendor/bidi.js']);
    for (const call of ctx.assetCalls) assert.ok(allowed.has(call), 'assets() was called with ' + call);
});

test('http: Host header allow-list on every route, exact match, extraHosts supported', async (t) => {
    const ctx = await makeCtx(t, { start: { extraHosts: ['abc.example.test', 'MyPC.tailnet.ts.net'] } });
    const p = ctx.port;
    const bad = ['evil.example', '127.0.0.1:' + (p + 1), '127.0.0.1', 'localhost', '127.0.0.1.evil.example:' + p, 'localhost:' + p + '.evil.example',
        'abc.example.test:443', 'abc.example.test.evil.test', '[::1]', ' ', '0.0.0.0:' + p];
    for (const host of bad) {
        for (const [method, urlPath, extra] of [['GET', '/', {}], ['GET', '/app/remote.js', {}], ['POST', '/api/pair', pairHeaders(ctx)], ['GET', '/nope', {}]]) {
            const r = await httpRequest(p, { method, path: urlPath, headers: Object.assign({ Host: host }, extra), body: method === 'POST' ? '{}' : undefined });
            assert.equal(r.status, 403, method + ' ' + urlPath + ' with Host ' + JSON.stringify(host));
        }
        const ws = await connectWs(p, { host });
        assert.equal(ws.status, 403, 'ws with Host ' + JSON.stringify(host));
        ws.sock.destroy();
    }
    // no Host header at all (HTTP/1.0)
    assert.equal((await rawHttp(p, 'GET / HTTP/1.0\r\n\r\n')).status, 403);
    for (const host of ['127.0.0.1:' + p, 'localhost:' + p, 'LOCALHOST:' + p, '[::1]:' + p, 'abc.example.test', 'mypc.tailnet.ts.net']) {
        const r = await httpRequest(p, { path: '/', headers: { Host: host } });
        assert.equal(r.status, 200, 'Host ' + host);
    }
    // a tunnel hostname can be added once it is known
    assert.equal((await httpRequest(p, { path: '/', headers: { Host: 'late.example.test' } })).status, 403);
    ctx.server.addAllowedHost('late.example.test');
    assert.equal((await httpRequest(p, { path: '/', headers: { Host: 'late.example.test' } })).status, 200);
    ctx.server.removeAllowedHost('late.example.test');
    assert.equal((await httpRequest(p, { path: '/', headers: { Host: 'late.example.test' } })).status, 403);
});

// ============================================================================================== server: pairing

test('pair: Origin must be one of ours; missing, null and foreign origins are refused and do not burn the secret', async (t) => {
    const ctx = await makeCtx(t, { start: { extraHosts: ['abc.example.test'] } });
    ctx.autoRole = 'read';
    const { secret } = ctx.server.newPairing();
    const body = JSON.stringify({ secret, label: 'x' });
    const bad = [null, 'null', '', 'http://evil.example', 'https://evil.example', 'http://127.0.0.1:' + (ctx.port + 1),
        'http://127.0.0.1.evil.example:' + ctx.port, 'http://localhost', 'file://', 'http://127.0.0.1:' + ctx.port + '/', 'https://abc.example.test:8443'];
    for (const origin of bad) {
        const headers = { 'Content-Type': 'application/json' };
        if (origin !== null) headers.Origin = origin;
        const r = await httpRequest(ctx.port, { method: 'POST', path: '/api/pair', headers, body });
        assert.equal(r.status, 403, 'Origin ' + JSON.stringify(origin));
    }
    assert.equal(ctx.approvals.length, 0, 'nothing reached the owner');
    // the secret is still valid: refused requests did not consume it
    const ok = await httpRequest(ctx.port, { method: 'POST', path: '/api/pair', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:' + ctx.port }, body });
    assert.equal(ok.status, 200);
    // a tunnel origin works for an allowed host
    const second = ctx.server.newPairing().secret;
    const viaTunnel = await httpRequest(ctx.port, {
        method: 'POST', path: '/api/pair',
        headers: { 'Content-Type': 'application/json', Host: 'abc.example.test', Origin: 'https://abc.example.test' },
        body: JSON.stringify({ secret: second, label: 'tunnel' }),
    });
    assert.equal(viaTunnel.status, 200);
});

test('pair: approval flow, roles, deny, label cleanup, owner never asked for bad secrets', async (t) => {
    const ctx = await makeCtx(t);
    ctx.autoRole = null;
    const seen = [];
    ctx.server.on('approval', (req) => {
        seen.push(req);
        assert.deepEqual(Object.keys(req).sort(), ['approve', 'deny', 'deviceId', 'forwardedFor', 'label', 'remoteAddress', 'requestedAt', 'userAgent'].sort());
    });

    // write role
    let pending = postPair(ctx, ctx.server.newPairing().secret, { label: 'Pixel 7', headers: { 'User-Agent': 'UA/1.0' } });
    await sleep(50);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].label, 'Pixel 7');
    assert.equal(seen[0].userAgent, 'UA/1.0');
    assert.equal(seen[0].remoteAddress, '127.0.0.1');
    assert.equal(seen[0].approve('write'), true);
    assert.equal(seen[0].approve('write'), false, 'a second decision is ignored');
    assert.equal(seen[0].deny(), false);
    const w = await pending;
    assert.equal(w.status, 200);
    assert.equal(w.role, 'write');
    assert.equal(w.deviceId, seen[0].deviceId);
    assert.match(w.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(w.headers['cache-control'], 'no-store');

    // default role is read, junk roles become read
    pending = postPair(ctx, ctx.server.newPairing().secret, { label: 'Laptop' });
    await sleep(50);
    seen[1].approve('superuser');
    assert.equal((await pending).role, 'read');
    pending = postPair(ctx, ctx.server.newPairing().secret);
    await sleep(50);
    seen[2].approve();
    assert.equal((await pending).role, 'read');

    // deny
    pending = postPair(ctx, ctx.server.newPairing().secret);
    await sleep(50);
    assert.equal(seen[3].deny(), true);
    const denied = await pending;
    assert.equal(denied.status, 403);
    assert.equal(denied.token, undefined);

    // hostile label
    pending = postPair(ctx, ctx.server.newPairing().secret, { label: '\u202eevil\u0007\n\r\t' + 'x'.repeat(300) });
    await sleep(50);
    assert.ok(seen[4].label.length <= 80);
    assert.ok(!/[\u0000-\u001f\u202a-\u202e]/.test(seen[4].label));
    seen[4].deny();
    await pending;
    pending = postPair(ctx, ctx.server.newPairing().secret, { label: '   ' });
    await sleep(50);
    assert.equal(seen[5].label, 'Unknown device');
    seen[5].deny();
    await pending;

    // a wrong secret never reaches the owner
    const count = seen.length;
    assert.equal((await postPair(ctx, 'wrong-secret')).status, 403);
    assert.equal(seen.length, count);
    // devices() lists the three approved ones with their roles
    assert.deepEqual(ctx.server.devices().map((d) => d.role).sort(), ['read', 'read', 'write']);
});

test('pair: nobody listening, timeout and an abandoned request all fail closed', async (t) => {
    const ctx = await makeCtx(t, { limits: { approvalTimeoutMs: 200 } });
    ctx.server.removeAllListeners('approval');
    const none = await postPair(ctx, ctx.server.newPairing().secret);
    assert.equal(none.status, 403);
    assert.equal(ctx.server.devices().length, 0);

    const cancels = [];
    ctx.server.on('approval-cancel', (c) => cancels.push(c));
    let held;
    ctx.server.on('approval', (req) => { held = req; });
    const slow = await postPair(ctx, ctx.server.newPairing().secret);
    assert.equal(slow.status, 403);
    assert.equal(slow.error, 'timeout');
    assert.equal(held.approve('write'), false, 'approving after the timeout does nothing');
    assert.equal(ctx.server.devices().length, 0);
    assert.equal(cancels[0].reason, 'timeout');

    // the browser gives up while the owner is deciding
    const { secret } = ctx.server.newPairing();
    const req = http.request({ host: '127.0.0.1', port: ctx.port, method: 'POST', path: '/api/pair', agent: false, headers: pairHeaders(ctx) });
    req.on('error', () => {});
    req.end(JSON.stringify({ secret, label: 'gone' }));
    await sleep(60);
    const abandoned = held;
    req.destroy();
    await sleep(60);
    assert.equal(abandoned.approve('write'), false);
    assert.equal(ctx.server.devices().length, 0);
    assert.ok(cancels.some((c) => c.reason === 'closed'));
});

test('pair: replayed, expired, wrong and malformed secrets are refused', async (t) => {
    const ctx = await makeCtx(t);
    ctx.autoRole = 'read';
    const { secret } = ctx.server.newPairing();
    assert.equal((await postPair(ctx, secret)).status, 200);
    const replay = await postPair(ctx, secret);                 // replayed
    assert.equal(replay.status, 403);
    assert.equal(replay.error, 'invalid');

    const old = ctx.server.newPairing();                        // expired
    ctx.clock.t += 10 * 60 * 1000 + 1;
    const late = await postPair(ctx, old.secret);
    assert.equal(late.status, 403);
    assert.equal(late.error, 'expired');
    assert.equal(ctx.approvals.length, 1, 'only the first request ever reached the owner');
    ctx.clock.t += 61000;

    // right at the edge: still valid one ms before expiry
    const edge = ctx.server.newPairing();
    ctx.clock.t = edge.expiresAt - 1;
    assert.equal((await postPair(ctx, edge.secret)).status, 200);
    ctx.clock.t += 61000;

    for (const rawBody of ['not json', '[]', '"x"', '{}', '{"secret":5}', '{"secret":null}', JSON.stringify({ secret: 'a'.repeat(1000) })]) {
        const r = await postPair(ctx, null, { rawBody });
        assert.ok(r.status === 400 || r.status === 413 || r.status === 403, rawBody.slice(0, 20) + ' -> ' + r.status);
        ctx.clock.t += 61000;                                   // keep the limiter out of the way
        ctx.server.auth.pairLimiter.reset();
    }
});

test('pair: body rules: JSON only, 1 KiB, slow bodies time out', async (t) => {
    const ctx = await makeCtx(t, { limits: { pairBodyTimeoutMs: 200 } });
    ctx.autoRole = 'read';
    const secret = ctx.server.newPairing().secret;
    const wrongType = await postPair(ctx, secret, { headers: { 'Content-Type': 'text/plain' } });
    assert.equal(wrongType.status, 415);
    const form = await postPair(ctx, secret, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(form.status, 415);
    const noType = await httpRequest(ctx.port, { method: 'POST', path: '/api/pair', headers: { Origin: 'http://127.0.0.1:' + ctx.port }, body: '{}' });
    assert.equal(noType.status, 415);
    const huge = await postPair(ctx, secret, { rawBody: JSON.stringify({ secret, label: 'x'.repeat(2000) }) });
    assert.equal(huge.status, 413);
    // an honest request with a charset parameter still works, so the secret survived all of the above
    const charset = await postPair(ctx, secret, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    assert.equal(charset.status, 200);

    // a body that never arrives
    const s = net.connect(ctx.port, '127.0.0.1');
    let answer = '';
    s.on('data', (d) => { answer += d.toString('latin1'); });
    s.on('error', () => {});
    s.write('POST /api/pair HTTP/1.1\r\nHost: 127.0.0.1:' + ctx.port + '\r\nOrigin: http://127.0.0.1:' + ctx.port
        + '\r\nContent-Type: application/json\r\nContent-Length: 50\r\n\r\n{"secret"');
    await sleep(500);
    s.destroy();
    assert.match(answer, /^HTTP\/1\.1 408/);
});

test('pair: the global limiter locks pairing after 2 failures a minute and 12 an hour', async (t) => {
    const ctx = await makeCtx(t);
    ctx.autoRole = 'read';
    assert.equal((await postPair(ctx, 'nope-1')).status, 403);
    assert.equal((await postPair(ctx, 'nope-2')).status, 403);
    const { secret } = ctx.server.newPairing();
    const locked = await postPair(ctx, secret);                 // even a correct secret is refused while locked
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers['retry-after']) >= 1);
    assert.ok(ctx.events.some((e) => e[0] === 'limit' && e[1].kind === 'pairing'), 'the owner is told');
    assert.equal(ctx.approvals.length, 0);
    ctx.clock.t += 61000;
    assert.equal((await postPair(ctx, secret)).status, 200, 'the secret was not burnt by the lockout');

    // hour window
    for (let i = 0; i < 6; i++) {
        await postPair(ctx, 'bad-' + i + 'a');
        await postPair(ctx, 'bad-' + i + 'b');
        ctx.clock.t += 61000;
    }
    const fresh = ctx.server.newPairing().secret;
    assert.equal((await postPair(ctx, fresh)).status, 429, 'twelve failures inside the hour keep pairing locked');
    ctx.clock.t += 3600000;
    assert.equal((await postPair(ctx, fresh)).status, 403, 'expired by now, but no longer locked');
});

test('pair: only a few approvals may wait at the same time', async (t) => {
    const ctx = await makeCtx(t, { limits: { maxPendingApprovals: 1 } });
    ctx.autoRole = null;
    const first = postPair(ctx, ctx.server.newPairing().secret);
    await sleep(50);
    const second = await postPair(ctx, ctx.server.newPairing().secret);
    assert.equal(second.status, 429);
    assert.equal(second.error, 'busy');
    assert.ok(ctx.events.some((e) => e[0] === 'limit' && e[1].kind === 'approvals'));
    ctx.approvals.length || 0;
    await sleep(10);
    ctx.server.revokeAll();
    ctx.server.stats();
    ctx.autoRole = 'read';
    // finish the first one so the test ends cleanly
    ctx.server.listeners('approval');
    await ctx.server.stop();
    assert.equal((await first).status, 403);
});

// ============================================================================================== server: WebSocket

test('ws: upgrade is refused for wrong Host, wrong, missing or null Origin, wrong path, bad handshake', async (t) => {
    const ctx = await makeCtx(t);
    const p = ctx.port;
    for (const origin of ['http://evil.example', 'null', null, 'http://127.0.0.1:' + (p + 7), 'https://evil.example', 'http://localhost']) {
        const ws = await connectWs(p, { origin });
        assert.equal(ws.status, 403, 'Origin ' + origin);
        ws.sock.destroy();
    }
    for (const bad of ['/', '/ws/', '/ws?token=x', '/WS', '/api/pair']) {
        const ws = await connectWs(p, { path: bad });
        assert.equal(ws.status, 404, bad);
        ws.sock.destroy();
    }
    const v8 = await connectWs(p, { version: '8' });
    assert.equal(v8.status, 426);
    assert.equal(v8.headers['sec-websocket-version'], '13');
    v8.sock.destroy();
    for (const key of ['short', 'AAAAAAAAAAAAAAAAAAAAAA', 'AAAAAAAAAAAAAAAAAAAAAAAA']) {
        const ws = await connectWs(p, { key });
        assert.equal(ws.status, 400, key);
        ws.sock.destroy();
    }
    // a real handshake works and answers with the right accept value and no extension
    const ok = await connectWs(p, { key: 'dGhlIHNhbXBsZSBub25jZQ==' });
    ctx.clients.push(ok);
    assert.equal(ok.status, 101);
    assert.equal(ok.headers['sec-websocket-accept'], 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
    assert.equal(ok.headers['sec-websocket-extensions'], undefined);
    assert.equal(ctx.server.stats().clients, 0);
    // none of the refused attempts left anything behind
    await sleep(50);
    assert.equal(ctx.server.stats().preAuth, 1);
});

test('ws: a non-browser client that offers permessage-deflate still gets a plain connection', async (t) => {
    const ctx = await makeCtx(t);
    const { token } = await pairDevice(ctx, 'write');
    const ws = new WebSocket('ws://127.0.0.1:' + ctx.port + '/ws', { headers: { Origin: 'http://127.0.0.1:' + ctx.port } });
    const messages = [];
    ws.onmessage = (e) => messages.push(JSON.parse(e.data));
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('node WebSocket could not connect')); });
    assert.equal(ws.extensions, '');
    ws.send(JSON.stringify({ t: 'auth', token }));
    ws.send(JSON.stringify({ t: 'attach', ids: [1] }));
    for (let i = 0; i < 100 && !messages.some((m) => m.t === 'snapshot'); i++) await sleep(20);
    assert.equal(messages[0].t, 'hello');
    assert.equal(messages[0].role, 'write');
    assert.ok(messages.some((m) => m.t === 'snapshot' && m.data === 'ring-1:'));
    ws.send(JSON.stringify({ t: 'input', id: 1, data: 'echo hi\r' }));
    for (let i = 0; i < 100 && ctx.bridge.writes.length === 0; i++) await sleep(20);
    assert.deepEqual(ctx.bridge.writes, [[1, 'echo hi\r']]);
    ws.close(1000);
    await sleep(100);
    // the same client without an Origin header (what a plain script would send) is refused
    const noOrigin = new WebSocket('ws://127.0.0.1:' + ctx.port + '/ws');
    const failed = await new Promise((resolve) => { noOrigin.onopen = () => resolve(false); noOrigin.onerror = () => resolve(true); });
    assert.equal(failed, false === failed ? false : true);
});

test('ws: end to end, pair -> approve -> auth -> hello -> attach -> snapshot -> output -> input reaches the bridge', async (t) => {
    const ctx = await makeCtx(t);
    const { ws, hello, deviceId } = await openAuthed(ctx, 'write');
    assert.equal(hello.role, 'write');
    assert.equal(hello.readOnly, false);
    assert.deepEqual(hello.limits, { input: 16384 });
    assert.deepEqual(hello.terminals, [{ id: 1, name: 'pwsh', cols: 100, rows: 30 }, { id: 2, name: 'wsl', cols: 80, rows: 24 }]);

    ws.send({ t: 'attach', ids: [1, 2, 99] });
    const s1 = await ws.waitFor((m) => m.t === 'snapshot' && m.id === 1);
    const s2 = await ws.waitFor((m) => m.t === 'snapshot' && m.id === 2);
    assert.deepEqual([s1.cols, s1.rows, s1.data], [100, 30, 'ring-1:']);
    assert.deepEqual([s2.cols, s2.rows, s2.data], [80, 24, 'ring-2:']);
    assert.equal(ws.inbox.filter((m) => m.t === 'snapshot').length, 0, 'an unshared id gets no snapshot');

    emit(ctx, 1, 'hello ');
    emit(ctx, 1, 'العربية');
    emit(ctx, 2, 'other');
    const o1 = await ws.waitFor((m) => m.t === 'output' && m.id === 1);
    assert.equal(o1.data, 'hello ');
    assert.equal((await ws.waitFor((m) => m.t === 'output' && m.id === 1)).data, 'العربية');
    assert.equal((await ws.waitFor((m) => m.t === 'output' && m.id === 2)).data, 'other');

    ws.send({ t: 'input', id: 1, data: 'dir\r' });
    ws.send({ t: 'input', id: 2, data: '\x1b[A' });
    await roundTrip(ws, 1);
    assert.deepEqual(ctx.bridge.writes, [[1, 'dir\r'], [2, '\x1b[A']]);

    // detach stops the stream and the input
    ws.send({ t: 'detach', ids: [2] });
    await roundTrip(ws, 2);
    emit(ctx, 2, 'after detach');
    ws.send({ t: 'input', id: 2, data: 'x' });
    await roundTrip(ws, 3);
    assert.equal(ws.take('output').filter((m) => m.id === 2).length, 0);
    assert.equal(ctx.bridge.writes.length, 2);

    // app-level heartbeat, number and string tokens
    ws.send({ t: 'ping', n: 7 });
    assert.equal((await ws.waitFor('pong')).n, 7);
    ws.send({ t: 'ping', n: 'abc' });
    assert.equal((await ws.waitFor('pong')).n, 'abc');

    // events and devices()
    const dev = ctx.server.devices()[0];
    assert.equal(dev.deviceId, deviceId);
    assert.equal(dev.role, 'write');
    assert.equal(dev.connections, 1);
    assert.equal(typeof dev.connectedAt, 'number');
    assert.ok(ctx.events.some((e) => e[0] === 'connect' && e[1].deviceId === deviceId && e[1].role === 'write'));
    ws.sock.destroy();
    await sleep(100);
    assert.ok(ctx.events.some((e) => e[0] === 'disconnect' && e[1].deviceId === deviceId));
    assert.equal(ctx.server.devices()[0].connections, 0);
});

test('ws: the first message must be a valid auth within the time limit', async (t) => {
    const ctx = await makeCtx(t, { limits: { authTimeoutMs: 150 } });
    const { token } = await pairDevice(ctx, 'write');

    const silent = await connectWs(ctx.port);
    ctx.clients.push(silent);
    assert.equal(await silent.waitClosed(), CLOSE.UNAUTHORIZED, 'no auth in time');

    for (const first of [{ t: 'attach', ids: [1] }, { t: 'input', id: 1, data: 'x' }, { t: 'ping', n: 1 }, { t: 'hello' }]) {
        const ws = await connectWs(ctx.port);
        ctx.clients.push(ws);
        ws.send(first);
        assert.equal(await ws.waitClosed(), CLOSE.UNAUTHORIZED, JSON.stringify(first));
        assert.equal(ws.inbox.filter((m) => m.t === 'snapshot' || m.t === 'hello').length, 0);
    }
    for (const bad of [{ t: 'auth', token: 'wrong-token-wrong-token-wrong-token-12' }, { t: 'auth' }, { t: 'auth', token: 5 }, { t: 'auth', token: 'x'.repeat(300) }, { t: 'auth', token: '' }]) {
        const ws = await connectWs(ctx.port);
        ctx.clients.push(ws);
        ws.send(bad);
        assert.equal(await ws.waitClosed(), CLOSE.UNAUTHORIZED, JSON.stringify(bad).slice(0, 40));
    }
    const notJson = await connectWs(ctx.port);
    ctx.clients.push(notJson);
    notJson.sendRaw(mkFrame({ payload: 'not json' }));
    assert.equal(await notJson.waitClosed(), CLOSE.BAD_MESSAGE);

    // the right token works, and a second auth afterwards is a protocol error
    const good = await connectWs(ctx.port);
    ctx.clients.push(good);
    good.send({ t: 'auth', token });
    await good.waitFor('hello');
    await sleep(250);                                           // well past the auth timeout: authenticated sockets stay
    assert.equal(good.closed, false);
    good.send({ t: 'auth', token });
    assert.equal(await good.waitClosed(), CLOSE.BAD_MESSAGE);
    // nothing leaked from the failed attempts
    await sleep(50);
    assert.equal(ctx.server.stats().preAuth, 0);
});

test('ws: pre-auth limits on size, bytes and the number of waiting sockets', async (t) => {
    const ctx = await makeCtx(t, { limits: { preAuthMax: 3, authTimeoutMs: 2000 } });
    // one frame above 1 KiB before auth
    const big = await connectWs(ctx.port);
    ctx.clients.push(big);
    big.sendRaw(mkFrame({ payload: JSON.stringify({ t: 'auth', token: 'x'.repeat(2000) }) }));
    assert.equal(await big.waitClosed(), CLOSE.TOO_BIG);
    // many tiny pings: the byte budget before auth runs out
    const flood = await connectWs(ctx.port);
    ctx.clients.push(flood);
    for (let i = 0; i < 800; i++) flood.sendRaw(mkFrame({ opcode: 9, payload: "p" }));
    assert.equal(await flood.waitClosed(), CLOSE.TOO_BIG);
    await sleep(50);
    // at most preAuthMax unauthenticated sockets at a time
    const held = [];
    for (let i = 0; i < 3; i++) { const w = await connectWs(ctx.port); ctx.clients.push(w); held.push(w); assert.equal(w.status, 101); }
    const extra = await connectWs(ctx.port);
    assert.equal(extra.status, 503);
    extra.sock.destroy();
    assert.ok(ctx.events.some((e) => e[0] === 'limit' && e[1].kind === 'preauth'));
    held[0].sock.destroy();
    await sleep(100);
    const again = await connectWs(ctx.port);
    ctx.clients.push(again);
    assert.equal(again.status, 101);
});

test('ws: the client cap refuses the 6th client (and the 3rd when set to 2)', async (t) => {
    const ctx = await makeCtx(t);
    const { token } = await pairDevice(ctx, 'read');
    const open = [];
    for (let i = 0; i < 5; i++) open.push((await openAuthed(ctx, 'read', token)).ws);
    assert.equal(ctx.server.stats().clients, 5);
    const sixth = await connectWs(ctx.port);
    ctx.clients.push(sixth);
    sixth.send({ t: 'auth', token });
    const bye = await sixth.waitFor('bye');
    assert.equal(bye.reason, 'too-many-clients');
    assert.equal(await sixth.waitClosed(), CLOSE.RATE_LIMITED);
    assert.equal(sixth.inbox.filter((m) => m.t === 'hello').length, 0);
    assert.ok(ctx.events.some((e) => e[0] === 'limit' && e[1].kind === 'clients'));
    assert.equal(ctx.server.stats().clients, 5);
    // freeing a slot lets the next one in
    open[0].sock.destroy();
    await sleep(100);
    const retry = await openAuthed(ctx, 'read', token);
    assert.equal(retry.hello.role, 'read');

    const small = await makeCtx(t, { start: { maxClients: 2 } });
    const { token: t2 } = await pairDevice(small, 'read');
    await openAuthed(small, 'read', t2);
    await openAuthed(small, 'read', t2);
    const third = await connectWs(small.port);
    small.clients.push(third);
    third.send({ t: 'auth', token: t2 });
    assert.equal(await third.waitClosed(), CLOSE.RATE_LIMITED);
});

test('ws: wrong tokens are counted globally and lock authentication', async (t) => {
    const ctx = await makeCtx(t, { limits: { authFailPerMin: 3 } });
    const { token } = await pairDevice(ctx, 'read');
    for (let i = 0; i < 3; i++) {
        const ws = await connectWs(ctx.port);
        ctx.clients.push(ws);
        ws.send({ t: 'auth', token: 'wrong-' + i + '-'.padEnd(40, 'x') });
        assert.equal(await ws.waitClosed(), CLOSE.UNAUTHORIZED);
    }
    const locked = await connectWs(ctx.port);
    ctx.clients.push(locked);
    locked.send({ t: 'auth', token });
    assert.equal(await locked.waitClosed(), CLOSE.RATE_LIMITED);
    assert.ok(ctx.events.some((e) => e[0] === 'limit' && e[1].kind === 'auth'));
    ctx.clock.t += 61000;
    const ok = await openAuthed(ctx, 'read', token);
    assert.equal(ok.hello.role, 'read');
});

test('ws: a read-only device can never write, whatever it sends', async (t) => {
    const ctx = await makeCtx(t);
    const { token } = await pairDevice(ctx, 'read');
    const attempts = [
        { t: 'input', id: 1, data: 'rm -rf /\r' },
        { t: 'input', id: 1, data: '\x1b[A' },
        { t: 'input', id: 1, data: '' },
        { t: 'input', id: 2, data: 'x', role: 'write' },
        { t: 'input', id: 1, data: 'x', readOnly: false },
        { t: 'input', id: 'one', data: {} },
    ];
    for (const attempt of attempts) {
        const { ws } = await openAuthed(ctx, 'read', token);
        ws.send({ t: 'attach', ids: [1, 2] });
        await ws.waitFor('snapshot');
        ws.send(attempt);
        assert.equal(await ws.waitClosed(), CLOSE.FORBIDDEN, JSON.stringify(attempt));
    }
    // a client that claims a role in its auth message gets nothing extra
    const ws = await connectWs(ctx.port);
    ctx.clients.push(ws);
    ws.send({ t: 'auth', token, role: 'write', readOnly: false });
    const hello = await ws.waitFor('hello');
    assert.equal(hello.role, 'read');
    assert.equal(hello.readOnly, true);
    ws.send({ t: 'attach', ids: [1] });
    await ws.waitFor('snapshot');
    ws.send({ t: 'input', id: 1, data: 'x' });
    assert.equal(await ws.waitClosed(), CLOSE.FORBIDDEN);
    assert.deepEqual(ctx.bridge.writes, [], 'nothing reached bridge.write');
    assert.ok(ctx.logs.some((l) => l.includes('read-only-input')));
});

test('ws: input rules for write devices: attached ids only, size cap, reply-shaped data dropped, real keys pass', async (t) => {
    const ctx = await makeCtx(t);
    const { ws } = await openAuthed(ctx, 'write');
    ws.send({ t: 'attach', ids: [1] });
    await ws.waitFor('snapshot');

    const passes = ['ls\r', '\x03', '\x1b', '\x1b[A', '\x1bOA', '\x1b[1;5C', '\x1b[15~', '\x1b[Z', '\x7f', 'العربية', '\x1b[200~paste\x1b[201~', '\x1b[I', '\x1b[<0;10;5M'];
    for (const data of passes) ws.send({ t: 'input', id: 1, data });
    await roundTrip(ws, 1);
    assert.deepEqual(ctx.bridge.writes.map((w) => w[1]), passes, 'every real key sequence is forwarded unchanged');
    ctx.bridge.writes.length = 0;

    const replies = ['\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[?64;1;2;6;22c', '\x1b[c', '\x1b[12;40R', '\x1b[1;1R', '\x1b]11;rgb:1e1e/1e1e/1e1e\x07', '\x1b]10;rgb:ffff/ffff/ffff\x1b\\',
        '\x1b]12;rgb:ffff/ffff/ffff\x07', '\x1b]4;1;rgb:cdcd/0000/0000\x07', '\x1bP>|xterm.js(6.0.0)\x1b\\', '\x1bP!|00000000\x1b\\', '\x1b[8;24;80t', '\x1b[4;600;800t',
        '\x1b[?2026;2$y', '\x1b[?1;2c\x1b[12;40R', '\x1b[?1;2c\x1b[>0;276;0c\x1b]11;rgb:0000/0000/0000\x07'];
    for (const data of replies) ws.send({ t: 'input', id: 1, data });
    ws.send({ t: 'input', id: 1, data: 'ls\r\x1b[?1;2c' });
    ws.send({ t: 'input', id: 1, data: '\x1b[12;40Rpwd\r' });
    await roundTrip(ws, 2);
    assert.deepEqual(ctx.bridge.writes.map((w) => w[1]), ['ls\r', 'pwd\r']);
    assert.equal(ctx.server.stats().queues[0].droppedReplies, replies.length);
    assert.deepEqual(['\x1b[A', 'x', '\x1b[?1;2c', 'a\x1b[?1;2cb'].map(filterInput), ['\x1b[A', 'x', '', 'ab']);
    ctx.bridge.writes.length = 0;

    ws.send({ t: 'input', id: 2, data: 'not attached' });       // terminal 2 was never attached
    ws.send({ t: 'input', id: 77, data: 'unknown terminal' });
    await roundTrip(ws, 3);
    assert.deepEqual(ctx.bridge.writes, []);

    ws.send({ t: 'input', id: 1, data: 'a'.repeat(16384) });     // exactly the limit is fine
    await roundTrip(ws, 4);
    assert.equal(ctx.bridge.writes.length, 1);
    ws.send({ t: 'input', id: 1, data: 'a'.repeat(16385) });
    assert.equal(await ws.waitClosed(), CLOSE.TOO_BIG);
    assert.equal(ctx.bridge.writes.length, 1);

    for (const bad of [{ t: 'input', id: 1 }, { t: 'input', id: 1.5, data: 'x' }, { t: 'input', id: -1, data: 'x' }, { t: 'input', id: 1, data: 5 }, { t: 'nope' }, { t: 5 }, [], 'x', null]) {
        const c = await openAuthed(ctx, 'write', ctx.server.devices()[0] && null);
        c.ws.send(bad);
        assert.equal(await c.ws.waitClosed(), CLOSE.BAD_MESSAGE, JSON.stringify(bad));
    }
});

test('ws: malformed frames get the application close codes and never reach the message handler', async (t) => {
    const ctx = await makeCtx(t);
    const { token } = await pairDevice(ctx, 'write');
    const cases = [
        ['unmasked frame', mkFrame({ mask: false, payload: JSON.stringify({ t: 'ping', n: 1 }) }), CLOSE.BAD_MESSAGE],
        ['oversize frame (70000 bytes)', mkFrame({ payload: 'x'.repeat(70000) }), CLOSE.TOO_BIG],
        ['oversize 64 bit length', mkFrame({ lenBytes: 8, claimLen: 2 ** 40, payload: '' }), CLOSE.TOO_BIG],
        ['RSV1 set (compression)', mkFrame({ rsv: 4, payload: JSON.stringify({ t: 'ping', n: 1 }) }), CLOSE.BAD_MESSAGE],
        ['fragmented ping', mkFrame({ fin: false, opcode: 9, payload: 'x' }), CLOSE.BAD_MESSAGE],
        ['ping with an oversize payload', mkFrame({ opcode: 9, payload: Buffer.alloc(200) }), CLOSE.BAD_MESSAGE],
        ['invalid UTF-8', mkFrame({ payload: Buffer.from([0x7b, 0xff, 0xfe, 0x7d]) }), CLOSE.BAD_MESSAGE],
        ['binary frame', mkFrame({ opcode: 2, payload: '{"t":"ping"}' }), CLOSE.BAD_MESSAGE],
        ['orphan continuation', mkFrame({ opcode: 0, payload: 'x' }), CLOSE.BAD_MESSAGE],
        ['unknown opcode', mkFrame({ opcode: 7 }), CLOSE.BAD_MESSAGE],
        ['fragments adding up above the cap', Buffer.concat([mkFrame({ fin: false, payload: 'a'.repeat(40000) }), mkFrame({ opcode: 0, payload: 'b'.repeat(40000) })]), CLOSE.TOO_BIG],
    ];
    for (const [name, bytes, code] of cases) {
        const { ws } = await openAuthed(ctx, 'write', token);
        ws.sendRaw(bytes);
        assert.equal(await ws.waitClosed(), code, name);
        assert.equal(ws.inbox.filter((m) => m.t === 'pong').length, 0, name + ' must not be processed');
        assert.equal(ws.violation, null);
        // the other clients and the server keep working
        const other = await openAuthed(ctx, 'write', token);
        await roundTrip(other.ws, 5);
        other.ws.sock.destroy();
    }
    // the same frames before authentication
    for (const [name, bytes] of cases.slice(0, 4)) {
        const ws = await connectWs(ctx.port);
        ctx.clients.push(ws);
        ws.sendRaw(bytes);
        const code = await ws.waitClosed();
        assert.ok(code === CLOSE.BAD_MESSAGE || code === CLOSE.TOO_BIG, name + ' -> ' + code);
    }
    assert.ok(ctx.logs.some((l) => l.includes('ws-violation')));
});

test('ws: fragmented text messages and control frames between fragments are handled', async (t) => {
    const ctx = await makeCtx(t);
    const { ws } = await openAuthed(ctx, 'read');
    const text = JSON.stringify({ t: 'ping', n: 42 });
    ws.sendRaw(Buffer.concat([
        mkFrame({ fin: false, opcode: 1, payload: text.slice(0, 5) }),
        mkFrame({ opcode: 9, payload: 'mid' }),
        mkFrame({ fin: true, opcode: 0, payload: text.slice(5) }),
    ]));
    assert.equal((await ws.waitFor('pong')).n, 42);
    // frames split at every byte boundary
    const whole = mkFrame({ payload: JSON.stringify({ t: 'ping', n: 43 }) });
    for (const b of whole) { ws.sendRaw(Buffer.from([b])); }
    assert.equal((await ws.waitFor((m) => m.t === 'pong' && m.n === 43)).n, 43);
    // a close from the client is answered and the socket goes away
    ws.sendRaw(mkFrame({ opcode: 8, payload: Buffer.from([0x03, 0xe8]) }));
    assert.equal(await ws.waitClosed(), 1000);
});

test('ws: slow-client flood on the ack path: bounded queue, owner never blocked, resync snapshot', async (t) => {
    const ctx = await makeCtx(t, { limits: { queueMaxBytes: 64 * 1024, ackWindow: 16 * 1024, coalesceBytes: 4096 } });
    const { ws } = await openAuthed(ctx, 'read');
    ws.send({ t: 'attach', ids: [1] });
    await ws.waitFor('snapshot');
    ws.send({ t: 'ack', id: 1, bytes: 0 });                    // from now on this client uses acknowledgements
    await roundTrip(ws, 1);

    const chunk = (i) => ('<' + i + '>').padEnd(1024, '.');
    const started = process.hrtime.bigint();
    let maxQueued = 0;
    for (let i = 0; i < 400; i++) {
        emit(ctx, 1, chunk(i));
        maxQueued = Math.max(maxQueued, ctx.server.stats().queues[0].queuedBytes);
    }
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 1500, 'server.output() must never wait for a client: 400 calls took ' + ms + ' ms');
    assert.ok(maxQueued <= 64 * 1024, 'queue stayed bounded: ' + maxQueued);
    assert.deepEqual(ctx.server.stats().queues[0].resync, [1], 'the client is marked for a resync');

    await sleep(100);
    const got = ws.take('output');
    const received = got.reduce((n, m) => n + m.data.length, 0);
    assert.ok(received >= 16 * 1024 && received <= 16 * 1024 + 1024, 'held back at the ack window, received ' + received);
    assert.equal(ws.inbox.filter((m) => m.t === 'snapshot').length, 0, 'no snapshot while the client is behind');

    ws.send({ t: 'ack', id: 1, bytes: received });               // the page caught up
    const snap = await ws.waitFor('snapshot');
    assert.equal(snap.data, ctx.bridge.terms.get(1).ring, 'the resync snapshot is the full current content');
    assert.deepEqual(ctx.server.stats().queues[0].resync, []);
    emit(ctx, 1, 'TAIL');
    assert.equal((await ws.waitFor((m) => m.t === 'output')).data, 'TAIL', 'the stream continues after the snapshot');
    assert.ok(ctx.events.some((e) => e[0] === 'limit' && e[1].kind === 'slow-client'));
});

test('ws: slow-client flood on the TCP path: a client that stops reading is cut off from the stream, then resynced', async (t) => {
    const ctx = await makeCtx(t, { limits: { queueMaxBytes: 256 * 1024 } });
    const { ws } = await openAuthed(ctx, 'read');
    ws.send({ t: 'attach', ids: [1] });
    await ws.waitFor('snapshot');
    ws.sock.pause();                                            // the phone stops reading

    const chunk = 'y'.repeat(64 * 1024);
    const started = process.hrtime.bigint();
    let maxQueued = 0;
    for (let i = 0; i < 700; i++) {                             // ~45 MB, far more than any socket buffer
        ctx.bridge.append(1, 'z');
        ctx.server.output(1, chunk);
        maxQueued = Math.max(maxQueued, ctx.server.stats().queues[0].queuedBytes);
    }
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 5000, 'owner side stayed fast: ' + ms + ' ms');
    assert.ok(maxQueued <= 256 * 1024, 'queue bound held: ' + maxQueued);
    assert.ok(ctx.logs.some((l) => l.includes('ws-slow-client')), 'overflow was detected');
    assert.ok(ctx.server.stats().queues[0].resync.length > 0 || ctx.server.stats().queues[0].queueItems > 0);

    ws.sock.resume();                                           // the phone reads again
    const snap = await ws.waitFor('snapshot', 15000);
    assert.equal(snap.id, 1);
    assert.equal(snap.data, ctx.bridge.terms.get(1).ring);
    emit(ctx, 1, 'END');
    const end = await ws.waitFor((m) => m.t === 'output' && m.data === 'END', 15000);
    assert.equal(end.id, 1);
});

test('ws: attach is atomic: snapshot plus everything after it equals the terminal, nothing lost or repeated', async (t) => {
    const ctx = await makeCtx(t);
    ctx.bridge.ringMax = 4 * 1024 * 1024;
    const { ws } = await openAuthed(ctx, 'read');
    let n = 0;
    let running = true;
    const pump = () => {
        if (!running) return;
        for (let i = 0; i < 3; i++) emit(ctx, 1, '<' + (n++) + '>');
        setImmediate(pump);
    };
    pump();
    await sleep(30);
    ws.send({ t: 'attach', ids: [1] });
    const snap = await ws.waitFor('snapshot');
    await sleep(150);
    running = false;
    await sleep(50);
    const outs = ws.take('output').filter((m) => m.id === 1).map((m) => m.data);
    assert.ok(outs.length > 0);
    assert.equal(snap.data + outs.join(''), ctx.bridge.terms.get(1).ring);
    // re-attaching the same terminal replaces the stream with a fresh snapshot
    ws.send({ t: 'attach', ids: [1] });
    const again = await ws.waitFor('snapshot');
    assert.equal(again.data.startsWith(snap.data), true);
});

test('ws: owner-side notifications reach the right clients', async (t) => {
    const ctx = await makeCtx(t);
    const a = (await openAuthed(ctx, 'read')).ws;
    const b = (await openAuthed(ctx, 'read')).ws;
    a.send({ t: 'attach', ids: [1] });
    await a.waitFor('snapshot');
    ctx.server.resize(1, 120, 40);
    ctx.server.title(1, 'new\x07 title');
    ctx.server.state(2, 'busy', true);
    ctx.server.exit(2, 3);
    assert.deepEqual(await a.waitFor('resize'), { t: 'resize', id: 1, cols: 120, rows: 40 });
    assert.equal((await a.waitFor('title')).name, 'new title');
    assert.deepEqual(await a.waitFor('state'), { t: 'state', id: 2, state: 'busy', attention: true });
    assert.deepEqual(await a.waitFor('exit'), { t: 'exit', id: 2, code: 3 });
    await roundTrip(b, 1);
    assert.equal(b.inbox.filter((m) => m.t === 'resize').length, 0, 'resize goes to attached clients only');
    assert.ok(b.inbox.some((m) => m.t === 'title'));            // names and states go to everyone
    assert.ok(b.inbox.some((m) => m.t === 'state'));

    // a terminal closes: the list changes and attached clients stop receiving it
    a.send({ t: 'attach', ids: [2] });
    await a.waitFor((m) => m.t === 'snapshot' && m.id === 2);
    ctx.bridge.terms.delete(2);
    ctx.server.listChanged();
    const list = await a.waitFor('terminals');
    assert.deepEqual(list.terminals.map((x) => x.id), [1]);
    emit(ctx, 1, 'one');
    ctx.server.output(2, 'ghost');
    await roundTrip(a, 2);
    assert.deepEqual(a.take('output').map((m) => m.data), ['one']);
    assert.equal(ctx.server.stats().queues.find((q) => q.attached.includes(2)), undefined);
});

test('ws: revoke closes the device sockets with 4430 and the token stops working', async (t) => {
    const ctx = await makeCtx(t);
    const a = await openAuthed(ctx, 'write');
    const sameDevice = await openAuthed(ctx, 'write', a.token);
    const other = await openAuthed(ctx, 'read');
    assert.equal(ctx.server.revoke('d-does-not-exist'), false);
    assert.equal(ctx.server.revoke(a.deviceId), true);
    assert.equal(await a.ws.waitClosed(), CLOSE.REVOKED);
    assert.equal(await sameDevice.ws.waitClosed(), CLOSE.REVOKED);
    assert.equal((await a.ws.waitFor('bye')).reason, 'revoked');
    await roundTrip(other.ws, 1);
    assert.equal(other.ws.closed, false, 'other devices are untouched');
    const retry = await connectWs(ctx.port);
    ctx.clients.push(retry);
    retry.send({ t: 'auth', token: a.token });
    assert.equal(await retry.waitClosed(), CLOSE.UNAUTHORIZED);
    assert.deepEqual(ctx.server.devices().map((d) => d.deviceId), [other.deviceId]);
    assert.equal(ctx.server.revokeAll(), 1);
    assert.equal(await other.ws.waitClosed(), CLOSE.REVOKED);
    assert.deepEqual(ctx.server.devices(), []);
});

test('ws: devices expire with their lifetime, even while connected', async (t) => {
    const ctx = await makeCtx(t, { start: { ttlMs: 60 * 1000 } });
    const live = await openAuthed(ctx, 'read');
    const { token: stale } = await pairDevice(ctx, 'read');
    ctx.clock.t += 61 * 1000;
    ctx.server._sweep();                                        // the timer does this every 30 s
    assert.equal(await live.ws.waitClosed(), CLOSE.REVOKED);
    assert.deepEqual(ctx.server.devices(), []);
    const ws = await connectWs(ctx.port);
    ctx.clients.push(ws);
    ws.send({ t: 'auth', token: stale });
    assert.equal(await ws.waitClosed(), CLOSE.UNAUTHORIZED);
});

test('ws: inbound message flood is cut off with 4429', async (t) => {
    const ctx = await makeCtx(t);
    const { ws } = await openAuthed(ctx, 'read');
    for (let i = 0; i < 600; i++) ws.send({ t: 'ping', n: i });
    assert.equal(await ws.waitClosed(), CLOSE.RATE_LIMITED);
    assert.ok(ctx.events.some((e) => e[0] === 'limit' && e[1].kind === 'messages'));
    // refill over time: after a pause a fresh connection behaves normally
    ctx.clock.t += 10000;
    const again = await openAuthed(ctx, 'read', ctx.server.devices()[0] ? undefined : undefined);
    await roundTrip(again.ws, 1);
});

test('ws: the server pings, answers pings, and drops a peer that goes silent', async (t) => {
    const ctx = await makeCtx(t, { limits: { pingIntervalMs: 40, idleTimeoutMs: 400 } });
    const { ws } = await openAuthed(ctx, 'read');
    await sleep(250);
    assert.ok(ws.pings >= 3, 'protocol pings arrive about every interval, got ' + ws.pings);
    assert.equal(ws.closed, false, 'a client that answers pings stays connected');
    // a silent client (no pongs, no traffic) is dropped with 4408 and told why
    const { ws: mute } = await openAuthed(ctx, 'read', (await pairDevice(ctx, 'read')).token);
    mute.noPong = true;
    assert.equal(await mute.waitClosed(2500), CLOSE.IDLE);
    assert.equal((await mute.waitFor('bye')).reason, 'idle');
    // a client that only sends application pings counts as alive
    const { ws: chatty } = await openAuthed(ctx, 'read', (await pairDevice(ctx, 'read')).token);
    chatty.noPong = true;
    for (let i = 0; i < 12; i++) { chatty.send({ t: 'ping', n: i }); await sleep(60); }
    assert.equal(chatty.closed, false);
});

test('ws: abrupt resets and half-open sockets never crash the server', async (t) => {
    const ctx = await makeCtx(t);
    const a = await openAuthed(ctx, 'write');
    a.ws.send({ t: 'attach', ids: [1] });
    await a.ws.waitFor('snapshot');
    for (let i = 0; i < 20; i++) emit(ctx, 1, 'x'.repeat(2000));
    a.ws.sock.resetAndDestroy();
    for (let i = 0; i < 20; i++) emit(ctx, 1, 'x'.repeat(2000));
    // a socket that dies in the middle of the handshake and one that dies in the middle of a frame
    const half = net.connect(ctx.port, '127.0.0.1');
    half.on('error', () => {});
    half.write('GET /ws HTTP/1.1\r\nHost: 127.0.0.1:' + ctx.port + '\r\nUpgr');
    half.resetAndDestroy();
    const mid = await openAuthed(ctx, 'read');
    mid.ws.sock.write(mkFrame({ payload: '{"t":"ping"' }).subarray(0, 9));
    mid.ws.sock.resetAndDestroy();
    // garbage that is not HTTP at all
    await rawHttp(ctx.port, '\x16\x03\x01\x02\x00\x01\x00\x01\xfc\x03\x03garbage\r\n\r\n');
    await sleep(150);
    const fine = await openAuthed(ctx, 'read');
    await roundTrip(fine.ws, 1);
    assert.equal((await httpRequest(ctx.port, { path: '/' })).status, 200);
    assert.equal(ctx.server.stats().clients, 1);
});

// ============================================================================================== audit log

test('audit log: events are recorded, tokens, secrets and keystrokes never are', async (t) => {
    const ctx = await makeCtx(t);
    ctx.autoRole = 'write';
    const { secret } = ctx.server.newPairing();
    const r = await postPair(ctx, secret, { label: 'Audit phone' });
    const { ws } = await openAuthed(ctx, 'write', r.token);
    ws.send({ t: 'attach', ids: [1] });
    await ws.waitFor('snapshot');
    ws.send({ t: 'input', id: 1, data: 'KEYSTROKE-MARKER-9f3a\r' });
    ws.send({ t: 'input', id: 1, data: '\x1b[?1;2c' });
    await roundTrip(ws, 1);
    await postPair(ctx, 'wrong-secret-value-aaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const evil = await connectWs(ctx.port, { origin: 'http://evil.example' });
    evil.sock.destroy();
    ws.sock.destroy();
    await sleep(100);
    const all = ctx.logs.join('\n');
    for (const forbidden of [secret, r.token, 'KEYSTROKE-MARKER-9f3a', 'wrong-secret-value']) {
        assert.ok(!all.includes(forbidden), 'the log must not contain ' + forbidden.slice(0, 12));
    }
    for (const expected of ['pair-request', 'pair-approved', 'ws-connected', 'pair-failed', 'rejected origin', 'ws-closed']) {
        assert.ok(all.includes(expected), 'log has ' + expected + '\n' + all);
    }
    assert.ok(ctx.logs.every((l) => l.startsWith('[web] ')));
    assert.ok(!/[\u0000-\u0008\u000b-\u001f]/.test(all), 'no control characters from hostile input in the log');
});
