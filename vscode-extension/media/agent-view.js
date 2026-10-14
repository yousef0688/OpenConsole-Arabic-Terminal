/*
 * The state of one terminal in the page: it listens to the signals (what the program writes, its own reports OSC 7501 / 9;4 / 133, its
 * title, the bell), asks the rules what the bottom of the screen says, keeps an OCAgentState, paints the small status mark in the row of
 * the list, and tells the extension (agentState when the state changes, attention when something needs the user). See agent-state.js
 * for the states and agent-rules.js for the screen rules.
 */
(function (root) {
    'use strict';

    const SCREEN_DELAY_MS = 250;      // the screen is read this long after the last output
    const MESSAGE_LIMIT = 200;        // what a program writes into its report is cut

    /** "42s", "3m", "1h 5m". */
    function elapsed(ms) {
        const s = Math.max(0, Math.floor(ms / 1000));
        if (s < 60) return s + 's';
        const m = Math.floor(s / 60);
        if (m < 60) return m + 'm';
        return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
    }

    const LABELS = { running: 'running', working: 'working', waiting: 'ready for you', blocked: 'needs you', done: 'done', error: 'failed', exited: 'ended', idle: '' };

    class OCAgentView {
        /**
         * @param {{ id: number, term: any, title: string }} t the terminal of the page
         * @param {{ post: Function, looking: (t) => boolean, rules: () => object[], minWorkMs: () => number }} host
         */
        constructor(t, host) {
            this.t = t;
            this.host = host;
            this.model = new OCAgent.OCAgentState({ minWorkMs: host.minWorkMs() });
            this.el = null;                 // the status mark in the row of the list
            this.timer = 0;
            this.published = '';
            this.shown = '';
            const term = t.term;
            this.disposables = [
                term.onWriteParsed(() => this.output()),
                term.onTitleChange((title) => { t.osTitle = String(title || '').slice(0, 200); const kind = OCAgent.kindOfTitle(title); if (kind) this.handle(this.model.identify(kind, Date.now())); }),
                term.onBell(() => this.bell()),
                term.parser.registerOscHandler(7501, (data) => { this.report(7501, data); return false; }),
                term.parser.registerOscHandler(9, (data) => { this.report(9, data); return false; }),
                term.parser.registerOscHandler(133, (data) => { this.report(133, data); return false; }),
            ];
        }

        dispose() {
            if (this.timer) clearTimeout(this.timer);
            this.timer = 0;
            for (const d of this.disposables) { try { d.dispose(); } catch { /* gone */ } }
            this.disposables = [];
        }

        // ---- the signals ----------------------------------------------------------------------------------------------------

        output() {
            this.handle(this.model.output(Date.now()));
            if (!this.timer && (this.model.running || this.model.screen)) this.timer = setTimeout(() => { this.timer = 0; this.readScreen(); }, SCREEN_DELAY_MS);
        }

        report(code, data) {
            this.handle(this.model.osc(code, String(data).slice(0, 4096), Date.now()));
        }

        bell() {
            // the bell of an agent calls you; the bell of a shell is only a beep
            if (this.model.running && OCAgent.isAgent(this.model.kind) && !this.host.looking(this.t)) {
                this.handle([{ type: 'attention', reason: 'bell', kind: this.model.kind, workedMs: 0, exitCode: null, message: '' }]);
            }
        }

        /** The programs under the shell changed (names, or an empty list). */
        program(names) {
            const kind = OCAgent.kindOfPrograms(names);
            this.handle(this.model.program(names.length > 0, kind, Date.now()));
            if (names.length) this.readScreen();
        }

        exit(code) { this.handle(this.model.exit(code, Date.now())); }

        reset() {
            this.model.reset(Date.now());
            this.published = '';
            this.handle([]);
        }

        /** The user typed into the terminal, or looked at it. */
        looked() {
            if (this.host.looking(this.t)) this.handle(this.model.looked(Date.now()));
        }

        typed() { this.handle(this.model.looked(Date.now())); }

        tick() { this.handle(this.model.tick(Date.now())); }

        /** Reads the bottom of the screen (rows of the visible screen) and asks the rules. */
        readScreen() {
            const buf = this.t.term.buffer.active;
            if (buf.type !== 'normal' && buf.type !== 'alternate') return;
            if (!this.model.running) { this.handle(this.model.observe(null, Date.now())); return; }
            const rows = [];
            for (let y = 0; y < this.t.term.rows; y++) {
                const line = buf.getLine(buf.viewportY + y);
                rows.push(line ? line.translateToString(true) : '');
            }
            this.rows = rows;
            const found = OCAgentRules.classify(this.model.kind, rows, this.host.rules());
            this.handle(this.model.observe(found, Date.now()));
        }

        // ---- what comes out of it ---------------------------------------------------------------------------------------------

        handle(events) {
            const view = this.model.view();
            const looking = this.host.looking(this.t);
            if (looking && (view.attention || events.length)) {
                // it is being watched: nothing to tell, what finished is seen
                const more = this.model.looked(Date.now());
                events = [];
                void more;
            }
            const now = this.model.view();
            const key = [now.state, now.kind, now.attention, now.evidence, now.message, this.t.title].join('|');
            if (key !== this.published) {
                this.published = key;
                this.host.post({ t: 'agentState', id: this.t.id, name: this.t.title, state: now.state, kind: now.kind, attention: now.attention, since: now.since, evidence: now.evidence, message: now.message, exitCode: now.exitCode });
            }
            for (const event of events) this.host.post({ t: 'attention', id: this.t.id, name: this.t.title, reason: event.reason, kind: event.kind, workedMs: event.workedMs, exitCode: event.exitCode, message: String(event.message || '').slice(0, MESSAGE_LIMIT) });
            this.paint();
        }

        /** The status mark of the row (it is made when the list is drawn). */
        attach(el) {
            this.el = el;
            this.shown = '';
            this.paint();
        }

        paint() {
            const el = this.el;
            if (!el) return;
            const view = this.model.view();
            // the mark is a small picture only (no number): it changes when the state does
            const key = view.state + '|' + view.kind + '|' + view.attention;
            if (key === this.shown) return;
            this.shown = key;
            el.dataset.state = view.state;
            el.dataset.kind = view.kind;
            el.classList.toggle('attention', !!view.attention);
            const row = el.parentElement;
            const name = this.t.title;
            const detail = [LABELS[view.state] ? name + ': ' + LABELS[view.state] + (view.state === 'exited' && view.exitCode ? ' (' + view.exitCode + ')' : '') : name];
            if (view.kind && view.kind !== 'shell') detail.push('program: ' + view.kind);
            if (view.message) detail.push(view.message);
            if (view.evidence && view.state !== 'idle') detail.push('(' + view.evidence + ')');
            if (row) row.title = detail.join('\n');
        }

        /** What a "Explain Terminal State" command shows. */
        explain() {
            const view = this.model.view();
            return { state: view.state, kind: view.kind, evidence: view.evidence, since: view.since, attention: view.attention, message: view.message, rows: (this.rows || []).filter(Boolean).slice(-30) };
        }
    }

    root.OCAgentView = OCAgentView;
    root.OCAgentView.elapsed = elapsed;
})(typeof window !== 'undefined' ? window : globalThis);
