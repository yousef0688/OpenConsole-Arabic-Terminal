/*
 * Find in the terminal (Ctrl+F): a small widget at the top right of the terminals, like the one of the terminal of VS Code.
 * It searches the whole buffer (what scrolled off the screen too) with the search add-on of xterm.js: every match is highlighted, the
 * current one is marked and scrolled into view, "3 of 17" says where you are. Options: match case, whole word, regular expression.
 *
 * The widget does not know the terminals: it asks for the one that is searched (an object with `search`, the add-on) and tells when it
 * is closed. The page (media/main.js) builds it once and gives it the active terminal.
 */
(function (root) {
    'use strict';

    const ICON_UP = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 10l4.5-4.5 4.5 4.5"/></svg>';
    const ICON_DOWN = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 6l4.5 4.5L12.5 6"/></svg>';
    const ICON_CLOSE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

    /** #rrggbb of a colour that is given as #rgb, #rrggbb(aa) or rgb()/rgba(); null when it is none of them. */
    function toHex(css) {
        const s = String(css || '').trim();
        let m = /^#([0-9a-f]{6})/i.exec(s);
        if (m) return '#' + m[1].toLowerCase();
        m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s);
        if (m) return ('#' + m[1] + m[1] + m[2] + m[2] + m[3] + m[3]).toLowerCase();
        m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(s);
        if (m) return '#' + [m[1], m[2], m[3]].map((n) => Math.min(255, +n).toString(16).padStart(2, '0')).join('');
        return null;
    }

    /** The colour `top` laid over `bottom` with the opacity `alpha` (both #rrggbb), as #rrggbb: xterm.js wants opaque colours. */
    function mix(top, bottom, alpha) {
        const channel = (hex, i) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16);
        return '#' + [0, 1, 2].map((i) => Math.round(channel(top, i) * alpha + channel(bottom, i) * (1 - alpha)).toString(16).padStart(2, '0')).join('');
    }

    class OCFind {
        /**
         * @param {HTMLElement} parent the element that the widget is put into (its top right corner is where it sits)
         * @param {{ terminal: () => ({ search: any, term: any } | null), background: () => string, onClose: (terminal: any) => void }} hooks
         */
        constructor(parent, hooks) {
            this.hooks = hooks;
            this.options = { caseSensitive: false, wholeWord: false, regex: false };
            this.target = null;
            const el = document.createElement('div');
            el.id = 'find';
            el.hidden = true;
            el.setAttribute('role', 'search');
            el.innerHTML =
                '<div class="field"><input type="text" spellcheck="false" autocomplete="off" placeholder="Find" aria-label="Find in the terminal">' +
                '<button type="button" class="opt case" title="Match Case (Alt+C)" aria-label="Match Case" aria-pressed="false">Aa</button>' +
                '<button type="button" class="opt word" title="Match Whole Word (Alt+W)" aria-label="Match Whole Word" aria-pressed="false"><span>ab</span></button>' +
                '<button type="button" class="opt regex" title="Use Regular Expression (Alt+R)" aria-label="Use Regular Expression" aria-pressed="false">.*</button></div>' +
                '<span class="count" role="status" aria-live="polite"></span>' +
                '<button type="button" class="nav previous" title="Previous Match (Shift+Enter)" aria-label="Previous Match">' + ICON_UP + '</button>' +
                '<button type="button" class="nav next" title="Next Match (Enter)" aria-label="Next Match">' + ICON_DOWN + '</button>' +
                '<button type="button" class="nav close" title="Close (Escape)" aria-label="Close">' + ICON_CLOSE + '</button>';
            parent.appendChild(el);
            this.el = el;
            this.input = el.querySelector('input');
            this.count = el.querySelector('.count');

            // the buttons do not take the focus from the field
            el.addEventListener('mousedown', (e) => { if (e.target !== this.input) e.preventDefault(); });
            this.input.addEventListener('input', () => this.run('next', true));
            this.input.addEventListener('keydown', (e) => this.key(e));
            el.querySelector('.case').addEventListener('click', () => this.toggle('caseSensitive', '.case'));
            el.querySelector('.word').addEventListener('click', () => this.toggle('wholeWord', '.word'));
            el.querySelector('.regex').addEventListener('click', () => this.toggle('regex', '.regex'));
            el.querySelector('.previous').addEventListener('click', () => this.run('previous', false));
            el.querySelector('.next').addEventListener('click', () => this.run('next', false));
            el.querySelector('.close').addEventListener('click', () => this.close());
        }

        get isOpen() { return !this.el.hidden; }

        /** Shows the widget (with the selected text of the terminal in it, if there is one) and puts the cursor in the field. */
        open(prefill, terminal) {
            terminal = terminal || this.hooks.terminal();
            if (!terminal) return;
            this.target = terminal;
            if (typeof prefill === 'string' && prefill && !/[\r\n]/.test(prefill)) this.input.value = prefill.slice(0, 200);
            this.el.hidden = false;
            this.input.focus();
            this.input.select();
            if (this.input.value) this.run('next', true);
        }

        /** Hides the widget, takes the highlights off and gives the focus back to the terminal. */
        close() {
            if (!this.isOpen) return;
            const terminal = this.target;
            this.clear(terminal);
            this.el.hidden = true;
            this.count.textContent = '';
            this.target = null;
            if (terminal) this.hooks.onClose(terminal);
        }

        /** A terminal was closed: if it was the one that is searched, the widget goes away (the focus stays where it is). */
        forget(terminal) {
            if (terminal !== this.target) return;
            this.clear(terminal);
            this.el.hidden = true;
            this.count.textContent = '';
            this.target = null;
        }

        /** The terminal that is shown changed: the search goes on there (the highlights of the old one are removed). */
        retarget(terminal) {
            if (!this.isOpen || terminal === this.target) return;
            this.clear(this.target);
            this.target = terminal;
            this.run('next', true);
        }

        clear(terminal) {
            if (terminal && terminal.search) { try { terminal.search.clearDecorations(); } catch { /* the terminal is gone */ } }
        }

        toggle(name, selector) {
            this.options[name] = !this.options[name];
            const button = this.el.querySelector(selector);
            button.classList.toggle('on', this.options[name]);
            button.setAttribute('aria-pressed', String(this.options[name]));
            this.clear(this.target);          // the add-on counts again only for another word: without this it keeps the count of the old options
            this.run('next', true);
            this.input.focus();
        }

        key(e) {
            if (e.key === 'Enter') this.run(e.shiftKey ? 'previous' : 'next', false);
            else if (e.key === 'Escape') this.close();
            else if (e.altKey && !e.ctrlKey && !e.metaKey && /^[cwr]$/i.test(e.key)) this.toggle({ c: 'caseSensitive', w: 'wholeWord', r: 'regex' }[e.key.toLowerCase()], { c: '.case', w: '.word', r: '.regex' }[e.key.toLowerCase()]);
            else if (e.key === 'F3') this.run(e.shiftKey ? 'previous' : 'next', false);
            else return;
            e.preventDefault();
            e.stopPropagation();
        }

        /** The colours of the highlights: the match that is current, and the others (from the theme of VS Code when it has them). */
        decorations() {
            const style = getComputedStyle(document.documentElement);
            const read = (name) => toHex(style.getPropertyValue(name));
            const background = toHex(this.hooks.background()) || '#1e1e1e';
            const current = read('--vscode-terminal-findMatchBackground') || '#515c6a';
            const others = read('--vscode-terminal-findMatchHighlightBackground') || '#ea5c00';
            const border = read('--vscode-terminal-findMatchBorder') || '#74879f';
            return {
                matchBackground: mix(others, background, 0.4),
                matchBorder: mix(others, background, 0.7),
                matchOverviewRuler: others,
                activeMatchBackground: current === '#515c6a' ? mix('#ffd33d', background, 0.55) : current,
                activeMatchBorder: border,
                activeMatchColorOverviewRuler: '#ffd33d',
            };
        }

        /** Searches (direction 'next' or 'previous'); incremental: while typing, the current match stays when it still matches. */
        run(direction, incremental) {
            const terminal = this.target;
            const query = this.input.value;
            if (!terminal || !terminal.search) return;
            this.input.classList.remove('invalid');
            if (!query) { this.clear(terminal); this.count.textContent = ''; this.count.classList.remove('none'); return; }
            if (this.options.regex) {
                try { new RegExp(query); }
                catch { this.clear(terminal); this.count.textContent = 'Invalid expression'; this.count.classList.add('none'); this.input.classList.add('invalid'); return; }
            }
            const found = direction === 'previous'
                ? terminal.search.findPrevious(query, Object.assign({ decorations: this.decorations() }, this.options))
                : terminal.search.findNext(query, Object.assign({ decorations: this.decorations(), incremental: !!incremental }, this.options));
            if (!found) { this.count.textContent = 'No results'; this.count.classList.add('none'); }
        }

        /** The add-on counted the matches (resultIndex -1: none is current). */
        results(terminal, event) {
            if (terminal !== this.target || !this.isOpen || !this.input.value) return;
            const many = event.resultCount >= 1000;
            if (!event.resultCount) { this.count.textContent = 'No results'; this.count.classList.add('none'); return; }
            this.count.classList.remove('none');
            this.count.textContent = (event.resultIndex >= 0 ? event.resultIndex + 1 : '?') + ' of ' + event.resultCount + (many ? '+' : '');
        }
    }

    root.OCFind = OCFind;
})(typeof window !== 'undefined' ? window : globalThis);
