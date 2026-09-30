'use strict';
// One shell running in a pseudo console (through conpty-bridge.exe), with its output turned into text.

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { StringDecoder } = require('node:string_decoder');
const { ToParent, encodeInput, encodeInputBytes, encodeResize, FrameReader } = require('./frames');

/** Quotes one argument the way CreateProcess and the C runtime expect it. */
function quoteArgument(arg) {
    if (arg !== '' && !/[\s"]/.test(arg)) return arg;
    let out = '"';
    let backslashes = 0;
    for (const ch of arg) {
        if (ch === '\\') { backslashes++; continue; }
        if (ch === '"') { out += '\\'.repeat(backslashes * 2 + 1) + '"'; }
        else { out += '\\'.repeat(backslashes) + ch; }
        backslashes = 0;
    }
    return out + '\\'.repeat(backslashes * 2) + '"';
}

function buildCommandLine(shell, args) {
    return [shell, ...args].map(quoteArgument).join(' ');
}

class TerminalSession extends EventEmitter {
    /**
     * @param {{bridgePath: string, shell: string, args: string[], cwd: string, env?: object, columns: number, rows: number}} options
     * Events: 'output' (text), 'exit' (code), 'procs' (array of lower-case program names), 'error' (message)
     */
    constructor(options) {
        super();
        this.options = options;
        this.child = null;
        this.exited = false;
        this._reader = new FrameReader();
        this._decoder = new StringDecoder('utf8');
        this._buffer = '';
        this._flushTimer = null;
    }

    start() {
        const o = this.options;
        const commandLine = buildCommandLine(o.shell, o.args);
        this.child = spawn(o.bridgePath, [String(o.columns), String(o.rows), o.cwd, commandLine], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: Object.assign({}, process.env, o.env || {}),
            windowsHide: true,
        });
        this.child.on('error', (e) => this._fail('Cannot start the terminal helper: ' + e.message));
        this.child.stdout.on('data', (chunk) => this._onData(chunk));
        this.child.stderr.on('data', () => { /* the bridge only writes here when tracing */ });
        this.child.stdin.on('error', () => { /* the helper is gone; the exit is reported elsewhere */ });
        this.child.on('close', () => {
            this._flush();
            if (!this.exited) {
                this.exited = true;
                this.emit('exit', null);
            }
        });
    }

    _fail(message) {
        this.emit('error', message);
    }

    _onData(chunk) {
        for (const frame of this._reader.feed(chunk)) {
            switch (frame.type) {
                case ToParent.OUTPUT:
                    this._buffer += this._decoder.write(frame.payload);
                    this._scheduleFlush();
                    break;
                case ToParent.EXIT:
                    this._flush();
                    this.exited = true;
                    this.emit('exit', frame.payload.readUInt32LE(0));
                    break;
                case ToParent.PROCS:
                    this.emit('procs', frame.payload.toString('utf8').split('\n').filter(Boolean));
                    break;
                case ToParent.ERROR:
                    this._fail(frame.payload.toString('utf8'));
                    break;
                default:
                    break;
            }
        }
    }

    // Output is handed on at most every few milliseconds: a program that writes a lot makes thousands of small chunks.
    _scheduleFlush() {
        if (this._flushTimer) return;
        this._flushTimer = setTimeout(() => this._flush(), 6);
    }

    _flush() {
        if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
        if (this._buffer) {
            const text = this._buffer;
            this._buffer = '';
            this.emit('output', text);
        }
    }

    write(text) {
        if (this.child && !this.exited) this.child.stdin.write(encodeInput(text));
    }

    writeBytes(bytes) {
        if (this.child && !this.exited) this.child.stdin.write(encodeInputBytes(bytes));
    }

    resize(columns, rows) {
        if (this.child && !this.exited) this.child.stdin.write(encodeResize(columns, rows));
    }

    dispose() {
        if (this._flushTimer) clearTimeout(this._flushTimer);
        if (this.child) {
            try { this.child.stdin.end(); } catch { /* already closed */ }
            const child = this.child;
            setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 1500).unref();
        }
        this.removeAllListeners();
    }
}

module.exports = { TerminalSession, buildCommandLine, quoteArgument };
