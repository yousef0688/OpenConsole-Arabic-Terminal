/*
 * What a terminal is doing, for the list of terminals and for the notifications: running a program, an agent that works, an agent that
 * waits for you, a prompt that needs an answer, something that finished while you were not looking, a process that ended.
 *
 * Several signals say it, and they are not equally good (the order below is the order of trust):
 *   1. a report of the program itself: OSC 7501 (state=working|idle|done|blocked|error), a progress bar (OSC 9;4), the end of a command (OSC 133;D)
 *   2. the screen: a rule that matches the bottom rows ("esc to interrupt" = working, a permission question = blocked), see agent-rules.js
 *   3. the programs that run under the shell (the extension knows them) and the silence of the output (an agent that animates its
 *      spinner is working, one that is quiet is waiting for you)
 * The class below keeps no timers and reads no clock: every call is given the time, so that the tests can play any story.
 *
 * Works in the browser (global OCAgent: { OCAgentState, kindOfPrograms, ... }) and in Node (module.exports), for the tests.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.OCAgent = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const QUIET_MS = 1500;            // an agent whose output stood still for this long is waiting for you
    const BLOCK_DWELL_MS = 300;       // a question must stay on the screen this long before it counts (no flicker)
    const REPORT_TTL_MS = 90000;      // a report is trusted until this long after it or after the last output, then the screen decides again

    const PROGRAMS = { 'claude.exe': 'claude', 'opencode.exe': 'opencode', 'codex.exe': 'codex', 'gemini.exe': 'gemini', 'aider.exe': 'aider', 'pi.exe': 'pi' };

    /** The agent that one of the programs under the shell is (null when none is): ['node.exe', 'claude.exe'] -> 'claude'. */
    function kindOfPrograms(names) {
        for (const name of names || []) {
            const kind = PROGRAMS[String(name).toLowerCase()];
            if (kind) return kind;
        }
        return null;
    }

    /** The agent that the title of the terminal says (pi and node programs have no name of their own), or null. */
    function kindOfTitle(title) {
        const t = String(title || '');
        if (/^\s*π(\s|$)/.test(t)) return 'pi';
        if (/claude/i.test(t)) return 'claude';
        if (/opencode/i.test(t)) return 'opencode';
        if (/codex/i.test(t)) return 'codex';
        if (/gemini/i.test(t)) return 'gemini';
        if (/aider/i.test(t)) return 'aider';
        return null;
    }

    const isAgent = (kind) => !!kind && kind !== 'shell';
    const BUSY = new Set(['working', 'running']);
    const CALM = new Set(['idle', 'waiting']);

    class OCAgentState {
        /** @param {{ minWorkMs?: number }} [options] minWorkMs: how long something must have worked for its end to be worth a notification */
        constructor(options = {}) {
            this.minWorkMs = options.minWorkMs === undefined ? 15000 : options.minWorkMs;
            this.reset(0);
        }

        /** A new session (the terminal was restarted or cleared). */
        reset(now) {
            this.kind = 'shell';
            this.running = false;            // a program runs under the shell
            this.exited = false;
            this.exitCode = null;
            this.report = null;              // { state, at }
            this.screen = null;              // { state, id, at, since }
            this.lastOutputAt = 0;
            this.state = 'idle';
            this.since = now;
            this.workStart = null;           // when the work began (null: none)
            this.unread = false;             // something finished (or ended) while nobody looked
            this.acknowledged = false;       // a question that was seen
            this.evidence = '';
            this.message = '';
        }

        // ---- the signals --------------------------------------------------------------------------------------------------

        /** The terminal wrote something. */
        output(now) {
            this.lastOutputAt = now;
            return this.evaluate(now);
        }

        /** The programs under the shell changed: running or not, and the agent among them (null: keep what is known). */
        program(running, kind, now) {
            this.running = !!running;
            if (!this.running) this.kind = 'shell';
            else if (kind) this.kind = kind;
            if (!this.running) { this.screen = null; this.report = null; }
            return this.evaluate(now);
        }

        /** The title or another sign says which agent this is (while a program runs). */
        identify(kind, now) {
            if (kind && this.running) this.kind = kind;
            return this.evaluate(now);
        }

        /** A sequence of the program itself (OSC): code 7501, 9 (progress "4;n"), 133 ("D;exit code"). */
        osc(code, data, now) {
            const text = String(data || '');
            if (code === 7501) {
                const state = /(?:^|:)state=([a-z]+)/.exec(text);
                if (state) {
                    const kv = {};
                    for (const part of text.split(':')) { const i = part.indexOf('='); if (i > 0) kv[part.slice(0, i)] = part.slice(i + 1); }
                    if (kv.state === 'clear') this.report = null;
                    else this.report = { state: kv.state, at: now };
                    if (kv.msg) { try { this.message = decodeURIComponent(escape(atob(kv.msg))).slice(0, 200); } catch { /* not base64 */ } }
                }
            }
            else if (code === 9) {
                const progress = /^4;(\d+)/.exec(text);
                if (progress) this.report = progress[1] === '0' ? { state: 'idle', at: now } : { state: 'working', at: now };
            }
            else if (code === 133) {
                if (/^D/.test(text)) this.report = { state: 'done', at: now };
                else if (/^C/.test(text)) this.report = { state: 'working', at: now };
            }
            return this.evaluate(now);
        }

        /** What the rules say about the bottom of the screen: { state: 'working' | 'blocked', id } or null. */
        observe(result, now) {
            if (!result) this.screen = null;
            else if (this.screen && this.screen.state === result.state && this.screen.id === result.id) this.screen.at = now;
            else this.screen = { state: result.state, id: result.id, at: now, since: now };
            return this.evaluate(now);
        }

        /** The process of the shell ended. */
        exit(code, now) {
            this.exited = true;
            this.exitCode = code === undefined ? null : code;
            return this.evaluate(now);
        }

        /** Somebody looked at this terminal (it was shown and has the focus) or typed into it. */
        looked(now) {
            this.unread = false;
            if (this.state === 'blocked' || this.state === 'error') this.acknowledged = true;
            return this.evaluate(now);
        }

        /** Time passes (call it every half second or so while something is not idle). */
        tick(now) {
            return this.evaluate(now);
        }

        // ---- the state ----------------------------------------------------------------------------------------------------

        /** The state that the signals say right now: { state, evidence }. */
        compute(now) {
            if (this.exited) return { state: 'exited', evidence: 'the process ended' + (this.exitCode ? ' (' + this.exitCode + ')' : '') };
            const agent = isAgent(this.kind);
            const report = this.report;
            if (report && now - Math.max(report.at, this.lastOutputAt) < REPORT_TTL_MS) {
                const evidence = 'report of the program (' + report.state + ')';
                if (report.state === 'working') return { state: 'working', evidence };
                if (report.state === 'blocked') return { state: 'blocked', evidence };
                if (report.state === 'error') return { state: 'error', evidence };
                return { state: agent || this.running ? 'waiting' : 'idle', evidence };           // idle, done
            }
            const screen = this.screen;
            if (screen && screen.state === 'blocked' && now - screen.since >= BLOCK_DWELL_MS) return { state: 'blocked', evidence: 'screen: ' + screen.id };
            if (screen && screen.state === 'working') return { state: 'working', evidence: 'screen: ' + screen.id };
            if (!this.running) return { state: 'idle', evidence: 'nothing runs' };
            if (!agent) return { state: 'running', evidence: 'a program runs' };
            return now - this.lastOutputAt < QUIET_MS
                ? { state: 'working', evidence: 'the output flows' }
                : { state: 'waiting', evidence: 'quiet for ' + Math.round((now - this.lastOutputAt) / 100) / 10 + ' s' };
        }

        /** Brings the state up to date and returns the events of the change: [{ type: 'attention', reason: 'blocked' | 'done' | 'error' | 'exited', ... }]. */
        evaluate(now) {
            const events = [];
            const next = this.compute(now);
            const previous = this.state;
            if (next.state !== previous) {
                this.state = next.state;
                this.since = now;
                if (BUSY.has(next.state) && !BUSY.has(previous)) this.workStart = now;
                const worked = this.workStart !== null && now - this.workStart >= this.minWorkMs;
                if (BUSY.has(previous) && CALM.has(next.state)) {
                    if (worked) { this.unread = true; events.push(this.event('done', now)); }
                    this.workStart = null;
                }
                if (next.state === 'blocked') { this.acknowledged = false; events.push(this.event('blocked', now)); }
                if (next.state === 'error') { this.acknowledged = false; this.unread = true; events.push(this.event('error', now)); }
                if (next.state === 'exited') {
                    if (worked || this.exitCode) { this.unread = true; events.push(this.event('exited', now)); }
                    this.workStart = null;
                }
            }
            this.evidence = next.evidence;
            return events;
        }

        event(reason, now) {
            return { type: 'attention', reason, kind: this.kind, workedMs: this.workStart !== null ? now - this.workStart : 0, exitCode: this.exitCode, message: this.message };
        }

        /** What to show: { state, kind, since, attention, evidence, message }. A finished thing that nobody looked at is "done". */
        view() {
            const calm = CALM.has(this.state);
            const state = this.unread && calm ? 'done' : this.state;
            const attention = ((this.state === 'blocked' || this.state === 'error') && !this.acknowledged) || (this.unread && (calm || this.state === 'exited' || this.state === 'error'));
            return { state, kind: this.kind, since: this.since, attention, unread: this.unread, evidence: this.evidence, message: this.message, exitCode: this.exitCode };
        }
    }

    return { OCAgentState, kindOfPrograms, kindOfTitle, isAgent, QUIET_MS, BLOCK_DWELL_MS, REPORT_TTL_MS };
});
