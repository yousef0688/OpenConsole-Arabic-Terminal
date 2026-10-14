/*
 * The suggestion of what you are going to type: while you type at a prompt, the rest of the newest command of the history that
 * starts with what you typed is shown in grey after the cursor, and the Right Arrow (or End) types it.
 *
 * It reads what is on the screen, it does not follow the keys: the text of the row before the cursor is cut at the prompt (a
 * character like > $ # % and the space after it), and what follows is compared with the commands of the history. So it also works
 * after the history keys, after a paste and after a correction. It is left out when another program runs in the terminal (the shell
 * is not at its prompt), on the alternate screen (vim), and when there is text after the cursor (the editor of the shell shows its
 * own prediction there, or you are editing in the middle of a line).
 */
(function (root) {
    'use strict';

    const PROMPT_END = /[>$#%]/;

    /** Where the text that was typed can start in the text of a row: after a character that ends a prompt, and the space after it. */
    function typedCandidates(text) {
        const out = [];
        const seen = new Set();
        for (let i = 0; i < text.length; i++) {
            if (!PROMPT_END.test(text[i])) continue;
            let start = i + 1;
            if (text[start] === ' ') start++;
            if (seen.has(start) || !text.slice(start).trim()) continue;
            seen.add(start);
            out.push({ start, typed: text.slice(start) });
        }
        return out;
    }

    /** The newest command of the history that starts with what was typed (and is longer), or null. The first prompt character wins. */
    function findSuggestion(text, history) {
        for (const candidate of typedCandidates(text)) {
            const typed = candidate.typed.toLowerCase();
            for (let i = history.length - 1; i >= 0; i--) {
                const command = history[i];
                if (command.length > candidate.typed.length && command.toLowerCase().startsWith(typed)) {
                    return { typed: candidate.typed, suffix: command.slice(candidate.typed.length), command };
                }
            }
        }
        return null;
    }

    const RTL_LETTER = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
    const LTR_LETTER = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/;

    /** Whether the first letter of the text (digits, spaces and signs have no direction) is a right-to-left one: true, false, or null. */
    function strongDirection(text, fromEnd) {
        for (let i = 0; i < text.length; i++) {
            const c = text[fromEnd ? text.length - 1 - i : i];
            if (RTL_LETTER.test(c)) return true;
            if (LTR_LETTER.test(c)) return false;
        }
        return null;
    }

    /**
     * Whether the suggestion would go on in a right-to-left word that was typed. Such a word is laid out from the right, so what comes
     * next belongs to the left of what was typed, and a grey text after the cursor would be on the wrong side. It is not shown then.
     */
    function continuesRtlRun(typed, suffix) {
        return strongDirection(typed, true) === true && strongDirection(suffix, false) === true;
    }

    /** The folder that a prompt shows: "PS C:\Users\me> " or "C:\Users\me>" (null for a prompt that does not show one). */
    function promptDirectory(prompt) {
        const match = /^PS (.+?)> ?$/.exec(prompt) || /^([A-Za-z]:\\.*?)> ?$/.exec(prompt);
        return match && /^[A-Za-z]:\\|^\\\\/.test(match[1]) ? match[1] : null;
    }

    /** The row of the cursor: the text before the cursor and the text after it (by cells, so wide characters keep their place). */
    function readCursorRow(term) {
        const buffer = term.buffer.active;
        if (buffer.type !== 'normal') return null;
        const y = buffer.baseY + buffer.cursorY;
        const line = buffer.getLine(y);
        if (!line) return null;
        const next = buffer.getLine(y + 1);
        const wrapped = line.isWrapped || !!(next && next.isWrapped);
        let before = '', after = '';
        const cell = buffer.getNullCell();
        for (let x = 0; x < term.cols; x++) {
            const c = line.getCell(x, cell);
            if (!c || c.getWidth() === 0) continue;
            const chars = c.getChars() || ' ';
            if (x < buffer.cursorX) before += chars; else after += chars;
        }
        return { before, after, wrapped, x: buffer.cursorX, y };
    }

    class OCSuggest {
        /**
         * @param {import('@xterm/xterm').Terminal} term
         * @param {{history: () => string[], enabled: () => boolean, busy: () => boolean}} options
         */
        constructor(term, options) {
            this.term = term;
            this.options = options;
            this.marker = null;
            this.decoration = null;
            this.signature = '';
            this.suffix = '';
            this.timer = 0;
            this.disposables = [
                term.onWriteParsed(() => this.schedule()),
                term.onCursorMove(() => this.schedule()),
                term.buffer.onBufferChange(() => this.schedule()),
            ];
        }

        schedule() {
            if (this.timer) return;
            this.timer = setTimeout(() => { this.timer = 0; this.update(); }, 40);
        }

        hide() {
            if (this.decoration) { this.decoration.dispose(); this.decoration = null; }
            if (this.marker) { this.marker.dispose(); this.marker = null; }
            this.signature = '';
            this.suffix = '';
        }

        update() {
            if (!this.options.enabled() || this.options.busy()) return this.hide();
            const row = readCursorRow(this.term);
            if (!row || row.wrapped || row.after.trim() !== '') return this.hide();
            const found = findSuggestion(row.before, this.options.history());
            if (!found || continuesRtlRun(found.typed, found.suffix)) return this.hide();
            const room = this.term.cols - row.x;
            if (room < 1) return this.hide();
            const shown = found.suffix.slice(0, room);
            const signature = `${row.y}:${row.x}:${found.suffix}`;
            if (signature === this.signature) return;
            this.hide();
            const marker = this.term.registerMarker(0);
            if (!marker) return;
            const decoration = this.term.registerDecoration({ marker, x: row.x, width: Math.max(1, shown.length) });
            if (!decoration) { marker.dispose(); return; }
            decoration.onRender((element) => this.paint(element, shown));
            this.marker = marker;
            this.decoration = decoration;
            this.signature = signature;
            this.suffix = found.suffix;
        }

        /** What the Right Arrow types: the rest of the suggestion (null when there is none). The suggestion goes away at once. */
        accept() {
            if (!this.suffix) return null;
            const text = this.suffix;
            this.hide();
            return text;
        }

        paint(element, text) {
            const options = this.term.options;
            const theme = options.theme || {};
            element.style.color = theme.brightBlack || '#6a6a6a';
            element.style.fontFamily = options.fontFamily;
            element.style.fontSize = options.fontSize + 'px';
            element.style.lineHeight = element.style.height;
            element.style.whiteSpace = 'pre';
            element.style.direction = 'ltr';             // its own paragraph: Arabic inside it is laid out on its own, left to right overall
            element.style.unicodeBidi = 'isolate';
            element.style.overflow = 'hidden';
            element.style.pointerEvents = 'none';
            element.textContent = text;
        }

        dispose() {
            if (this.timer) clearTimeout(this.timer);
            this.timer = 0;
            this.hide();
            for (const d of this.disposables) d.dispose();
            this.disposables = [];
        }
    }

    OCSuggest.typedCandidates = typedCandidates;
    OCSuggest.findSuggestion = findSuggestion;
    OCSuggest.promptDirectory = promptDirectory;
    OCSuggest.continuesRtlRun = continuesRtlRun;
    OCSuggest.readCursorRow = readCursorRow;
    root.OCSuggest = OCSuggest;
})(typeof window !== 'undefined' ? window : globalThis);
