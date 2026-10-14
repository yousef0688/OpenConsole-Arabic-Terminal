/*
 * Addresses (http and https) in the output of a terminal, found by the position of the mouse.
 *
 * While no program uses the mouse, xterm.js and its web links add-on find the addresses themselves (underline, hint, Ctrl + click).
 * A program that asks for the mouse (pi, opencode, vim) gets the clicks instead, and xterm.js then leaves the addresses alone. For
 * that case the page looks for the address under the pointer itself: OCLinks.addressAt() reads it from the buffer.
 *
 * Works in the browser (global OCLinks) and in Node (module.exports), for the tests.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.OCLinks = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // the same pattern as the web links add-on of xterm.js: no spaces, quotes or brackets, and no punctuation at the end
    const URL_PATTERN = /https?:[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/g;
    const MAX_WRAPPED_ROWS = 20;      // an address that runs over more rows than this is not looked for

    function isWebAddress(text) {
        try {
            const url = new URL(text);
            return url.protocol === 'http:' || url.protocol === 'https:';
        }
        catch { return false; }
    }

    /**
     * The address in the cell (col, row) of the screen (row 0 is the top row that is shown), or null.
     * An address that wraps onto the next row is one address: the rows that go on in each other are read together.
     * term: an xterm.js Terminal (or anything with buffer.active, cols).
     */
    function addressAt(term, col, row) {
        const buffer = term.buffer.active;
        const y = buffer.viewportY + row;
        if (col < 0 || row < 0 || !buffer.getLine(y)) return null;

        let first = y;
        while (first > 0 && y - first < MAX_WRAPPED_ROWS && buffer.getLine(first).isWrapped) first--;
        let last = y;
        while (last - y < MAX_WRAPPED_ROWS && buffer.getLine(last + 1) && buffer.getLine(last + 1).isWrapped) last++;

        // the text of those rows, and for every character the cell that it is in (counted from the first cell of the first row)
        let text = '';
        const cellOf = [];
        let cell;
        for (let r = first; r <= last; r++) {
            const line = buffer.getLine(r);
            for (let x = 0; x < term.cols; x++) {
                cell = line.getCell(x, cell);
                if (!cell || cell.getWidth() === 0) continue;          // the second half of a wide character
                const chars = cell.getChars() || ' ';
                for (let k = 0; k < chars.length; k++) cellOf.push((r - first) * term.cols + x);
                text += chars;
            }
        }

        const target = (y - first) * term.cols + col;
        URL_PATTERN.lastIndex = 0;
        for (let match = URL_PATTERN.exec(text); match; match = URL_PATTERN.exec(text)) {
            const from = cellOf[match.index];
            const to = cellOf[match.index + match[0].length - 1];
            if (from > target) break;
            if (target <= to) return isWebAddress(match[0]) ? match[0] : null;
        }
        return null;
    }

    /** The address under a point of the page (clientX, clientY), given the element that holds the rows of the terminal. */
    function addressAtPoint(term, screen, clientX, clientY) {
        const rect = screen.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        const col = Math.floor((clientX - rect.left) / (rect.width / term.cols));
        const row = Math.floor((clientY - rect.top) / (rect.height / term.rows));
        if (col < 0 || row < 0 || col >= term.cols || row >= term.rows) return null;
        return addressAt(term, col, row);
    }

    return { addressAt, addressAtPoint, isWebAddress };
});
