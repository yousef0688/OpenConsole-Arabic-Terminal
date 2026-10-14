'use strict';
// The frames that the extension and conpty-bridge.exe exchange:  [type: 1 byte][length: 4 bytes, little endian][payload]

const FromParent = { INPUT: 1, RESIZE: 2, CLEAR: 3 };
const ToParent = { OUTPUT: 1, EXIT: 2, PROCS: 3, READY: 4, ERROR: 5 };

function encode(type, payload) {
    const body = payload || Buffer.alloc(0);
    const header = Buffer.alloc(5);
    header[0] = type;
    header.writeUInt32LE(body.length, 1);
    return Buffer.concat([header, body]);
}

function encodeInput(text) {
    return encode(FromParent.INPUT, Buffer.from(text, 'utf8'));
}

/** Input that is already bytes (from the binary events of xterm.js). */
function encodeInputBytes(bytes) {
    return encode(FromParent.INPUT, Buffer.from(bytes));
}

function encodeResize(columns, rows) {
    const payload = Buffer.alloc(4);
    payload.writeUInt16LE(Math.max(1, Math.min(columns, 0xffff)), 0);
    payload.writeUInt16LE(Math.max(1, Math.min(rows, 0xffff)), 2);
    return encode(FromParent.RESIZE, payload);
}

/** Asks the pseudo console to forget what is on its screen (keepCursorRow: the row of the cursor stays, as the prompt does). */
function encodeClear(keepCursorRow) {
    return encode(FromParent.CLEAR, Buffer.from([keepCursorRow ? 1 : 0]));
}

/** Cuts a stream of bytes into frames; feed() returns the complete frames received so far. */
class FrameReader {
    constructor() {
        this._pending = Buffer.alloc(0);
    }

    feed(chunk) {
        this._pending = this._pending.length ? Buffer.concat([this._pending, chunk]) : chunk;
        const frames = [];
        for (;;) {
            if (this._pending.length < 5) break;
            const length = this._pending.readUInt32LE(1);
            if (this._pending.length < 5 + length) break;
            frames.push({ type: this._pending[0], payload: this._pending.subarray(5, 5 + length) });
            this._pending = this._pending.subarray(5 + length);
        }
        return frames;
    }
}

module.exports = { FromParent, ToParent, encode, encodeInput, encodeInputBytes, encodeResize, encodeClear, FrameReader };
