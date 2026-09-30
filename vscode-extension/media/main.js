/*
 * The terminal in the webview: xterm.js + the right-to-left layer (arabic-layout.js, row-patcher.js).
 * Talks to the extension (src/extension.js) with messages:
 *   webview -> extension   hello | ready {cols, rows} | input {data} | binary {data} | resize {cols, rows} | restart | pasteImage {data}
 *   extension -> webview   config {...} | output {data} | exit {code} | mode {mode} | focus | error {message}
 */
(function () {
    'use strict';

    const vscode = acquireVsCodeApi();
    const post = (message) => vscode.postMessage(message);
    const container = document.getElementById('terminal');
    const notice = document.getElementById('message');

    let term = null;
    let fit = null;
    let patcher = null;
    let mode = 'implicit';
    let exited = false;
    let config = null;

    // ---- theme, fonts ------------------------------------------------------------------------------------------------

    const ANSI_DEFAULTS = ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
        '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#e5e5e5'];
    const ANSI_NAMES = ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White',
        'BrightBlack', 'BrightRed', 'BrightGreen', 'BrightYellow', 'BrightBlue', 'BrightMagenta', 'BrightCyan', 'BrightWhite'];
    const ANSI_KEYS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
        'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];

    function cssVar(name, fallback) {
        const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        return value || fallback;
    }

    function readTheme() {
        const background = cssVar('--vscode-terminal-background', cssVar('--vscode-panel-background', '#1e1e1e'));
        const theme = {
            background,
            foreground: cssVar('--vscode-terminal-foreground', '#cccccc'),
            cursor: cssVar('--vscode-terminalCursor-foreground', cssVar('--vscode-terminal-foreground', '#cccccc')),
            cursorAccent: cssVar('--vscode-terminalCursor-background', background),
            selectionBackground: cssVar('--vscode-terminal-selectionBackground', '#264f78'),
            selectionInactiveBackground: cssVar('--vscode-terminal-inactiveSelectionBackground', '#3a3d41'),
        };
        for (let i = 0; i < 16; i++) theme[ANSI_KEYS[i]] = cssVar('--vscode-terminal-ansi' + ANSI_NAMES[i], ANSI_DEFAULTS[i]);
        document.documentElement.style.setProperty('--oc-background', background);
        return theme;
    }

    /** Splits a CSS font-family list at the commas that are not inside quotes. */
    function splitFontList(list) {
        const out = [];
        let current = '', quote = null;
        for (const ch of list) {
            if (quote) { current += ch; if (ch === quote) quote = null; }
            else if (ch === '"' || ch === "'") { quote = ch; current += ch; }
            else if (ch === ',') { if (current.trim()) out.push(current.trim()); current = ''; }
            else current += ch;
        }
        if (current.trim()) out.push(current.trim());
        return out;
    }

    const quoteFont = (name) => (/^['"]/.test(name) ? name : "'" + name.replace(/'/g, '') + "'");

    /**
     * The font list for the terminal. The first font decides the size of a cell. Arabic and Hebrew letters are taken from
     * the "text font" (Segoe UI) instead of from the first font of the list that happens to have them, because a
     * fixed-width font with its own Arabic letters (Courier New, Nerd Fonts) draws them squeezed and badly.
     */
    function fontStack(c) {
        const fonts = splitFontList(c.fontFamily || 'Consolas, monospace');
        const stack = [fonts[0]];
        if (c.textFont) stack.push(quoteFont(c.textFont));
        if (c.iconFont) stack.push(quoteFont(c.iconFont));
        stack.push(...fonts.slice(1));
        return stack.join(', ');
    }

    // ---- terminal ----------------------------------------------------------------------------------------------------

    function copySelection() {
        const text = term.getSelection();
        if (!text) return;
        const fallback = () => {
            const area = document.createElement('textarea');
            area.value = text;
            area.style.position = 'fixed';
            area.style.opacity = '0';
            document.body.appendChild(area);
            area.select();
            document.execCommand('copy');
            area.remove();
            term.focus();
        };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(fallback);
        else fallback();
    }

    function pasteFromClipboard() {
        if (!navigator.clipboard || !navigator.clipboard.readText) return;
        navigator.clipboard.readText().then((text) => { if (text) term.paste(text); }).catch(() => { /* not allowed here: Ctrl+V still works */ });
    }

    function createTerminal(c) {
        config = c;
        const options = {
            allowProposedApi: true,
            fontFamily: fontStack(c),
            fontSize: c.fontSize || 14,
            lineHeight: c.lineHeight || 1,
            cursorStyle: c.cursorStyle || 'bar',
            cursorInactiveStyle: 'outline',
            cursorBlink: !!c.cursorBlink,
            scrollback: c.scrollback || 1000,
            theme: readTheme(),
            windowsPty: { backend: 'conpty', buildNumber: c.windowsBuildNumber || 22621 },
            fontWeight: 'normal',
            fontWeightBold: 'bold',
            macOptionIsMeta: false,
            rightClickSelectsWord: false,
            drawBoldTextInBrightColors: true,
        };
        term = new Terminal(options);
        fit = new FitAddon.FitAddon();
        term.loadAddon(fit);
        const unicode = new Unicode11Addon.Unicode11Addon();
        term.loadAddon(unicode);
        term.unicode.activeVersion = '11';
        term.open(container);

        patcher = new OCRowPatcher(term, () => mode);
        patcher.start();
        window.__openconsole = { term, patcher };      // for the tests (test/e2e)

        term.onData((data) => {
            if (exited) {
                if (data === '\r' || data === ' ') { exited = false; post({ t: 'restart', cols: term.cols, rows: term.rows }); }
                return;
            }
            post({ t: 'input', data });
        });
        term.onBinary((data) => post({ t: 'binary', data }));
        term.onResize(({ cols, rows }) => post({ t: 'resize', cols, rows }));

        term.attachCustomKeyEventHandler((e) => {
            if (e.type !== 'keydown') return true;
            const ctrl = e.ctrlKey && !e.altKey && !e.metaKey;
            if (ctrl && e.code === 'KeyC' && (e.shiftKey || term.hasSelection())) { copySelection(); return false; }
            if (ctrl && e.shiftKey && e.code === 'KeyV') { pasteFromClipboard(); return false; }
            if (ctrl && !e.shiftKey && e.code === 'KeyV') return false;           // the browser pastes, xterm.js receives the paste event
            if (e.shiftKey && e.code === 'Insert') return false;
            return true;
        });

        // A screenshot in the clipboard: the extension saves it as a file and types its path (as OpenConsole does).
        container.addEventListener('paste', (e) => {
            const data = e.clipboardData;
            if (!data || !data.files || !data.files.length || data.getData('text/plain')) return;
            const file = Array.from(data.files).find((f) => f.type.startsWith('image/'));
            if (!file) return;
            e.preventDefault();
            e.stopPropagation();
            const reader = new FileReader();
            reader.onload = () => post({ t: 'pasteImage', data: String(reader.result).split(',')[1] || '' });
            reader.readAsDataURL(file);
        }, true);

        // follow the theme of VS Code
        new MutationObserver(() => { if (term) term.options.theme = readTheme(); })
            .observe(document.body, { attributes: true, attributeFilter: ['class'] });

        // keep the terminal as large as the view
        let pending = false;
        new ResizeObserver(() => {
            if (pending) return;
            pending = true;
            requestAnimationFrame(() => { pending = false; refit(); });
        }).observe(container);

        refit();
        post({ t: 'ready', cols: term.cols, rows: term.rows });
        term.focus();
    }

    function refit() {
        if (!term || !container.clientWidth || !container.clientHeight) return;
        try { fit.fit(); } catch (e) { /* not visible yet */ }
    }

    function applyConfig(c) {
        config = c;
        term.options.fontFamily = fontStack(c);
        term.options.fontSize = c.fontSize || 14;
        term.options.lineHeight = c.lineHeight || 1;
        term.options.cursorStyle = c.cursorStyle || 'bar';
        term.options.cursorBlink = !!c.cursorBlink;
        term.options.scrollback = c.scrollback || 1000;
        term.options.theme = readTheme();
        refit();
    }

    function showNotice(text) {
        notice.textContent = text;
        notice.hidden = !text;
    }

    // ---- messages from the extension ---------------------------------------------------------------------------------

    window.addEventListener('message', (event) => {
        const m = event.data;
        switch (m.t) {
            case 'config':
                if (!term) createTerminal(m.config);
                else applyConfig(m.config);
                break;
            case 'output':
                if (term) term.write(m.data);
                break;
            case 'paste':
                if (term) term.paste(m.text);
                break;
            case 'exit':
                exited = true;
                if (term) term.write('\r\n\x1b[90m[The process ended' + (m.code === null || m.code === undefined ? '' : ' with code ' + m.code) + '. Press Enter to start it again.]\x1b[0m\r\n');
                break;
            case 'mode':
                if (mode !== m.mode) {
                    mode = m.mode;
                    if (term) term.refresh(0, term.rows - 1);
                }
                break;
            case 'focus':
                if (term) term.focus();
                break;
            case 'clear':
                if (term) term.clear();
                break;
            case 'reset':
                exited = false;
                if (term) { term.reset(); }
                break;
            case 'error':
                showNotice(m.message);
                break;
            default:
                break;
        }
    });

    post({ t: 'hello' });
})();
