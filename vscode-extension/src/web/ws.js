'use strict';
// A small, strict, server-side RFC 6455 implementation. Node built-ins only.
//
// What it does:
//   - validates the upgrade request and answers 101 (acceptWebSocket)
//   - parses client frames strictly (FrameReader): masked frames only, RSV must be 0, opcode whitelist,
//     control frames <= 125 bytes and never fragmented, fragmentation reassembly with a hard size cap,
//     UTF-8 validation of text messages, shortest-form length encodings with overflow checks
//   - writes text, ping, pong and close frames
//   - close handshake with a lingering close, server pings, an idle timeout
//   - error and close handlers are ALWAYS attached to the socket, so a reset or an abort can never raise
//     an unhandled 'error' event inside the extension host
//
// What it deliberately does NOT do: extensions (no permessage-deflate), subprotocols, binary messages
// (rejected by default), messages larger than maxMessage (64 KiB by default) from the client.

const crypto = require('node:crypto');
const buffer = require('node:buffer');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

// Close codes used when the peer breaks the rules. The server overrides them with its own 44xx codes.
const DEFAULT_CODES = Object.freeze({
    protocol: 1002,
    unsupported: 1003,
    badPayload: 1007,
    tooBig: 1009,
    internal: 1011,
    idle: 1001,
});

const EMPTY = Buffer.alloc(0);
const noop = () => {};

const isUtf8 = typeof buffer.isUtf8 === 'function'
    ? buffer.isUtf8
    : (b) => {
        try { new TextDecoder('utf-8', { fatal: true }).decode(b); return true; } catch { return false; }
    };

class WsError extends Error {
    constructor(code, reason) {
        super(reason);
        this.name = 'WsError';
        this.code = code;
        this.reason = reason;
    }
}

function acceptKey(key) {
    return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function validCloseCode(code) {
    if (code >= 3000 && code <= 4999) return true;
    if (code >= 1000 && code <= 1014) return code !== 1004 && code !== 1005 && code !== 1006;
    return false;
}

// Cut a string to at most maxBytes of UTF-8 without splitting a character.
function truncateUtf8(str, maxBytes) {
    let buf = Buffer.from(String(str), 'utf8');
    if (buf.length <= maxBytes) return buf;
    let end = maxBytes;
    while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
    return buf.subarray(0, end);
}

// Build one frame. `mask` false = server style, true = random key, or a 4-byte Buffer (used by tests/clients).
function encodeFrame(opcode, payload, options) {
    const fin = !options || options.fin !== false;
    const rsv = (options && options.rsv) || 0;
    let key = null;
    if (options && options.mask) key = Buffer.isBuffer(options.mask) ? options.mask : crypto.randomBytes(4);
    const body = payload || EMPTY;
    const len = body.length;
    const ext = len < 126 ? 0 : len < 65536 ? 2 : 8;
    const head = Buffer.allocUnsafe(2 + ext + (key ? 4 : 0));
    head[0] = (fin ? 0x80 : 0) | ((rsv & 7) << 4) | (opcode & 0x0f);
    const maskBit = key ? 0x80 : 0;
    if (ext === 0) {
        head[1] = maskBit | len;
    } else if (ext === 2) {
        head[1] = maskBit | 126;
        head.writeUInt16BE(len, 2);
    } else {
        head[1] = maskBit | 127;
        head.writeUInt32BE(Math.floor(len / 4294967296), 2);
        head.writeUInt32BE(len >>> 0, 6);
    }
    if (!key) return len ? Buffer.concat([head, body], head.length + len) : head;
    key.copy(head, 2 + ext);
    const out = Buffer.allocUnsafe(head.length + len);
    head.copy(out, 0);
    for (let i = 0; i < len; i++) out[head.length + i] = body[i] ^ key[i & 3];
    return out;
}

function encodeClose(code, reason, options) {
    if (code === null || code === undefined || code === 1005) return encodeFrame(OP_CLOSE, EMPTY, options);
    const text = truncateUtf8(reason || '', 123);
    const body = Buffer.allocUnsafe(2 + text.length);
    body.writeUInt16BE(code, 0);
    text.copy(body, 2);
    return encodeFrame(OP_CLOSE, body, options);
}

// Incremental frame parser. push() delivers complete messages to onMessage and throws WsError on the first
// violation; after a violation (or after a Close frame) the reader ignores everything else.
class FrameReader {
    constructor(options) {
        const o = options || {};
        this.maxMessage = o.maxMessage || 64 * 1024;
        this.maxFragments = o.maxFragments || 64;
        this.expectMasked = o.expectMasked !== false;   // true = we are a server reading client frames
        this.allowBinary = o.allowBinary === true;
        this.codes = Object.assign({}, DEFAULT_CODES, o.codes);
        this.onMessage = o.onMessage || noop;
        this.failed = false;
        this.closed = false;
        this.bytes = 0;
        this._chunks = [];
        this._len = 0;
        this._hdr = null;
        this._frag = null;
    }

    _fail(kind, reason) {
        this.failed = true;
        this._chunks = [];
        this._len = 0;
        this._frag = null;
        this._hdr = null;
        throw new WsError(this.codes[kind], reason);
    }

    // Look at the first n bytes without consuming them. Requires this._len >= n.
    _peek(n) {
        const first = this._chunks[0];
        if (first.length >= n) return first;
        const all = Buffer.concat(this._chunks, this._len);
        this._chunks = [all];
        return all;
    }

    _consume(n) {
        const first = this._chunks[0];
        if (first.length === n) this._chunks.shift();
        else this._chunks[0] = first.subarray(n);
        this._len -= n;
    }

    push(chunk) {
        if (this.failed || this.closed || !chunk || chunk.length === 0) return;
        this.bytes += chunk.length;
        this._chunks.push(chunk);
        this._len += chunk.length;
        while (!this.failed && !this.closed) {
            if (!this._hdr && !this._readHeader()) return;
            if (!this._readPayload()) return;
        }
    }

    _readHeader() {
        if (this._len < 2) return false;
        const b = this._peek(2);
        const b0 = b[0];
        const b1 = b[1];
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;

        // Cheap checks first, before waiting for more bytes.
        if ((b0 & 0x70) !== 0) this._fail('protocol', 'reserved bits set');
        if (opcode !== OP_CONT && opcode !== OP_TEXT && opcode !== OP_BINARY
            && opcode !== OP_CLOSE && opcode !== OP_PING && opcode !== OP_PONG) {
            this._fail('protocol', 'unknown opcode');
        }
        if (opcode === OP_BINARY && !this.allowBinary) this._fail('unsupported', 'binary messages are not supported');
        if (masked !== this.expectMasked) this._fail('protocol', masked ? 'masked frame from the server' : 'unmasked frame from the client');
        const control = opcode >= 0x8;
        if (control && !fin) this._fail('protocol', 'fragmented control frame');
        if (control && len > 125) this._fail('protocol', 'control frame too long');

        const ext = len === 126 ? 2 : len === 127 ? 8 : 0;
        const headSize = 2 + ext + (masked ? 4 : 0);
        if (this._len < headSize) return false;
        const h = this._peek(headSize);

        if (ext === 2) {
            len = h.readUInt16BE(2);
            if (len < 126) this._fail('protocol', 'length not in shortest form');
        } else if (ext === 8) {
            const hi = h.readUInt32BE(2);
            const lo = h.readUInt32BE(6);
            if ((hi & 0x80000000) !== 0) this._fail('protocol', 'length has the top bit set');
            if (hi !== 0) this._fail('tooBig', 'frame too large');
            len = lo;
            if (len < 65536) this._fail('protocol', 'length not in shortest form');
        }
        if (len > this.maxMessage) this._fail('tooBig', 'frame too large');

        if (opcode === OP_CONT) {
            if (!this._frag) this._fail('protocol', 'continuation without a message');
            if (this._frag.size + len > this.maxMessage) this._fail('tooBig', 'message too large');
            if (this._frag.count >= this.maxFragments) this._fail('tooBig', 'too many fragments');
        } else if (opcode === OP_TEXT || opcode === OP_BINARY) {
            if (this._frag) this._fail('protocol', 'new message inside a fragmented message');
        }

        const mask = masked ? Buffer.from(h.subarray(headSize - 4, headSize)) : null;
        this._consume(headSize);
        this._hdr = { fin, opcode, len, mask };
        return true;
    }

    _readPayload() {
        const hd = this._hdr;
        if (this._len < hd.len) return false;
        let payload = EMPTY;
        if (hd.len > 0) {
            const src = this._peek(hd.len);
            payload = Buffer.allocUnsafe(hd.len);
            if (hd.mask) {
                const m = hd.mask;
                for (let i = 0; i < hd.len; i++) payload[i] = src[i] ^ m[i & 3];
            } else {
                src.copy(payload, 0, 0, hd.len);
            }
            this._consume(hd.len);
        }
        this._hdr = null;
        this._dispatch(hd, payload);
        return true;
    }

    _dispatch(hd, payload) {
        switch (hd.opcode) {
            case OP_TEXT:
            case OP_BINARY:
                if (hd.fin) { this._deliver(hd.opcode, payload); return; }
                this._frag = { opcode: hd.opcode, parts: [payload], size: payload.length, count: 1 };
                return;
            case OP_CONT: {
                const f = this._frag;
                f.parts.push(payload);
                f.size += payload.length;
                f.count++;
                if (hd.fin) {
                    this._frag = null;
                    this._deliver(f.opcode, f.parts.length === 1 ? f.parts[0] : Buffer.concat(f.parts, f.size));
                }
                return;
            }
            case OP_PING:
                this.onMessage({ type: 'ping', data: payload });
                return;
            case OP_PONG:
                this.onMessage({ type: 'pong', data: payload });
                return;
            case OP_CLOSE: {
                if (payload.length === 0) {
                    this.closed = true;
                    this.onMessage({ type: 'close', code: 1005, reason: '' });
                    return;
                }
                if (payload.length === 1) this._fail('protocol', 'close frame with a one byte body');
                const code = payload.readUInt16BE(0);
                if (!validCloseCode(code)) this._fail('protocol', 'invalid close code');
                const reasonBytes = payload.subarray(2);
                if (!isUtf8(reasonBytes)) this._fail('badPayload', 'close reason is not UTF-8');
                this.closed = true;
                this.onMessage({ type: 'close', code, reason: reasonBytes.toString('utf8') });
                return;
            }
            default:
                this._fail('protocol', 'unknown opcode');
        }
    }

    _deliver(opcode, payload) {
        if (opcode === OP_BINARY) {
            this.onMessage({ type: 'binary', data: payload });
            return;
        }
        if (!isUtf8(payload)) this._fail('badPayload', 'text message is not valid UTF-8');
        this.onMessage({ type: 'text', data: payload.toString('utf8') });
    }
}

function hasToken(value, token) {
    if (typeof value !== 'string') return false;
    for (const part of value.split(',')) if (part.trim().toLowerCase() === token) return true;
    return false;
}

const KEY_SHAPE = /^[A-Za-z0-9+/]{22}==$/;

// Plain HTTP answer on a socket that will not become a WebSocket, then hang up.
function rejectSocket(socket, status, text, headers) {
    try {
        if (!socket.destroyed && socket.writable) {
            let head = 'HTTP/1.1 ' + status + ' ' + text + '\r\nConnection: close\r\nContent-Length: 0\r\nCache-Control: no-store\r\n';
            if (headers) for (const k of Object.keys(headers)) head += k + ': ' + headers[k] + '\r\n';
            socket.end(head + '\r\n');
        }
    } catch { /* the socket is already gone */ }
    const timer = setTimeout(() => { try { socket.destroy(); } catch { /* ignore */ } }, 1500);
    socket.once('close', () => clearTimeout(timer));
}

class WebSocketConnection extends EventEmitter {
    // Events: 'message'(text), 'pong'(buffer), 'drain', 'violation'(WsError), 'idle', 'close'(code, reason)
    constructor(socket, head, options) {
        super();
        const o = options || {};
        this.socket = socket;
        this.state = 'open';            // open -> closing -> closed
        this.codes = Object.assign({}, DEFAULT_CODES, o.codes);
        this.closeTimeoutMs = o.closeTimeoutMs || 3000;
        this.idleTimeoutMs = o.idleTimeoutMs || 60000;
        this.lastError = null;
        this.localCode = null;          // code we sent in our Close frame
        this.peerCode = null;           // code the peer sent in its Close frame
        this.peerReason = '';
        this._byteBudget = Infinity;
        this._lastRx = Date.now();
        this._closeTimer = null;
        this._pingTimer = null;
        this._closedEmitted = false;

        this._reader = new FrameReader({
            maxMessage: o.maxMessage,
            maxFragments: o.maxFragments,
            allowBinary: o.allowBinary,
            codes: this.codes,
            onMessage: (m) => this._onFrameMessage(m),
        });

        // Always attached, first thing: a reset or abort must never become an unhandled 'error'.
        socket.on('error', (err) => { this.lastError = err; });
        socket.on('close', () => this._onSocketClose());
        socket.on('end', () => this._onSocketEnd());
        socket.on('drain', () => this.emit('drain'));
        socket.on('data', (chunk) => this._onData(chunk));
        socket.pause();   // hold incoming bytes until the caller had a chance to attach its listeners
        try { socket.setNoDelay(true); socket.setTimeout(0); } catch { /* ignore */ }

        process.nextTick(() => {
            if (head && head.length) this._onData(head);
            if (!socket.destroyed) socket.resume();
        });

        const interval = o.pingIntervalMs || 20000;
        this._pingTimer = setInterval(() => this._tick(), interval);
    }

    get bufferedAmount() { return this.socket.writableLength; }
    get remoteAddress() { return this.socket.remoteAddress; }
    get bytesReceived() { return this._reader.bytes; }

    setMaxMessage(n) { this._reader.maxMessage = n; }
    // Total bytes the peer may send in this connection before it is failed with 'tooBig'. Infinity = no budget.
    setByteBudget(n) { this._byteBudget = n; }

    _writable() { return !this.socket.destroyed && this.socket.writable; }

    _write(buf) {
        if (!this._writable()) return false;
        try { return this.socket.write(buf); } catch (err) { this.lastError = err; return false; }
    }

    // true = written and the socket buffer is below its high-water mark; false = written but wait for 'drain',
    // or not written at all because the connection is closing.
    sendText(text) {
        if (this.state !== 'open') return false;
        return this._write(encodeFrame(OP_TEXT, Buffer.from(String(text), 'utf8')));
    }

    sendPing(payload) {
        if (this.state !== 'open') return false;
        return this._write(encodeFrame(OP_PING, payload ? Buffer.from(payload).subarray(0, 125) : EMPTY));
    }

    close(code, reason) {
        if (this.state !== 'open') return;
        this.state = 'closing';
        this.localCode = code === undefined ? 1000 : code;
        this._write(encodeClose(this.localCode, reason));
        this._endAndLinger();
    }

    terminate() {
        this.state = this.state === 'closed' ? 'closed' : 'closing';
        try { this.socket.destroy(); } catch { /* ignore */ }
    }

    // Our Close frame is out: send FIN after it, keep reading so the peer can finish, and give up after a while.
    _endAndLinger() {
        try { if (this._writable()) this.socket.end(); } catch { /* ignore */ }
        if (!this._closeTimer) {
            this._closeTimer = setTimeout(() => { try { this.socket.destroy(); } catch { /* ignore */ } }, this.closeTimeoutMs);
        }
    }

    _tick() {
        if (this.state !== 'open') return;
        if (Date.now() - this._lastRx >= this.idleTimeoutMs) {
            this.emit('idle');
            this.close(this.codes.idle, 'idle');
            return;
        }
        this._write(encodeFrame(OP_PING, EMPTY));
    }

    _onData(chunk) {
        if (this.state === 'closed') return;
        this._lastRx = Date.now();
        const r = this._reader;
        if (r.failed || r.closed) return;
        if (r.bytes + chunk.length > this._byteBudget) {
            this._fail(new WsError(this.codes.tooBig, 'too many bytes before authentication'));
            return;
        }
        try {
            r.push(chunk);
        } catch (err) {
            if (err instanceof WsError) this._fail(err);
            else { this.lastError = err; this._fail(new WsError(this.codes.internal, 'internal error')); }
        }
    }

    _fail(err) {
        this._reader.failed = true;
        try { this.emit('violation', err); } catch (e) { this.lastError = e; }
        this.close(err.code, err.reason);
    }

    _onFrameMessage(m) {
        switch (m.type) {
            case 'text':
                if (this.state === 'open') this.emit('message', m.data);
                break;
            case 'ping':
                if (this.state === 'open') this._write(encodeFrame(OP_PONG, m.data));
                break;
            case 'pong':
                this.emit('pong', m.data);
                break;
            case 'close':
                this.peerCode = m.code;
                this.peerReason = m.reason;
                if (this.state === 'open') {
                    this.state = 'closing';
                    this._write(encodeClose(m.code === 1005 ? null : m.code, ''));
                }
                this._endAndLinger();
                break;
            default:
                break;
        }
    }

    _onSocketEnd() {
        // The peer is done sending. Finish our side too (http server sockets are allowHalfOpen).
        if (this.state === 'open') this.state = 'closing';
        try { if (this._writable()) this.socket.end(); } catch { /* ignore */ }
        if (!this._closeTimer) {
            this._closeTimer = setTimeout(() => { try { this.socket.destroy(); } catch { /* ignore */ } }, this.closeTimeoutMs);
        }
    }

    _onSocketClose() {
        clearInterval(this._pingTimer);
        clearTimeout(this._closeTimer);
        this._pingTimer = null;
        this._closeTimer = null;
        this.state = 'closed';
        if (this._closedEmitted) return;
        this._closedEmitted = true;
        let code = this.localCode;
        if (code === null) code = this.peerCode !== null ? this.peerCode : 1006;
        try { this.emit('close', code, this.peerReason); } catch (e) { this.lastError = e; }
    }
}

// Validate the upgrade request and complete the handshake. Returns a WebSocketConnection, or null after
// answering with a plain HTTP error and hanging up. The caller has already done its own Host/Origin/auth gates.
function acceptWebSocket(req, socket, head, options) {
    socket.on('error', noop);   // before anything else, so no code path can leave the socket without a handler
    const o = options || {};
    const h = req.headers || {};

    if (req.method !== 'GET') return rejectSocket(socket, 405, 'Method Not Allowed', { Allow: 'GET' }), null;
    if (req.httpVersionMajor < 1 || (req.httpVersionMajor === 1 && req.httpVersionMinor < 1)) {
        return rejectSocket(socket, 400, 'Bad Request'), null;
    }
    if (!hasToken(h.upgrade, 'websocket') || !hasToken(h.connection, 'upgrade')) {
        return rejectSocket(socket, 400, 'Bad Request'), null;
    }
    if (h['sec-websocket-version'] !== '13') {
        return rejectSocket(socket, 426, 'Upgrade Required', { 'Sec-WebSocket-Version': '13' }), null;
    }
    const key = h['sec-websocket-key'];
    if (typeof key !== 'string' || !KEY_SHAPE.test(key)) return rejectSocket(socket, 400, 'Bad Request'), null;
    if (socket.destroyed || !socket.writable) return null;

    socket.write('HTTP/1.1 101 Switching Protocols\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + 'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n');
    return new WebSocketConnection(socket, head, o);
}

module.exports = {
    GUID,
    OP_CONT, OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG,
    DEFAULT_CODES,
    WsError,
    FrameReader,
    WebSocketConnection,
    acceptWebSocket,
    acceptKey,
    encodeFrame,
    encodeClose,
    validCloseCode,
    truncateUtf8,
    rejectSocket,
};
