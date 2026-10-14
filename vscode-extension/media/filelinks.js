/*
 * File paths in the output of a terminal: "src/app.ts:12:5", "C:\proj\lib\a.js:7", ".\build\x.cs(10,3)", "packages/ui/index.tsx".
 * Compilers, test runners and agents print them; Ctrl + click opens the file in the editor at that line and column.
 *
 * find(text) looks for them in one row of text (the page does not know whether a file exists: the extension checks that when the
 * link is opened, and does nothing when it does not). linkProvider() makes the provider that xterm.js asks, row by row, when the
 * pointer comes over a row. Addresses (https://host/a.html) are left to the web links add-on and are never taken for a path.
 *
 * Works in the browser (global OCFileLinks) and in Node (module.exports), for the tests.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.OCFileLinks = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // [drive or ./ or ../ or ~/ or /] folders/ name.ext [:line[:col] or (line[,col])]; not after a letter, a slash, a dot or a colon (an address)
    const PATH = /(?<![\w/\\.:@%-])((?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|~[\\/]|[\\/])?(?:[\w@+~.-]+[\\/])*[\w@+~-][\w@+~.-]*\.([A-Za-z0-9]{1,10})(?!\w))(?::(\d{1,7})(?::(\d{1,5}))?|\((\d{1,7})(?:,\s*(\d{1,5}))?\))?/g;
    const MAX_LENGTH = 1024;

    /**
     * The paths in a text: [{ start, end (exclusive), text, path, line, col }]. line and col count from 1, and are 0 when not there.
     * A name without a folder ("index.js") counts only with a line ("index.js:10"): "node.js" or "1.2.3" in a sentence is not a path.
     */
    function find(text) {
        const found = [];
        if (typeof text !== 'string' || text.length === 0) return found;
        PATH.lastIndex = 0;
        let m;
        while ((m = PATH.exec(text)) !== null) {
            const path = m[1];
            const ext = m[2];
            const line = Number(m[3] || m[5] || 0);
            const col = Number(m[4] || m[6] || 0);
            if (path.length > MAX_LENGTH) continue;
            if (/^\d+$/.test(ext)) continue;                                       // "1/2.5", "10.0.0.1": numbers
            if (!/[\\/]/.test(path) && !line) continue;                           // "node.js", "v1.2.3": a name that is not clearly a file
            found.push({ start: m.index, end: m.index + m[0].length, text: m[0], path, line, col });
        }
        return found;
    }

    /** The text of a row of xterm.js and the column of each of its characters: wide characters take two cells, and their second cell has no text. */
    function rowText(line, cols) {
        let text = '';
        const columns = [];
        for (let x = 0; x < cols; x++) {
            const cell = line.getCell(x);
            if (!cell || cell.getWidth() === 0) continue;
            const chars = cell.getChars() || ' ';
            for (let i = 0; i < chars.length; i++) { text += chars[i]; columns.push(x); }
        }
        return { text, columns };
    }

    /**
     * The link provider for xterm.js (term.registerLinkProvider).
     * hooks: { open(match, event), hover(event, match), leave() }; a click without Ctrl only selects, as in the terminal of VS Code.
     */
    function linkProvider(term, hooks) {
        return {
            provideLinks(y, callback) {
                const buffer = term.buffer.active;
                const line = buffer.getLine(y - 1);
                if (!line) { callback(undefined); return; }
                const { text, columns } = rowText(line, term.cols);
                const links = find(text).map((m) => ({
                    range: { start: { x: columns[m.start] + 1, y }, end: { x: columns[m.end - 1] + 1, y } },
                    text: m.text,
                    activate: (event) => { if (event.button === 0 && (event.ctrlKey || event.metaKey)) hooks.open(m, event); },
                    hover: (event) => hooks.hover(event, m),
                    leave: () => hooks.leave(),
                }));
                callback(links.length ? links : undefined);
            },
        };
    }

    return { find, rowText, linkProvider, PATH };
});
