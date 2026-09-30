/*
 * Right-to-left layout of one terminal row.
 *
 * A terminal row is a list of "units": one unit per character cell (a base character with its combining marks, or a wide
 * character that covers two columns). This module decides, without touching the DOM:
 *   - which units form right-to-left runs (Unicode Bidirectional Algorithm, base direction left-to-right),
 *   - in which columns each run is drawn (a run is mirrored INSIDE the columns it occupies, so everything around it,
 *     and the cursor, keep working on the logical columns), and
 *   - where the cursor goes.
 * It is the same design as the renderer of OpenConsole (src/renderer/atlas), written for the browser.
 *
 * Works in Node (tests) and in the browser (global OCLayout, needs the global bidi_js from bidi-js).
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('bidi-js'));
    } else {
        root.OCLayout = factory(root.bidi_js);
    }
})(typeof self !== 'undefined' ? self : this, function (bidiFactory) {
    'use strict';

    const bidi = bidiFactory();

    // ---- character classes -------------------------------------------------------------------------------------------

    /** Code points of scripts that are written right to left (letters and their punctuation). */
    function isRtlCodePoint(cp) {
        return (cp >= 0x0590 && cp <= 0x08FF) ||   // Hebrew, Arabic, Syriac, Arabic Supplement, Thaana, NKo, Samaritan, Mandaic, Arabic Extended-A
            (cp >= 0xFB1D && cp <= 0xFDFF) ||      // Hebrew and Arabic presentation forms A
            (cp >= 0xFE70 && cp <= 0xFEFF) ||      // Arabic presentation forms B
            cp === 0x200F || cp === 0x061C ||      // RLM, ALM
            (cp >= 0x10800 && cp <= 0x10FFF) ||    // right-to-left scripts of the supplementary plane
            (cp >= 0x1E800 && cp <= 0x1EFFF);
    }

    /** Arabic-script letters that join with their neighbours (the ones that must be shaped as a word). */
    function isArabicLetter(cp) {
        if (cp >= 0x0660 && cp <= 0x0669) return false;    // Arabic-Indic digits
        if (cp >= 0x06F0 && cp <= 0x06F9) return false;    // Extended Arabic-Indic digits
        return (cp >= 0x0620 && cp <= 0x064A) || (cp >= 0x066E && cp <= 0x06D3) || cp === 0x06D5 ||
            (cp >= 0x06FA && cp <= 0x06FF) || (cp >= 0x0750 && cp <= 0x077F) || (cp >= 0x08A0 && cp <= 0x08C9) ||
            (cp >= 0xFB50 && cp <= 0xFDFF) || (cp >= 0xFE70 && cp <= 0xFEFC);
    }

    /** Symbols that terminal user interfaces draw with: they end a run, so the columns of a table are not swapped. */
    function isLayoutSymbol(cp) {
        return (cp >= 0x2500 && cp <= 0x259F) ||   // box drawing, block elements
            (cp >= 0x25A0 && cp <= 0x25FF) ||      // geometric shapes
            (cp >= 0x2800 && cp <= 0x28FF) ||      // braille (used for graphs)
            (cp >= 0xE000 && cp <= 0xF8FF) ||      // private use area (icon fonts, powerline)
            cp >= 0xF0000;
    }

    /** True if any unit of the row needs right-to-left treatment. */
    function rowHasRtl(units) {
        for (let i = 0; i < units.length; i++) {
            const cp = units[i].text.codePointAt(0);
            if (cp >= 0x0590 && isRtlCodePoint(cp)) return true;
        }
        return false;
    }

    /** True if the row has a letter of a script that a visual-order program would have reversed. */
    function rowHasArabicLetter(units) {
        for (let i = 0; i < units.length; i++) {
            const cp = units[i].text.codePointAt(0);
            if (cp >= 0x0620 && isArabicLetter(cp)) return true;
        }
        return false;
    }

    // ---- the analysis ------------------------------------------------------------------------------------------------

    /** One character per unit, chosen so that the bidi algorithm sees the right class for it. */
    function representativeString(units) {
        const out = new Array(units.length);
        for (let i = 0; i < units.length; i++) {
            const cp = units[i].text.codePointAt(0);
            if (isLayoutSymbol(cp)) out[i] = 'a';                    // strong left-to-right
            else if (cp > 0xFFFF) out[i] = isRtlCodePoint(cp) ? 'א' : '■';   // one UTF-16 unit per unit
            else out[i] = String.fromCharCode(cp);
        }
        return out.join('');
    }

    /**
     * Implicit mode: apply the Unicode Bidirectional Algorithm to the row.
     * units: [{ text, width }]  (width is 1 or 2 columns)
     * Returns { hasRtl, levels, vcol, boxes } where boxes are the pieces that are drawn as one:
     *   { u0, u1, rtl, reverse: false, vcol, cells }   (units [u0, u1), first visual column, width in columns)
     */
    function analyzeImplicit(units, breakBefore) {
        const n = units.length;
        const s = representativeString(units);
        const embedding = bidi.getEmbeddingLevels(s, 'ltr');
        const levels = embedding.levels;
        let hasRtl = false;
        for (let i = 0; i < n; i++) if (levels[i] & 1) { hasRtl = true; break; }

        // visual order (rule L2) and the first visual column of every unit
        const order = hasRtl ? bidi.getReorderedIndices(s, embedding) : null;
        const vcol = new Int32Array(n);
        if (!hasRtl) {
            let col = 0;
            for (let i = 0; i < n; i++) { vcol[i] = col; col += units[i].width; }
        } else {
            let col = 0;
            for (let k = 0; k < n; k++) { const u = order[k]; vcol[u] = col; col += units[u].width; }
        }

        const boxes = [];
        let start = 0;
        for (let i = 1; i <= n; i++) {
            const boundary = i === n || (levels[i] > 0) !== (levels[start] > 0) || (breakBefore && (i === breakBefore.before || i === breakBefore.after));
            if (!boundary) continue;
            pushBox(boxes, units, vcol, start, i, levels[start] > 0, false);
            start = i;
        }
        return { hasRtl, levels, vcol, boxes };
    }

    /**
     * Visual mode: the program already put the text in visual order (Claude Code does this for right-to-left text), so
     * keep every column where it is and only give each word of Arabic letters back its logical order for shaping.
     */
    function analyzeVisual(units, breakBefore) {
        const n = units.length;
        const vcol = new Int32Array(n);
        let col = 0;
        for (let i = 0; i < n; i++) { vcol[i] = col; col += units[i].width; }
        const arabic = new Array(n);
        let hasRtl = false;
        for (let i = 0; i < n; i++) {
            arabic[i] = isArabicLetter(units[i].text.codePointAt(0));
            if (arabic[i]) hasRtl = true;
        }
        const boxes = [];
        let start = 0;
        for (let i = 1; i <= n; i++) {
            const boundary = i === n || arabic[i] !== arabic[start] || (breakBefore && (i === breakBefore.before || i === breakBefore.after));
            if (!boundary) continue;
            pushBox(boxes, units, vcol, start, i, arabic[start], arabic[start]);
            start = i;
        }
        return { hasRtl, levels: null, vcol, boxes };
    }

    function pushBox(boxes, units, vcol, u0, u1, rtl, reverse) {
        let lo = Infinity, hi = -Infinity, cells = 0;
        for (let i = u0; i < u1; i++) {
            lo = Math.min(lo, vcol[i]);
            hi = Math.max(hi, vcol[i] + units[i].width);
            cells += units[i].width;
        }
        if (hi - lo === cells) {
            boxes.push({ u0, u1, rtl, reverse, vcol: lo, cells });
        } else {
            // the units are not next to each other on screen (should not happen): draw them one by one
            for (let i = u0; i < u1; i++) boxes.push({ u0: i, u1: i + 1, rtl: false, reverse: false, vcol: vcol[i], cells: units[i].width });
        }
    }

    /** Run of units around index i in [levels > 0]; { a, b } are unit indices, b exclusive. */
    function runAround(analysis, i) {
        for (const box of analysis.boxes) if (box.rtl && i >= box.u0 && i < box.u1) return box;
        return null;
    }

    /**
     * Where the cursor is drawn, in visual columns (implicit mode).
     * cursorUnit: index of the unit under the cursor (may be past the last unit). kind: 'bar' or another cursor shape.
     * Returns { col } where col is the column of the cursor cell (bar: the column its left edge is in).
     */
    function cursorColumn(analysis, units, cursorUnit, kind, cursorColFallback) {
        const n = units.length;
        if (!analysis.hasRtl || analysis.levels === null) {
            return cursorUnit < n ? analysis.vcol[cursorUnit] : cursorColFallback;
        }
        const bar = kind === 'bar';
        // inside a right-to-left run: mirror the position inside the columns of the run
        if (cursorUnit < n) {
            const run = runAround(analysis, cursorUnit);
            if (run) {
                const cellStart = analysis.vcol[cursorUnit];
                return bar ? cellStart + units[cursorUnit].width : cellStart;   // bar: on the right edge of the cell, i.e. before the character in reading order
            }
        }
        // right after a run (typing at its end): the next character appears at the left end of the run
        if (cursorUnit > 0) {
            const prev = runAround(analysis, cursorUnit - 1);
            if (prev && prev.u1 === cursorUnit) {
                const blank = cursorUnit >= n || units[cursorUnit].text === ' ';
                if (bar) return prev.vcol;
                if (blank) return prev.vcol - 1;
            }
        }
        return cursorUnit < n ? analysis.vcol[cursorUnit] : cursorColFallback;
    }

    return {
        isRtlCodePoint, isArabicLetter, isLayoutSymbol,
        rowHasRtl, rowHasArabicLetter,
        analyzeImplicit, analyzeVisual, cursorColumn,
    };
});
