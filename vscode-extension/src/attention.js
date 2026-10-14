'use strict';
// What the terminals ask of the user. The page (media/agent-view.js) works out the state of every terminal and posts
// { t: 'agentState' } when it changes and { t: 'attention' } when something needs a look (a question, an end, a bell). This module keeps
// the list of them for all the views, shows the status bar item ("$(bell) 2"), the notifications (one per terminal and reason in a
// while, with a button that shows the terminal), and answers the commands "Next Terminal That Needs You" and "Terminals That Need You".
// It knows nothing about shells or webviews: it is given what it needs, so that it can be tested without VS Code.

const COOLDOWN_MS = 30 * 1000;       // the same reason for the same terminal is told again after this long at the earliest
const BLOCKED_STATES = new Set(['blocked']);

/** The kinds of notification the user can ask for (openconsole.attention.notify). */
const LEVELS = ['off', 'important', 'all'];
const IMPORTANT = new Set(['blocked', 'error', 'exited', 'bell']);

function label(state, exitCode) {
    switch (state) {
        case 'blocked': return 'needs you';
        case 'done': return 'done';
        case 'error': return 'failed';
        case 'exited': return exitCode ? `ended (${exitCode})` : 'ended';
        case 'waiting': return 'ready for you';
        case 'working': return 'working';
        case 'running': return 'running';
        default: return '';
    }
}

class AttentionTracker {
    /**
     * @param {object} api what the tracker needs from the editor:
     *   createStatusBarItem(): { text, tooltip, command, backgroundColor, show(), hide(), dispose() }
     *   warningBackground: the color for a terminal that needs you (or undefined)
     *   notify(kind: 'info' | 'warn', text, button): Promise<string | undefined>
     *   settings(): { notify: 'off' | 'important' | 'all', statusBar: boolean }
     *   show(key): shows that terminal (the view is opened, the terminal chosen)
     *   now(): milliseconds
     */
    constructor(api) {
        this.api = api;
        this.terminals = new Map();        // key -> { key, name, state, kind, attention, since, message, exitCode, evidence }
        this.told = new Map();             // key + reason -> when it was told
        this.item = null;
        this.refresh();
    }

    now() { return this.api.now ? this.api.now() : Date.now(); }

    /** { t: 'agentState' } of a terminal. */
    state(key, m) {
        if (!m || typeof m !== 'object') return;
        if (m.state === 'idle' && !m.attention) { this.terminals.delete(key); this.refresh(); return; }
        this.terminals.set(key, {
            key,
            name: String(m.name || 'terminal').slice(0, 80),
            state: String(m.state || ''),
            kind: String(m.kind || ''),
            attention: m.attention === true,
            since: Number(m.since) || this.now(),
            message: String(m.message || '').slice(0, 200),
            exitCode: Number.isFinite(m.exitCode) ? m.exitCode : null,
            evidence: String(m.evidence || '').slice(0, 120),
        });
        this.refresh();
    }

    /** The terminal went away (closed, its view gone). */
    remove(key) {
        this.terminals.delete(key);
        for (const k of Array.from(this.told.keys())) if (k.startsWith(key + '|')) this.told.delete(k);
        this.refresh();
    }

    /** { t: 'attention' } of a terminal: maybe a notification. Returns what was done (for the tests): 'told', 'cooldown', 'off' or 'quiet'. */
    event(key, m) {
        if (!m || typeof m !== 'object') return 'quiet';
        const reason = String(m.reason || '');
        const level = this.settings().notify;
        if (level === 'off') return 'off';
        if (level === 'important' && !IMPORTANT.has(reason)) return 'quiet';
        if (!['blocked', 'done', 'error', 'exited', 'bell'].includes(reason)) return 'quiet';
        const last = this.told.get(key + '|' + reason);
        const now = this.now();
        if (last !== undefined && now - last < COOLDOWN_MS) return 'cooldown';
        this.told.set(key + '|' + reason, now);
        const name = String(m.name || 'terminal').slice(0, 60);
        const program = m.kind && m.kind !== 'shell' ? ` (${m.kind})` : '';
        const detail = m.message ? `: ${String(m.message).slice(0, 120)}` : '';
        let text;
        let kind = 'info';
        if (reason === 'blocked') { text = `${name}${program} needs you${detail}`; kind = 'warn'; }
        else if (reason === 'bell') { text = `${name}${program} is calling you${detail}`; kind = 'warn'; }
        else if (reason === 'error') { text = `${name}${program} failed${detail}`; kind = 'warn'; }
        else if (reason === 'exited') { text = `${name} ended${m.exitCode ? ` with code ${m.exitCode}` : ''}`; kind = m.exitCode ? 'warn' : 'info'; }
        else text = `${name}${program} is done${detail}`;
        Promise.resolve(this.api.notify(kind, text, 'Show')).then((choice) => { if (choice === 'Show') this.api.show(key); }, () => { /* closed */ });
        return 'told';
    }

    settings() {
        const s = (this.api.settings && this.api.settings()) || {};
        return { notify: LEVELS.includes(s.notify) ? s.notify : 'all', statusBar: s.statusBar !== false };
    }

    /** The terminals that wait for a look, the ones that are blocked first, then the oldest first. */
    needing() {
        return Array.from(this.terminals.values())
            .filter((t) => t.attention)
            .sort((a, b) => (BLOCKED_STATES.has(b.state) - BLOCKED_STATES.has(a.state)) || a.since - b.since);
    }

    /** Everything that is running or waiting, for the list of the command. */
    all() {
        return Array.from(this.terminals.values())
            .sort((a, b) => (b.attention - a.attention) || (BLOCKED_STATES.has(b.state) - BLOCKED_STATES.has(a.state)) || a.since - b.since);
    }

    refresh() {
        const { statusBar } = this.settings();
        const needing = this.needing();
        if (!statusBar || needing.length === 0) {
            if (this.item) this.item.hide();
            return;
        }
        if (!this.item) {
            this.item = this.api.createStatusBarItem();
            this.item.command = 'openconsole.attentionList';
        }
        const blocked = needing.some((t) => BLOCKED_STATES.has(t.state) || t.state === 'error');
        this.item.text = `$(bell) ${needing.length}`;
        this.item.tooltip = needing.map((t) => `${t.name}: ${label(t.state, t.exitCode)}${t.message ? ' - ' + t.message : ''}`).join('\n');
        this.item.backgroundColor = blocked ? this.api.warningBackground : undefined;
        this.item.show();
    }

    /** The first terminal that needs a look, or null. */
    next() {
        const first = this.needing()[0];
        return first ? first.key : null;
    }

    dispose() {
        if (this.item) this.item.dispose();
        this.item = null;
        this.terminals.clear();
        this.told.clear();
    }
}

module.exports = { AttentionTracker, label, COOLDOWN_MS, LEVELS };
