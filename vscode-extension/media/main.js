/*
 * The terminals in the webview: xterm.js + the right-to-left layer (arabic-layout.js, row-patcher.js).
 * A webview holds one or more terminals (xterm.js instances). Every message about a terminal carries its id.
 * Talks to the extension (src/extension.js) with messages:
 *   webview -> extension   hello | ready {id, cols, rows, token, splitOf} | active {id} | close {id} | input {id, data} | binary {id, data}
 *                          | resize {id, cols, rows} | restart {id, cols, rows} | pasteImage {id, data}
 *                          | command {id, text, directory} | action {id, action} | menuPick {id} | openLink {uri} | openFile {id, path, line, col} | pasteRequest {id} | agentState {id, name, state, kind, attention, ...} | attention {id, reason, ...}
 *   extension -> webview   config {...} | history {commands} | busy {id, busy} | scrollCommand {id, dir} | menu {items}
 *                          | new {title, token} | split {id} | output {id, data} | exit {id, code} | mode {id, mode} | paste {id, text}
 *                          | show {id} | explainState {id} | find {id} | pasteEmpty {id} | clear {id} | reset {id} | focus | error {message}
 */
(function () {
    'use strict';

    const vscode = acquireVsCodeApi();
    const post = (message) => vscode.postMessage(message);
    const panes = document.getElementById('terminals');
    const list = document.getElementById('list');
    const notice = document.getElementById('message');

    const terminals = new Map();      // id -> { id, el, term, fit, patcher, mode, exited, title }
    const groups = [];                // the terminals that are shown together, side by side, in this order: [[id, id], [id], ...]
    let history = [];                 // the commands that were typed, oldest first (for the suggestion of what you are going to type)

    /** Adds commands to the history: a command that was there moves to the end (it is the newest now). */
    function addHistory(commands) {
        const fresh = new Set(commands);
        history = history.filter((c) => !fresh.has(c)).concat(commands).slice(-2500);
    }
    let activeId = null;
    let nextId = 1;
    let config = null;

    const activeTerminal = () => terminals.get(activeId) || null;

    // What every terminal is doing (media/agent-view.js): the page tells the extension, which shows the status bar and the notifications.
    // It is not told about what is being watched: the terminal that is shown, in a window that has the focus.
    const agentHost = {
        post,
        looking: (t) => (typeof window.__openconsoleLooking === 'boolean' ? window.__openconsoleLooking : (t.id === activeId && document.hasFocus() && document.visibilityState !== 'hidden')),
        rules: () => (config && Array.isArray(config.agentRules) ? config.agentRules : []),
        minWorkMs: () => ((config && Number(config.attentionMinSeconds)) || 15) * 1000,
    };

    // Find in the terminal (Ctrl+F): one widget for all the terminals, it searches the one that is shown (media/find.js)
    const find = new OCFind(panes, {
        terminal: activeTerminal,
        background: () => cssVar('--vscode-terminal-background', cssVar('--vscode-panel-background', '#1e1e1e')),
        onClose: (t) => t.term.focus(),
    });

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

    // ---- the list of terminals ---------------------------------------------------------------------------------------

    const ICON_TERMINAL = '<svg class="icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">' +
        '<path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5v-9zm1.5-.5a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5h-9z"/>' +
        '<path d="M4.15 5.15a.5.5 0 0 1 .7 0l2 2a.5.5 0 0 1 0 .7l-2 2a.5.5 0 0 1-.7-.7L5.79 7.5 4.15 5.85a.5.5 0 0 1 0-.7zM8 10h3v1H8z"/></svg>';
    // The icons of the two buttons of a row, drawn so that they can move (see "the buttons of a row" in main.css): in Split Terminal the
    // line in the middle divides in two and the halves move apart, on the bin the lid lifts. Both are centred in their 16 x 16 box.
    const ICON_SPLIT = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path class="frame" d="M3.5 2h9A1.5 1.5 0 0 1 14 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5v-9A1.5 1.5 0 0 1 3.5 2z"/>' +
        '<path class="half-l" d="M8 2v12"/><path class="half-r" d="M8 2v12"/></svg>';
    const ICON_TRASH = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path class="lid" d="M3 4h10M6.5 4V2.75a.75.75 0 0 1 .75-.75h1.5a.75.75 0 0 1 .75.75V4"/>' +
        '<path class="can" d="M4.5 4l.55 8.9A1.1 1.1 0 0 0 6.15 14h3.7a1.1 1.1 0 0 0 1.1-1.1L11.5 4"/>' +
        '<path class="bar" d="M7 6.5v4.5"/><path class="bar" d="M9 6.5v4.5"/></svg>';

    /**
     * The icon of a row: the one of the agent or program that runs in the terminal (or of its kind of shell), from Material Icon Theme,
     * unless the terminal was given a colour (the plain icon wears that colour). The pictures are our own files (media/vendor), not text of a program.
     */
    /** The pictures of the theme, and the ones that this extension draws itself (media/custom-icons.js). */
    const iconSet = () => Object.assign({}, typeof OCMaterialIcons === 'undefined' ? {} : OCMaterialIcons, typeof OCCustomIcons === 'undefined' ? {} : OCCustomIcons);

    function iconName(t) {
        if (t.color || typeof OCProgramIcons === 'undefined' || typeof OCMaterialIcons === 'undefined') return null;
        const icons = iconSet();
        const name = OCProgramIcons.pick({ agent: t.agent && t.agent.model ? t.agent.model.kind : '', programs: t.programs || [], title: t.kindTitle });
        return name && icons[name] ? name : null;
    }

    function iconHTML(t) {
        const name = iconName(t);
        t.iconKey = name || '';
        return name ? iconSet()[name].replace('<svg ', '<svg class="icon prog" data-icon="' + name + '" aria-hidden="true" ') : ICON_TERMINAL;
    }

    /** The row changes its icon when the program in the terminal changes (no other part of the list is drawn again). */
    function refreshIcon(t) {
        const row = list.querySelector('.item[data-id="' + t.id + '"]');
        if (!row) return;
        const name = iconName(t) || '';
        if (name === t.iconKey) return;
        const old = row.querySelector(':scope > .icon');
        if (!old) return;
        const holder = document.createElement('div');
        holder.innerHTML = iconHTML(t);
        old.replaceWith(holder.firstChild);
    }

    // ---- the menu next to "+" ---------------------------------------------------------------------------------------------
    // A dropdown like the menus of VS Code, drawn at the top right of the terminal (an extension cannot open a menu with entries that
    // are only known at run time from a button of the toolbar). The entries come from the extension; a pick goes back as menuPick.

    const menu = document.createElement('div');
    menu.id = 'menu';
    menu.setAttribute('role', 'menu');
    menu.tabIndex = -1;
    menu.hidden = true;
    document.body.appendChild(menu);
    let menuEntries = [];                 // the entries that can be picked, in order
    let menuLocal = null;                 // for a menu that the page made itself (the row of a terminal): id -> what it does
    let menuSelected = -1;
    let menuOpenedAt = 0;

    function selectMenuEntry(index) {
        menuSelected = index;
        menuEntries.forEach((el, i) => el.classList.toggle('selected', i === index));
        if (menuEntries[index]) menuEntries[index].scrollIntoView({ block: 'nearest' });
    }

    function closeMenu(refocus) {
        if (menu.hidden) return;
        menu.hidden = true;
        menu.textContent = '';
        menuEntries = [];
        menuLocal = null;
        menuSelected = -1;
        if (refocus) { const t = activeTerminal(); if (t) t.term.focus(); }
    }

    function pickMenuEntry(id) {
        const local = menuLocal;
        closeMenu(true);
        if (local && local[id]) local[id]();
        else post({ t: 'menuPick', id });
    }
    function showMenu(items, local) {
        closeMenu(false);
        if (!Array.isArray(items)) return;
        menuLocal = local || null;
        for (const item of items) {
            if (!item || item.separator) {
                const separator = document.createElement('div');
                separator.className = 'separator';
                separator.setAttribute('role', 'separator');
                menu.appendChild(separator);
                continue;
            }
            const entry = document.createElement('div');
            entry.className = 'entry';
            entry.setAttribute('role', 'menuitem');
            entry.dataset.id = String(item.id);
            entry.textContent = String(item.label);
            entry.addEventListener('mouseenter', () => selectMenuEntry(menuEntries.indexOf(entry)));
            entry.addEventListener('click', (e) => { e.stopPropagation(); pickMenuEntry(entry.dataset.id); });
            entry.style.setProperty('--i', String(menuEntries.length));      // the entries come in one after the other
            menu.appendChild(entry);
            menuEntries.push(entry);
        }
        if (!menuEntries.length) return;
        menuOpenedAt = Date.now();
        menu.hidden = false;
        selectMenuEntry(0);
        menu.focus();
    }

    menu.addEventListener('keydown', (e) => {
        const n = menuEntries.length;
        if (!n) return;
        if (e.key === 'ArrowDown') selectMenuEntry((menuSelected + 1) % n);
        else if (e.key === 'ArrowUp') selectMenuEntry((menuSelected - 1 + n) % n);
        else if (e.key === 'Home') selectMenuEntry(0);
        else if (e.key === 'End') selectMenuEntry(n - 1);
        else if (e.key === 'Enter' || e.key === ' ') { if (menuEntries[menuSelected]) pickMenuEntry(menuEntries[menuSelected].dataset.id); }
        else if (e.key === 'Escape' || e.key === 'Tab') closeMenu(true);
        else return;
        e.preventDefault();
        e.stopPropagation();
    });
    // a click anywhere else closes it; so does leaving the view (but not in the instant it opens, while the focus is still moving to the view)
    document.addEventListener('mousedown', (e) => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(false); }, true);
    window.addEventListener('blur', () => { if (!menu.hidden && Date.now() - menuOpenedAt > 500) closeMenu(false); });

    function rowButton(className, title, icon, run) {
        const button = document.createElement('button');
        button.className = className;
        button.type = 'button';
        button.title = title;
        button.setAttribute('aria-label', title);
        button.innerHTML = icon;
        button.addEventListener('click', (e) => { e.stopPropagation(); run(); });
        return button;
    }

    // ---- the line between the terminals and the list: drag it to the left or to the right to change the width of the list ---------
    // Like the sash of VS Code: a thin line that lights up when it is pointed at. The list follows the pointer at once (the terminals
    // are measured again by the observer of their area, once per frame), double click gives the list its usual width back, and the arrow
    // keys move it when it has the focus. The width is kept in the state of the view.

    const LIST_WIDTH = 184, LIST_MIN_WIDTH = 80, TERMINAL_MIN_WIDTH = 120, LIST_KEY_STEP = 16;
    const sash = document.createElement('div');
    sash.id = 'sash';
    sash.hidden = true;
    sash.tabIndex = 0;
    sash.setAttribute('role', 'separator');
    sash.setAttribute('aria-orientation', 'vertical');
    sash.setAttribute('aria-label', 'Resize the list of terminals');
    list.parentNode.insertBefore(sash, list);
    let listWidth = LIST_WIDTH;
    try {
        const saved = typeof vscode.getState === 'function' ? vscode.getState() : null;
        if (saved && Number.isFinite(saved.listWidth)) listWidth = saved.listWidth;
    } catch (e) { /* no saved state */ }

    /** The list is as wide as asked, but never narrower than a name needs, and it leaves room for the terminals. */
    function setListWidth(width, save) {
        const room = Math.max(LIST_MIN_WIDTH, list.parentNode.clientWidth - TERMINAL_MIN_WIDTH);
        listWidth = Math.round(Math.min(room, Math.max(LIST_MIN_WIDTH, width)));
        list.style.width = listWidth + 'px';
        sash.setAttribute('aria-valuenow', String(listWidth));
        if (save) { try { if (typeof vscode.setState === 'function') vscode.setState({ listWidth }); } catch (e) { /* not kept */ } }
    }
    setListWidth(listWidth, false);

    let drag = null;                       // { startX, startWidth, x, frame } while the line is held
    sash.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        drag = { startX: e.clientX, startWidth: list.getBoundingClientRect().width, x: e.clientX, frame: 0 };
        try { sash.setPointerCapture(e.pointerId); } catch (err) { /* a pointer that is not active (a test) */ }
        sash.classList.add('dragging');
        document.body.classList.add('oc-resizing');
        e.preventDefault();
    });
    sash.addEventListener('pointermove', (e) => {
        if (!drag) return;
        drag.x = e.clientX;
        if (drag.frame) return;
        drag.frame = requestAnimationFrame(() => {        // at most one change per frame: smooth, and nothing is measured twice
            if (!drag) return;
            drag.frame = 0;
            setListWidth(drag.startWidth + (drag.startX - drag.x), false);
        });
    });
    const endDrag = (e) => {
        if (!drag) return;
        if (drag.frame) cancelAnimationFrame(drag.frame);
        setListWidth(drag.startWidth + (drag.startX - (e && Number.isFinite(e.clientX) ? e.clientX : drag.x)), true);
        drag = null;
        sash.classList.remove('dragging');
        document.body.classList.remove('oc-resizing');
    };
    sash.addEventListener('pointerup', endDrag);
    sash.addEventListener('pointercancel', endDrag);
    sash.addEventListener('lostpointercapture', () => endDrag(null));
    sash.addEventListener('dblclick', () => setListWidth(LIST_WIDTH, true));
    sash.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft') setListWidth(listWidth + LIST_KEY_STEP, true);
        else if (e.key === 'ArrowRight') setListWidth(listWidth - LIST_KEY_STEP, true);
        else if (e.key === 'Home') setListWidth(LIST_WIDTH, true);
        else return;
        e.preventDefault();
    });

    // ---- the name and the colour of a terminal (double click on its row, or its menu: right button) --------------------------------

    const TAB_COLORS = {
        red: 'var(--vscode-terminal-ansiRed, #f14c4c)', orange: 'var(--vscode-terminal-ansiBrightYellow, #e8912d)', yellow: 'var(--vscode-terminal-ansiYellow, #cca700)',
        green: 'var(--vscode-terminal-ansiGreen, #23d18b)', cyan: 'var(--vscode-terminal-ansiCyan, #29b8db)', blue: 'var(--vscode-terminal-ansiBlue, #3b8eea)',
        purple: 'var(--vscode-terminal-ansiMagenta, #bc3fbc)', pink: 'var(--vscode-terminal-ansiBrightMagenta, #e56fb0)',
    };

    /** A name that a user typed (or a program set): no control characters, no direction marks that would turn the list around, at most 60 characters. */
    function cleanName(text) {
        return String(text === undefined || text === null ? '' : text).replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    }

    /** An empty name gives the name of the kind of terminal back. */
    function renameTerminal(t, name) {
        t.title = cleanName(name) || t.kindTitle;
        renderList();
        t.agent.handle([]);                    // the extension is told the new name (its notifications and the web page use it)
    }

    function colorTerminal(t, color) {
        t.color = TAB_COLORS[color] ? color : '';
        renderList();
    }

    /** The menu of a row (right button): rename, colour, split, kill. */
    function showRowMenu(t) {
        const items = [{ id: 'rename', label: 'Rename...' }, { separator: true }];
        const local = { rename: () => post({ t: 'renameAsk', id: t.id, name: t.title }), split: () => splitTerminal(t.id), kill: () => closeTerminal(t.id) };
        for (const name of Object.keys(TAB_COLORS)) {
            items.push({ id: 'color:' + name, label: (t.color === name ? '✓ ' : '') + name[0].toUpperCase() + name.slice(1) });
            local['color:' + name] = () => colorTerminal(t, name);
        }
        items.push({ id: 'color:', label: 'No colour' }, { separator: true }, { id: 'split', label: 'Split Terminal' }, { id: 'kill', label: 'Kill Terminal' });
        local['color:'] = () => colorTerminal(t, '');
        showMenu(items, local);
    }
    /** The list is shown only when there is more than one terminal, as in the terminal of VS Code. */
    function renderList() {
        const show = terminals.size > 1;
        const changed = list.hidden === show;
        list.hidden = !show;
        sash.hidden = !show;
        list.textContent = '';
        // the list takes room from the terminals, or gives it back: they are measured again at once
        if (changed) for (const t of terminals.values()) refit(t);
        if (!show) {
            for (const t of terminals.values()) t.fresh = false;       // no row to come in: the next list shows the ones that are there as they are
            return;
        }
        for (const ids of groups) {
            ids.forEach((id, position) => {
                const t = terminals.get(id);
                const item = document.createElement('div');
                // the terminals of a group (split next to each other) hang together under one another, with a line at their side
                const entering = t.fresh === true;
                t.fresh = false;
                item.className = 'item' + (entering ? ' entering' : '') + (t.id === activeId ? ' active' : '') +
                    (ids.length > 1 ? ' grouped' + (position === 0 ? ' first' : '') + (position === ids.length - 1 ? ' last' : '') : '');
                item.dataset.id = String(t.id);
                item.title = t.title;
                item.innerHTML = iconHTML(t);
                if (TAB_COLORS[t.color]) { item.dataset.color = t.color; item.style.setProperty('--oc-tab', TAB_COLORS[t.color]); }
                const label = document.createElement('span');
                label.className = 'label';
                label.textContent = t.title;
                item.appendChild(label);
                const status = document.createElement('span');
                status.className = 'status';
                status.innerHTML = '<i class="dot"></i>';
                item.appendChild(status);
                t.agent.attach(status);
                item.appendChild(rowButton('split', 'Split Terminal', ICON_SPLIT, () => splitTerminal(t.id)));
                item.appendChild(rowButton('close', 'Kill Terminal', ICON_TRASH, () => closeTerminal(t.id)));
                item.addEventListener('mousedown', (e) => e.preventDefault());     // keep the focus in the terminal
                item.addEventListener('click', () => activate(t.id));
                item.addEventListener('dblclick', () => post({ t: 'renameAsk', id: t.id, name: t.title }));
                item.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); showRowMenu(t); });
                list.appendChild(item);
            });
        }
    }

    // ---- terminals ---------------------------------------------------------------------------------------------------

    function copySelection(t) {
        const text = t.term.getSelection();
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
            t.term.focus();
        };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(fallback);
        else fallback();
    }

    /**
     * Pastes what is in the clipboard (Ctrl+Shift+V, and the right mouse button). A webview may not read the clipboard itself, so the
     * extension does, and answers with a paste message (or pasteEmpty when there is no text in the clipboard: then a screenshot is tried).
     */
    function pasteFromClipboard(t) {
        post({ t: 'pasteRequest', id: t.id });
    }

    /** A screenshot in the clipboard (best effort: the page may not be allowed to read it): saved as a file and its path typed. */
    function pasteImageFromClipboard(t) {
        if (!navigator.clipboard || !navigator.clipboard.read) return;
        navigator.clipboard.read().then(async (items) => {
            for (const item of items) {
                const type = item.types.find((name) => name.startsWith('image/'));
                if (!type) continue;
                const blob = await item.getType(type);
                const reader = new FileReader();
                reader.onload = () => post({ t: 'pasteImage', id: t.id, data: String(reader.result).split(',')[1] || '' });
                reader.readAsDataURL(blob);
                return;
            }
        }).catch(() => { /* not allowed here: Ctrl+V still works */ });
    }

    function refit(t) {
        if (!t.el.clientWidth || !t.el.clientHeight) return;
        try { t.fit.fit(); } catch (e) { /* not visible yet */ }
    }

    /**
     * The terminals of the group that has the focus are shown side by side, each with an equal share of the width; the ones of the other
     * groups are hidden (they keep the full size, so that xterm.js can measure them).
     */
    function layout() {
        for (const ids of groups) {
            const shown = ids.includes(activeId);
            ids.forEach((id, position) => {
                const t = terminals.get(id);
                t.el.style.left = shown ? (100 * position / ids.length) + '%' : '0';
                t.el.style.width = shown ? (100 / ids.length) + '%' : '100%';
                t.el.classList.toggle('active', shown);
                t.el.classList.toggle('divided', shown && position > 0);
            });
        }
    }

    /** Makes a terminal the focused one, and its group the shown one (no message to the extension). */
    function select(t) {
        activeId = t.id;
        layout();
        renderList();
        for (const ids of groups) if (ids.includes(t.id)) for (const id of ids) refit(terminals.get(id));
        find.retarget(t);
        t.term.focus();
        t.agent.looked();
    }

    /** The user picks a terminal. */
    function activate(id) {
        const t = terminals.get(id);
        if (!t) return;
        select(t);
        post({ t: 'active', id });
    }

    function closeTerminal(id) {
        const t = terminals.get(id);
        if (!t) return;
        if (terminals.size === 1) {
            // the last one is not removed (the view would be empty): its shell starts again
            t.exited = false;
            post({ t: 'restart', id, cols: t.term.cols, rows: t.term.rows });
            t.term.focus();
            return;
        }
        const order = groups.flat();            // the order of the list
        const index = order.indexOf(id);
        const groupIndex = groups.findIndex((ids) => ids.includes(id));
        const position = groups[groupIndex].indexOf(id);
        groups[groupIndex].splice(position, 1);
        const remaining = groups[groupIndex];
        if (!remaining.length) groups.splice(groupIndex, 1);
        terminals.delete(id);
        find.forget(t);
        t.patcher.stop();
        t.chips.dispose();
        t.suggest.dispose();
        t.term.dispose();
        t.el.remove();
        post({ t: 'close', id });
        if (activeId === id) {
            // the one next to it in its group, else the one that comes next in the list
            const next = remaining.length
                ? terminals.get(remaining[Math.min(position, remaining.length - 1)])
                : terminals.get(order[index + 1]) || terminals.get(order[index - 1]);
            activeId = null;
            if (next) activate(next.id);
        }
        else {
            layout();
            renderList();
            for (const ids of groups) if (ids.includes(activeId)) for (const member of ids) refit(terminals.get(member));
        }
    }

    /**
     * The user pressed Enter at a prompt: the command (the text of the row after the prompt) goes to the history, with the folder that
     * the prompt shows, and the row is marked, so that "scroll to previous command" can come back to it. Nothing is done while another
     * program runs in the terminal, when the row has text after the cursor, and when the suggestions are off.
     */
    function rememberCommand(t) {
        if (!config || config.suggestions === false || t.busy) return;
        const row = OCSuggest.readCursorRow(t.term);
        if (!row || row.wrapped || row.after.trim() !== '') return;
        const candidate = OCSuggest.typedCandidates(row.before)[0];
        if (!candidate) return;
        const text = candidate.typed.trim();
        if (!text) return;
        const marker = t.term.registerMarker(0);
        if (marker) t.marks.push(marker);
        t.marks = t.marks.filter((m) => !m.isDisposed).slice(-300);
        addHistory([text]);
        post({ t: 'command', id: t.id, text, directory: OCSuggest.promptDirectory(row.before.slice(0, candidate.start)) });
    }

    /** Scrolls to the command before the top row of the screen (direction -1) or after it (1). */
    function scrollToCommand(t, direction) {
        const top = t.term.buffer.active.viewportY;
        const lines = t.marks.filter((m) => !m.isDisposed && m.line >= 0).map((m) => m.line).sort((a, b) => a - b);
        const target = direction < 0 ? lines.reverse().find((line) => line < top) : lines.find((line) => line > top);
        if (target !== undefined) t.term.scrollToLine(target);
    }

    // ---- links: Ctrl + click on an address (http or https) in the output opens it ----------------------------------------------------
    // xterm.js finds the addresses (also when one runs over several rows) and underlines the one that is pointed at. The page has no way
    // to open a browser, so the click goes to the extension, which asks VS Code to open it (VS Code asks the user first, as it does for
    // every address that it does not trust yet).

    const linkTip = document.createElement('div');
    linkTip.id = 'linktip';
    linkTip.hidden = true;
    linkTip.textContent = 'Follow link (Ctrl + click)';
    document.body.appendChild(linkTip);

    function showLinkTip(event, text) {
        linkTip.textContent = text || 'Follow link (Ctrl + click)';
        linkTip.hidden = false;
        const below = event.clientY + 22;
        const top = below + linkTip.offsetHeight > window.innerHeight ? event.clientY - linkTip.offsetHeight - 8 : below;
        linkTip.style.left = Math.max(0, Math.min(event.clientX + 10, window.innerWidth - linkTip.offsetWidth - 4)) + 'px';
        linkTip.style.top = Math.max(0, top) + 'px';
    }

    /**
     * A program that asks for the mouse (pi, opencode, vim) gets the clicks, and xterm.js leaves the addresses alone then. So while it
     * does, the page looks for the address under the pointer itself (media/links.js): it shows the hint, and a Ctrl + click on an
     * address opens it instead of going to the program. Every other click, and every click away from an address, still goes to it.
     */
    function watchLinksUnderTheMouse(t) {
        const usesMouse = () => t.term.modes.mouseTrackingMode !== 'none';
        const addressUnder = (e) => OCLinks.addressAtPoint(t.term, t.el.querySelector('.xterm-screen'), e.clientX, e.clientY);
        let pressed = null;          // the address of a Ctrl + click that the program did not get (it is opened when the button comes up)
        let lastCell = '';
        t.el.addEventListener('mousemove', (e) => {
            if (!usesMouse()) return;
            const cell = e.clientX + ',' + e.clientY;
            if (cell === lastCell) return;
            lastCell = cell;
            if (addressUnder(e)) showLinkTip(e); else linkTip.hidden = true;
        }, true);
        t.el.addEventListener('mouseleave', () => { if (usesMouse()) linkTip.hidden = true; }, true);
        t.el.addEventListener('mousedown', (e) => {
            pressed = null;
            if (!usesMouse() || e.button !== 0 || !(e.ctrlKey || e.metaKey)) return;
            const uri = addressUnder(e);
            if (!uri) return;
            pressed = uri;
            e.stopPropagation();
            e.preventDefault();
        }, true);
        t.el.addEventListener('mouseup', (e) => {
            if (!pressed) return;
            const uri = pressed;
            pressed = null;
            e.stopPropagation();
            e.preventDefault();
            linkTip.hidden = true;
            post({ t: 'openLink', uri });
        }, true);
    }

    function makeLinksAddon() {
        return new WebLinksAddon.WebLinksAddon((event, uri) => {
            linkTip.hidden = true;
            if (event.button !== 0 || !(event.ctrlKey || event.metaKey)) return;     // a click without Ctrl only selects, as in the terminal of VS Code
            post({ t: 'openLink', uri });
        }, {
            hover: (event) => showLinkTip(event),
            leave: () => { linkTip.hidden = true; },
        });
    }

    /** Splits a terminal: a new one of the same kind opens at its right side, in the same group. */
    function splitTerminal(id) {
        const source = terminals.get(id === undefined ? activeId : id);
        if (!source || !config) return;
        createTerminal(config, source.title, undefined, source.id);
    }

    /**
     * title: the name in the list (the kind of terminal, when it was chosen); token: what the extension gave, so that it knows which
     * one this is; splitOf: the id of the terminal that this one splits (it opens at its right side, and is of its kind)
     */
    function createTerminal(c, title, token, splitOf) {
        config = c;
        const id = nextId++;
        const el = document.createElement('div');
        el.className = 'pane';
        panes.appendChild(el);

        const term = new Terminal({
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
        });
        const fit = new FitAddon.FitAddon();
        term.loadAddon(fit);
        const unicode = new Unicode11Addon.Unicode11Addon();
        term.loadAddon(unicode);
        term.unicode.activeVersion = '11';
        term.loadAddon(makeLinksAddon());
        term.open(el);

        const t = { id, el, term, fit, patcher: null, chips: null, mode: 'implicit', exited: false, fresh: true, title: title || c.shellName || 'terminal', kindTitle: title || c.shellName || 'terminal', color: '' };
        t.patcher = new OCRowPatcher(term, () => t.mode);
        t.patcher.start();
        t.chips = new OCImageChips(term);      // "[Image #1]" over the path of a pasted screenshot
        watchLinksUnderTheMouse(t);
        // file paths ("src/app.ts:12:5"): Ctrl + click opens the file in the editor, where the extension finds it
        term.registerLinkProvider(OCFileLinks.linkProvider(term, {
            open: (m) => { linkTip.hidden = true; post({ t: 'openFile', id: t.id, path: m.path, line: m.line, col: m.col }); },
            hover: (event) => showLinkTip(event, 'Open file (Ctrl + click)'),
            leave: () => { linkTip.hidden = true; },
        }));
        t.agent = new OCAgentView(t, agentHost);                                // what it is doing: running, working, waiting for you...
        t.search = new SearchAddon.SearchAddon({ highlightLimit: 1000 });      // find in the terminal
        term.loadAddon(t.search);
        t.search.onDidChangeResults((e) => find.results(t, e));
        t.busy = false;                        // another program than the shell runs in it (the shell is not at its prompt)
        t.marks = [];                          // where the commands that were entered are (for "scroll to previous command")
        t.suggest = new OCSuggest(term, {       // the rest of a command that you are typing, in grey; the Right Arrow types it
            history: () => history,
            enabled: () => !!config && config.suggestions !== false && !t.exited,
            busy: () => t.busy,
        });
        terminals.set(id, t);
        const sourceGroup = splitOf === undefined ? null : groups.find((ids) => ids.includes(splitOf));
        if (sourceGroup) sourceGroup.splice(sourceGroup.indexOf(splitOf) + 1, 0, id);
        else groups.push([id]);
        // a click in a terminal that is shown next to the focused one moves the focus there
        el.addEventListener('focusin', () => { if (activeId !== id && terminals.has(id)) activate(id); });

        term.onData((data) => {
            if (t.exited) {
                if (data === '\r' || data === ' ') { t.exited = false; post({ t: 'restart', id, cols: term.cols, rows: term.rows }); }
                return;
            }
            t.agent.typed();
            if (data === '\r') rememberCommand(t);
            post({ t: 'input', id, data });
        });
        term.onBinary((data) => post({ t: 'binary', id, data }));
        term.onResize(({ cols, rows }) => post({ t: 'resize', id, cols, rows }));

        term.attachCustomKeyEventHandler((e) => {
            if (e.type !== 'keydown') return true;
            const ctrl = e.ctrlKey && !e.altKey && !e.metaKey;
            // The key is told by its position (code), or by its virtual key code when there is no position: the Ctrl+V that
            // Windows sends after you pick an item of the clipboard history (Win+V) comes without a scan code, so its code
            // is empty, and on an Arabic layout its key is "ر". The virtual key code is 86 for the V key in every layout.
            const is = (code, virtualKey) => e.code === code || (!e.code && e.keyCode === virtualKey);
            const plain = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
            // A pasted screenshot (drawn as "[Image #1]") is one character for Backspace and Delete: right behind it (or in front of it) the
            // key removes the whole path at once, not letter by letter.
            if (plain && (e.key === 'Backspace' || e.key === 'Delete') && !t.exited) {
                const touching = t.chips.touching();
                const count = e.key === 'Backspace' ? touching.before : touching.after;
                if (count > 0) {
                    e.preventDefault();
                    post({ t: 'input', id, data: (e.key === 'Backspace' ? '\x7f' : '\x1b[3~').repeat(count) });
                    return false;
                }
            }
            // the suggestion of what you are going to type: the Right Arrow (or End) types it
            if (plain && (e.key === 'ArrowRight' || e.key === 'End')) {
                const rest = t.suggest.accept();
                if (rest) { e.preventDefault(); post({ t: 'input', id, data: rest }); return false; }
            }
            // the keys of the menu of the view: scroll to the previous / next command, go to a recent directory, run a recent command
            if (ctrl && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); scrollToCommand(t, e.key === 'ArrowUp' ? -1 : 1); return false; }
            if (ctrl && !e.shiftKey && is('KeyF', 70)) { e.preventDefault(); find.open(term.getSelection(), t); return false; }
            if (e.key === 'F3' && !e.ctrlKey && !e.altKey && !e.metaKey && find.isOpen) { e.preventDefault(); find.run(e.shiftKey ? 'previous' : 'next', false); return false; }
            if (ctrl && !e.shiftKey && is('KeyG', 71)) { e.preventDefault(); post({ t: 'action', id, action: 'recentDirectory' }); return false; }
            if (e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey && is('KeyR', 82)) { e.preventDefault(); post({ t: 'action', id, action: 'recentCommand' }); return false; }
            if (ctrl && is('KeyC', 67) && (e.shiftKey || term.hasSelection())) { copySelection(t); return false; }
            if (ctrl && e.shiftKey && is('KeyV', 86)) { pasteFromClipboard(t); return false; }
            if (ctrl && !e.shiftKey && is('KeyV', 86)) return false;           // the browser pastes, xterm.js receives the paste event
            if (e.shiftKey && is('Insert', 45)) return false;
            return true;
        });

        // The right mouse button pastes what was copied last (openconsole.rightClickPaste), as in the console window and in Windows
        // Terminal, instead of the menu of VS Code. A program that uses the mouse (pi, opencode, vim) gets the right button itself;
        // Shift + right button pastes then. The key for the menu (and anything that is not the right button) is left alone.
        el.addEventListener('contextmenu', (e) => {
            if (!config || config.rightClickPaste === false) return;
            e.preventDefault();
            e.stopPropagation();
            if (e.button !== 2 || t.exited) return;
            if (term.modes.mouseTrackingMode !== 'none' && !e.shiftKey) return;
            pasteFromClipboard(t);
        }, true);

        // A screenshot in the clipboard: the extension saves it as a file and types its path (as OpenConsole does).
        el.addEventListener('paste', (e) => {
            const data = e.clipboardData;
            if (!data || !data.files || !data.files.length || data.getData('text/plain')) return;
            const file = Array.from(data.files).find((f) => f.type.startsWith('image/'));
            if (!file) return;
            e.preventDefault();
            e.stopPropagation();
            const reader = new FileReader();
            reader.onload = () => post({ t: 'pasteImage', id, data: String(reader.result).split(',')[1] || '' });
            reader.readAsDataURL(file);
        }, true);

        // the new terminal is the shown one; the list (when there is more than one terminal) takes part of the width first
        select(t);
        post({ t: 'ready', id, cols: term.cols, rows: term.rows, token, splitOf });
        return t;
    }

    /** How long the motion of the page takes (the setting openconsole.motionSpeed): the stylesheet multiplies every duration by it. */
    function applyMotionSpeed(c) {
        const speed = Number(c && c.motionSpeed);
        document.documentElement.style.setProperty('--oc-speed', String(Number.isFinite(speed) && speed >= 0 ? Math.min(speed, 4) : 1));
    }

    function applyConfig(c) {
        config = c;
        for (const t of terminals.values()) {
            t.term.options.fontFamily = fontStack(c);
            t.term.options.fontSize = c.fontSize || 14;
            t.term.options.lineHeight = c.lineHeight || 1;
            t.term.options.cursorStyle = c.cursorStyle || 'bar';
            t.term.options.cursorBlink = !!c.cursorBlink;
            t.term.options.scrollback = c.scrollback || 1000;
            t.term.options.theme = readTheme();
            t.agent.model.minWorkMs = agentHost.minWorkMs();
            refit(t);
            t.suggest.schedule();               // the setting of the suggestions may have changed
        }
    }

    function showNotice(text) {
        notice.textContent = text;
        notice.hidden = !text;
    }

    // for the tests (test/e2e): the shown terminal, and all of them
    window.__openconsole = {
        get term() { const t = activeTerminal(); return t && t.term; },
        get patcher() { const t = activeTerminal(); return t && t.patcher; },
        get activeId() { return activeId; },
        terminals,
    };

    // time passes: an agent that was quiet for a moment is waiting for you, the numbers of the rows count
    setInterval(() => { for (const t of terminals.values()) { t.agent.tick(); t.agent.paint(); refreshIcon(t); } }, 500);
    window.addEventListener('focus', () => { const t = activeTerminal(); if (t) t.agent.looked(); });

    // follow the theme of VS Code
    new MutationObserver(() => {
        const theme = readTheme();
        for (const t of terminals.values()) t.term.options.theme = theme;
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

    // keep the terminals as large as the view
    let pending = false;
    new ResizeObserver(() => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
            pending = false;
            if (!list.hidden) setListWidth(listWidth, false);          // a narrower view leaves the terminals their room
            for (const t of terminals.values()) refit(t);
        });
    }).observe(panes);

    // ---- messages from the extension ---------------------------------------------------------------------------------

    window.addEventListener('message', (event) => {
        const m = event.data;
        const t = terminals.get(m.id);
        switch (m.t) {
            case 'config':
                applyMotionSpeed(m.config);
                if (!terminals.size) createTerminal(m.config);
                else applyConfig(m.config);
                break;
            case 'new':
                closeMenu(false);
                if (config) createTerminal(config, m.title, m.token);
                break;
            case 'menu':
                showMenu(m.items);
                break;
            case 'split':
                splitTerminal(m.id);
                break;
            case 'history':
                if (m.replace) history = [];
                addHistory(Array.isArray(m.commands) ? m.commands.filter((c) => typeof c === 'string') : []);
                break;
            case 'busy':
                if (t) {
                    t.busy = !!m.busy;
                    t.programs = Array.isArray(m.programs) ? m.programs.map(String) : [];
                    t.agent.program(Array.isArray(m.programs) ? m.programs.map(String) : (m.busy ? ['program'] : []));
                    refreshIcon(t);                    // after the agent was told: its kind is part of the icon
                    t.suggest.schedule();
                }
                break;
            case 'show':
                if (t) select(t);
                break;
            case 'renameRequest':
                if (t) post({ t: 'renameAsk', id: t.id, name: t.title });
                break;
            case 'setName':
                if (t) renameTerminal(t, m.name);
                break;
            case 'setColor':
                if (t) colorTerminal(t, m.color);
                break;
            case 'explainState':
                if (t) post({ t: 'stateExplained', id: t.id, name: t.title, ...t.agent.explain() });
                break;
            case 'scrollCommand':
                if (t) scrollToCommand(t, m.dir < 0 ? -1 : 1);
                break;
            case 'output':
                if (t) t.term.write(m.data);
                break;
            case 'find':
                if (t) { if (t.id !== activeId) select(t); find.open(t.term.getSelection(), t); }
                break;
            case 'pasteEmpty':
                if (t) pasteImageFromClipboard(t);
                break;
            case 'paste':
                if (t) {
                    if (m.image) t.chips.add(m.text);       // the path of a screenshot: it is typed, and drawn as "[Image #n]"
                    t.term.paste(m.text);
                }
                break;
            case 'exit':
                if (t) {
                    t.exited = true;
                    t.agent.exit(m.code);
                    t.term.write('\r\n\x1b[90m[The process ended' + (m.code === null || m.code === undefined ? '' : ' with code ' + m.code) + '. Press Enter to start it again.]\x1b[0m\r\n');
                }
                break;
            case 'mode':
                if (t && t.mode !== m.mode) {
                    t.mode = m.mode;
                    t.term.refresh(0, t.term.rows - 1);
                }
                break;
            case 'focus': {
                const shown = activeTerminal();
                if (shown) shown.term.focus();
                break;
            }
            case 'clear':
                if (t) t.term.clear();
                break;
            case 'reset':
                if (t) { t.exited = false; t.chips.reset(); t.suggest.hide(); t.marks = []; t.term.reset(); t.agent.reset(); }
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
