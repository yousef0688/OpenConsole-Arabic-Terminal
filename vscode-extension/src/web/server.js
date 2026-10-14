'use strict';
// WebShareServer: serves the OpenConsole browser page and mirrors the owner's shared terminals over a
// WebSocket. Node built-ins only. See the protocol notes next to this file's callers; the rules enforced here:
//
//   - binds loopback by default; any other address needs allowNonLoopback === true
//   - Host allow-list on every HTTP route and INSIDE the upgrade handler (DNS rebinding)
//   - Origin allow-list on POST /api/pair and GET /ws; a missing or "null" Origin is rejected
//   - no cookies; the token travels only in the first WebSocket message; pairing secrets are single use
//   - the owner approves every new device and picks its role; the role lives on the server only
//   - strict frame parser (ws.js), 64 KiB messages, 16 KiB input, rate limits, pre-auth caps, client cap
//   - slow clients get a bounded queue and then a fresh snapshot; the owner side is never blocked
//   - audit lines go to log() and never contain tokens, secrets or keystrokes

const http = require('node:http');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { acceptWebSocket, rejectSocket } = require('./ws');
const { AuthManager } = require('./auth');

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; "
    + "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const APP_FILES = ['remote.js', 'remote.css', 'arabic-layout.js', 'row-patcher.js'];
const VENDOR_FILES = ['xterm.js', 'xterm.css', 'addon-fit.js', 'addon-unicode11.js', 'bidi.js'];

const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.map': 'application/json; charset=utf-8',
};

const CLOSE = Object.freeze({
    BAD_MESSAGE: 4400,
    UNAUTHORIZED: 4401,
    FORBIDDEN: 4403,
    IDLE: 4408,
    TOO_BIG: 4413,
    RATE_LIMITED: 4429,
    REVOKED: 4430,
});

// How ws.js maps frame-level violations onto the application close codes.
const WS_CODES = Object.freeze({
    protocol: CLOSE.BAD_MESSAGE,
    unsupported: CLOSE.BAD_MESSAGE,
    badPayload: CLOSE.BAD_MESSAGE,
    tooBig: CLOSE.TOO_BIG,
    internal: CLOSE.BAD_MESSAGE,
    idle: CLOSE.IDLE,
});

const DEFAULT_LIMITS = Object.freeze({
    maxMessage: 64 * 1024,          // client -> server message cap after authentication
    inputMax: 16 * 1024,            // characters in one 'input' message
    preAuthBytes: 1024,             // largest frame accepted before authentication
    preAuthTotalBytes: 4096,        // total bytes accepted before authentication
    preAuthMax: 8,                  // sockets allowed to sit unauthenticated at once
    authTimeoutMs: 5000,
    approvalTimeoutMs: 60000,
    maxPendingApprovals: 3,
    pairBodyMax: 1024,
    pairBodyTimeoutMs: 5000,
    pairingTtlMs: 10 * 60 * 1000,
    pairFailPerMin: 2,
    pairFailPerHour: 12,
    authFailPerMin: 10,
    authFailPerHour: 60,
    pingIntervalMs: 20000,
    idleTimeoutMs: 70000,
    closeTimeoutMs: 2000,
    queueMaxBytes: 1024 * 1024,     // per client, queued output waiting for the socket
    coalesceBytes: 32 * 1024,       // queued output chunks of one terminal are merged up to this size
    ackWindow: 512 * 1024,          // unacknowledged characters per terminal before we hold output (ack users only)
    msgBurst: 300,                  // inbound message bucket
    msgPerSec: 100,
    byteBurst: 1024 * 1024,         // inbound payload bucket (characters)
    bytesPerSec: 512 * 1024,
    sweepMs: 30000,
    maxConnections: 128,
    maxHeaderSize: 8 * 1024,
    staticMaxBytes: 8 * 1024 * 1024,
});

// Terminal answers to queries (DA1/DA2, CPR, colour queries, XTVERSION, window reports, DECRPM). A web
// client must never forward these: every viewer's emulator answers the same query and the shell would
// receive N copies. Real keys (arrows, Esc, Ctrl combos, F-keys) do not match.
const REPLY_RE = /\x1b\[[?>]?[\d;]*c|\x1b\[\d+;\d+R|\x1b\[\??\d+;\d+\$y|\x1b\[\d+(?:;\d+){1,2}t|\x1bP[>!]?\|[^\x1b\x07]*(?:\x1b\\|\x07)?|\x1b\](?:10|11|12|4);[^\x07\x1b]*(?:\x07|\x1b\\)?/g;

function filterInput(data) {
    if (data.indexOf('\x1b') === -1) return data;
    return data.replace(REPLY_RE, '');
}

const noop = () => {};

function clean(value, max) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

function stripV4Mapped(addr) {
    return typeof addr === 'string' && addr.startsWith('::ffff:') ? addr.slice(7) : (addr || '');
}

function isLoopbackAddress(address) {
    if (address === 'localhost') return true;
    const a = stripV4Mapped(address);
    if (net.isIPv4(a)) return a.startsWith('127.');
    return a === '::1';
}

function normalizeHost(value) {
    let h = String(value || '').trim().toLowerCase();
    if (h.includes('://')) {
        try { h = new URL(h).host.toLowerCase(); } catch { return ''; }
    }
    return /^[a-z0-9.\-:\[\]]{1,255}$/.test(h) ? h : '';
}

function validId(id) {
    return Number.isSafeInteger(id) && id >= 0;
}

class Client {
    constructor(id, conn, remoteAddress, now, limits) {
        this.id = id;
        this.conn = conn;
        this.remoteAddress = remoteAddress;
        this.state = 'preauth';          // preauth -> authed -> closed
        this.device = null;
        this.role = 'read';
        this.connectedAt = now;
        this.authTimer = null;
        this.attached = new Set();
        this.queue = [];                 // { kind: 'output'|'snapshot'|'ctl', id, data|text }
        this.queuedBytes = 0;
        this.resync = new Set();         // terminals that need a fresh snapshot once the client caught up
        this.waitDrain = false;
        this.sent = new Map();           // terminal -> characters of output sent since its last snapshot
        this.acked = new Map();          // terminal -> characters the page acknowledged
        this.usesAck = false;
        this.rate = { t: now, msgs: limits.msgBurst, bytes: limits.byteBurst };
        this.droppedReplies = 0;
    }
}

class WebShareServer extends EventEmitter {
    constructor(options) {
        super();
        const o = options || {};
        if (!o.bridge) throw new TypeError('WebShareServer needs a bridge');
        this.bridge = o.bridge;
        this._assets = typeof o.assets === 'function' ? o.assets : () => null;
        this._log = typeof o.log === 'function' ? o.log : noop;
        this._now = typeof o.now === 'function' ? o.now : Date.now;
        this._csp = typeof o.csp === 'string' && o.csp ? o.csp : CSP;
        this._appFiles = new Set(o.appFiles || APP_FILES);
        this._vendorFiles = new Set(o.vendorFiles || VENDOR_FILES);
        this._allowNonLoopback = o.allowNonLoopback === true;
        this.limits = Object.assign({}, DEFAULT_LIMITS, o.limits);
        this.auth = new AuthManager({
            now: this._now,
            pairingTtlMs: this.limits.pairingTtlMs,
            pairFailPerMin: this.limits.pairFailPerMin,
            pairFailPerHour: this.limits.pairFailPerHour,
            authFailPerMin: this.limits.authFailPerMin,
            authFailPerHour: this.limits.authFailPerHour,
        });
        this.port = 0;
        this.bindAddress = '';
        this.maxClients = 5;
        this._http = null;
        this._stopping = false;
        this._hosts = new Set();
        this._sockets = new Set();
        this._clients = new Set();       // authenticated connections
        this._preAuth = new Set();       // connected, not yet authenticated
        this._pending = new Set();       // approvals waiting for the owner
        this._sweepTimer = null;
        this._seq = 0;
    }

    // ---------------------------------------------------------------- lifecycle

    get listening() { return !!this._http && this._http.listening; }

    async start(options) {
        const o = options || {};
        if (this._http) throw new Error('web share server is already running');
        const bindAddress = o.bindAddress || '127.0.0.1';
        if (!isLoopbackAddress(bindAddress) && !(o.allowNonLoopback === true || this._allowNonLoopback)) {
            throw new Error('refusing to bind a non-loopback address (' + bindAddress + ') without allowNonLoopback: true');
        }
        this.maxClients = Number.isInteger(o.maxClients) && o.maxClients > 0 ? o.maxClients : 5;
        if (o.ttlMs) this.auth.setDeviceTtl(o.ttlMs);
        this._stopping = false;

        const L = this.limits;
        const server = http.createServer({
            maxHeaderSize: L.maxHeaderSize,
            headersTimeout: 10000,
            requestTimeout: 15000,
            keepAliveTimeout: 5000,
        });
        server.maxConnections = L.maxConnections;
        server.on('connection', (socket) => {
            socket.on('error', noop);
            this._sockets.add(socket);
            socket.once('close', () => this._sockets.delete(socket));
        });
        server.on('request', (req, res) => this._onRequest(req, res));
        server.on('upgrade', (req, socket, head) => this._onUpgrade(req, socket, head));
        server.on('clientError', (err, socket) => {
            try {
                if (socket.writable && !socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
                else socket.destroy();
            } catch { /* ignore */ }
        });

        await new Promise((resolve, reject) => {
            const onError = (err) => reject(err);
            server.once('error', onError);
            server.listen({ port: o.port || 0, host: bindAddress }, () => {
                server.removeListener('error', onError);
                resolve();
            });
        });
        server.on('error', (err) => this._audit('server-error code=' + clean(err && err.code, 40)));

        this._http = server;
        this.port = server.address().port;
        this.bindAddress = bindAddress;
        this._hosts = new Set(['127.0.0.1:' + this.port, 'localhost:' + this.port, '[::1]:' + this.port]);
        if (!isLoopbackAddress(bindAddress) && bindAddress !== '0.0.0.0' && bindAddress !== '::') {
            this._hosts.add((net.isIPv6(bindAddress) ? '[' + bindAddress + ']' : bindAddress) + ':' + this.port);
        }
        for (const h of o.extraHosts || []) this.addAllowedHost(h);

        this._sweepTimer = setInterval(() => this._sweep(), L.sweepMs);
        this._audit('started bind=' + bindAddress + ' port=' + this.port + ' hosts=' + this._hosts.size);
        return { port: this.port };
    }

    async stop() {
        const server = this._http;
        if (!server) return;
        this._stopping = true;
        this._http = null;
        clearInterval(this._sweepTimer);
        this._sweepTimer = null;

        for (const p of Array.from(this._pending)) p.finish(403, { error: 'stopped' });
        this.auth.clear();

        const closing = [];
        for (const c of Array.from(this._clients).concat(Array.from(this._preAuth))) {
            closing.push(new Promise((resolve) => c.conn.once('close', resolve)));
            this._kick(c, 1001, 'stopped');
        }
        const closed = new Promise((resolve) => server.close(() => resolve()));
        // Give the close handshakes a moment, then cut whatever is left so the port is free right away.
        await Promise.race([Promise.all(closing), new Promise((resolve) => setTimeout(resolve, 250))]);
        for (const s of this._sockets) { try { s.destroy(); } catch { /* ignore */ } }
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        await closed;
        this._clients.clear();
        this._preAuth.clear();
        this._sockets.clear();
        this._pending.clear();
        this._audit('stopped');
    }

    addAllowedHost(host) {
        const h = normalizeHost(host);
        if (h) this._hosts.add(h);
        return !!h;
    }

    removeAllowedHost(host) {
        return this._hosts.delete(normalizeHost(host));
    }

    allowedHosts() { return Array.from(this._hosts); }

    // ---------------------------------------------------------------- owner-facing API

    newPairing() {
        const r = this.auth.newPairing();
        this._audit('pairing-created');
        return { secret: r.secret, expiresAt: r.expiresAt };
    }

    devices() {
        const live = new Map();
        for (const c of this._clients) {
            const id = c.device.deviceId;
            const e = live.get(id) || { count: 0, since: Infinity };
            e.count++;
            e.since = Math.min(e.since, c.connectedAt);
            live.set(id, e);
        }
        return this.auth.listDevices().map((d) => {
            const e = live.get(d.deviceId);
            return {
                deviceId: d.deviceId,
                label: d.label,
                role: d.role,
                connectedAt: e ? e.since : null,
                remoteAddress: d.remoteAddress,
                connections: e ? e.count : 0,
                userAgent: d.userAgent,
                createdAt: d.createdAt,
                expiresAt: d.expiresAt,
                lastSeenAt: d.lastSeenAt,
            };
        });
    }

    revoke(deviceId) {
        const existed = this.auth.revoke(deviceId);
        for (const p of Array.from(this._pending)) if (p.deviceId === deviceId) p.finish(403, { error: 'denied' });
        for (const c of Array.from(this._clients)) {
            if (c.device && c.device.deviceId === deviceId) this._kick(c, CLOSE.REVOKED, 'revoked');
        }
        if (existed) this._audit('revoked device=' + clean(deviceId, 40));
        return existed;
    }

    revokeAll() {
        let n = 0;
        for (const d of this.auth.listDevices()) if (this.revoke(d.deviceId)) n++;
        return n;
    }

    stats() {
        return {
            clients: this._clients.size,
            preAuth: this._preAuth.size,
            pendingApprovals: this._pending.size,
            sockets: this._sockets.size,
            queues: Array.from(this._clients, (c) => ({
                deviceId: c.device.deviceId,
                queuedBytes: c.queuedBytes,
                queueItems: c.queue.length,
                resync: Array.from(c.resync),
                attached: Array.from(c.attached),
                droppedReplies: c.droppedReplies,
            })),
        };
    }

    output(id, data) {
        if (typeof data !== 'string' || data.length === 0 || !validId(id)) return;
        let json = null;
        const getJson = () => json || (json = JSON.stringify({ t: 'output', id, data }));
        for (const c of this._clients) {
            if (!c.attached.has(id)) continue;
            if (c.resync.has(id)) continue;                       // the pending snapshot will contain it
            if (!c.waitDrain && c.queue.length === 0 && !this._ackBlocked(c, id)) {
                this._writeOutput(c, id, data, getJson());
            } else {
                this._queueOutput(c, id, data);
            }
        }
    }

    resize(id, cols, rows) {
        if (!validId(id)) return;
        const text = JSON.stringify({ t: 'resize', id, cols: cols | 0, rows: rows | 0 });
        for (const c of this._clients) if (c.attached.has(id)) this._sendControl(c, text);
    }

    title(id, name) {
        if (!validId(id)) return;
        const text = JSON.stringify({ t: 'title', id, name: clean(name, 200) });
        const shared = this._sharedIds();
        for (const c of this._clients) if (shared.has(id) || c.attached.has(id)) this._sendControl(c, text);
    }

    exit(id, code) {
        if (!validId(id)) return;
        const text = JSON.stringify({ t: 'exit', id, code: Number.isFinite(code) ? code : null });
        const shared = this._sharedIds();
        for (const c of this._clients) if (shared.has(id) || c.attached.has(id)) this._sendControl(c, text);
    }

    state(id, state, attention) {
        if (!validId(id)) return;
        const text = JSON.stringify({ t: 'state', id, state: clean(state, 64), attention: !!attention });
        const shared = this._sharedIds();
        for (const c of this._clients) if (shared.has(id) || c.attached.has(id)) this._sendControl(c, text);
    }

    // The shared list changed (opened, closed, renamed, resized). Call it after every change.
    listChanged() {
        const terminals = this._terminals();
        const ids = new Set(terminals.map((t) => t.id));
        const text = JSON.stringify({ t: 'terminals', terminals });
        for (const c of this._clients) {
            for (const id of Array.from(c.attached)) {
                if (!ids.has(id)) this._forget(c, id);
            }
            this._sendControl(c, text);
        }
    }

    // ---------------------------------------------------------------- helpers

    _emit(name, payload) {
        try { this.emit(name, payload); } catch (err) { this._audit('listener-error event=' + name); }
    }

    _audit(line) {
        try { this._log('[web] ' + line); } catch { /* the log must never break the server */ }
    }

    _terminals() {
        let list;
        try { list = this.bridge.list(); } catch { list = []; }
        const out = [];
        for (const t of Array.isArray(list) ? list : []) {
            if (!t || !validId(t.id)) continue;
            out.push({ id: t.id, name: clean(t.name, 200), cols: t.cols | 0, rows: t.rows | 0 });
        }
        return out;
    }

    _sharedIds() {
        return new Set(this._terminals().map((t) => t.id));
    }

    _takeSnapshot(id) {
        let snap;
        try { snap = this.bridge.snapshot(id); } catch { snap = null; }
        if (!snap) return null;
        const data = typeof snap.data === 'string' ? snap.data : (Buffer.isBuffer(snap.data) ? snap.data.toString('utf8') : '');
        return { cols: snap.cols | 0, rows: snap.rows | 0, data };
    }

    _hostOk(req) {
        const h = req.headers.host;
        return typeof h === 'string' && this._hosts.has(h.toLowerCase());
    }

    _originOk(req) {
        const o = req.headers.origin;
        if (typeof o !== 'string' || o === '' || o.toLowerCase() === 'null') return false;
        const m = /^https?:\/\/([^/]+)$/i.exec(o);
        return !!m && this._hosts.has(m[1].toLowerCase());
    }

    _headers(extra) {
        return Object.assign({
            'Content-Security-Policy': this._csp,
            'Referrer-Policy': 'no-referrer',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Cross-Origin-Resource-Policy': 'same-origin',
            'X-Frame-Options': 'DENY',
        }, extra);
    }

    _send(res, status, body, extraHeaders, headOnly) {
        if (res.headersSent || res.writableEnded) return;
        const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
        const headers = this._headers(Object.assign({ 'Content-Length': buf.length }, extraHeaders));
        res.writeHead(status, headers);
        res.end(headOnly ? undefined : buf);
    }

    _json(res, status, obj, extraHeaders) {
        this._send(res, status, JSON.stringify(obj), Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extraHeaders));
    }

    _plain(res, status, text, extraHeaders) {
        this._send(res, status, text, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, extraHeaders));
    }

    // ---------------------------------------------------------------- HTTP

    _onRequest(req, res) {
        res.on('error', noop);
        req.on('error', noop);
        try {
            this._route(req, res);
        } catch (err) {
            this._audit('route-error ' + clean(err && err.message, 80));
            try { this._plain(res, 500, 'Internal Server Error', { Connection: 'close' }); } catch { /* ignore */ }
        }
    }

    _route(req, res) {
        // Host check first, on every request, before any routing.
        if (!this._hostOk(req)) {
            this._audit('rejected host=' + clean(req.headers.host, 80) + ' path-kind=http');
            this._plain(res, 403, 'Forbidden', { Connection: 'close' });
            return;
        }
        const raw = typeof req.url === 'string' ? req.url : '';
        const q = raw.indexOf('?');
        const pathname = q < 0 ? raw : raw.slice(0, q);
        const method = req.method;

        if (pathname === '/ws') {
            this._plain(res, 426, 'Upgrade Required', { Upgrade: 'websocket', Connection: 'Upgrade' });
            return;
        }
        if (pathname === '/api/pair') {
            if (method !== 'POST') {
                this._plain(res, 405, 'Method Not Allowed', { Allow: 'POST', Connection: 'close' });
                return;
            }
            this._handlePair(req, res);
            return;
        }
        const asset = this._assetPath(pathname);
        if (asset) {
            if (method !== 'GET' && method !== 'HEAD') {
                this._plain(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD', Connection: 'close' });
                return;
            }
            this._serveAsset(res, asset, method === 'HEAD');
            return;
        }
        this._plain(res, 404, 'Not Found');
    }

    // Static files are matched against a fixed whitelist on the RAW path. Nothing is decoded and nothing is
    // joined onto a directory here, so "..", "%2e%2e", backslashes and NUL bytes simply never match.
    _assetPath(pathname) {
        if (pathname === '/') return '/';
        const m = /^\/(app|vendor)\/([A-Za-z0-9._-]{1,64})$/.exec(pathname);
        if (!m) return null;
        const set = m[1] === 'app' ? this._appFiles : this._vendorFiles;
        return set.has(m[2]) ? pathname : null;
    }

    _serveAsset(res, urlPath, headOnly) {
        let file = null;
        try { file = this._assets(urlPath); } catch { file = null; }
        if (typeof file !== 'string' || !path.isAbsolute(file)) {
            this._plain(res, 404, 'Not Found');
            return;
        }
        fs.stat(file, (err, st) => {
            if (err || !st.isFile() || st.size > this.limits.staticMaxBytes) {
                this._plain(res, 404, 'Not Found');
                return;
            }
            fs.readFile(file, (err2, data) => {
                if (err2) {
                    this._plain(res, 404, 'Not Found');
                    return;
                }
                const type = CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
                this._send(res, 200, data, { 'Content-Type': type }, headOnly);
            });
        });
    }

    _readBody(req, max, timeoutMs, cb) {
        const chunks = [];
        let size = 0;
        let done = false;
        const timer = setTimeout(() => finish('timeout'), timeoutMs);
        function finish(err, buf) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            req.removeListener('data', onData);
            cb(err, buf);
        }
        function onData(chunk) {
            size += chunk.length;
            if (size > max) { finish('too-large'); return; }
            chunks.push(chunk);
        }
        req.on('data', onData);
        req.on('end', () => finish(null, Buffer.concat(chunks)));
        req.on('close', () => finish('aborted'));
    }

    _handlePair(req, res) {
        const remote = stripV4Mapped(req.socket.remoteAddress);
        const closeAfter = { Connection: 'close' };
        if (!this._originOk(req)) {
            this._audit('rejected origin=' + clean(req.headers.origin, 80) + ' path-kind=pair');
            this._json(res, 403, { error: 'forbidden' }, closeAfter);
            return;
        }
        if (!/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] || ''))) {
            this._json(res, 415, { error: 'unsupported-media-type' }, closeAfter);
            return;
        }
        const cl = req.headers['content-length'];
        if (cl !== undefined) {
            const n = Number(cl);
            if (!Number.isInteger(n) || n < 0) { this._json(res, 400, { error: 'bad-request' }, closeAfter); return; }
            if (n > this.limits.pairBodyMax) { this._json(res, 413, { error: 'too-large' }, closeAfter); return; }
        }
        const wait = this.auth.pairLimiter.retryAfterMs();
        if (wait > 0) {
            this._audit('pair-limited addr=' + clean(remote, 64));
            this._json(res, 429, { error: 'rate-limited' }, Object.assign({ 'Retry-After': String(Math.ceil(wait / 1000)) }, closeAfter));
            return;
        }
        if (this._pending.size >= this.limits.maxPendingApprovals) {
            this._emit('limit', { kind: 'approvals', pending: this._pending.size });
            this._json(res, 429, { error: 'busy' }, Object.assign({ 'Retry-After': '10' }, closeAfter));
            return;
        }
        this._readBody(req, this.limits.pairBodyMax, this.limits.pairBodyTimeoutMs, (err, buf) => {
            if (err) {
                if (err === 'aborted') return;
                this._json(res, err === 'too-large' ? 413 : 408, { error: err }, closeAfter);
                return;
            }
            let body;
            try { body = JSON.parse(buf.toString('utf8')); } catch { body = null; }
            if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.secret !== 'string') {
                this._json(res, 400, { error: 'bad-request' }, closeAfter);
                return;
            }
            const r = this.auth.redeemPairing(body.secret);
            if (!r.ok) {
                if (r.reason === 'limited') {
                    this._json(res, 429, { error: 'rate-limited' }, Object.assign({ 'Retry-After': String(Math.ceil(r.retryAfterMs / 1000)) }, closeAfter));
                    return;
                }
                this._audit('pair-failed reason=' + r.reason + ' addr=' + clean(remote, 64));
                if (r.tripped) {
                    this._audit('pairing-locked retry-ms=' + r.retryAfterMs);
                    this._emit('limit', { kind: 'pairing', retryAfterMs: r.retryAfterMs });
                }
                this._json(res, 403, { error: r.reason }, closeAfter);
                return;
            }
            const label = clean(body.label, 80) || 'Unknown device';
            this._beginApproval(req, res, label, remote);
        });
    }

    _beginApproval(req, res, label, remote) {
        const deviceId = this.auth.reserveDeviceId();
        const userAgent = clean(req.headers['user-agent'], 200);
        const fwd = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'];
        const pending = { deviceId, settled: false, timer: null, finish: null };
        this._pending.add(pending);

        const finish = (status, body) => {
            if (pending.settled) return false;
            pending.settled = true;
            clearTimeout(pending.timer);
            this._pending.delete(pending);
            this._json(res, status, body);
            return true;
        };
        pending.finish = finish;

        const request = {
            deviceId,
            label,
            remoteAddress: remote,
            forwardedFor: fwd ? clean(fwd, 64) : null,   // as sent by a proxy; unverified, for display only
            userAgent,
            requestedAt: this._now(),
            approve: (role) => {
                if (pending.settled) return false;
                if (!res.socket || res.socket.destroyed) return false;
                const made = this.auth.createDevice({ deviceId, label, role, remoteAddress: remote, userAgent });
                finish(200, { token: made.token, deviceId, role: made.device.role });
                this._audit('pair-approved device=' + deviceId + ' role=' + made.device.role);
                return true;
            },
            deny: () => {
                if (!finish(403, { error: 'denied' })) return false;
                this._audit('pair-denied device=' + deviceId);
                return true;
            },
        };

        res.on('close', () => {
            if (pending.settled) return;
            pending.settled = true;
            clearTimeout(pending.timer);
            this._pending.delete(pending);
            this._audit('pair-abandoned device=' + deviceId);
            this._emit('approval-cancel', { deviceId, reason: 'closed' });
        });
        pending.timer = setTimeout(() => {
            if (finish(403, { error: 'timeout' })) {
                this._audit('pair-timeout device=' + deviceId);
                this._emit('approval-cancel', { deviceId, reason: 'timeout' });
            }
        }, this.limits.approvalTimeoutMs);

        this._audit('pair-request device=' + deviceId + ' label="' + label + '" addr=' + clean(remote, 64));
        if (this.listenerCount('approval') === 0) {
            finish(403, { error: 'denied' });       // nobody to ask: fail closed
            this._audit('pair-denied device=' + deviceId + ' (no approver)');
            return;
        }
        this._emit('approval', request);
    }

    // ---------------------------------------------------------------- WebSocket

    _onUpgrade(req, socket, head) {
        socket.on('error', noop);
        if (this._stopping || !this._http) { rejectSocket(socket, 503, 'Service Unavailable'); return; }
        // Every gate lives here, in the upgrade handler itself.
        if (!this._hostOk(req)) {
            this._audit('rejected host=' + clean(req.headers.host, 80) + ' path-kind=ws');
            rejectSocket(socket, 403, 'Forbidden');
            return;
        }
        if (req.url !== '/ws') { rejectSocket(socket, 404, 'Not Found'); return; }
        if (!this._originOk(req)) {
            this._audit('rejected origin=' + clean(req.headers.origin, 80) + ' path-kind=ws');
            rejectSocket(socket, 403, 'Forbidden');
            return;
        }
        const L = this.limits;
        if (this._preAuth.size >= L.preAuthMax) {
            this._emit('limit', { kind: 'preauth', count: this._preAuth.size });
            rejectSocket(socket, 503, 'Service Unavailable', { 'Retry-After': '5' });
            return;
        }
        const conn = acceptWebSocket(req, socket, head, {
            maxMessage: L.preAuthBytes,
            pingIntervalMs: L.pingIntervalMs,
            idleTimeoutMs: L.idleTimeoutMs,
            closeTimeoutMs: L.closeTimeoutMs,
            codes: WS_CODES,
        });
        if (!conn) return;
        conn.setByteBudget(L.preAuthTotalBytes);

        const c = new Client(++this._seq, conn, stripV4Mapped(req.socket.remoteAddress), this._now(), L);
        this._preAuth.add(c);
        c.authTimer = setTimeout(() => this._kick(c, CLOSE.UNAUTHORIZED, 'auth-timeout'), L.authTimeoutMs);
        conn.on('message', (text) => this._onMessage(c, text));
        conn.on('violation', (err) => this._audit('ws-violation client=' + c.id + ' reason="' + clean(err.reason, 60) + '"'));
        conn.on('idle', () => { this._audit('ws-idle client=' + c.id); try { conn.sendText(JSON.stringify({ t: 'bye', reason: 'idle' })); } catch { /* gone */ } });
        conn.on('drain', () => { c.waitDrain = false; this._pump(c); });
        conn.on('close', (code) => this._onClose(c, code));
    }

    // Say goodbye and close. Safe to call at any time and more than once.
    _kick(c, code, reason) {
        if (c.conn.state !== 'open') return;
        c.conn.sendText(JSON.stringify({ t: 'bye', reason }));
        c.conn.close(code, reason);
    }

    _onClose(c, code) {
        clearTimeout(c.authTimer);
        const wasAuthed = c.state === 'authed';
        c.state = 'closed';
        this._preAuth.delete(c);
        this._clients.delete(c);
        c.queue = [];
        c.queuedBytes = 0;
        if (wasAuthed) {
            const dev = this._publicClient(c);
            this._audit('ws-closed device=' + c.device.deviceId + ' code=' + code);
            this._emit('disconnect', dev);
        } else {
            this._audit('ws-closed client=' + c.id + ' unauthenticated code=' + code);
        }
    }

    _publicClient(c) {
        let n = 0;
        for (const o of this._clients) if (o.device.deviceId === c.device.deviceId) n++;
        return {
            deviceId: c.device.deviceId,
            label: c.device.label,
            role: c.role,
            connectedAt: c.connectedAt,
            remoteAddress: c.remoteAddress,
            connections: n,
        };
    }

    _takeBudget(c, size) {
        const L = this.limits;
        const t = this._now();
        const dt = Math.max(0, t - c.rate.t) / 1000;
        c.rate.t = t;
        c.rate.msgs = Math.min(L.msgBurst, c.rate.msgs + dt * L.msgPerSec);
        c.rate.bytes = Math.min(L.byteBurst, c.rate.bytes + dt * L.bytesPerSec);
        if (c.rate.msgs < 1 || c.rate.bytes < size) return false;
        c.rate.msgs -= 1;
        c.rate.bytes -= size;
        return true;
    }

    _onMessage(c, text) {
        if (c.state === 'closed') return;
        let msg;
        try { msg = JSON.parse(text); } catch { this._kick(c, CLOSE.BAD_MESSAGE, 'bad-json'); return; }
        if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') {
            this._kick(c, CLOSE.BAD_MESSAGE, 'bad-message');
            return;
        }
        if (c.state === 'preauth') {
            if (msg.t !== 'auth') { this._kick(c, CLOSE.UNAUTHORIZED, 'unauthenticated'); return; }
            this._handleAuth(c, msg);
            return;
        }
        if (!this._takeBudget(c, text.length)) {
            this._audit('ws-rate-limited device=' + c.device.deviceId);
            this._emit('limit', { kind: 'messages', deviceId: c.device.deviceId });
            this._kick(c, CLOSE.RATE_LIMITED, 'rate-limited');
            return;
        }
        switch (msg.t) {
            case 'attach': this._handleAttach(c, msg); break;
            case 'detach': this._handleDetach(c, msg); break;
            case 'input': this._handleInput(c, msg); break;
            case 'ping': this._handlePing(c, msg); break;
            case 'ack': this._handleAck(c, msg); break;
            default: this._kick(c, CLOSE.BAD_MESSAGE, 'unknown-type'); break;
        }
    }

    _handleAuth(c, msg) {
        if (typeof msg.token !== 'string' || msg.token.length > 256) {
            this._kick(c, CLOSE.UNAUTHORIZED, 'unauthorized');
            return;
        }
        const r = this.auth.authenticate(msg.token);
        if (!r.ok) {
            if (r.reason === 'limited') {
                this._audit('ws-auth-limited client=' + c.id);
                this._kick(c, CLOSE.RATE_LIMITED, 'rate-limited');
                return;
            }
            this._audit('ws-auth-failed client=' + c.id);
            if (r.tripped) {
                this._audit('auth-locked retry-ms=' + r.retryAfterMs);
                this._emit('limit', { kind: 'auth', retryAfterMs: r.retryAfterMs });
            }
            this._kick(c, CLOSE.UNAUTHORIZED, 'unauthorized');
            return;
        }
        if (this._clients.size >= this.maxClients) {
            this._audit('ws-refused too-many-clients device=' + r.device.deviceId);
            this._emit('limit', { kind: 'clients', max: this.maxClients });
            this._kick(c, CLOSE.RATE_LIMITED, 'too-many-clients');
            return;
        }
        clearTimeout(c.authTimer);
        this._preAuth.delete(c);
        c.state = 'authed';
        c.device = r.device;
        c.role = r.device.role;                  // fixed by the owner at approval time, never by the client
        c.conn.setMaxMessage(this.limits.maxMessage);
        c.conn.setByteBudget(Infinity);
        this._clients.add(c);
        c.conn.sendText(JSON.stringify({
            t: 'hello',
            role: c.role,
            terminals: this._terminals(),
            limits: { input: this.limits.inputMax },
            readOnly: c.role !== 'write',
        }));
        this._audit('ws-connected device=' + c.device.deviceId + ' role=' + c.role + ' addr=' + clean(c.remoteAddress, 64));
        this._emit('connect', this._publicClient(c));
    }

    _handleAttach(c, msg) {
        const ids = msg.ids;
        if (!Array.isArray(ids) || ids.length > 64 || !ids.every(validId)) {
            this._kick(c, CLOSE.BAD_MESSAGE, 'bad-attach');
            return;
        }
        const shared = this._sharedIds();
        for (const id of new Set(ids)) {
            if (!shared.has(id)) continue;
            // One synchronous block: take the snapshot, register for the stream, queue the snapshot first.
            const snap = this._takeSnapshot(id);
            if (!snap) continue;
            c.attached.add(id);
            c.resync.delete(id);
            this._purge(c, id);
            c.queue.push({ kind: 'snapshot', id, text: JSON.stringify({ t: 'snapshot', id, cols: snap.cols, rows: snap.rows, data: snap.data }) });
        }
        this._pump(c);
    }

    _handleDetach(c, msg) {
        if (!Array.isArray(msg.ids) || msg.ids.length > 64 || !msg.ids.every(validId)) {
            this._kick(c, CLOSE.BAD_MESSAGE, 'bad-detach');
            return;
        }
        for (const id of msg.ids) this._forget(c, id);
    }

    _handleInput(c, msg) {
        if (c.role !== 'write') {
            this._audit('ws-read-only-input device=' + c.device.deviceId);
            this._kick(c, CLOSE.FORBIDDEN, 'read-only');
            return;
        }
        if (!validId(msg.id) || typeof msg.data !== 'string') { this._kick(c, CLOSE.BAD_MESSAGE, 'bad-input'); return; }
        if (msg.data.length > this.limits.inputMax) { this._kick(c, CLOSE.TOO_BIG, 'input-too-large'); return; }
        if (msg.data.length === 0 || !c.attached.has(msg.id)) return;
        const data = filterInput(msg.data);
        if (data.length === 0) { c.droppedReplies++; return; }
        try { this.bridge.write(msg.id, data); } catch (err) { this._audit('bridge-write-error'); }
    }

    _handlePing(c, msg) {
        const n = msg.n;
        const reply = { t: 'pong' };
        if (typeof n === 'number' && Number.isFinite(n)) reply.n = n;
        else if (typeof n === 'string' && n.length <= 32) reply.n = n;
        this._sendControl(c, JSON.stringify(reply));
    }

    _handleAck(c, msg) {
        if (!validId(msg.id) || typeof msg.bytes !== 'number' || !Number.isFinite(msg.bytes) || msg.bytes < 0) {
            this._kick(c, CLOSE.BAD_MESSAGE, 'bad-ack');
            return;
        }
        if (!c.attached.has(msg.id)) return;
        c.usesAck = true;
        const sent = c.sent.get(msg.id) || 0;
        const prev = c.acked.get(msg.id) || 0;
        c.acked.set(msg.id, Math.max(prev, Math.min(Math.floor(msg.bytes), sent)));
        this._pump(c);
    }

    // ---------------------------------------------------------------- per-client queue

    _ackBlocked(c, id) {
        return c.usesAck && (c.sent.get(id) || 0) - (c.acked.get(id) || 0) >= this.limits.ackWindow;
    }

    _writeOutput(c, id, data, json) {
        const ok = c.conn.sendText(json || JSON.stringify({ t: 'output', id, data }));
        c.sent.set(id, (c.sent.get(id) || 0) + data.length);
        if (!ok) c.waitDrain = true;
    }

    _queueOutput(c, id, data) {
        if (c.queuedBytes + data.length > this.limits.queueMaxBytes) {
            this._overflow(c, id);
            return;
        }
        const last = c.queue[c.queue.length - 1];
        if (last && last.kind === 'output' && last.id === id && last.data.length + data.length <= this.limits.coalesceBytes) {
            last.data += data;
        } else {
            c.queue.push({ kind: 'output', id, data });
        }
        c.queuedBytes += data.length;
    }

    // The client cannot keep up. Throw away its queued output, remember which terminals need a fresh snapshot
    // and send those once it caught up. Nothing here ever waits for the client or touches the owner's terminal.
    _overflow(c, id) {
        const kept = [];
        for (const item of c.queue) {
            if (item.kind === 'output') {
                c.resync.add(item.id);
                c.queuedBytes -= item.data.length;
            } else if (item.kind === 'snapshot') {
                c.resync.add(item.id);
            } else {
                kept.push(item);
            }
        }
        c.queue = kept;
        c.resync.add(id);
        this._audit('ws-slow-client device=' + c.device.deviceId + ' resync=' + Array.from(c.resync).join(','));
        this._emit('limit', { kind: 'slow-client', deviceId: c.device.deviceId });
        this._pump(c);
    }

    _sendControl(c, text) {
        if (c.state !== 'authed' || c.conn.state !== 'open') return;
        if (!c.waitDrain && c.queue.length === 0) {
            if (!c.conn.sendText(text)) c.waitDrain = true;
            return;
        }
        c.queue.push({ kind: 'ctl', text });
        c.queuedBytes += text.length;
    }

    // Remove everything queued for one terminal.
    _purge(c, id) {
        if (!c.queue.length) return;
        const kept = [];
        for (const item of c.queue) {
            if (item.id === id && (item.kind === 'output' || item.kind === 'snapshot')) {
                if (item.kind === 'output') c.queuedBytes -= item.data.length;
            } else {
                kept.push(item);
            }
        }
        c.queue = kept;
    }

    _forget(c, id) {
        c.attached.delete(id);
        c.resync.delete(id);
        c.sent.delete(id);
        c.acked.delete(id);
        this._purge(c, id);
    }

    _sendSnapshotNow(c, id, text) {
        c.sent.set(id, 0);       // the page restarts its count at a snapshot; counting low is the safe direction
        c.acked.set(id, 0);
        if (!c.conn.sendText(text)) c.waitDrain = true;
    }

    _pump(c) {
        if (c.state !== 'authed' || c.conn.state !== 'open') return;
        while (c.queue.length && !c.waitDrain) {
            const item = c.queue[0];
            if (item.kind === 'output') {
                if (this._ackBlocked(c, item.id)) return;       // wait for the page to acknowledge
                c.queue.shift();
                c.queuedBytes -= item.data.length;
                this._writeOutput(c, item.id, item.data);
            } else if (item.kind === 'snapshot') {
                c.queue.shift();
                this._sendSnapshotNow(c, item.id, item.text);
            } else {
                c.queue.shift();
                c.queuedBytes -= item.text.length;
                if (!c.conn.sendText(item.text)) c.waitDrain = true;
            }
        }
        if (c.queue.length === 0 && !c.waitDrain && c.resync.size) {
            for (const id of Array.from(c.resync)) {
                if (c.waitDrain) break;
                if (this._ackBlocked(c, id)) continue;
                c.resync.delete(id);
                const snap = this._takeSnapshot(id);
                if (!snap) { c.attached.delete(id); continue; }
                this._sendSnapshotNow(c, id, JSON.stringify({ t: 'snapshot', id, cols: snap.cols, rows: snap.rows, data: snap.data }));
            }
        }
    }

    // ---------------------------------------------------------------- housekeeping

    // Close connections of devices that expired or were revoked. Runs on a timer; tests call it directly.
    _sweep() {
        const gone = this.auth.pruneExpired();
        for (const id of gone) this._audit('device-expired device=' + clean(id, 40));
        const t = this._now();
        for (const c of Array.from(this._clients)) {
            if (!this.auth.getDevice(c.device.deviceId) || c.device.expiresAt <= t) this._kick(c, CLOSE.REVOKED, 'expired');
        }
    }
}

module.exports = {
    WebShareServer,
    filterInput,
    isLoopbackAddress,
    CLOSE,
    WS_CODES,
    CSP,
    APP_FILES,
    VENDOR_FILES,
    DEFAULT_LIMITS,
};
