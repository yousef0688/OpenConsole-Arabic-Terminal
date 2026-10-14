/*
 * A pasted screenshot is typed into the shell as the path of a PNG file (C:\Users\...\OpenConsole\clipboard-....png), which is long
 * and ugly. The terminal keeps that text (the program needs it, and copying gives it back), but draws a small "[Image #1]"
 * over it, as Claude Code does in its own input box. The label is an xterm.js decoration: it follows its line when the terminal
 * scrolls, and the rows are looked at again after every write, every resize and every change between the normal and the
 * alternate screen.
 *
 * The label behaves like one character: touching() tells how long the path is when the cursor is right behind it or right in front
 * of it, so that Backspace and Delete can remove the whole path at once instead of letter by letter.
 */
(function (root) {
    'use strict';

    const MAX_LINES = 400;        // only the last lines of the buffer are looked at

    /** A CSS colour (#rgb, #rrggbb, rgb(...), rgba(...)) as #rrggbb, which xterm.js wants for the colours of a decoration. */
    function hexColor(css) {
        const s = String(css || '').trim();
        let m = /^#([0-9a-f]{6})/i.exec(s);
        if (m) return '#' + m[1].toLowerCase();
        m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s);
        if (m) return ('#' + m[1] + m[1] + m[2] + m[2] + m[3] + m[3]).toLowerCase();
        m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(s);
        if (m) return '#' + [m[1], m[2], m[3]].map((n) => Math.min(255, +n).toString(16).padStart(2, '0')).join('');
        return '#1e1e1e';
    }

    class OCImageChips {
        /** @param {import('@xterm/xterm').Terminal} term */
        constructor(term) {
            this.term = term;
            this.items = [];          // { key: the path in lower case, label }
            this.current = [];        // { marker, decoration }
            this.signature = '';
            this.timer = 0;
            this.cell = null;
            this.disposables = [
                term.onWriteParsed(() => this.schedule()),
                term.onResize(() => this.schedule()),
                term.buffer.onBufferChange((b) => { if (b.type === 'alternate') this.clearDecorations(); else this.schedule(); }),
            ];
        }

        /** A screenshot was pasted: its path (with or without quotes) will be shown as "[Image #n]". Returns the label. */
        add(pathText) {
            const key = String(pathText).trim().replace(/^"(.*)"$/, '$1').toLowerCase();
            if (!key) return '';
            let item = this.items.find((i) => i.key === key);
            if (!item) {
                item = { key, label: '[Image #' + (this.items.length + 1) + ']' };
                this.items.push(item);
            }
            return item.label;
        }

        /** A fresh session: the numbering starts again. */
        reset() {
            this.items = [];
            this.clearDecorations();
        }

        schedule() {
            if (!this.items.length || this.timer) return;
            this.timer = setTimeout(() => { this.timer = 0; this.scan(); }, 30);
        }

        clearDecorations() {
            for (const c of this.current) { c.decoration.dispose(); c.marker.dispose(); }
            this.current = [];
            this.signature = '';
        }

        dispose() {
            if (this.timer) clearTimeout(this.timer);
            this.timer = 0;
            this.clearDecorations();
            for (const d of this.disposables) d.dispose();
            this.disposables = [];
            this.items = [];
        }

        /**
         * The line of text that starts at row y of the buffer (the rows that were wrapped are joined):
         * { text, columns: the column of every UTF-16 unit of the text, rows: [{ y, start, end }] the part of the text that is in a row, next: the row after it }
         */
        logicalLine(buf, y) {
            const term = this.term;
            if (!this.cell) this.cell = buf.getNullCell();
            let text = '';
            const columns = [];
            const rows = [];
            do {
                const line = buf.getLine(y);
                const start = text.length;
                for (let x = 0; x < term.cols; x++) {
                    const cell = line.getCell(x, this.cell);
                    if (!cell) break;
                    if (cell.getWidth() === 0) continue;                   // the second half of a wide character
                    const chars = cell.getChars() || ' ';
                    for (let k = 0; k < chars.length; k++) { text += chars[k]; columns.push(x); }
                }
                rows.push({ y, start, end: text.length });
                y++;
            } while (y < buf.length && buf.getLine(y).isWrapped);
            return { text, columns, rows, next: y };
        }

        /** Finds the paths in the rows, and puts a label over each place (the same again is left as it is). */
        scan() {
            const term = this.term;
            const buf = term.buffer.active;
            if (!this.items.length || buf.type !== 'normal') { this.clearDecorations(); return; }

            const found = [];
            let y = Math.max(0, buf.length - MAX_LINES);
            while (y > 0 && buf.getLine(y) && buf.getLine(y).isWrapped) y--;       // start at the beginning of a line of text
            while (y < buf.length) {
                const line = this.logicalLine(buf, y);
                this.find(line.text, line.columns, line.rows, found);
                y = line.next;
            }

            const signature = found.map((f) => `${f.y}:${f.col}:${f.width}:${f.label}`).join('|');
            if (signature === this.signature) return;
            this.clearDecorations();
            const cursor = buf.baseY + buf.cursorY;
            // the cells of the path are drawn in the colour of the background, so the text is not there at all
            const hide = hexColor((term.options.theme || {}).background);
            for (const f of found) {
                const marker = term.registerMarker(f.y - cursor);
                if (!marker) continue;
                const decoration = term.registerDecoration({ marker, x: f.col, width: f.width, layer: 'top', backgroundColor: hide, foregroundColor: hide });
                if (!decoration) { marker.dispose(); continue; }
                decoration.onRender((element) => this.paint(element, f.label));
                this.current.push({ marker, decoration });
            }
            this.signature = signature;
        }

        /** Where the pasted paths are in a line of text: [{ a, b, item }] (b is exclusive; the quotes around a path are a part of it). */
        spans(text) {
            const lower = text.toLowerCase();
            const out = [];
            for (const item of this.items) {
                let from = 0;
                for (;;) {
                    const at = lower.indexOf(item.key, from);
                    if (at < 0) break;
                    let a = at, b = at + item.key.length;
                    if (text[a - 1] === '"' && text[b] === '"') { a--; b++; }        // the quotes go with the path
                    out.push({ a, b, item });
                    from = b;
                }
            }
            return out;
        }

        find(text, columns, rows, found) {
            for (const { a, b, item } of this.spans(text)) {
                let first = true;
                for (const r of rows) {
                    const s = Math.max(a, r.start), e = Math.min(b, r.end);
                    if (s >= e) continue;
                    found.push({ y: r.y, col: columns[s], width: columns[e - 1] - columns[s] + 1, label: first ? item.label : '' });
                    first = false;
                }
            }
        }

        /**
         * The pasted path that the cursor touches: { before, after }. `before` is the number of characters of the path (the quotes
         * count) when the cursor is right behind it, `after` when it is right in front of it; 0 when it is not next to one. Backspace
         * and Delete send that many keys, so that the label is removed whole, as one character.
         */
        touching() {
            const none = { before: 0, after: 0 };
            const buf = this.term.buffer.active;
            if (!this.items.length || buf.type !== 'normal') return none;
            const cursorRow = buf.baseY + buf.cursorY;
            let first = cursorRow;
            while (first > 0 && cursorRow - first < MAX_LINES && buf.getLine(first) && buf.getLine(first).isWrapped) first--;
            const line = this.logicalLine(buf, first);

            // the place of the cursor in the text: the first unit of its row that is at or after its column (the end of the row if none)
            const row = line.rows.find((r) => r.y === cursorRow);
            if (!row) return none;
            let at = row.end;
            for (let i = row.start; i < row.end; i++) if (line.columns[i] >= buf.cursorX) { at = i; break; }

            for (const { a, b } of this.spans(line.text)) {
                const length = Array.from(line.text.slice(a, b)).length;
                if (at === b) none.before = length;
                if (at === a) none.after = length;
            }
            return none;
        }

        /** The label sits at the start of the covered cells (the other cells are only hidden). */
        paint(element, label) {
            const options = this.term.options;
            const theme = options.theme || {};
            element.style.color = theme.foreground || '#cccccc';
            element.style.fontFamily = options.fontFamily;
            element.style.fontSize = options.fontSize + 'px';
            element.style.lineHeight = element.style.height;
            element.style.whiteSpace = 'pre';
            element.style.overflow = 'hidden';
            element.style.pointerEvents = 'none';
            element.textContent = '';
            if (label) {
                const chip = document.createElement('span');
                chip.textContent = label;
                chip.style.cssText = 'background:rgba(128,128,128,0.3);border-radius:3px;padding:0 3px;';
                element.appendChild(chip);
            }
        }
    }

    root.OCImageChips = OCImageChips;
})(typeof window !== 'undefined' ? window : globalThis);
