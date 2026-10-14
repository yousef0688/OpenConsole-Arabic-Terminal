'use strict';
// "Log helper" for the editor: put a log line for the selected variable on a sensible line of JS/TS (and Vue, Svelte, Astro, HTML
// script blocks) and of Python files, and comment, uncomment, delete and correct the logs that were made.
//
// Behaviour inspired by Turbo Console Log (Chakroun Anas); independent implementation, no code used.
//
// Pure logic: no "vscode" import. Everything works on a text and gives back offset-based edits, computed against the original text, sorted
// and not overlapping, so that the glue can apply them in ONE WorkspaceEdit (one undo step). There is no parser dependency: a small
// tokenizer and a statement scanner find where a statement ends. When the scanner is unsure it falls back to "after the statement".

const KINDS = ['log', 'info', 'debug', 'table', 'warn', 'error', 'custom'];

const defaultOptions = Object.freeze({
    wrapLogMessage: false,
    logMessagePrefix: '▶',
    logMessageSuffix: ':',
    includeFilename: false,
    includeLineNum: false,
    addSemicolonInTheEnd: false,
    insertEnclosingClass: true,
    insertEnclosingFunction: true,
    insertEmptyLineBeforeLogMessage: false,
    insertEmptyLineAfterLogMessage: false,
    delimiterInsideMessage: '›',
    quote: '"',
    logFunction: 'log',
});

/** The settings, completed with the defaults. "tabSize" and "insertSpaces" (of the editor) are optional extras for new indentation. */
function normalizeOptions(options) {
    const o = Object.assign({}, defaultOptions, options || {});
    const d = defaultOptions;
    const bool = (v, def) => (typeof v === 'boolean' ? v : def);
    const str = (v, def) => (typeof v === 'string' ? v : def);
    return {
        wrapLogMessage: bool(o.wrapLogMessage, d.wrapLogMessage),
        logMessagePrefix: str(o.logMessagePrefix, d.logMessagePrefix),
        logMessageSuffix: str(o.logMessageSuffix, d.logMessageSuffix),
        includeFilename: bool(o.includeFilename, d.includeFilename),
        includeLineNum: bool(o.includeLineNum, d.includeLineNum),
        addSemicolonInTheEnd: bool(o.addSemicolonInTheEnd, d.addSemicolonInTheEnd),
        insertEnclosingClass: bool(o.insertEnclosingClass, d.insertEnclosingClass),
        insertEnclosingFunction: bool(o.insertEnclosingFunction, d.insertEnclosingFunction),
        insertEmptyLineBeforeLogMessage: bool(o.insertEmptyLineBeforeLogMessage, d.insertEmptyLineBeforeLogMessage),
        insertEmptyLineAfterLogMessage: bool(o.insertEmptyLineAfterLogMessage, d.insertEmptyLineAfterLogMessage),
        delimiterInsideMessage: str(o.delimiterInsideMessage, d.delimiterInsideMessage),
        quote: ['"', "'", '`'].includes(o.quote) ? o.quote : '"',
        logFunction: (str(o.logFunction, d.logFunction).trim()) || 'log',
        tabSize: Number.isInteger(o.tabSize) && o.tabSize > 0 && o.tabSize <= 16 ? o.tabSize : 4,
        insertSpaces: o.insertSpaces !== false,
    };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Text helpers

const isP = (t, v) => !!t && t.t === 'p' && (v === undefined || t.v === v);
const isId = (t, v) => !!t && t.t === 'id' && (v === undefined || t.v === v);
const basename = (name) => String(name || '').split(/[\\/]/).pop();
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function detectEol(text) {
    const m = /\r\n|\n|\r/.exec(text);
    return m ? m[0] : '\n';
}
const countEol = (s) => (s.match(/\r\n|\r|\n/g) || []).length;

function buildLines(text) {
    const starts = [0];
    const ends = [];
    const re = /\r\n|\r|\n/g;
    let m;
    while ((m = re.exec(text)) !== null) { ends.push(m.index); starts.push(m.index + m[0].length); }
    ends.push(text.length);
    const count = starts.length;
    return {
        count, starts, ends,
        lineOf(off) {
            let lo = 0, hi = count - 1;
            while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; }
            return lo;
        },
        start: (l) => (l < count ? starts[l] : text.length),
        end: (l) => (l < count ? ends[l] : text.length),
        /** the leading white space of a line ('' for a blank line or a line that is not there) */
        indent(l) {
            if (l < 0 || l >= count) return '';
            const s = text.slice(starts[l], ends[l]);
            const ws = /^[ \t]*/.exec(s)[0];
            return ws.length === s.length ? '' : ws;
        },
    };
}

function indentUnit(text, opt) {
    if (opt.insertSpaces === false) return '\t';
    let tabs = 0, min = Infinity;
    for (const l of text.split(/\r\n|\r|\n/)) {
        const m = /^([ \t]+)\S/.exec(l);
        if (!m || l.trimStart().startsWith('*')) continue;
        if (m[1][0] === '\t') tabs++;
        else if (m[1].length >= 2 && m[1].length < min) min = m[1].length;
    }
    if (tabs > 0 && min === Infinity) return '\t';
    if ([2, 3, 4, 8].includes(min)) return ' '.repeat(min);
    return ' '.repeat(opt.tabSize);
}

function applyEdits(text, edits) {
    const sorted = edits.map((e, i) => ({ e, i })).sort((a, b) => a.e.offset - b.e.offset || a.i - b.i);
    let out = '', pos = 0;
    for (const { e } of sorted) {
        if (e.offset < pos) throw new Error('overlapping edits');
        out += text.slice(pos, e.offset) + e.text;
        pos = e.offset + (e.deleteLength || 0);
    }
    return out + text.slice(pos);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Languages

const JS_LANG_IDS = new Set(['javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'vue', 'svelte', 'astro', 'html', 'jsx', 'tsx']);
const JS_EXT = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte', 'astro', 'html', 'htm']);

function detectLanguage(languageId, fileName) {
    const id = String(languageId || '').toLowerCase();
    if (id === 'python') return 'py';
    if (JS_LANG_IDS.has(id)) return 'js';
    if (id && id !== 'plaintext') return null;
    const ext = (/\.([A-Za-z0-9]+)$/.exec(basename(fileName)) || [])[1];
    if (!ext) return null;
    if (/^(py|pyw)$/i.test(ext)) return 'py';
    return JS_EXT.has(ext.toLowerCase()) ? 'js' : null;
}

function jsFlavor(languageId, fileName) {
    const id = String(languageId || '').toLowerCase();
    const ext = ((/\.([A-Za-z0-9]+)$/.exec(basename(fileName)) || [])[1] || '').toLowerCase();
    const blocks = ['vue', 'svelte', 'astro', 'html'].includes(id) || ['vue', 'svelte', 'astro', 'html', 'htm'].includes(ext);
    const astro = id === 'astro' || ext === 'astro';
    const ts = blocks || ['typescript', 'typescriptreact', 'tsx'].includes(id) || ['ts', 'tsx', 'mts', 'cts'].includes(ext);
    const jsx = !blocks && (['javascript', 'javascriptreact', 'typescriptreact', 'jsx', 'tsx'].includes(id) || ['js', 'jsx', 'tsx', 'mjs', 'cjs'].includes(ext));
    return { blocks, astro, ts, jsx };
}

/** For Vue, Svelte, Astro and HTML only the script blocks are code: everything else is turned into spaces (offsets and lines stay). */
function scriptView(text, flavor) {
    if (!flavor.blocks) return { code: text, inScript: () => true };
    const ranges = [];
    if (flavor.astro) {
        const m = /^(\s*)---[ \t]*(?:\r\n|\r|\n)/.exec(text);
        if (m) {
            const a = m[0].length;
            const close = /(?:^|\r\n|\r|\n)---[ \t]*(?:\r\n|\r|\n|$)/.exec(text.slice(a));
            if (close) ranges.push([a, a + close.index]);
        }
    }
    const re = /<script\b([^>]*)>/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
        const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(m[1]);
        const a = m.index + m[0].length;
        const close = text.indexOf('</script', a);
        const b = close < 0 ? text.length : close;
        if (!type || /module|javascript|ecmascript|babel|jsx|typescript|^ts$/i.test(type[1])) ranges.push([a, b]);
        re.lastIndex = Math.max(re.lastIndex, b);
    }
    ranges.sort((x, y) => x[0] - y[0]);
    const blank = (s) => s.replace(/[^\r\n]/g, ' ');
    let code = '', pos = 0;
    for (const [a, b] of ranges) { if (a < pos) continue; code += blank(text.slice(pos, a)) + text.slice(a, b); pos = b; }
    code += blank(text.slice(pos));
    return { code, inScript: (off) => ranges.some(([a, b]) => off >= a && off <= b) };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// JavaScript / TypeScript: tokenizer

const PUNCTS = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.',
    '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>'];
const REGEX_AFTER_ID = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await', 'default', 'extends']);
const JSX_AFTER_P = new Set(['(', ',', '=', ':', '[', '?', '{', ';', '&&', '||', '??', '=>', '!', '+']);
const JSX_AFTER_ID = new Set(['return', 'case', 'default', 'yield', 'await', 'else', 'do', 'of', 'in']);
const isIdStart = (c) => /[A-Za-z_$\u0080-￿]/.test(c);
const isIdPart = (c) => /[\w$\u0080-￿]/.test(c);

function regexAllowed(prev, nl) {
    if (!prev) return true;
    if (prev.t === 'id') return REGEX_AFTER_ID.has(prev.v);
    if (prev.t !== 'p') return false;
    if (prev.v === ')' || prev.v === ']' || prev.v === '++' || prev.v === '--') return false;
    if (prev.v === '}') return nl;
    return true;
}

/**
 * Tokens: {t: 'id'|'num'|'str'|'tpl'|'rx'|'jsx'|'p', v, s, e, nl}. nl: a line break came before the token. Comments are not tokens (they are
 * listed apart). The text of JSX is one token per piece; the {expressions} inside JSX are tokens of their own.
 */
function tokenizeJs(code, opts) {
    const jsx = !!(opts && opts.jsx);
    const n = code.length;
    const comments = [];
    const mkTok = (t, v, s, e, nl) => ({ t, v, s, e, nl });

    function skipString(i) {
        const q = code[i];
        let j = i + 1;
        while (j < n && code[j] !== q && code[j] !== '\n' && code[j] !== '\r') {
            if (code[j] === '\\') j += (code[j + 1] === '\r' && code[j + 2] === '\n') ? 3 : 2; else j++;
        }
        if (j < n && code[j] === q) j++;
        return Math.min(j, n);
    }
    function skipTemplate(i) {
        let j = i + 1;
        while (j < n) {
            const c = code[j];
            if (c === '\\') j += 2;
            else if (c === '`') return j + 1;
            else if (c === '$' && code[j + 1] === '{') j = Math.min(scan([], j + 2, true) + 1, n);
            else j++;
        }
        return n;
    }
    function skipRegex(i) {
        let j = i + 1, inClass = false;
        while (j < n) {
            const c = code[j];
            if (c === '\n' || c === '\r') return -1;
            if (c === '\\') { j += 2; continue; }
            if (c === '[') inClass = true; else if (c === ']') inClass = false;
            else if (c === '/' && !inClass) break;
            j++;
        }
        if (j >= n || code[j] !== '/') return -1;
        j++;
        while (j < n && /[A-Za-z]/.test(code[j])) j++;
        return j;
    }
    function scanJsx(arr, i, nlFlag) {
        let chunkStart = i, nlNext = nlFlag;
        const flush = (upto) => { if (upto > chunkStart) { arr.push(mkTok('jsx', '', chunkStart, upto, nlNext)); nlNext = false; } };
        const container = (j) => {
            flush(j);
            arr.push(mkTok('p', '{', j, j + 1, false)); nlNext = false;
            const close = scan(arr, j + 1, true);
            if (close >= n || code[close] !== '}') return -1;
            arr.push(mkTok('p', '}', close, close + 1, false));
            chunkStart = close + 1;
            return close + 1;
        };
        const children = (j, name) => {
            for (;;) {
                if (j >= n) return -1;
                const ch = code[j];
                if (ch === '<') {
                    if (code[j + 1] === '/') {
                        const e = code.indexOf('>', j);
                        if (e < 0 || code.slice(j + 2, e).trim() !== name) return -1;
                        return e + 1;
                    }
                    j = element(j);
                    if (j < 0) return -1;
                } else if (ch === '{') { j = container(j); if (j < 0) return -1; } else j++;
            }
        };
        const element = (j) => {
            j++;
            if (code[j] === '>') return children(j + 1, '');
            const m = /^[A-Za-z_$][\w$.:-]*/.exec(code.slice(j, j + 200));
            if (!m) return -1;
            const name = m[0];
            j += name.length;
            for (;;) {
                while (j < n && /\s/.test(code[j])) j++;
                if (j >= n) return -1;
                const ch = code[j];
                if (ch === '/' && code[j + 1] === '>') return j + 2;
                if (ch === '>') return children(j + 1, name);
                if (ch === '{') { j = container(j); if (j < 0) return -1; continue; }
                if (ch === '"' || ch === "'") { const e = code.indexOf(ch, j + 1); if (e < 0) return -1; j = e + 1; continue; }
                if (/[\w$:.\-=]/.test(ch)) { j++; continue; }
                return -1;
            }
        };
        const e = element(i);
        if (e < 0) return -1;
        flush(e);
        return e;
    }
    function scan(arr, start, nested) {
        let i = start, nl = false, braces = 0;
        if (start === 0 && code.startsWith('#!')) while (i < n && code[i] !== '\n' && code[i] !== '\r') i++;
        while (i < n) {
            const c = code[i];
            if (c === '\n' || c === '\r' || c === ' ' || c === ' ') { nl = true; i++; continue; }
            if (c === ' ' || c === '\t' || c === '\f' || c === '\v' || c === ' ' || c === '﻿') { i++; continue; }
            const prev = arr.length ? arr[arr.length - 1] : null;
            if (c === '/' && code[i + 1] === '/') {
                const s = i;
                while (i < n && code[i] !== '\n' && code[i] !== '\r') i++;
                comments.push({ s, e: i, block: false });
                continue;
            }
            if (c === '/' && code[i + 1] === '*') {
                const s = i;
                const e = code.indexOf('*/', i + 2);
                i = e < 0 ? n : e + 2;
                if (/[\r\n]/.test(code.slice(s, i))) nl = true;
                comments.push({ s, e: i, block: true });
                continue;
            }
            if (c === '"' || c === "'") { const e = skipString(i); arr.push(mkTok('str', '', i, e, nl)); nl = false; i = e; continue; }
            if (c === '`') { const e = skipTemplate(i); arr.push(mkTok('tpl', '', i, e, nl)); nl = false; i = e; continue; }
            if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(code[i + 1] || ''))) {
                const m = /^(?:0[xXbBoO][\da-fA-F_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?n?)/.exec(code.slice(i, i + 60));
                const len = m ? m[0].length : 1;
                arr.push(mkTok('num', '', i, i + len, nl)); nl = false; i += len;
                continue;
            }
            if (isIdStart(c) || (c === '#' && isIdStart(code[i + 1] || ''))) {
                let j = i + 1;
                while (j < n && isIdPart(code[j])) j++;
                arr.push(mkTok('id', code.slice(i, j), i, j, nl)); nl = false; i = j;
                continue;
            }
            if (c === '/' && regexAllowed(prev, nl)) {
                const e = skipRegex(i);
                if (e > i) { arr.push(mkTok('rx', '', i, e, nl)); nl = false; i = e; continue; }
            }
            if (jsx && c === '<' && /[A-Za-z_$>]/.test(code[i + 1] || '') &&
                (!prev || (prev.t === 'p' && JSX_AFTER_P.has(prev.v)) || (prev.t === 'id' && JSX_AFTER_ID.has(prev.v)))) {
                const mark = arr.length, cm = comments.length;
                const e = scanJsx(arr, i, nl);
                if (e > i) { i = e; nl = false; continue; }
                arr.length = mark; comments.length = cm;
            }
            let p = null;
            for (const q of PUNCTS) if (code.startsWith(q, i)) { p = q; break; }
            if (p === '?.' && /[0-9]/.test(code[i + 2] || '')) p = '?';
            if (!p) p = c;
            if (p === '}' && nested && braces === 0) return i;
            if (p === '{') braces++; else if (p === '}') braces--;
            arr.push(mkTok('p', p, i, i + p.length, nl)); nl = false; i += p.length;
        }
        return i;
    }
    const tokens = [];
    scan(tokens, 0, false);
    return { tokens, comments };
}

/** match[i]: the partner of a bracket token; outer[i]: the bracket that encloses token i. */
function bracketMaps(tk) {
    const match = new Array(tk.length).fill(-1);
    const outer = new Array(tk.length).fill(-1);
    const stack = [];
    for (let i = 0; i < tk.length; i++) {
        const t = tk[i];
        if (t.t === 'p' && (t.v === ')' || t.v === ']' || t.v === '}')) {
            const want = t.v === ')' ? '(' : t.v === ']' ? '[' : '{';
            let k = stack.length - 1;
            while (k >= 0 && tk[stack[k]].v !== want) k--;
            if (k >= 0) { const o = stack[k]; stack.length = k; match[o] = i; match[i] = o; }
            outer[i] = stack.length ? stack[stack.length - 1] : -1;
        } else {
            outer[i] = stack.length ? stack[stack.length - 1] : -1;
            if (t.t === 'p' && (t.v === '(' || t.v === '[' || t.v === '{')) stack.push(i);
        }
    }
    return { match, outer };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// JavaScript / TypeScript: statements

const CONT_PREV_P = new Set([',', '.', '?.', '=>', '=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=',
    '+', '-', '*', '/', '%', '**', '&&', '||', '??', '==', '===', '!=', '!==', '<', '<=', '>=', '&', '|', '^', '<<', '>>', '>>>', '?', ':', '(', '[', '{', '...', '~']);
const CONT_PREV_ID = new Set(['in', 'of', 'instanceof', 'typeof', 'new', 'delete', 'void', 'await', 'yield', 'extends', 'as', 'satisfies', 'keyof']);
const CONT_NEXT_P = new Set(['.', '?.', '?', ':', '&&', '||', '??', '==', '===', '!=', '!==', '*', '/', '%', '**', '=', '+=', '-=', '*=', '/=', '%=', '**=',
    '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=', ',', '<', '>', '<=', '>=', '&', '|', '^', '<<', '>>', '>>>', '+', '-', '(', '[', '=>']);
const RESERVED_LABEL = new Set(['default', 'case', 'else', 'return', 'if', 'for', 'while', 'do', 'switch', 'try', 'catch', 'finally', 'function', 'class',
    'const', 'let', 'var', 'new', 'typeof', 'void', 'delete', 'throw', 'break', 'continue', 'this', 'super', 'null', 'true', 'false', 'import', 'export',
    'in', 'of', 'instanceof', 'async', 'await', 'yield', 'with', 'debugger']);
const MODS = new Set(['public', 'private', 'protected', 'readonly', 'abstract', 'override', 'declare', 'static', 'async', 'get', 'set', 'accessor']);
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=']);
const NOT_CHAIN = new Set(['return', 'typeof', 'new', 'delete', 'void', 'await', 'yield', 'in', 'of', 'instanceof', 'case', 'else', 'do', 'throw', 'var', 'let', 'const', 'extends']);

/** A line break between two tokens that ends a statement (automatic semicolon insertion, as far as it can be told without a parser). */
function isBreak(prev, tok) {
    if (prev.t === 'p' && CONT_PREV_P.has(prev.v)) return false;
    if (prev.t === 'id' && CONT_PREV_ID.has(prev.v)) return false;
    if (tok.t === 'p' && CONT_NEXT_P.has(tok.v)) return false;
    if (tok.t === 'tpl') return false;
    if (tok.t === 'id' && (tok.v === 'in' || tok.v === 'instanceof' || tok.v === 'as' || tok.v === 'satisfies')) return false;
    return true;
}

function analyzeJs(code, flavor, lines) {
    const { tokens: tk, comments } = tokenizeJs(code, { jsx: flavor.jsx });
    const n = tk.length;
    const { match, outer } = bracketMaps(tk);
    const funcs = [], classes = [];
    const nodeByTok = new Map();
    const root = { kind: 'root', tokStart: 0, tokEnd: n, start: 0, end: code.length, startLine: 0, endLine: lines.count - 1, parent: null, children: [],
        bodies: [], head: null, braceless: false, elseIf: false, bodyOpen: -1, bodyClose: -1, name: null, bodyNode: null, consequent: null };

    function mk(kind, i, parent) {
        const t = tk[i];
        const node = { kind, tokStart: i, tokEnd: i + 1, start: t.s, end: t.e, startLine: lines.lineOf(t.s), endLine: lines.lineOf(Math.max(t.e - 1, t.s)), parent,
            children: [], bodies: [], head: null, braceless: false, elseIf: false, bodyOpen: -1, bodyClose: -1, name: null, bodyNode: null, consequent: null };
        parent.children.push(node);
        nodeByTok.set(i, node);
        return node;
    }
    function finish(node, next) {
        const e = Math.min(Math.max(next, node.tokStart + 1), n);
        node.tokEnd = e;
        node.end = Math.max(tk[e - 1].e, node.start);
        node.endLine = lines.lineOf(Math.max(node.end - 1, node.start));
        return e;
    }
    function setStart(node, i) {
        node.tokStart = i;
        node.start = tk[i].s;
        node.startLine = lines.lineOf(node.start);
        nodeByTok.set(i, node);
    }
    const skipAngles = (j) => {
        let depth = 0;
        for (let k = j; k < Math.min(n, j + 80); k++) {
            const t = tk[k];
            if (!isP(t)) continue;
            if (t.v === '<') depth++;
            else if (t.v === '>') depth--;
            else if (t.v === '>>') depth -= 2;
            else if (t.v === '>>>') depth -= 3;
            else if (t.v === ';' || t.v === '{' || t.v === '}') break;
            if (depth <= 0) return k + 1;
        }
        return j + 1;
    };
    const skipDecorator = (j) => {
        let k = j + 1;
        while (isId(tk[k]) && (isP(tk[k + 1], '.'))) k += 2;
        if (isId(tk[k])) k++;
        if (isP(tk[k], '(') && match[k] > k) k = match[k] + 1;
        return k;
    };

    function parseList(i, limit, parent) {
        while (i < limit) {
            const j = parseStatement(i, limit, parent, false);
            i = j > i ? j : i + 1;
        }
    }
    function parseBody(j, limit, node) {
        if (j >= limit) return j;
        if (isP(tk[j], '{')) return parseBlock(j, limit, node, false);
        return parseStatement(j, limit, node, true);
    }
    function parseBlock(i, limit, parent, braceless) {
        const node = mk('block', i, parent);
        node.braceless = braceless;
        const close = match[i] > i && match[i] < limit ? match[i] : limit;
        node.bodyOpen = tk[i].s;
        node.bodyClose = close < n ? tk[close].s : code.length;
        node.bodies.push({ open: node.bodyOpen, close: node.bodyClose });
        parseList(i + 1, close, node);
        return finish(node, close + 1);
    }
    function scanHead(from, to, node) {
        let j = from;
        while (j < to) { const nx = scanExpr(j, to, node, 'head', {}); j = nx > j ? nx : j + 1; }
    }
    function parseExprStatement(kind, i, limit, parent, braceless, opts) {
        const node = mk(kind, i, parent);
        node.braceless = braceless;
        const j = scanExpr(i, limit, node, kind, opts || {});
        return finish(node, j <= i ? i + 1 : j);
    }

    function parseStatement(i, limit, parent, braceless) {
        const t = tk[i];
        if (t.t === 'p') {
            if (t.v === ';') return i + 1;
            if (t.v === '{') return parseBlock(i, limit, parent, braceless);
            if (t.v === '@') { const j = skipDecorator(i); return j < limit ? parseStatement(j, limit, parent, braceless) : limit; }
            return parseExprStatement('expr', i, limit, parent, braceless);
        }
        if (t.t !== 'id') return parseExprStatement('expr', i, limit, parent, braceless);
        const v = t.v, nx = tk[i + 1];
        if (isP(nx, ':') && i + 2 < limit && !RESERVED_LABEL.has(v)) {
            const j = parseStatement(i + 2, limit, parent, braceless);
            const inner = nodeByTok.get(i + 2);
            if (inner && inner.parent === parent) setStart(inner, i);
            return j;
        }
        switch (v) {
            case 'if': return parseIf(i, limit, parent, braceless, false);
            case 'for': return parseFor(i, limit, parent, braceless);
            case 'while': case 'with': return parseWhile(i, limit, parent, braceless, v);
            case 'do': return parseDo(i, limit, parent, braceless);
            case 'switch': return parseSwitch(i, limit, parent, braceless);
            case 'try': return parseTry(i, limit, parent, braceless);
            case 'function': return parseFunctionStmt(i, limit, parent, braceless);
            case 'async': if (isId(nx, 'function') && !nx.nl) return parseFunctionStmt(i, limit, parent, braceless); break;
            case 'class': return parseClassStmt(i, limit, parent, braceless);
            case 'const': if (flavor.ts && isId(nx, 'enum')) return parseTypeBlock(i, limit, parent, 'type'); return parseExprStatement('decl', i, limit, parent, braceless);
            case 'var': return parseExprStatement('decl', i, limit, parent, braceless);
            case 'let': if (isId(nx) || isP(nx, '[') || isP(nx, '{')) return parseExprStatement('decl', i, limit, parent, braceless); break;
            case 'return': case 'throw': return parseExprStatement(v, i, limit, parent, braceless);
            case 'import': if (!isP(nx, '(') && !isP(nx, '.')) return parseExprStatement('import', i, limit, parent, braceless, { plain: true }); break;
            case 'export': {
                let j = i + 1;
                if (isId(tk[j], 'default')) j++;
                const nt = tk[j];
                const decl = nt && nt.t === 'id' && (['function', 'class', 'const', 'let', 'var'].includes(nt.v) ||
                    (flavor.ts && ['interface', 'enum', 'type', 'declare', 'abstract', 'namespace', 'module'].includes(nt.v)) || (nt.v === 'async' && isId(tk[j + 1], 'function')));
                if (decl && j < limit) {
                    const r = parseStatement(j, limit, parent, braceless);
                    const nd = nodeByTok.get(j);
                    if (nd) setStart(nd, i);
                    return r;
                }
                return parseExprStatement('export', i, limit, parent, braceless);
            }
            case 'interface': case 'enum': if (flavor.ts && isId(nx) && !nx.nl) return parseTypeBlock(i, limit, parent, 'type'); break;
            case 'type': if (flavor.ts && isId(nx) && !nx.nl && (isP(tk[i + 2], '=') || isP(tk[i + 2], '<'))) return parseExprStatement('type', i, limit, parent, braceless, { plain: true }); break;
            case 'namespace': case 'module': if (flavor.ts && !nx.nl && (isId(nx) || nx.t === 'str')) return parseNamespace(i, limit, parent, braceless); break;
            case 'declare': case 'abstract':
                if (flavor.ts && isId(nx) && !nx.nl) {
                    const j = parseStatement(i + 1, limit, parent, braceless);
                    const nd = nodeByTok.get(i + 1);
                    if (nd) setStart(nd, i);
                    return j;
                }
                break;
            default: break;
        }
        return parseExprStatement('expr', i, limit, parent, braceless);
    }

    function parseTypeBlock(i, limit, parent, kind) {
        const node = mk(kind, i, parent);
        let k = i + 1;
        while (k < limit && !isP(tk[k], '{') && !isP(tk[k], ';')) { if ((isP(tk[k], '(') || isP(tk[k], '[')) && match[k] > k) k = match[k]; k++; }
        if (isP(tk[k], '{') && match[k] > k) return finish(node, match[k] + 1);
        return finish(node, k + (isP(tk[k], ';') ? 1 : 0));
    }
    function parseNamespace(i, limit, parent, braceless) {
        let k = i + 1;
        while (k < limit && !isP(tk[k], '{') && !isP(tk[k], ';')) k++;
        if (!(isP(tk[k], '{') && match[k] > k)) return parseExprStatement('expr', i, limit, parent, braceless);
        const node = mk('block', i, parent);
        node.bodies.push({ open: tk[k].s, close: tk[match[k]].s });
        node.bodyOpen = tk[k].s; node.bodyClose = tk[match[k]].s;
        parseList(k + 1, match[k], node);
        return finish(node, match[k] + 1);
    }
    function parseIf(i, limit, parent, braceless, elseIf) {
        const node = mk('if', i, parent);
        node.braceless = braceless; node.elseIf = elseIf;
        const open = i + 1;
        if (!(isP(tk[open], '(') && match[open] > open && match[open] < limit)) return finish(node, i + 1);
        const close = match[open];
        node.head = { open: tk[open].s, close: tk[close].s };
        scanHead(open + 1, close, node);
        let j = close + 1;
        const before = node.children.length;
        j = parseBody(j, limit, node);
        node.consequent = node.children[before] || null;
        node.bodyNode = node.consequent;
        if (isId(tk[j], 'else') && j < limit) {
            j++;
            if (isId(tk[j], 'if')) j = parseIf(j, limit, node, false, true);
            else j = parseBody(j, limit, node);
        }
        return finish(node, j);
    }
    function parseFor(i, limit, parent, braceless) {
        const node = mk('for', i, parent);
        node.braceless = braceless;
        let j = i + 1;
        if (isId(tk[j], 'await')) j++;
        if (!(isP(tk[j], '(') && match[j] > j && match[j] < limit)) return finish(node, i + 1);
        const open = j, close = match[j];
        node.head = { open: tk[open].s, close: tk[close].s };
        for (let k = open + 1; k < close; k++) {
            const t = tk[k];
            if (isP(t) && (t.v === '(' || t.v === '[' || t.v === '{') && match[k] > k) { k = match[k]; continue; }
            if (isId(t, 'of') || isId(t, 'in')) { node.kind = t.v === 'of' ? 'forof' : 'forin'; node.headBind = { s: tk[open + 1].s, e: t.s }; break; }
            if (isP(t, ';')) { node.headBind = { s: tk[open + 1].s, e: t.s }; break; }
        }
        if (node.headBind) { const f = tk[open + 1]; node.headBind.decl = isId(f) && (f.v === 'const' || f.v === 'let' || f.v === 'var'); }
        scanHead(open + 1, close, node);
        const before = node.children.length;
        j = parseBody(close + 1, limit, node);
        node.bodyNode = node.children[before] || null;
        return finish(node, j);
    }
    function parseWhile(i, limit, parent, braceless, kw) {
        const node = mk('while', i, parent);
        node.braceless = braceless;
        const open = i + 1;
        if (!(isP(tk[open], '(') && match[open] > open && match[open] < limit)) return finish(node, i + 1);
        const close = match[open];
        node.head = { open: tk[open].s, close: tk[close].s };
        if (kw === 'with') node.kind = 'with';
        scanHead(open + 1, close, node);
        const before = node.children.length;
        const j = parseBody(close + 1, limit, node);
        node.bodyNode = node.children[before] || null;
        return finish(node, j);
    }
    function parseDo(i, limit, parent, braceless) {
        const node = mk('do', i, parent);
        node.braceless = braceless;
        const before = node.children.length;
        let j = parseBody(i + 1, limit, node);
        node.bodyNode = node.children[before] || null;
        if (isId(tk[j], 'while') && isP(tk[j + 1], '(') && match[j + 1] > j + 1) {
            const open = j + 1, close = match[open];
            node.head = { open: tk[open].s, close: tk[close].s };
            scanHead(open + 1, close, node);
            j = close + 1;
            if (isP(tk[j], ';')) j++;
        }
        return finish(node, j);
    }
    function parseSwitch(i, limit, parent, braceless) {
        const node = mk('switch', i, parent);
        node.braceless = braceless;
        const open = i + 1;
        if (!(isP(tk[open], '(') && match[open] > open && match[open] < limit)) return finish(node, i + 1);
        const hc = match[open];
        node.head = { open: tk[open].s, close: tk[hc].s };
        scanHead(open + 1, hc, node);
        const bo = hc + 1;
        if (!(isP(tk[bo], '{') && match[bo] > bo)) return finish(node, hc + 1);
        const bc = match[bo];
        node.bodies.push({ open: tk[bo].s, close: tk[bc].s });
        let k = bo + 1;
        while (k < bc) {
            const t = tk[k];
            if (isId(t, 'case') || (isId(t, 'default') && isP(tk[k + 1], ':'))) {
                let c = k + 1;
                while (c < bc) {
                    if (isP(tk[c]) && (tk[c].v === '(' || tk[c].v === '[' || tk[c].v === '{') && match[c] > c) { c = match[c] + 1; continue; }
                    if (isP(tk[c], ':')) break;
                    c++;
                }
                const lab = mk('case', k, node);
                finish(lab, Math.min(c + 1, bc));
                k = c + 1;
            } else { const j = parseStatement(k, bc, node, false); k = j > k ? j : k + 1; }
        }
        return finish(node, bc + 1);
    }
    function parseTry(i, limit, parent, braceless) {
        const node = mk('try', i, parent);
        node.braceless = braceless;
        let j = i + 1;
        if (isP(tk[j], '{') && match[j] > j) j = parseBlock(j, limit, node, false);
        if (isId(tk[j], 'catch')) {
            const c = mk('catch', j, node);
            const kw = j;
            j++;
            let rec = null;
            if (isP(tk[j], '(') && match[j] > j) {
                const pc = match[j];
                c.head = { open: tk[j].s, close: tk[pc].s };
                rec = { kind: 'catch', name: null, start: tk[kw].s, end: tk[pc].e, paramsOpen: tk[j].s, paramsClose: tk[pc].s, ptS: j + 1, ptE: pc, single: null,
                    bodyKind: null, bodyOpen: -1, bodyClose: -1, exprStart: -1, exprEnd: -1, owner: c };
                scanHead(j + 1, pc, c);
                j = pc + 1;
            }
            if (isP(tk[j], '{') && match[j] > j) {
                const bc = match[j];
                c.bodies.push({ open: tk[j].s, close: tk[bc].s });
                c.bodyOpen = tk[j].s; c.bodyClose = tk[bc].s;
                if (rec) { rec.bodyKind = 'block'; rec.bodyOpen = tk[j].s; rec.bodyClose = tk[bc].s; rec.end = tk[bc].e; }
                parseList(j + 1, bc, c);
                j = bc + 1;
            }
            if (rec) funcs.push(rec);
            j = finish(c, j);
        }
        if (isId(tk[j], 'finally')) {
            const f = mk('finally', j, node);
            j++;
            if (isP(tk[j], '{') && match[j] > j) {
                const bc = match[j];
                f.bodies.push({ open: tk[j].s, close: tk[bc].s });
                parseList(j + 1, bc, f);
                j = bc + 1;
            }
            j = finish(f, j);
        }
        return finish(node, j);
    }

    // functions ----------------------------------------------------------------------------------------------------------------
    function findBodyOpen(j) {
        if (!tk[j]) return -1;
        if (isP(tk[j], '{')) return j;
        if (!isP(tk[j], ':') || !flavor.ts) return -1;
        let k = j + 1, guard = 0;
        while (k < n && guard++ < 200) {
            const t = tk[k];
            if (isP(t)) {
                if (t.v === '{') {
                    const pv = tk[k - 1];
                    const typeCtx = pv && ((isP(pv) && [':', '|', '&', '<', ',', '(', '=>', '['].includes(pv.v)) || (isId(pv) && ['extends', 'keyof', 'readonly'].includes(pv.v)));
                    if (typeCtx) { if (match[k] < 0) return -1; k = match[k] + 1; continue; }
                    return k;
                }
                if ((t.v === '(' || t.v === '[') && match[k] > k) { k = match[k] + 1; continue; }
                if (t.v === ';' || t.v === '=') return -1;
            }
            k++;
        }
        return -1;
    }
    /** i: index of "async" or "function". Returns { next, rec } or null when it is not a function after all. */
    function parseFunction(i, owner, fallbackName, limit) {
        let j = i;
        if (isId(tk[j], 'async')) j++;
        j++;
        if (isP(tk[j], '*')) j++;
        let name = null;
        if (isId(tk[j]) && (isP(tk[j + 1], '(') || isP(tk[j + 1], '<'))) { name = tk[j].v; j++; }
        if (isP(tk[j], '<')) j = skipAngles(j);
        if (!isP(tk[j], '(') || match[j] < 0) return null;
        const po = j, pc = match[j];
        const rec = { kind: 'function', name: name || fallbackName || null, start: tk[i].s, end: tk[pc].e, paramsOpen: tk[po].s, paramsClose: tk[pc].s, ptS: po + 1, ptE: pc,
            single: null, bodyKind: null, bodyOpen: -1, bodyClose: -1, exprStart: -1, exprEnd: -1, owner };
        const bo = findBodyOpen(pc + 1);
        let next = pc + 1;
        if (bo >= 0 && match[bo] > bo) {
            const bc = Math.min(match[bo], limit);
            rec.bodyKind = 'block'; rec.bodyOpen = tk[bo].s; rec.bodyClose = tk[bc].s; rec.end = tk[bc].e;
            owner.bodies.push({ open: rec.bodyOpen, close: rec.bodyClose });
            parseList(bo + 1, bc, owner);
            next = bc + 1;
        }
        funcs.push(rec);
        return { next, rec };
    }
    function parseFunctionStmt(i, limit, parent, braceless) {
        const node = mk('function', i, parent);
        node.braceless = braceless;
        const r = parseFunction(i, node, null, limit);
        if (!r) { node.kind = 'expr'; return finish(node, scanExpr(i, limit, node, 'expr', {}) || i + 1); }
        let j = r.next;
        if (!r.rec.bodyKind) j = scanExpr(j, limit, node, 'type', { plain: true });
        else if (isP(tk[j], ';')) j++;
        return finish(node, j);
    }
    function arrowReturnTypeParen(k) {
        let m = k - 1, steps = 0;
        while (m >= 0 && steps++ < 40) {
            const t = tk[m];
            if (isP(t) && (t.v === ')' || t.v === ']' || t.v === '}')) { if (match[m] < 0) return -1; m = match[m] - 1; continue; }
            if (isP(t, ':')) return isP(tk[m - 1], ')') ? m - 1 : -1;
            if (isP(t) && [';', '=', '(', ',', '{', '[', '?'].includes(t.v)) return -1;
            m--;
        }
        return -1;
    }
    function conciseEnd(j0, limit) {
        let j = j0;
        while (j < limit) {
            const t = tk[j];
            if (isP(t)) {
                if (t.v === '(' || t.v === '[' || t.v === '{') { if (match[j] < 0) return limit; j = match[j] + 1; continue; }
                if (t.v === ',' || t.v === ';' || t.v === ')' || t.v === ']' || t.v === '}') break;
            }
            if (j > j0 && t.nl && isBreak(tk[j - 1], t)) break;
            j++;
        }
        return j;
    }
    function arrowAt(k, node, limit, curName, lastEq, nameable) {
        const a = k - 1;
        let startTok = -1, ps = -1, pc = -1, single = -1;
        if (a >= 0 && isP(tk[a], ')') && match[a] >= 0) { pc = a; ps = match[a]; startTok = ps; }
        else if (a >= 0 && isId(tk[a]) && !NOT_CHAIN.has(tk[a].v)) { single = a; startTok = a; }
        else if (flavor.ts) { const r = arrowReturnTypeParen(k); if (r >= 0 && match[r] >= 0) { pc = r; ps = match[r]; startTok = ps; } }
        if (startTok < 0) return k + 1;
        if (isId(tk[startTok - 1], 'async') && !tk[startTok].nl && startTok !== single) startTok--;
        const name = nameable && curName && lastEq >= 0 && startTok - 1 === lastEq ? curName : null;
        const rec = { kind: 'arrow', name, start: tk[startTok].s, end: tk[k].e, paramsOpen: ps >= 0 ? tk[ps].s : -1, paramsClose: pc >= 0 ? tk[pc].s : -1,
            ptS: ps >= 0 ? ps + 1 : single, ptE: ps >= 0 ? pc : single + 1, single: single >= 0 ? { s: tk[single].s, e: tk[single].e } : null,
            bodyKind: null, bodyOpen: -1, bodyClose: -1, exprStart: -1, exprEnd: -1, arrowEnd: tk[k].e, owner: node };
        const b = tk[k + 1];
        if (isP(b, '{') && match[k + 1] > k + 1 && k + 1 < limit) {
            const bc = Math.min(match[k + 1], limit);
            rec.bodyKind = 'block'; rec.bodyOpen = b.s; rec.bodyClose = tk[bc].s; rec.end = tk[bc].e;
            node.bodies.push({ open: b.s, close: tk[bc].s });
            parseList(k + 2, bc, node);
            funcs.push(rec);
            return bc + 1;
        }
        const endIdx = conciseEnd(k + 1, limit);
        if (b && endIdx > k + 1) { rec.bodyKind = 'expr'; rec.exprStart = b.s; rec.exprEnd = tk[endIdx - 1].e; rec.end = rec.exprEnd; }
        funcs.push(rec);
        return k + 1;
    }
    /** `name(params) { body }` inside an object literal; j: the ")" token. */
    function objectMethod(j, node, limit) {
        const open = match[j];
        const bo = j + 1, bc = match[bo];
        if (open < 1 || bc <= bo || bc > limit) return -1;
        let k = open - 1;
        const kt = tk[k];
        if (!(isId(kt) && !NOT_CHAIN.has(kt.v) && !['if', 'while', 'for', 'switch', 'catch', 'function'].includes(kt.v)) && kt.t !== 'str' && kt.t !== 'num' && !isP(kt, ']')) return -1;
        if (isP(kt, ']')) k = match[k] >= 0 ? match[k] : k;
        let s = k;
        if (isP(tk[s - 1], '*')) s--;
        if (isId(tk[s - 1]) && ['async', 'get', 'set'].includes(tk[s - 1].v)) s--;
        const rec = { kind: 'method', name: isId(kt) ? kt.v : null, start: tk[s].s, end: tk[bc].e, paramsOpen: tk[open].s, paramsClose: tk[j].s, ptS: open + 1, ptE: j, single: null,
            bodyKind: 'block', bodyOpen: tk[bo].s, bodyClose: tk[bc].s, exprStart: -1, exprEnd: -1, owner: node };
        node.bodies.push({ open: tk[bo].s, close: tk[bc].s });
        parseList(bo + 1, bc, node);
        funcs.push(rec);
        return bc + 1;
    }

    // classes ------------------------------------------------------------------------------------------------------------------
    function parseClassStmt(i, limit, parent, braceless) {
        const node = mk('class', i, parent);
        node.braceless = braceless;
        const j = parseClassInto(i, node, true);
        return finish(node, Math.max(j, i + 1));
    }
    function memberKeyFollows(k, close) {
        const t = tk[k + 1];
        if (!t || k + 1 >= close) return false;
        if (t.t === 'id' || t.t === 'str' || t.t === 'num') return true;
        return isP(t) && (t.v === '[' || t.v === '*' || t.v === '{');
    }
    function parseClassInto(i, node, isDecl) {
        let j = i + 1, name = null;
        if (isId(tk[j]) && tk[j].v !== 'extends' && tk[j].v !== 'implements') { name = tk[j].v; j++; }
        let open = -1;
        for (let k = j; k < n; k++) {
            const t = tk[k];
            if (!isP(t)) continue;
            if (t.v === '{') { open = k; break; }
            if ((t.v === '(' || t.v === '[') && match[k] > k) { k = match[k]; continue; }
            if (t.v === ';') break;
        }
        if (open < 0 || match[open] < 0) return j;
        const close = match[open];
        node.bodyOpen = tk[open].s; node.bodyClose = tk[close].s;
        node.isClass = true;
        classes.push({ name: isDecl ? name : null, start: tk[i].s, end: tk[close].e });
        let m = open + 1;
        while (m < close) {
            const t = tk[m];
            if (isP(t, ';')) { m++; continue; }
            if (isP(t, '@')) { m = Math.max(skipDecorator(m), m + 1); continue; }
            const mem = mk('member', m, node);
            mem.inClass = true;
            let k = m, isStatic = false;
            while (k < close && isId(tk[k]) && MODS.has(tk[k].v) && memberKeyFollows(k, close)) { if (tk[k].v === 'static') isStatic = true; k++; }
            if (isStatic && isP(tk[k], '{') && match[k] > k) {
                const bc = match[k];
                mem.kind = 'static';
                mem.bodies.push({ open: tk[k].s, close: tk[bc].s });
                parseList(k + 1, bc, mem);
                m = finish(mem, bc + 1);
                continue;
            }
            if (isP(tk[k], '*')) k++;
            const kt = tk[k];
            let keyName = null;
            if (k >= close || !kt) { m = finish(mem, close); continue; }
            if (kt.t === 'id') { keyName = kt.v.charAt(0) === '#' ? null : kt.v; k++; }
            else if (kt.t === 'str' || kt.t === 'num') k++;
            else if (isP(kt, '[') && match[k] > k) k = match[k] + 1;
            else { m = finish(mem, k + 1); continue; }
            if (isP(tk[k], '?') || isP(tk[k], '!')) k++;
            if (isP(tk[k], '<')) k = skipAngles(k);
            if (isP(tk[k], '(') && match[k] > k) {
                const pc = match[k];
                mem.kind = 'method'; mem.name = keyName; mem.isStatic = isStatic; mem.isCtor = keyName === 'constructor';
                const rec = { kind: 'method', name: keyName, start: tk[m].s, end: tk[pc].e, paramsOpen: tk[k].s, paramsClose: tk[pc].s, ptS: k + 1, ptE: pc, single: null,
                    bodyKind: null, bodyOpen: -1, bodyClose: -1, exprStart: -1, exprEnd: -1, owner: mem };
                const bo = findBodyOpen(pc + 1);
                if (bo >= 0 && match[bo] > bo && bo < close) {
                    const bc = match[bo];
                    rec.bodyKind = 'block'; rec.bodyOpen = tk[bo].s; rec.bodyClose = tk[bc].s; rec.end = tk[bc].e;
                    mem.bodies.push({ open: rec.bodyOpen, close: rec.bodyClose });
                    mem.bodyOpen = rec.bodyOpen; mem.bodyClose = rec.bodyClose;
                    parseList(bo + 1, bc, mem);
                    m = finish(mem, bc + 1);
                } else m = finish(mem, Math.max(scanExpr(pc + 1, close, mem, 'field', { plain: true }), pc + 1));
                funcs.push(rec);
                continue;
            }
            mem.kind = 'field'; mem.name = keyName; mem.isStatic = isStatic;
            m = finish(mem, Math.max(scanExpr(m, close, mem, 'field', { declName: keyName }), m + 1));
        }
        return close + 1;
    }

    // expressions --------------------------------------------------------------------------------------------------------------
    function scanExpr(i, limit, node, kind, opts) {
        let j = i;
        const stack = [];
        const plain = !!opts.plain || kind === 'type' || kind === 'import';
        let curName = opts.declName || null, expectName = false, lastEq = -1;
        if (kind === 'decl') { j = i + 1; expectName = true; }
        while (j < limit) {
            const t = tk[j];
            if (stack.length === 0) {
                if (isP(t)) {
                    if (t.v === ';') return j + 1;
                    if (t.v === '}' || t.v === ')' || t.v === ']') return j;
                }
                if (j > i && t.nl && isBreak(tk[j - 1], t)) return j;
                if (kind === 'decl' && expectName) { expectName = false; curName = isId(t) ? t.v : null; lastEq = -1; }
                else if ((kind === 'decl' || kind === 'field') && isP(t)) {
                    if (t.v === ',' && kind === 'decl') { expectName = true; curName = null; lastEq = -1; }
                    else if (t.v === '=' && lastEq < 0) lastEq = j;
                }
            }
            if (isP(t)) {
                const v = t.v;
                if (v === '(' || v === '[' || v === '{') { stack.push(j); j++; continue; }
                if (v === ')' || v === ']' || v === '}') {
                    stack.pop();
                    if (v === ')' && !plain && stack.length && tk[stack[stack.length - 1]].v === '{' && isP(tk[j + 1], '{')) {
                        const next = objectMethod(j, node, limit);
                        if (next > 0) { j = next; continue; }
                    }
                    j++; continue;
                }
                if (v === '=>' && !plain) { j = arrowAt(j, node, limit, curName, lastEq, kind === 'decl' || kind === 'field'); continue; }
            } else if (isId(t) && !plain && !isP(tk[j - 1], '.') && !isP(tk[j - 1], '?.')) {
                const isFn = t.v === 'function' || (t.v === 'async' && isId(tk[j + 1], 'function') && !tk[j + 1].nl);
                if (isFn) {
                    const name = curName && lastEq >= 0 && j - 1 === lastEq ? curName : null;
                    const r = parseFunction(j, node, name, limit);
                    if (r) { j = r.next; continue; }
                } else if (t.v === 'class') {
                    const cn = mk('class', j, node);
                    const next = parseClassInto(j, cn, false);
                    j = finish(cn, Math.max(next, j + 1));
                    continue;
                }
            }
            j++;
        }
        return j;
    }

    parseList(0, n, root);

    function tokenIndexAt(off) {
        let lo = 0, hi = n;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (tk[mid].e > off) hi = mid; else lo = mid + 1; }
        return lo;
    }
    function deepest(s, e) {
        let node = root;
        for (;;) {
            let nx = null;
            for (const c of node.children) if (c.start <= s && e <= c.end) { nx = c; break; }
            if (!nx) return node;
            node = nx;
        }
    }
    function strictContainer(P) {
        let node = root;
        for (;;) {
            let nx = null;
            for (const c of node.children) if (c.start < P && P < c.end) { nx = c; break; }
            if (!nx) return node;
            node = nx;
        }
    }
    return { lang: 'js', code, flavor, tk, match, outer, comments, lines, root, funcs, classes, nodeByTok, tokenIndexAt, deepest, strictContainer };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Placement in JavaScript / TypeScript

function chainStart(an, ti) {
    const { tk, match } = an;
    let s = ti;
    for (let guard = 0; guard < 50; guard++) {
        const dot = tk[s - 1];
        if (!isP(dot, '.') && !isP(dot, '?.')) break;
        let p = s - 2;
        while (isP(tk[p], ']') && match[p] > 0) p = match[p] - 1;
        if (p >= 0 && isId(tk[p]) && !NOT_CHAIN.has(tk[p].v)) { s = p; continue; }
        break;
    }
    return s;
}

const OBJ_AFTER_P = new Set(['=', '(', ',', ':', '[', '?', '&&', '||', '??', '|', '&', '!', '...', '{', '+']);
const OBJ_AFTER_ID = new Set(['return', 'default', 'case', 'yield', 'await', 'typeof', 'in', 'of', 'throw']);
function isObjectBrace(tk, open) {
    const p = tk[open - 1];
    if (!p) return false;
    if (p.t === 'p') return OBJ_AFTER_P.has(p.v);
    return p.t === 'id' && OBJ_AFTER_ID.has(p.v);
}

function enclosingJs(an, off) {
    let cls = null, fn = null;
    for (const c of an.classes) if (c.name && c.start <= off && off < c.end && (!cls || c.start >= cls.start)) cls = c;
    for (const f of an.funcs) if (f.name && f.start <= off && off < f.end && (!fn || f.start >= fn.start)) fn = f;
    return { cls: cls ? cls.name : '', fn: fn ? fn.name : '' };
}

/** The names that a parameter list binds (plain, default, rest, destructuring, renamed, TypeScript parameter properties). */
function boundNames(an, s, e) {
    const { tk, match } = an;
    const names = new Set();
    const splitTop = (a, b) => {
        const parts = [];
        let from = a;
        for (let k = a; k < b; k++) {
            const t = tk[k];
            if (isP(t) && (t.v === '(' || t.v === '[' || t.v === '{') && match[k] > k) { k = match[k]; continue; }
            if (isP(t, ',')) { parts.push([from, k]); from = k + 1; }
        }
        if (from < b) parts.push([from, b]);
        return parts;
    };
    const pattern = (a, b) => {
        while (a < b && isP(tk[a], '@')) a++;
        while (a < b && isId(tk[a]) && ['public', 'private', 'protected', 'readonly', 'override'].includes(tk[a].v) && a + 1 < b) a++;
        if (isP(tk[a], '...')) a++;
        if (a >= b) return;
        const t = tk[a];
        if (isId(t)) { names.add(t.v); return; }
        if ((isP(t, '{') || isP(t, '[')) && match[a] > a) {
            const inner = [a + 1, Math.min(match[a], b)];
            for (const [x, y] of splitTop(inner[0], inner[1])) {
                if (isP(t, '{')) {
                    let c = x;
                    if (isP(tk[c], '...')) c++;
                    let colon = -1;
                    for (let k = c; k < y; k++) { if (isP(tk[k]) && (tk[k].v === '(' || tk[k].v === '[' || tk[k].v === '{') && match[k] > k) { k = match[k]; continue; } if (isP(tk[k], ':')) { colon = k; break; } if (isP(tk[k], '=')) break; }
                    if (colon >= 0) pattern(colon + 1, y); else pattern(c, y);
                } else pattern(x, y);
            }
        }
    };
    for (const [a, b] of splitTop(s, e)) pattern(a, b);
    return names;
}

function simpleValue(an, from, to) {
    const { tk } = an;
    if (from >= to) return null;
    if (to - from === 1 && (tk[from].t === 'num' || tk[from].t === 'str')) return an.code.slice(tk[from].s, tk[from].e);
    let depth = 0;
    for (let k = from; k < to; k++) {
        const t = tk[k];
        if (t.t === 'id') { if (NOT_CHAIN.has(t.v) || ['function', 'class', 'async', 'super'].includes(t.v)) return null; continue; }
        if (isP(t, '.') || isP(t, '?.')) continue;
        if (isP(t, '[')) { depth++; continue; }
        if (isP(t, ']')) { depth--; continue; }
        if (depth > 0 && (t.t === 'num' || t.t === 'str')) continue;
        return null;
    }
    return an.code.slice(tk[from].s, tk[to - 1].e).replace(/\s*[\r\n]+\s*/g, '');
}

function declRegions(an, S) {
    const { tk, match } = an;
    const out = [];
    let j = S.tokStart;
    while (j < S.tokEnd && !(isId(tk[j]) && (tk[j].v === 'const' || tk[j].v === 'let' || tk[j].v === 'var'))) j++;
    j++;
    while (j < S.tokEnd) {
        const a = j;
        let k = j;
        while (k < S.tokEnd) {
            const t = tk[k];
            if (isP(t)) {
                if ((t.v === '(' || t.v === '[' || t.v === '{') && match[k] > k) { k = match[k] + 1; continue; }
                if (t.v === '=' || t.v === ',' || t.v === ';') break;
            }
            k++;
        }
        if (k > a) out.push({ s: tk[a].s, e: tk[k - 1].e });
        if (isP(tk[k], '=')) {
            k++;
            while (k < S.tokEnd) {
                const t = tk[k];
                if (isP(t) && (t.v === '(' || t.v === '[' || t.v === '{') && match[k] > k) { k = match[k] + 1; continue; }
                if (isP(t, ',') || isP(t, ';')) break;
                k++;
            }
        }
        j = k + 1;
    }
    return out;
}

function assignLhs(an, S) {
    const { tk, match } = an;
    let k = S.tokStart;
    while (k < S.tokEnd) {
        const t = tk[k];
        if (isP(t) && (t.v === '(' || t.v === '[' || t.v === '{') && match[k] > k) { k = match[k] + 1; continue; }
        if (isP(t)) {
            if (ASSIGN_OPS.has(t.v)) return k > S.tokStart ? { s: tk[S.tokStart].s, e: tk[k - 1].e } : null;
            if (t.v === '=>' || t.v === ';' || t.v === '?') return null;
        }
        k++;
    }
    return null;
}

function enclosingBody(X) {
    for (let A = X.parent; A; A = A.parent) for (const b of A.bodies) if (b.open < X.start && X.end <= b.close) return b;
    return null;
}
const isListPos = (an, T, P) => T === an.root || T.bodies.some((b) => b.open < P && P <= b.close);

function blockStartTarget(env, open, close) {
    const { an } = env, { tk, lines } = an;
    const braceLine = lines.lineOf(open);
    const nt = tk[an.tokenIndexAt(open) + 1];
    const outerIndent = lines.indent(braceLine);
    if (!nt || nt.s > close) return null;
    if (nt.s === close) {
        if (lines.lineOf(close) === braceLine) return { type: 'splitOpen', key: 'open:' + open, open, close, outerIndent };
        return { type: 'line', line: braceLine + 1, anchorLine: braceLine, indentOverride: outerIndent + env.unit };
    }
    if (lines.lineOf(nt.s) === braceLine) return { type: 'splitOpen', key: 'open:' + open, open, close, outerIndent };
    return { type: 'line', line: braceLine + 1, anchorLine: braceLine, indentOverride: lines.indent(lines.lineOf(nt.s)) || outerIndent + env.unit };
}
function blockEndTarget(env, body, X) {
    const lines = env.an.lines;
    const openLine = lines.lineOf(body.open), closeLine = lines.lineOf(body.close);
    const outerIndent = lines.indent(openLine);
    const bodyIndent = openLine === closeLine ? outerIndent + env.unit : lines.indent(X.startLine) || outerIndent + env.unit;
    return { type: 'blockEnd', key: 'end:' + body.close, close: body.close, bodyIndent, outerIndent };
}

function beforeTarget(env, S) {
    const { an } = env, { lines } = an;
    let X = S;
    for (let guard = 0; guard < 60; guard++) {
        const body = enclosingBody(X);
        const line = X.startLine;
        if (body && lines.lineOf(body.open) === line && body.open < X.start) {
            const t = blockStartTarget(env, body.open, body.close);
            if (t) return t;
        }
        const P = lines.start(line);
        const T = an.strictContainer(P);
        if (T !== an.root && !isListPos(an, T, P)) { X = T; continue; }
        return { type: 'line', line, anchorLine: X.startLine };
    }
    return { type: 'line', line: S.startLine, anchorLine: S.startLine };
}
function afterTarget(env, S) {
    const { an } = env, { lines } = an;
    let X = S;
    for (let guard = 0; guard < 60; guard++) {
        if (X.kind === 'case' && X.parent) {
            const sibs = X.parent.children;
            for (let k = sibs.indexOf(X) + 1; k < sibs.length && sibs[k].startLine === X.endLine && sibs[k].kind !== 'case'; k++) {
                if (sibs[k].endLine > X.endLine || sibs[k].end > X.end) X = Object.assign({}, X, { end: sibs[k].end, endLine: sibs[k].endLine });
            }
        }
        const body = enclosingBody(X);
        if (body && lines.lineOf(body.close) === X.endLine && body.close >= X.end) return blockEndTarget(env, body, X);
        const line = X.endLine + 1;
        const P = line < lines.count ? lines.starts[line] : env.text.length;
        const T = P < env.text.length ? an.strictContainer(P) : an.root;
        if (T !== an.root && !isListPos(an, T, P)) { X = T; continue; }
        let A = X;
        while (A.braceless && A.parent && A.parent !== an.root) A = A.parent;
        return { type: 'line', line, anchorLine: A.startLine };
    }
    return { type: 'line', line: S.endLine + 1, anchorLine: S.startLine };
}
function firstBodyTarget(env, S) {
    const b = S.bodyNode;
    if (b && b.kind === 'block' && b.bodyOpen >= 0) { const t = blockStartTarget(env, b.bodyOpen, b.bodyClose); if (t) return t; }
    return afterTarget(env, S);
}

function placeJs(env, sel) {
    const an = env.an, { tk, lines } = an;
    const off = sel.start, end = sel.end;
    let expr = sel.text;
    const ti = an.tokenIndexAt(off);
    const tkn = tk[ti];
    const exact = tkn && tkn.s === off && tkn.e === end;
    if (exact && tkn.t === 'id') {
        const s0 = chainStart(an, ti);
        if (s0 !== ti) expr = an.code.slice(tk[s0].s, tkn.e).replace(/\s*[\r\n]+\s*/g, '');
    }
    const { cls, fn } = enclosingJs(an, off);
    const done = (target, e) => ({ target, expr: e || expr, cls, fn });
    const selLine = lines.lineOf(off);
    const fallback = () => done({ type: 'line', line: selLine + 1, anchorLine: selLine });

    // 1. a parameter: the first line of the body
    let pf = null;
    for (const f of an.funcs) {
        const inParams = f.paramsOpen >= 0 ? f.paramsOpen < off && end <= f.paramsClose : !!f.single && f.single.s <= off && end <= f.single.e;
        if (inParams && (!pf || f.start >= pf.start)) pf = f;
    }
    if (pf && pf.bodyKind === 'block' && pf.bodyClose > pf.bodyOpen) {
        const t = blockStartTarget(env, pf.bodyOpen, pf.bodyClose);
        if (t) return done(t);
    }
    if (pf && pf.bodyKind === 'expr') return done({ type: 'arrow', key: 'arrow:' + pf.arrowEnd, fn: pf });
    // the parameter of a concise arrow, used in its body
    const rootName = /^[A-Za-z_$][\w$]*/.exec(expr);
    if (rootName) {
        const arrows = an.funcs.filter((f) => f.bodyKind === 'expr' && f.exprStart <= off && end <= f.exprEnd).sort((a, b) => b.start - a.start);
        for (const f of arrows) if (boundNames(an, f.ptS, f.ptE).has(rootName[0])) return done({ type: 'arrow', key: 'arrow:' + f.arrowEnd, fn: f });
    }

    const S = an.deepest(off, end);
    const inHead = !!S.head && S.head.open < off && end <= S.head.close;
    const inBody = S.bodies.some((b) => b.open < off && end <= b.close);       // between the statements of a body (a comment, an empty line)
    if (S === an.root || inBody || (['block', 'try', 'finally', 'catch', 'switch'].includes(S.kind) && !inHead)) return fallback();

    // 2. a class member: no statement can stand there, the constructor is the place
    if (S.inClass) {
        const cn = S.parent;
        if (S.kind !== 'field' || S.isStatic) return { reason: 'a log line cannot be put in a class body here' };
        const ctor = cn.children.find((c) => c.kind === 'method' && c.isCtor && c.bodyOpen >= 0);
        if (!ctor) return { reason: 'a class field is set before the constructor body: the class has no constructor to log in' };
        const keySel = exact && tkn.t === 'id' && tkn.v === S.name;
        const e = keySel ? 'this.' + S.name : expr;
        const first = ctor.children[0];
        if (first && first.kind === 'expr' && isId(tk[first.tokStart], 'super') && isP(tk[first.tokStart + 1], '(')) return done(afterTarget(env, first), e);
        return done(blockStartTarget(env, ctor.bodyOpen, ctor.bodyClose) || { type: 'line', line: selLine + 1, anchorLine: selLine }, e);
    }

    // 3. the head of if / while / for / switch
    if (inHead && ['if', 'while', 'for', 'forin', 'forof', 'switch', 'with', 'do'].includes(S.kind)) {
        if (S.headBind && S.headBind.decl && S.headBind.s <= off && end <= S.headBind.e) return done(firstBodyTarget(env, S));
        if (S.kind === 'if' && S.elseIf) return done(firstBodyTarget(env, S));
        return done(beforeTarget(env, S));
    }

    // 4. a declaration or an assignment that binds the selection: after the whole statement
    const binds = (S.kind === 'decl' && declRegions(an, S).some((r) => r.s <= off && end <= r.e)) ||
        (S.kind === 'expr' && (() => { const r = assignLhs(an, S); return !!r && r.s <= off && end <= r.e; })());
    if (binds) return done(afterTarget(env, S));

    // 5. the key of an object literal: the path from the variable that holds the object (or the value, when nothing holds it)
    if (exact && (tkn.t === 'id' || tkn.t === 'str' || tkn.t === 'num') && isP(tk[ti + 1], ':') && (isP(tk[ti - 1], '{') || isP(tk[ti - 1], ','))) {
        const open0 = an.outer[ti];
        if (open0 >= 0 && isP(tk[open0], '{') && isObjectBrace(tk, open0)) {
            const keyText = (k) => { const t = tk[k]; const raw = an.code.slice(t.s, t.e); return t.t === 'id' ? '.' + raw : '[' + raw + ']'; };
            const parts = [keyText(ti)];
            let open = open0, rootKind = 'none', rootText = '';
            for (let guard = 0; guard < 30; guard++) {
                const prev = tk[open - 1];
                if (isP(prev, ':')) {
                    const k = open - 2, kt = tk[k];
                    if (kt && (kt.t === 'id' || kt.t === 'str' || kt.t === 'num') && (isP(tk[k - 1], '{') || isP(tk[k - 1], ','))) {
                        const o2 = an.outer[k];
                        if (o2 >= 0 && isP(tk[o2], '{') && isObjectBrace(tk, o2)) { parts.unshift(keyText(k)); open = o2; continue; }
                    }
                } else if (isP(prev, '=')) {
                    let r = open - 2;
                    if (isP(tk[r - 1], ':') && isId(tk[r - 2]) && S.kind === 'decl') r -= 2;
                    if (r >= 0 && isId(tk[r]) && !NOT_CHAIN.has(tk[r].v)) {
                        const s0 = chainStart(an, r);
                        const before = tk[s0 - 1];
                        rootKind = isId(before) && ['const', 'let', 'var'].includes(before.v) ? 'decl' : 'assign';
                        rootText = an.code.slice(tk[s0].s, tk[r].e).replace(/\s*[\r\n]+\s*/g, '');
                    }
                }
                break;
            }
            if (rootKind !== 'none' && (S.kind === 'decl' || S.kind === 'expr')) {
                let e = rootText + parts.join('');
                e = e.replace(/^(\w+)\[("[^"]*"|'[^']*')\]$/, '$1[$2]');
                return done(afterTarget(env, S), e);
            }
            // nothing holds the object: log its value, when that is only a path
            let vEnd = ti + 2;
            while (vEnd < match0(an, open0) && !(isP(tk[vEnd], ',') )) { if (isP(tk[vEnd]) && (tk[vEnd].v === '(' || tk[vEnd].v === '[' || tk[vEnd].v === '{') && an.match[vEnd] > vEnd) { vEnd = an.match[vEnd] + 1; continue; } vEnd++; }
            const v = simpleValue(an, ti + 2, vEnd);
            if (v === null) return { reason: 'the value of this key is not a plain path: select a variable instead' };
            return done(beforeTarget(env, S), v);
        }
    }

    // 6. return and throw: before
    if (S.kind === 'return' || S.kind === 'throw') return done(beforeTarget(env, S));

    // 7. any other use: a statement over several lines gets the log before it, a one-line statement after it
    if (S.endLine > S.startLine && S.kind !== 'case') return done(beforeTarget(env, S));
    return done(afterTarget(env, S));
}
const match0 = (an, open) => (an.match[open] >= 0 ? an.match[open] : an.tk.length);

// ---------------------------------------------------------------------------------------------------------------------------------
// Python

function tokenizePy(text) {
    const n = text.length;
    const tokens = [], comments = [];
    let i = 0, depth = 0, lb = true;
    const PY_PUNCT = ['**=', '//=', '>>=', '<<=', '...', '->', ':=', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '@=', '&=', '|=', '^=', '**', '//', '>>', '<<'];
    const push = (t, v, s, e) => { tokens.push({ t, v, s, e, lb }); lb = false; };
    const skipPyString = (q0, tripleOk) => {
        const q = text[q0];
        const triple = tripleOk && text.startsWith(q.repeat(3), q0);
        let j = q0 + (triple ? 3 : 1);
        while (j < n) {
            const c = text[j];
            if (c === '\\') { j += 2; continue; }
            if (triple) { if (text.startsWith(q.repeat(3), j)) return j + 3; j++; continue; }
            if (c === q) return j + 1;
            if (c === '\n' || c === '\r') return j;
            j++;
        }
        return n;
    };
    while (i < n) {
        const c = text[i];
        if (c === '\n' || c === '\r') { if (depth === 0) lb = true; i++; continue; }
        if (c === ' ' || c === '\t' || c === '\f') { i++; continue; }
        if (c === '\\' && (text[i + 1] === '\n' || text[i + 1] === '\r')) { i += text[i + 1] === '\r' && text[i + 2] === '\n' ? 3 : 2; continue; }
        if (c === '#') { const s = i; while (i < n && text[i] !== '\n' && text[i] !== '\r') i++; comments.push({ s, e: i }); continue; }
        if (c === '"' || c === "'") { const e = skipPyString(i, true); push('str', '', i, e); i = e; continue; }
        if (/[\p{L}_]/u.test(c)) {
            let j = i + 1;
            while (j < n && /[\p{L}\p{N}_]/u.test(text[j])) j++;
            const w = text.slice(i, j);
            if ((text[j] === '"' || text[j] === "'") && /^(?:[rRbBuUfF]|[rR][bBfF]|[bBfF][rR])$/.test(w)) { const e = skipPyString(j, true); push('str', '', i, e); i = e; continue; }
            push('id', w, i, j); i = j;
            continue;
        }
        if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] || ''))) {
            const m = /^(?:0[xXbBoO][\da-fA-F_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?[jJ]?)/.exec(text.slice(i, i + 60));
            const len = m ? m[0].length : 1;
            push('num', '', i, i + len); i += len;
            continue;
        }
        let p = null;
        for (const q of PY_PUNCT) if (text.startsWith(q, i)) { p = q; break; }
        if (!p) p = c;
        if (p === '(' || p === '[' || p === '{') depth++;
        else if ((p === ')' || p === ']' || p === '}') && depth > 0) depth--;
        push('p', p, i, i + p.length); i += p.length;
    }
    return { tokens, comments };
}

const PY_COMPOUND = new Set(['if', 'elif', 'else', 'for', 'while', 'try', 'except', 'finally', 'with', 'def', 'class', 'match', 'case']);
function pyWidth(ws) {
    let w = 0;
    for (const c of ws) w = c === '\t' ? (Math.floor(w / 8) + 1) * 8 : w + 1;
    return w;
}
const isLoneString = (tk, l) => { for (let i = l.a; i < l.b; i++) if (tk[i].t !== 'str') return false; return true; };

function analyzePy(text, lines) {
    const { tokens: tk, comments } = tokenizePy(text);
    const { match, outer } = bracketMaps(tk);
    const L = [];
    for (let i = 0; i < tk.length; i++) {
        if (tk[i].lb || !L.length) L.push({ a: i, b: i + 1 }); else L[L.length - 1].b = i + 1;
    }
    for (const l of L) {
        l.s = tk[l.a].s; l.e = tk[l.b - 1].e;
        l.startLine = lines.lineOf(l.s); l.endLine = lines.lineOf(Math.max(l.e - 1, l.s));
        const pre = text.slice(lines.start(l.startLine), l.s);
        l.indent = /^[ \t]*$/.test(pre) ? pre : /^[ \t]*/.exec(pre)[0];
        l.width = pyWidth(l.indent);
        let a = l.a;
        const f = tk[a];
        l.kw = isP(f, '@') ? '@' : isId(f) ? f.v : '';
        if (l.kw === 'async' && isId(tk[a + 1]) && ['def', 'for', 'with'].includes(tk[a + 1].v)) { l.kw = tk[a + 1].v; a++; }
        l.colon = -1;
        if (PY_COMPOUND.has(l.kw)) {
            let depth = 0, lam = 0;
            for (let i = a; i < l.b; i++) {
                const t = tk[i];
                if (isP(t)) {
                    if (t.v === '(' || t.v === '[' || t.v === '{') depth++;
                    else if (t.v === ')' || t.v === ']' || t.v === '}') depth--;
                    else if (t.v === ':' && depth === 0) { if (lam > 0) { lam--; continue; } l.colon = i; break; }
                } else if (isId(t, 'lambda') && depth === 0) lam++;
            }
            if ((l.kw === 'match' || l.kw === 'case') && l.colon !== l.b - 1) l.colon = -1;
        }
        l.compound = l.colon >= 0;
        l.inline = l.compound && l.colon < l.b - 1;
    }
    const blockEndLine = (i) => {
        let j = i + 1;
        while (j < L.length && L[j].width > L[i].width) j++;
        return j > i + 1 ? L[j - 1].endLine : L[i].endLine;
    };
    const defs = [];
    for (let i = 0; i < L.length; i++) {
        const l = L[i];
        if ((l.kw === 'def' || l.kw === 'class') && l.compound) {
            const nameTok = tk[l.a + (isId(tk[l.a], 'async') ? 2 : 1)];
            if (isId(nameTok)) defs.push({ kind: l.kw, name: nameTok.v, startLine: l.startLine, endLine: blockEndLine(i), width: l.width });
        }
    }
    return { lang: 'py', tk, match, outer, comments, lines, L, blockEndLine, defs,
        logicalAt(off) { let lo = 0, hi = L.length - 1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (L[mid].e <= off) lo = mid + 1; else if (L[mid].s > off) hi = mid - 1; else return mid; } return -1; },
        logicalAtLine(line) { return L.findIndex((l) => l.startLine <= line && line <= l.endLine); },
        tokenIndexAt(off) { let lo = 0, hi = tk.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (tk[mid].e > off) hi = mid; else lo = mid + 1; } return lo; } };
}

function placePy(env, sel) {
    const an = env.an, { tk, L, lines } = an;
    const off = sel.start, end = sel.end;
    let expr = sel.text;
    const ti = an.tokenIndexAt(off);
    const tkn = tk[ti];
    if (tkn && tkn.t === 'id' && tkn.s === off && tkn.e === end) {
        const s0 = chainStart(an, ti);
        if (s0 !== ti) expr = env.text.slice(tk[s0].s, tkn.e).replace(/\s*[\r\n]+\s*/g, '');
    }
    const selLine = lines.lineOf(off);
    let cls = null, fn = null;
    for (const d of an.defs) {
        if (d.startLine > selLine || selLine > d.endLine) continue;
        if (d.kind === 'class' && (!cls || d.width >= cls.width)) cls = d;
        if (d.kind === 'def' && (!fn || d.width >= fn.width)) fn = d;
    }
    const done = (target) => ({ target, expr, cls: cls ? cls.name : '', fn: fn ? fn.name : '' });
    const idx = an.logicalAt(off) >= 0 ? an.logicalAt(off) : an.logicalAtLine(selLine);
    if (idx < 0) return done({ type: 'line', line: selLine + 1, anchorLine: selLine });
    const S = L[idx];
    const before = () => done({ type: 'line', line: S.startLine, anchorLine: S.startLine });
    const after = () => done({ type: 'line', line: S.endLine + 1, anchorLine: S.startLine });
    const afterBlock = () => done({ type: 'line', line: an.blockEndLine(idx) + 1, anchorLine: S.startLine });
    const firstBody = (docstring) => {
        if (S.inline) {
            const ce = tk[S.colon].e;
            return done({ type: 'pySplit', key: 'py:' + ce, colonEnd: ce, bodyIndent: S.indent + env.unit });
        }
        const F = L[idx + 1];
        if (!F || F.width <= S.width) return after();
        let line = S.endLine + 1, indent = F.indent;
        if (docstring && isLoneString(tk, F)) {
            line = F.endLine + 1;
            const G = L[idx + 2];
            if (G && G.width > S.width) indent = G.indent;
        }
        return done({ type: 'line', line, anchorLine: F.startLine, indentOverride: indent });
    };
    if (S.kw === '@') {
        let j = idx;
        while (j > 0 && L[j - 1].kw === '@' && L[j - 1].width === S.width) j--;
        return done({ type: 'line', line: L[j].startLine, anchorLine: L[j].startLine });
    }
    if (S.compound) {
        if (off >= tk[S.colon].s) return after();
        const kwTok = isId(tk[S.a], 'async') ? S.a + 1 : S.a;
        switch (S.kw) {
            case 'def': {
                let po = kwTok + 2;
                while (po < S.colon && !isP(tk[po], '(')) po++;
                if (isP(tk[po], '(') && match1(an, po) > po && off > tk[po].s && end <= tk[match1(an, po)].s) return firstBody(true);
                return afterBlock();
            }
            case 'class': return afterBlock();
            case 'for': {
                let inTok = -1, depth = 0;
                for (let k = kwTok + 1; k < S.colon; k++) {
                    if (isP(tk[k]) && '([{'.includes(tk[k].v)) depth++; else if (isP(tk[k]) && ')]}'.includes(tk[k].v)) depth--;
                    else if (depth === 0 && isId(tk[k], 'in')) { inTok = k; break; }
                }
                return inTok >= 0 && off < tk[inTok].s ? firstBody(false) : before();
            }
            case 'with': {
                let asTok = -1;
                for (let k = kwTok + 1; k < S.colon; k++) if (isId(tk[k], 'as') && tk[k].s < off) asTok = k;
                if (asTok >= 0) {
                    let stop = S.colon;
                    for (let k = asTok; k < S.colon; k++) if (isP(tk[k], ',') && outer1(an, k) === outer1(an, asTok)) { stop = k; break; }
                    if (off < tk[stop].s) return firstBody(false);
                }
                return before();
            }
            case 'if': case 'while': return tk.slice(S.a, S.colon).some((t) => isP(t, ':=')) ? firstBody(false) : before();
            case 'match': return before();
            default: return firstBody(false);       // elif, else, try, finally, except, case
        }
    }
    if (S.kw === 'return' || S.kw === 'raise') return before();
    return after();
}
const match1 = (an, i) => an.match[i];
const outer1 = (an, i) => an.outer[i];

// ---------------------------------------------------------------------------------------------------------------------------------
// The log statement

function pickJsQuote(configured, expr) {
    const t = expr.trim();
    if (t.startsWith('{')) return '`';
    if (t.includes('"')) return '`';
    if (t.includes("'")) return '"';
    return configured;
}
function pickPyQuote(configured, msg) {
    const d = msg.includes('"'), s = msg.includes("'");
    if (d && !s) return "'";
    if (s && !d) return '"';
    return configured === "'" ? "'" : '"';
}
function escapeFor(msg, q) {
    let s = msg.replace(/\\/g, '\\\\').split(q).join('\\' + q);
    if (q === '`') s = s.replace(/\$\{/g, '\\${');
    return s;
}
const oneLine = (s) => s.replace(/\s*[\r\n]+\s*/g, ' ');

function buildMessage(env, log, n) {
    const { opt } = env;
    const pad = ` ${opt.delimiterInsideMessage} `;
    let msg = '';
    if (opt.logMessagePrefix) msg += opt.logMessagePrefix + pad;
    if (opt.includeFilename || opt.includeLineNum) {
        const f = opt.includeFilename && env.base ? env.base : '';
        const l = opt.includeLineNum ? ':' + n : '';
        if (f || l) msg += f + l + pad;
    }
    if (log.cls && opt.insertEnclosingClass && log.cls !== log.expr) msg += log.cls + pad;
    if (log.fn && opt.insertEnclosingFunction && log.fn !== log.expr) msg += log.fn + pad;
    return msg + oneLine(log.expr) + opt.logMessageSuffix;
}
function separatorText(env, message) {
    const { opt } = env;
    const pad = ` ${opt.delimiterInsideMessage} `;
    const lead = opt.logMessagePrefix ? opt.logMessagePrefix + pad : (opt.delimiterInsideMessage ? opt.delimiterInsideMessage + ' ' : '');
    const trail = opt.logMessagePrefix;
    const w = Math.min(120, Math.max(3, message.length - lead.length - trail.length));
    return lead + '-'.repeat(w) + trail;
}
function pyFunctionFor(env) {
    const { kind, opt } = env;
    if (kind === 'info') return 'logging.info';
    if (kind === 'debug') return 'logging.debug';
    if (kind === 'warn') return 'logging.warning';
    if (kind === 'error') return 'logging.error';
    if (kind === 'custom' && opt.logFunction !== 'log') return opt.logFunction;
    return 'print';
}
function buildStatements(env, log, n) {
    const { opt, kind } = env;
    const message = buildMessage(env, log, n);
    let main, sep;
    if (env.lang === 'py') {
        const fn = pyFunctionFor(env);
        const logging = fn.startsWith('logging.');
        const fmt = (x) => (logging ? x.replace(/%/g, '%%') : x);
        const text = fmt(message) + (logging ? ' %s' : '');
        const q = pickPyQuote(opt.quote, text);
        main = `${fn}(${q}${escapeFor(text, q)}${q}, ${log.expr})`;
        if (opt.wrapLogMessage) { const st = fmt(separatorText(env, message)); const q2 = pickPyQuote(opt.quote, st); sep = `${fn}(${q2}${escapeFor(st, q2)}${q2})`; }
    } else {
        const semi = opt.addSemicolonInTheEnd ? ';' : '';
        const fn = kind === 'custom' ? opt.logFunction : 'console.' + kind;
        if (kind === 'table') main = `console.table(${log.expr})${semi} // ${message}`;
        else { const q = pickJsQuote(opt.quote, log.expr); main = `${fn}(${q}${escapeFor(message, q)}${q}, ${log.expr})${semi}`; }
        if (opt.wrapLogMessage) {
            const fn2 = kind === 'custom' ? opt.logFunction : kind === 'table' ? 'console.log' : fn;
            const st = separatorText(env, message);
            const q2 = pickJsQuote(opt.quote, st);
            sep = `${fn2}(${q2}${escapeFor(st, q2)}${q2})${semi}`;
        }
    }
    return opt.wrapLogMessage ? [sep, main, sep] : [main];
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Insert

function resolveSelection(text, sel, lines, lang) {
    const len = text.length;
    let s = sel.selectionStart, e = sel.selectionEnd;
    if (!Number.isInteger(s)) {
        const ln = Math.min(Math.max(sel.line | 0, 0), lines.count - 1);
        s = Math.min(lines.start(ln) + (sel.character | 0), lines.end(ln));
        e = s;
    }
    if (!Number.isInteger(e)) e = s;
    if (e < s) { const t = s; s = e; e = t; }
    s = Math.min(Math.max(s, 0), len); e = Math.min(Math.max(e, 0), len);
    if (s === e) {
        const word = lang === 'py' ? /[\p{L}\p{N}_]/u : /[\p{L}\p{N}_$]/u;
        let a = s, b = s;
        while (a > 0 && word.test(text[a - 1])) a--;
        while (b < len && word.test(text[b])) b++;
        if (a === b) return null;
        s = a; e = b;
    } else {
        while (s < e && /\s/.test(text[s])) s++;
        while (e > s && /\s/.test(text[e - 1])) e--;
        if (s === e) return null;
    }
    return { start: s, end: e, text: text.slice(s, e) };
}

function chooseIndent(env, t) {
    if (t.indentOverride !== undefined) return t.indentOverride;
    const a = env.lines.indent(t.anchorLine);
    const b = env.lines.indent(t.line);
    return b.length >= a.length ? b : a;
}

function pyLoggingImportItem(env) {
    const { an, text, lines, eol } = env;
    const { L, tk } = an;
    for (const l of L) if (l.kw === 'import' && /^import\s+(?:[\w.]+(?:\s+as\s+\w+)?\s*,\s*)*logging(?:\.\w+)*(?!\w)(?!\s+as\b)/.test(text.slice(l.s, l.e))) return null;
    let firstImport = -1, lastFuture = -1;
    for (let i = 0; i < L.length; i++) {
        const l = L[i];
        if (l.width !== 0) continue;
        if (l.kw === 'from' && isId(tk[l.a + 1], '__future__')) { lastFuture = i; continue; }
        if (l.kw === 'import' || l.kw === 'from') { firstImport = i; break; }
    }
    const blankAt = (line) => line >= lines.count || text.slice(lines.start(line), lines.end(line)).trim() === '';
    if (firstImport >= 0) return { offset: lines.start(L[firstImport].startLine), deleteLength: 0, text: 'import logging' + eol };
    let after = -1;
    if (L[0] && L[0].width === 0 && isLoneString(tk, L[0])) after = 0;
    if (lastFuture > after) after = lastFuture;
    if (after >= 0) {
        const line = L[after].endLine + 1;
        if (line >= lines.count) return { offset: text.length, deleteLength: 0, text: eol + eol + 'import logging' };
        return { offset: lines.start(line), deleteLength: 0, text: eol + 'import logging' + eol + (blankAt(line) ? '' : eol) };
    }
    if (L[0]) return { offset: lines.start(L[0].startLine), deleteLength: 0, text: 'import logging' + eol + eol };
    return { offset: text.length, deleteLength: 0, text: (text.length && !/[\r\n]$/.test(text) ? eol : '') + 'import logging' + eol };
}

/** All the plans become edits. Several logs for the same spot are merged; line numbers inside the messages count the lines that earlier edits add. */
function buildItems(env, plans, extraItems) {
    const { text, lines, eol, opt, an } = env;
    const items = [];
    const groups = new Map();
    let order = 0;
    const wrapN = opt.wrapLogMessage ? 1 : 0;
    const bb = opt.insertEmptyLineBeforeLogMessage, ba = opt.insertEmptyLineAfterLogMessage;
    const wsRunAfter = (off) => { let e = off; while (e < text.length && (text[e] === ' ' || text[e] === '\t')) e++; return e - off; };
    const wsRunBefore = (off) => { let b = off; while (b > 0 && (text[b - 1] === ' ' || text[b - 1] === '\t')) b--; return off - b; };
    for (const it of extraItems) items.push(Object.assign({ order: -1, k: 0, build: () => it.text }, it));
    for (const plan of plans) {
        const t = plan.target, log = plan.log;
        if (t.type === 'line') {
            const atEof = t.line >= lines.count;
            const offset = atEof ? text.length : lines.starts[t.line];
            const indent = chooseIndent(env, t);
            items.push({ offset, deleteLength: 0, order: order++, k: (atEof ? 1 : 0) + (bb ? 1 : 0) + wrapN, logs: [log], build: (n) => {
                const stmts = log.stmts(n);
                if (atEof) return eol + (bb ? eol : '') + stmts.map((s) => indent + s).join(eol);
                return (bb ? eol : '') + stmts.map((s) => indent + s + eol).join('') + (ba ? eol : '');
            } });
            continue;
        }
        let g = groups.get(t.key);
        if (g) { g.logs.push(log); continue; }
        const logsOf = (list, n, fmt) => { let run = 0; return list.map((l) => { const st = l.stmts(n + run); run += st.length; return fmt(st); }).join(''); };
        if (t.type === 'splitOpen') {
            g = { logs: [log] };
            const wsLen = wsRunAfter(t.open + 1);
            const bodyIndent = t.outerIndent + env.unit;
            const closeSame = lines.lineOf(t.open) === lines.lineOf(t.close);
            const emptyInner = closeSame && text.slice(t.open + 1, t.close).trim() === '';
            if (emptyInner) {
                items.push({ offset: t.open + 1, deleteLength: t.close - t.open - 1, order: order++, k: 1 + wrapN, logs: g.logs, build: (n) => eol + logsOf(g.logs, n, (st) => st.map((s) => bodyIndent + s + eol).join('')) + t.outerIndent });
            } else {
                items.push({ offset: t.open + 1, deleteLength: wsLen, order: order++, k: 1 + wrapN, logs: g.logs, build: (n) => eol + logsOf(g.logs, n, (st) => st.map((s) => bodyIndent + s + eol).join('')) + bodyIndent });
                if (closeSame) { const b = wsRunBefore(t.close); items.push({ offset: t.close - b, deleteLength: b, order: order++, k: 0, build: () => eol + t.outerIndent }); }
            }
        } else if (t.type === 'blockEnd') {
            g = { logs: [log] };
            const b = wsRunBefore(t.close);
            items.push({ offset: t.close - b, deleteLength: b, order: order++, k: 1 + wrapN, logs: g.logs, build: (n) => eol + logsOf(g.logs, n, (st) => st.map((s) => t.bodyIndent + s + eol).join('')) + t.outerIndent });
        } else if (t.type === 'pySplit') {
            g = { logs: [log] };
            const wsLen = wsRunAfter(t.colonEnd);
            items.push({ offset: t.colonEnd, deleteLength: wsLen, order: order++, k: 1 + wrapN, logs: g.logs, build: (n) => eol + logsOf(g.logs, n, (st) => st.map((s) => t.bodyIndent + s + eol).join('')) + t.bodyIndent });
        } else if (t.type === 'arrow') {
            g = { logs: [log] };
            const f = t.fn;
            const arrowLine = lines.lineOf(f.arrowEnd - 1);
            const outerIndent = lines.indent(arrowLine);
            const bodyIndent = outerIndent + env.unit;
            const gap = text.slice(f.arrowEnd, f.exprStart);
            const clean = gap.trim() === '';
            const from = clean ? f.arrowEnd : f.exprStart;
            const exprText = text.slice(f.exprStart, f.exprEnd);
            const owner = f.owner;
            const semi = opt.addSemicolonInTheEnd || (owner && owner.end > 0 && text[owner.end - 1] === ';') ? ';' : '';
            items.push({ offset: from, deleteLength: f.exprEnd - from, order: order++, k: 1 + wrapN, logs: g.logs, build: (n) =>
                (clean ? ' ' : '') + '{' + eol + logsOf(g.logs, n, (st) => st.map((s) => bodyIndent + s + eol).join('')) + bodyIndent + 'return ' + exprText + semi + eol + outerIndent + '}' });
        }
        groups.set(t.key, g);
    }
    for (const it of items) if (!it.logs) it.logs = [];
    items.sort((a, b) => a.offset - b.offset || a.order - b.order);
    let shift = 0;
    for (const it of items) {
        const line0 = lines.lineOf(it.offset);
        const n = line0 + shift + (it.k || 0) + 1;
        it.text = it.build(n);
        let run = 0;
        for (const l of it.logs) { l.finalLine = line0 + shift + (it.k || 0) + run; run += l.stmts(0).length; }
        shift += countEol(it.text) - countEol(text.slice(it.offset, it.offset + it.deleteLength));
    }
    // merge inserts at the same offset, refuse overlaps
    const edits = [];
    for (const it of items) {
        const last = edits[edits.length - 1];
        if (last && it.offset < last.offset + last.deleteLength) return null;
        if (last && last.offset === it.offset && last.deleteLength === 0 && it.deleteLength === 0) last.text += it.text;
        else edits.push({ offset: it.offset, deleteLength: it.deleteLength, text: it.text });
    }
    return edits;
}

/**
 * Put a log for the selection(s).
 * @param {string} text the whole document
 * @param {object|object[]} selections { selectionStart, selectionEnd } (offsets) or { line, character } (0-based), plus languageId and fileName
 *   (taken from the first one). An empty selection takes the word under the cursor.
 * @param {object} options the settings (see defaultOptions); tabSize/insertSpaces of the editor are optional
 * @param {string} kind log | info | debug | table | warn | error | custom
 * @returns {{edits: {offset: number, deleteLength: number, text: string}[], variable?: string, insertedLine?: number, inserts?: object[], reason?: string}}
 */
function insertLog(text, selections, options, kind) {
    text = String(text);
    const opt = normalizeOptions(options);
    kind = KINDS.includes(kind) ? kind : 'log';
    const list = (Array.isArray(selections) ? selections : [selections]).filter(Boolean);
    const first = list[0];
    if (!first) return { edits: [], reason: 'nothing is selected' };
    const lang = detectLanguage(first.languageId, first.fileName);
    if (!lang) return { edits: [], reason: 'log messages are made for JavaScript, TypeScript, Vue, Svelte, Astro, HTML and Python files' };
    const lines = buildLines(text);
    let an, view = null;
    if (lang === 'py') an = analyzePy(text, lines);
    else { view = scriptView(text, jsFlavor(first.languageId, first.fileName)); an = analyzeJs(view.code, jsFlavor(first.languageId, first.fileName), lines); }
    const env = { text, lines, eol: detectEol(text), opt, kind, lang, an, unit: indentUnit(text, opt), base: basename(first.fileName) };
    const plans = [], reasons = [], seen = new Set();
    for (const s of list) {
        const sel = resolveSelection(text, s, lines, lang);
        if (!sel) { reasons.push('select a variable, or put the cursor in it'); continue; }
        if (view && !view.inScript(sel.start)) { reasons.push('the cursor is not in a script block'); continue; }
        const p = lang === 'py' ? placePy(env, sel) : placeJs(env, sel);
        if (p.reason) { reasons.push(p.reason); continue; }
        const key = [p.target.key || p.target.type + ':' + p.target.line, p.expr].join(' ');
        if (seen.has(key)) continue;
        seen.add(key);
        p.log = { expr: p.expr, cls: p.cls, fn: p.fn, finalLine: -1, stmts(n) { return buildStatements(env, this, n); } };
        plans.push(p);
    }
    if (!plans.length) return { edits: [], reason: reasons[0] || 'nothing to log' };
    const extra = [];
    if (lang === 'py' && ['info', 'debug', 'warn', 'error'].includes(kind)) { const imp = pyLoggingImportItem(env); if (imp) extra.push(imp); }
    const edits = buildItems(env, plans, extra);
    if (!edits) return { edits: [], reason: 'the selections ask for overlapping changes' };
    return { edits, variable: plans[0].expr, insertedLine: plans[0].log.finalLine,
        inserts: plans.map((p) => ({ variable: p.expr, line: p.log.finalLine })) };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Find, comment, uncomment, delete, correct

function logNames(lang, opt) {
    const names = lang === 'py' ? ['print', 'logging.debug', 'logging.info', 'logging.warning', 'logging.error'] :
        ['console.log', 'console.info', 'console.debug', 'console.warn', 'console.error', 'console.table'];
    if (!(lang === 'py' && opt.logFunction === 'log') && !names.includes(opt.logFunction)) names.push(opt.logFunction);
    return names.map((s) => s.split('.'));
}
function matchCall(tk, i, parts) {
    let k = i;
    for (let p = 0; p < parts.length; p++) {
        if (p > 0) { if (!isP(tk[k], '.')) return -1; k++; }
        if (!isId(tk[k], parts[p])) return -1;
        k++;
    }
    return isP(tk[k], '(') ? k : -1;
}
function hasMarker(text, opt) {
    const p = opt.logMessagePrefix, d = opt.delimiterInsideMessage;
    if (!p && !d) return false;
    return (!p || text.includes(p)) && (!d || text.includes(d));
}

function openContext(text, languageId, fileName, options) {
    const lang = detectLanguage(languageId, fileName);
    if (!lang) return null;
    const opt = normalizeOptions(options);
    const lines = buildLines(text);
    if (lang === 'py') return { lang, opt, lines, an: analyzePy(text, lines), names: logNames(lang, opt), eol: detectEol(text), text };
    const flavor = jsFlavor(languageId, fileName);
    const view = scriptView(text, flavor);
    return { lang, opt, lines, an: analyzeJs(view.code, flavor, lines), names: logNames(lang, opt), eol: detectEol(text), text };
}

function collectLogs(ctx) {
    const { lang, opt, lines, an, names, text } = ctx;
    const logs = [];
    const mkLog = (startLine, endLine, commented, extra) => {
        const first = lines.start(startLine), last = lines.end(endLine);
        const raw = text.slice(first, last);
        return Object.assign({ startLine, endLine, commented, text: raw, indent: lines.indent(startLine) || /^[ \t]*/.exec(raw)[0], startOffset: first, endOffset: last, marker: hasMarker(raw, opt) }, extra);
    };
    const tk = an.tk;
    // active logs
    if (lang === 'js') {
        for (let i = 0; i < tk.length; i++) {
            const t = tk[i];
            if (!isId(t)) continue;
            const prev = tk[i - 1];
            if (prev && lines.lineOf(Math.max(prev.e - 1, 0)) === lines.lineOf(t.s)) continue;
            let open = -1;
            for (const parts of names) { open = matchCall(tk, i, parts); if (open >= 0) break; }
            if (open < 0 || an.match[open] < 0) continue;
            let last = an.match[open];
            if (isP(tk[last + 1], ';') && lines.lineOf(tk[last + 1].s) === lines.lineOf(tk[last].e - 1)) last++;
            const next = tk[last + 1];
            const endLine = lines.lineOf(tk[last].e - 1);
            if (next && lines.lineOf(next.s) === endLine) continue;
            const node = an.nodeByTok.get(i);
            if (!node) continue;
            logs.push(mkLog(lines.lineOf(t.s), endLine, false, { unsafe: node.braceless, firstTok: i }));
        }
    } else {
        an.L.forEach((l, li) => {
            let open = -1;
            for (const parts of names) { open = matchCall(tk, l.a, parts); if (open >= 0) break; }
            if (open < 0 || an.match[open] < 0) return;
            let last = an.match[open];
            if (isP(tk[last + 1], ';')) last++;
            if (last !== l.b - 1) return;
            logs.push(mkLog(l.startLine, l.endLine, false, { logical: li }));
        });
    }
    // commented logs
    const markerStr = lang === 'py' ? '#' : '//';
    const byLine = new Map();
    for (const c of an.comments) {
        if (c.block || !text.startsWith(markerStr, c.s)) continue;
        const ln = lines.lineOf(c.s);
        if (text.slice(lines.start(ln), c.s).trim() === '') byLine.set(ln, c);
    }
    const nameRe = new RegExp('^\\s*(?:' + names.map((p) => p.map(escapeRegExp).join('\\s*\\.\\s*')).join('|') + ')\\s*\\(');
    let skipUntil = -1;
    for (const ln of Array.from(byLine.keys()).sort((a, b) => a - b)) {
        if (ln <= skipUntil) continue;
        const c0 = byLine.get(ln);
        if (!nameRe.test(text.slice(c0.s + markerStr.length, c0.e))) continue;
        const stripped = [];
        for (let l = ln; byLine.has(l) && stripped.length < 300; l++) { const c = byLine.get(l); stripped.push(text.slice(c.s + markerStr.length, c.e)); }
        const joined = stripped.join('\n');
        const sub = lang === 'py' ? tokenizePy(joined) : tokenizeJs(joined, { jsx: false });
        const stk = sub.tokens;
        const { match } = bracketMaps(stk);
        let open = -1;
        for (const parts of names) { open = matchCall(stk, 0, parts); if (open >= 0) break; }
        if (open < 0 || match[open] < 0) continue;
        let last = match[open];
        if (isP(stk[last + 1], ';')) last++;
        const endIdx = (joined.slice(0, stk[last].e).match(/\n/g) || []).length;
        if (endIdx >= stripped.length) continue;
        if (stk[last + 1] && (joined.slice(0, stk[last + 1].s).match(/\n/g) || []).length === endIdx) continue;
        logs.push(mkLog(ln, ln + endIdx, true, {}));
        skipUntil = ln + endIdx;
    }
    logs.sort((a, b) => a.startLine - b.startLine);
    return logs;
}

/** The log calls of a file: [{ startLine, endLine, commented, text }] (0-based lines). A log is a marked one when its text has the prefix and the delimiter. */
function findLogs(text, languageId, options, fileName) {
    text = String(text);
    const ctx = openContext(text, languageId, fileName, options);
    if (!ctx) return [];
    return collectLogs(ctx).filter((l) => l.marker);
}

const EMPTY = (extra) => Object.assign({ edits: [], count: 0, skipped: 0 }, extra || {});

/** Python: logs that are the whole body of a block (taking them away would leave a block without a statement). */
function soleBodyLogs(ctx, logs) {
    const sole = new Set();
    if (ctx.lang !== 'py') return sole;
    const { L } = ctx.an;
    const del = new Set(logs.filter((l) => l.logical !== undefined).map((l) => l.logical));
    for (let i = 0; i < L.length; i++) {
        if (!L[i].compound || L[i].inline) continue;
        let j = i + 1;
        const body = [];
        while (j < L.length && L[j].width > L[i].width) { body.push(j); j++; }
        if (body.length && body.every((b) => del.has(b))) body.forEach((b) => sole.add(b));
    }
    return sole;
}

function commentLogs(text, languageId, options, fileName) {
    text = String(text);
    const ctx = openContext(text, languageId, fileName, options);
    if (!ctx) return EMPTY();
    const marker = ctx.lang === 'py' ? '#' : '//';
    const all = collectLogs(ctx).filter((l) => l.marker && !l.commented);
    const sole = soleBodyLogs(ctx, all);
    const out = EMPTY();
    for (const l of all) {
        if (l.unsafe || (l.logical !== undefined && sole.has(l.logical))) { out.skipped++; continue; }
        for (let ln = l.startLine; ln <= l.endLine; ln++) {
            const s = ctx.lines.start(ln), e = ctx.lines.end(ln);
            const ws = /^[ \t]*/.exec(text.slice(s, e))[0].length;
            out.edits.push({ offset: s + Math.min(ws, l.indent.length), deleteLength: 0, text: s + ws === e ? marker : marker + ' ' });
        }
        out.count++;
    }
    return out;
}

function uncommentLogs(text, languageId, options, fileName) {
    text = String(text);
    const ctx = openContext(text, languageId, fileName, options);
    if (!ctx) return EMPTY();
    const re = ctx.lang === 'py' ? /^([ \t]*)# ?/ : /^([ \t]*)\/\/ ?/;
    const out = EMPTY();
    for (const l of collectLogs(ctx).filter((x) => x.marker && x.commented)) {
        for (let ln = l.startLine; ln <= l.endLine; ln++) {
            const s = ctx.lines.start(ln);
            const m = re.exec(text.slice(s, ctx.lines.end(ln)));
            if (m) out.edits.push({ offset: s + m[1].length, deleteLength: m[0].length - m[1].length, text: '' });
        }
        out.count++;
    }
    return out;
}

function deleteLogs(text, languageId, options, fileName) {
    text = String(text);
    const ctx = openContext(text, languageId, fileName, options);
    if (!ctx) return EMPTY();
    const { lines, opt } = ctx;
    const all = collectLogs(ctx).filter((l) => l.marker);
    const sole = soleBodyLogs(ctx, all.filter((l) => !l.commented));
    const out = EMPTY();
    const gone = new Set();
    const pass = [];
    const blank = (ln) => ln >= 0 && ln < lines.count && text.slice(lines.start(ln), lines.end(ln)).trim() === '';
    const doomed = [];
    for (const l of all) {
        if (l.unsafe) { out.skipped++; continue; }
        doomed.push(l);
    }
    const doomedLines = new Set();
    for (const l of doomed) for (let ln = l.startLine; ln <= l.endLine; ln++) doomedLines.add(ln);
    let passDone = new Set();
    for (const l of doomed) {
        if (l.logical !== undefined && sole.has(l.logical)) {
            // the block would be empty: the first log of the block becomes "pass"
            const header = ctx.an.L.findIndex((h, hi) => h.compound && !h.inline && hi < l.logical && ctx.an.L[hi + 1] && ctx.an.L[hi + 1].width > h.width && !(ctx.an.L.slice(hi + 1, l.logical).some((x) => x.width <= h.width)));
            if (!passDone.has(header)) { passDone.add(header); pass.push(l); continue; }
        }
        for (let ln = l.startLine; ln <= l.endLine; ln++) gone.add(ln);
        if (opt.insertEmptyLineBeforeLogMessage && blank(l.startLine - 1) && !doomedLines.has(l.startLine - 1)) gone.add(l.startLine - 1);
        if (opt.insertEmptyLineAfterLogMessage && blank(l.endLine + 1) && !doomedLines.has(l.endLine + 1)) gone.add(l.endLine + 1);
        out.count++;
    }
    for (const l of pass) {
        const s = lines.start(l.startLine);
        out.edits.push({ offset: s + l.indent.length, deleteLength: lines.end(l.endLine) - s - l.indent.length, text: 'pass' });
        for (let ln = l.startLine; ln <= l.endLine; ln++) gone.delete(ln);
        out.count++;
    }
    const sorted = Array.from(gone).sort((a, b) => a - b);
    for (let i = 0; i < sorted.length;) {
        let j = i;
        while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
        const a = sorted[i], b = sorted[j];
        let from = lines.start(a), to = b + 1 < lines.count ? lines.start(b + 1) : text.length;
        if (b + 1 >= lines.count && a > 0) from = lines.end(a - 1);
        out.edits.push({ offset: from, deleteLength: to - from, text: '' });
        i = j + 1;
    }
    out.edits.sort((a, b) => a.offset - b.offset);
    return out;
}

/** Refresh the file name and the line number that the existing logs show (only the parts that the settings ask for). */
function correctLogs(text, languageId, options, fileName) {
    text = String(text);
    const ctx = openContext(text, languageId, fileName, options);
    if (!ctx) return EMPTY();
    const { opt, lines } = ctx;
    const out = EMPTY();
    if (!opt.includeFilename && !opt.includeLineNum) return out;
    const base = basename(fileName);
    const pad = ` ${opt.delimiterInsideMessage} `;
    for (const l of collectLogs(ctx).filter((x) => x.marker)) {
        const first = text.slice(lines.start(l.startLine), lines.end(l.startLine));
        let segStart;
        if (opt.logMessagePrefix) { const i = first.indexOf(opt.logMessagePrefix + pad); if (i < 0) continue; segStart = i + opt.logMessagePrefix.length + pad.length; }
        else { const q = /\(\s*(["'`])/.exec(first); if (!q) continue; segStart = q.index + q[0].length; }
        const segEnd = first.indexOf(pad, segStart);
        if (segEnd < 0) continue;
        const seg = first.slice(segStart, segEnd);
        const num = l.startLine + 1;
        let next = null;
        if (opt.includeFilename && opt.includeLineNum) { const m = /^(.*):(\d+)$/.exec(seg); if (m) next = `${base}:${num}`; }
        else if (opt.includeFilename) { if (/^[^\s:]*\.[A-Za-z0-9_]+$/.test(seg)) next = base; }
        else if (/^:\d+$/.test(seg)) next = ':' + num;
        if (next === null || next === seg) continue;
        out.edits.push({ offset: lines.start(l.startLine) + segStart, deleteLength: seg.length, text: next });
        out.count++;
    }
    return out;
}

module.exports = {
    KINDS, defaultOptions, normalizeOptions, detectLanguage, insertLog, findLogs, commentLogs, uncommentLogs, deleteLogs, correctLogs, applyEdits,
    _internals: { tokenizeJs, tokenizePy, buildLines, analyzeJs, analyzePy },
};
