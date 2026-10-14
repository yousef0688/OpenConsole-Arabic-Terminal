'use strict';
// Pairing secrets, device tokens and rate limits for the web share. Node built-ins only.
//
// Rules this file enforces:
//   - secrets and tokens are 32 random bytes (base64url) and are stored ONLY as SHA-256 digests
//   - comparisons use crypto.timingSafeEqual on fixed-length digests and never exit early across records
//   - a pairing secret is single use (consumed on the first match, even if the owner then says no) and
//     expires after pairingTtlMs
//   - failed attempts are limited globally (never per peer address: a tunnel makes every peer look like
//     127.0.0.1), with a per-minute and a per-hour window
//   - a device's role is fixed here when it is created; nothing a client sends can change it

const crypto = require('node:crypto');

function sha256(value) {
    return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

function safeEqual(a, b) {
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizeRole(role) {
    return role === 'write' ? 'write' : 'read';
}

// Counts failures inside sliding windows. Blocked attempts are not recorded, so an attacker who keeps
// hammering cannot extend the lockout forever; it ends when the oldest counted failure ages out.
class SlidingWindowLimiter {
    constructor(windows, now) {
        this.windows = windows;           // [{ ms, max }]
        this.now = now || Date.now;
        this._times = [];
        this._horizon = windows.reduce((m, w) => Math.max(m, w.ms), 0);
    }

    _prune(t) {
        const cut = t - this._horizon;
        let i = 0;
        while (i < this._times.length && this._times[i] <= cut) i++;
        if (i) this._times.splice(0, i);
    }

    // 0 when an attempt is allowed now, else the number of ms until it would be.
    retryAfterMs() {
        const t = this.now();
        this._prune(t);
        let wait = 0;
        for (const w of this.windows) {
            const inside = [];
            for (const x of this._times) if (x > t - w.ms) inside.push(x);
            if (inside.length >= w.max) {
                const oldest = inside[inside.length - w.max];
                wait = Math.max(wait, oldest + w.ms - t);
            }
        }
        return Math.max(0, Math.ceil(wait));
    }

    // Record a failed attempt. Returns { blocked, retryAfterMs } for the state AFTER recording.
    fail() {
        const t = this.now();
        if (this.retryAfterMs() === 0) this._times.push(t);
        const retryAfterMs = this.retryAfterMs();
        return { blocked: retryAfterMs > 0, retryAfterMs };
    }

    reset() { this._times = []; }
}

class AuthManager {
    constructor(options) {
        const o = options || {};
        this.now = typeof o.now === 'function' ? o.now : Date.now;
        this.pairingTtlMs = o.pairingTtlMs || 10 * 60 * 1000;
        this.ttlMs = o.ttlMs || 8 * 3600 * 1000;
        this.maxPendingPairings = o.maxPendingPairings || 5;
        this._pairings = [];                 // { hash: Buffer(32), expiresAt }
        this._devices = new Map();           // deviceId -> record
        this.pairLimiter = new SlidingWindowLimiter([
            { ms: 60 * 1000, max: o.pairFailPerMin || 2 },
            { ms: 3600 * 1000, max: o.pairFailPerHour || 12 },
        ], this.now);
        this.authLimiter = new SlidingWindowLimiter([
            { ms: 60 * 1000, max: o.authFailPerMin || 10 },
            { ms: 3600 * 1000, max: o.authFailPerHour || 60 },
        ], this.now);
    }

    setDeviceTtl(ms) {
        if (Number.isFinite(ms) && ms > 0) this.ttlMs = ms;
    }

    // A new single-use pairing secret. The caller builds the link; the secret itself is never stored.
    newPairing() {
        const t = this.now();
        this._prunePairings(t);
        const secret = crypto.randomBytes(32).toString('base64url');
        const expiresAt = t + this.pairingTtlMs;
        this._pairings.push({ hash: sha256(secret), expiresAt });
        let live = this._pairings.filter((p) => p.expiresAt > t);
        while (live.length > this.maxPendingPairings) {
            const oldest = live.shift();
            this._pairings.splice(this._pairings.indexOf(oldest), 1);
        }
        return { secret, expiresAt };
    }

    _prunePairings(t) {
        // keep expired records for a while so the page can be told "expired" instead of "invalid"
        this._pairings = this._pairings.filter((p) => p.expiresAt + 3600 * 1000 > t);
        if (this._pairings.length > 32) this._pairings.splice(0, this._pairings.length - 32);
    }

    // Try to consume a pairing secret.
    //   { ok: true }
    //   { ok: false, reason: 'limited', retryAfterMs }
    //   { ok: false, reason: 'invalid' | 'expired', tripped, retryAfterMs }   (tripped = this failure locked pairing)
    redeemPairing(secret) {
        const limited = this.pairLimiter.retryAfterMs();
        if (limited > 0) return { ok: false, reason: 'limited', retryAfterMs: limited, tripped: false };

        const t = this.now();
        const usable = typeof secret === 'string' && secret.length > 0 && secret.length <= 256;
        const digest = sha256(usable ? secret : '');
        let found = -1;
        for (let i = 0; i < this._pairings.length; i++) {
            if (safeEqual(digest, this._pairings[i].hash) && usable) found = i;   // no early exit
        }
        if (found < 0) {
            const r = this.pairLimiter.fail();
            return { ok: false, reason: 'invalid', tripped: r.blocked, retryAfterMs: r.retryAfterMs };
        }
        const record = this._pairings.splice(found, 1)[0];   // single use: gone on the first match
        if (record.expiresAt <= t) {
            const r = this.pairLimiter.fail();
            return { ok: false, reason: 'expired', tripped: r.blocked, retryAfterMs: r.retryAfterMs };
        }
        return { ok: true };
    }

    reserveDeviceId() {
        return 'd' + crypto.randomBytes(6).toString('hex');
    }

    // Register a device after the owner approved it. Returns the token ONCE; only its digest is kept.
    createDevice(info) {
        const t = this.now();
        const token = crypto.randomBytes(32).toString('base64url');
        const deviceId = info.deviceId || this.reserveDeviceId();
        const record = {
            deviceId,
            label: info.label || 'device',
            role: normalizeRole(info.role),
            remoteAddress: info.remoteAddress || '',
            userAgent: info.userAgent || '',
            createdAt: t,
            expiresAt: t + this.ttlMs,
            lastSeenAt: t,
            tokenHash: sha256(token),
        };
        this._devices.set(deviceId, record);
        return { token, device: this._publicDevice(record) };
    }

    _publicDevice(r) {
        return {
            deviceId: r.deviceId,
            label: r.label,
            role: r.role,
            remoteAddress: r.remoteAddress,
            userAgent: r.userAgent,
            createdAt: r.createdAt,
            expiresAt: r.expiresAt,
            lastSeenAt: r.lastSeenAt,
        };
    }

    // The device for a token, or null. Constant work over all devices; expired devices are dropped.
    verifyToken(token) {
        const t = this.now();
        const usable = typeof token === 'string' && token.length >= 16 && token.length <= 256;
        const digest = sha256(usable ? token : '');
        let found = null;
        for (const r of this._devices.values()) {
            if (safeEqual(digest, r.tokenHash) && usable) found = r;   // no early exit
        }
        if (!found) return null;
        if (found.expiresAt <= t) {
            this._devices.delete(found.deviceId);
            return null;
        }
        found.lastSeenAt = t;
        return this._publicDevice(found);
    }

    // verifyToken plus the global failure limiter.
    //   { ok: true, device } | { ok: false, reason: 'limited' | 'invalid', tripped, retryAfterMs }
    authenticate(token) {
        const limited = this.authLimiter.retryAfterMs();
        if (limited > 0) return { ok: false, reason: 'limited', retryAfterMs: limited, tripped: false };
        const device = this.verifyToken(token);
        if (device) return { ok: true, device };
        const r = this.authLimiter.fail();
        return { ok: false, reason: 'invalid', tripped: r.blocked, retryAfterMs: r.retryAfterMs };
    }

    getDevice(deviceId) {
        const r = this._devices.get(deviceId);
        return r ? this._publicDevice(r) : null;
    }

    listDevices() {
        return Array.from(this._devices.values(), (r) => this._publicDevice(r));
    }

    revoke(deviceId) {
        return this._devices.delete(deviceId);
    }

    // Drop devices whose lifetime is over. Returns their ids.
    pruneExpired() {
        const t = this.now();
        const gone = [];
        for (const r of this._devices.values()) if (r.expiresAt <= t) gone.push(r.deviceId);
        for (const id of gone) this._devices.delete(id);
        this._prunePairings(t);
        return gone;
    }

    // Kill switch: nothing issued before this call works afterwards.
    clear() {
        this._pairings = [];
        this._devices.clear();
        this.pairLimiter.reset();
        this.authLimiter.reset();
    }
}

module.exports = { AuthManager, SlidingWindowLimiter, sha256, safeEqual, normalizeRole };
