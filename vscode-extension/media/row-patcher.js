/*
 * Draws the rows of an xterm.js terminal that contain right-to-left text.
 *
 * xterm.js (DOM renderer) draws every character on its own, left to right, so Arabic letters do not join and words come out
 * in the wrong order. This class watches the rows that xterm.js draws and, only for the rows that contain right-to-left
 * text, replaces them with the layout computed by arabic-layout.js:
 *   - every run of characters is put in a box that covers exactly the columns of the run,
 *   - a right-to-left box is shaped by the browser as one piece of text (this is what joins the letters) and squeezed
 *     into its columns,
 *   - the cursor is moved to where the next character will appear.
 * The colours and styles of xterm.js are kept: the spans that xterm.js made are only cut and moved.
 * Rows without right-to-left text are never touched.
 */
(function (root) {
    'use strict';

    const L = root.OCLayout;
    const RTL_TEST = /[֐-ࣿיִ-﷿ﹰ-﻿‏؜]|[\uD802\uD803\uD83A\uD83B]/;
    const LETTER_SPACING = /letter-spacing:[^;]*;?\s*/g;
    const CURSOR_CLASSES = /\bxterm-cursor(?:-[a-z]+)?\b/g;
    const MAX_STRETCH = 1.3;       // a right-to-left box is never widened by more than this factor

    class RowPatcher {
        /**
         * @param term       the xterm.js Terminal (already opened)
         * @param getMode    () => 'implicit' | 'visual'
         */
        constructor(term, getMode) {
            this.term = term;
            this.getMode = getMode;
            this.rowsEl = null;
            this.cell = null;
            this.observer = new MutationObserver((records) => this._onMutations(records));
            this._patching = false;
        }

        start() {
            this.rowsEl = this.term.element.querySelector('.xterm-rows');
            if (!this.rowsEl) throw new Error('xterm.js is not using the DOM renderer');
            this.cell = this.term.buffer.active.getNullCell();
            this.observer.observe(this.rowsEl, { childList: true, subtree: true });
            this.patchAll();
        }

        stop() {
            this.observer.disconnect();
        }

        patchAll() {
            const rows = this.rowsEl.children;
            this._patchRows(Array.from(rows));
        }

        _onMutations(records) {
            let all = false;
            const rows = new Set();
            for (const r of records) {
                let n = r.target;
                if (n === this.rowsEl) { all = true; break; }
                while (n && n.parentNode !== this.rowsEl) n = n.parentNode;
                if (n) rows.add(n);
            }
            this._patchRows(all ? Array.from(this.rowsEl.children) : Array.from(rows));
        }

        _patchRows(rowEls) {
            if (!rowEls.length) return;
            const cellWidth = this._cellWidth();
            if (!cellWidth) return;
            const pending = [];
            for (const rowEl of rowEls) {
                try {
                    const job = this._prepare(rowEl, cellWidth);
                    if (job) pending.push(job);
                } catch (e) {
                    console.error('OpenConsole: cannot lay out a row', e);
                }
            }
            if (pending.length) {
                // write all rows first, measure afterwards, so the browser lays out once
                for (const job of pending) job.write();
                for (const job of pending) job.measure();
                for (const job of pending) job.fit();
            }
            // drop the records of our own changes
            this.observer.takeRecords();
        }

        _cellWidth() {
            const core = this.term._core;
            const dims = core && core._renderService && core._renderService.dimensions;
            if (dims && dims.css && dims.css.cell && dims.css.cell.width) return dims.css.cell.width;
            const w = this.rowsEl.getBoundingClientRect().width;
            return w && this.term.cols ? w / this.term.cols : 0;
        }

        /** Returns null (leave the row as xterm.js drew it) or an object with write() / measure() / fit(). */
        _prepare(rowEl, cellWidth) {
            const children = rowEl.children;
            if (!children.length) return null;
            if (children[0].classList.contains('oc-box')) return null;          // already ours
            if (!RTL_TEST.test(rowEl.textContent)) return null;                  // nothing right-to-left in this row

            const y = Array.prototype.indexOf.call(this.rowsEl.children, rowEl);
            const buf = this.term.buffer.active;
            const line = buf.getLine(buf.viewportY + y);
            if (!line) return null;

            // 1. the cells of the row
            const cells = [];
            for (let x = 0; x < this.term.cols; x++) {
                const c = line.getCell(x, this.cell);
                if (!c) break;
                const w = c.getWidth();
                if (w === 0) continue;
                cells.push({ text: c.getChars() || ' ', width: w, col: x });
            }

            // 2. the style of every cell, from the spans that xterm.js made
            const spans = Array.from(children);
            const styles = [];
            let pos = 0, cursorIdx = -1, cursorSpan = null;
            for (const span of spans) {
                if (span.tagName !== 'SPAN') return null;
                const text = span.textContent;
                const isCursor = /\bxterm-cursor\b/.test(span.className);
                const cls = span.className.replace(CURSOR_CLASSES, '').replace(/\s+/g, ' ').trim();
                const css = span.style.cssText.replace(LETTER_SPACING, '');
                const key = cls + '|' + css;
                let k = 0;
                while (k < text.length) {
                    const u = cells[pos];
                    if (!u || !text.startsWith(u.text, k)) return null;         // not what we expect: leave the row alone
                    k += u.text.length;
                    styles[pos] = { cls, css, key };
                    if (isCursor) { cursorIdx = pos; cursorSpan = span; }
                    pos++;
                }
            }
            const units = cells.slice(0, pos);
            if (!units.length) return null;

            // 3. the layout
            const mode = this.getMode();
            const isolate = cursorIdx >= 0 ? { before: cursorIdx, after: cursorIdx + 1 } : undefined;
            const analysis = mode === 'visual' ? L.analyzeVisual(units, isolate) : L.analyzeImplicit(units, isolate);
            if (!analysis.hasRtl) return null;

            // 4. the boxes
            const boxes = [];
            const doc = rowEl.ownerDocument;
            for (const box of analysis.boxes) {
                if (cursorIdx >= 0 && box.u0 === cursorIdx && box.u1 === cursorIdx + 1) continue;   // the cursor is placed below
                boxes.push(this._makeBox(doc, box, units, styles, cellWidth));
            }
            let cursorBox = null;
            if (cursorSpan) {
                const bar = /\bxterm-cursor-bar\b/.test(cursorSpan.className);
                let col = L.cursorColumn(analysis, units, cursorIdx, bar ? 'bar' : 'other', units[cursorIdx].col);
                col = Math.max(0, col);
                cursorBox = doc.createElement('div');
                cursorBox.className = 'oc-box oc-cursor';
                cursorBox.style.cssText = 'position:absolute;z-index:2;top:0;height:100%;left:' + (col * cellWidth) + 'px;width:' + (units[cursorIdx].width * cellWidth) + 'px;';
                cursorBox.appendChild(cursorSpan);
            }

            return {
                write() {
                    rowEl.style.position = 'relative';
                    const frag = doc.createDocumentFragment();
                    for (const b of boxes) frag.appendChild(b.el);
                    if (cursorBox) frag.appendChild(cursorBox);
                    rowEl.replaceChildren(frag);
                },
                measure() {
                    for (const b of boxes) if (b.rtl) b.natural = b.el.getBoundingClientRect().width;
                },
                fit() {
                    for (const b of boxes) {
                        if (!b.rtl || !b.natural) continue;
                        const target = b.cells * cellWidth;
                        const k = Math.min(MAX_STRETCH, target / b.natural);
                        b.el.style.width = b.natural + 'px';
                        b.el.style.left = (b.vcol * cellWidth + target - b.natural) + 'px';
                        b.el.style.transformOrigin = 'right center';
                        if (Math.abs(k - 1) > 0.005) b.el.style.transform = 'scaleX(' + k + ')';
                    }
                },
            };
        }

        _makeBox(doc, box, units, styles, cellWidth) {
            const el = doc.createElement('div');
            el.className = 'oc-box';
            const rtl = box.rtl;
            let css = 'position:absolute;z-index:2;top:0;height:100%;white-space:pre;unicode-bidi:isolate;direction:' + (rtl ? 'rtl' : 'ltr') + ';';
            if (rtl) css += 'left:' + (box.vcol * cellWidth) + 'px;width:max-content;';
            else css += 'left:' + (box.vcol * cellWidth) + 'px;width:' + (box.cells * cellWidth) + 'px;';
            el.style.cssText = css;

            // the pieces of text of the box, in the order the browser should get them
            const order = [];
            for (let i = box.u0; i < box.u1; i++) order.push(i);
            if (box.reverse) order.reverse();

            let current = null, currentKey = null;
            for (const i of order) {
                const st = styles[i];
                if (!current || st.key !== currentKey) {
                    current = doc.createElement('span');
                    current.className = st.cls;
                    current.style.cssText = st.css;
                    current.style.display = 'inline';
                    current.style.verticalAlign = 'baseline';
                    current.textContent = '';
                    el.appendChild(current);
                    currentKey = st.key;
                }
                current.textContent += units[i].text;
            }
            return { el, rtl, cells: box.cells, vcol: box.vcol, natural: 0 };
        }
    }

    root.OCRowPatcher = RowPatcher;
})(typeof self !== 'undefined' ? self : this);
