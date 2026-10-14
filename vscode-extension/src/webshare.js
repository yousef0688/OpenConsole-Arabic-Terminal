'use strict';
// Opens the terminals of this window to a browser (a phone, another computer), the same terminals, not copies.
// This module joins three things: the terminals of the extension (what they wrote lately, their size, a way to type into them), the secure
// server of src/web/ (pairing with the owner's approval, tokens, WebSocket), and the page that the server serves (media/remote.*).
// It decides nothing about the user interface: extension.js asks the questions and shows the messages.
//
// What a browser that joins late sees: the server cannot ask the pseudo console to draw its screen again, so it keeps the last part of what
// each shared terminal wrote (a ring of RING_CHARS characters) and plays it back from a safe place: the last time the screen was cleared,
// else the first whole line. A full-screen program that has been running for a long time can therefore show a partly drawn screen to a
// late browser until it redraws. The size is always the owner's: the browser draws exactly the columns and rows of the VS Code panel.

const path = require('node:path');
const { WebShareServer } = require('./web/server');

const RING_CHARS = 512 * 1024;
// where a replay may start so that the screen is drawn from a clean state: a clear of the screen, a reset, the alternate screen coming up
const CLEAR_POINT = /\u001b\[[23]J|\u001bc|\u001b\[\?1049h/g;
const RESET = '\u001b[0m\u001b[?25h';

/** The last RING_CHARS characters that a terminal wrote. */
class Ring {
    constructor(max = RING_CHARS) {
        this.max = max;
        this.text = '';
        this.dropped = false;               // the start of what was written is gone
    }

    push(data) {
        this.text += data;
        if (this.text.length > this.max * 2) {
            this.text = this.text.slice(this.text.length - this.max);
            this.dropped = true;
        }
    }

    /** What to play back to a new viewer. */
    snapshot() {
        let text = this.text;
        if (text.length > this.max) { text = text.slice(text.length - this.max); this.dropped = true; }
        let start = -1;
        CLEAR_POINT.lastIndex = 0;
        for (let m = CLEAR_POINT.exec(text); m; m = CLEAR_POINT.exec(text)) start = m.index;
        if (start >= 0) text = text.slice(start);
        else if (this.dropped) {
            const newline = text.indexOf('\n');
            text = newline >= 0 ? text.slice(newline + 1) : '';
        }
        return RESET + text;
    }

    clear() {
        this.text = '';
        this.dropped = false;
    }
}

/** "https://abc.trycloudflare.com/x" -> { origin: "https://abc.trycloudflare.com", host: "abc.trycloudflare.com" }, or null when it is not an address. */
function parsePublicUrl(text) {
    if (typeof text !== 'string' || !text.trim()) return null;
    try {
        const url = new URL(text.trim());
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
        if (!url.hostname) return null;
        return { origin: url.origin, host: url.host };
    }
    catch { return null; }
}

class WebShare {
    /**
     * @param {{ mediaDir: string, terminals: () => Array<{ webId: number, name: string, cols: number, rows: number, ring: Ring, write: (data: string) => boolean }>, log?: (line: string) => void }} deps
     */
    constructor(deps) {
        this.deps = deps;
        this.shared = new Set();            // webId of the terminals that are shared
        this.server = null;
        this.base = '';
        this.role = 'read';                 // what a new device gets unless the owner chooses at the approval
        const self = this;
        this.bridge = {
            list() { return self.sharedTerminals().map((t) => ({ id: t.webId, name: t.name, cols: t.cols, rows: t.rows })); },
            snapshot(id) {
                const t = self.sharedTerminals().find((x) => x.webId === id);
                return t ? { cols: t.cols, rows: t.rows, data: t.ring.snapshot() } : null;
            },
            write(id, data) {
                const t = self.sharedTerminals().find((x) => x.webId === id);
                return t ? t.write(data) !== false : false;
            },
        };
    }

    get active() { return !!this.server && this.server.listening; }

    sharedTerminals() {
        return this.deps.terminals().filter((t) => this.shared.has(t.webId));
    }

    /** The file that the server sends for an address of its own (it has already checked the name against its list). */
    assets(urlPath) {
        if (urlPath === '/') return path.join(this.deps.mediaDir, 'remote.html');
        const m = /^\/(app|vendor)\/([A-Za-z0-9._-]+)$/.exec(urlPath);
        if (!m) return null;
        return m[1] === 'app' ? path.join(this.deps.mediaDir, m[2]) : path.join(this.deps.mediaDir, 'vendor', m[2]);
    }

    /**
     * Starts the server on this computer only (127.0.0.1). publicUrl is the address that the owner's own tunnel gives (Cloudflare, Tailscale):
     * its host is allowed in the Host and Origin checks, and the link is made with it.
     */
    async start(options = {}) {
        if (this.active) return { port: this.server.port, base: this.base };
        const pub = parsePublicUrl(options.publicUrl);
        this.server = new WebShareServer({ bridge: this.bridge, assets: (p) => this.assets(p), log: this.deps.log });
        const started = await this.server.start({
            port: 0,
            bindAddress: '127.0.0.1',
            extraHosts: pub ? [pub.host] : [],
            maxClients: options.maxClients,
            ttlMs: options.ttlMs,
        });
        this.base = pub ? pub.origin : 'http://127.0.0.1:' + started.port;
        this.local = 'http://127.0.0.1:' + started.port;
        return { port: started.port, base: this.base };
    }

    async stop() {
        const server = this.server;
        this.server = null;
        this.shared.clear();
        if (server) await server.stop();
    }

    /** A new link for a browser to pair with: the secret is in the part after "#", which a browser never sends to a server. */
    pairingLink() {
        if (!this.active) throw new Error('not sharing');
        const { secret, expiresAt } = this.server.newPairing();
        return { url: this.base + '/#p=' + secret, local: this.local + '/#p=' + secret, expiresAt };
    }

    // ---- what the terminals tell it ---------------------------------------------------------------------------------------------

    isShared(webId) { return this.active && this.shared.has(webId); }

    output(webId, data) { if (this.isShared(webId)) this.server.output(webId, data); }
    resize(webId, cols, rows) { if (this.isShared(webId)) this.server.resize(webId, cols, rows); }
    title(webId, name) { if (this.isShared(webId)) this.server.title(webId, name); }
    exit(webId, code) { if (this.isShared(webId)) this.server.exit(webId, code); }
    state(webId, state, attention) { if (this.isShared(webId)) this.server.state(webId, state, attention); }

    /** The set of shared terminals changed (the owner chose, or one was closed). */
    setShared(ids) {
        this.shared = new Set(ids);
        if (this.active) this.server.listChanged();
    }

    forget(webId) {
        if (!this.shared.delete(webId)) return;
        if (this.active) this.server.listChanged();
    }
}

module.exports = { WebShare, Ring, parsePublicUrl, RING_CHARS };
