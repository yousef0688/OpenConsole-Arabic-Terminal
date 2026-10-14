/*
 * The terminals of VS Code in a browser (a phone, another computer): media/remote.html + remote.css + this file, served by src/web/server.js.
 * One WebSocket (/ws) carries every shared terminal. The owner decides the size of a terminal; this page draws it at exactly that
 * many columns and rows (xterm.js, with the same right-to-left layer as the panel: arabic-layout.js + row-patcher.js) and scales the
 * font or lets you pan, it never asks the pty to resize.
 *
 *   pairing    the link of the owner ends in #p=<secret>. The secret is read, removed from the address bar (history.replaceState) and
 *              sent once: POST /api/pair {secret, label}. The owner approves in VS Code (up to 60 s) and the answer is {token, deviceId,
 *              role}. The token is kept in localStorage (when the browser allows it), so a reload does not need a new link.
 *   page -> server   auth {token} (first) | attach {ids} | detach {ids} | input {id, data} (role 'write' only) | ping {n} | ack {id, bytes}
 *   server -> page   hello {role, terminals, limits, readOnly} | terminals {terminals} | snapshot {id, cols, rows, data} | output {id, data}
 *                    | resize {id, cols, rows} | title {id, name} | exit {id, code} | state {id, state, attention} | pong {n} | bye {reason}
 *                    | mode {id, mode} (optional: 'implicit' | 'visual' | 'words', the right-to-left mode of a terminal)
 *
 * Rules of this page (the server has the same rules on its side):
 *   - nothing that comes from the network or from a terminal is ever put into the page as HTML (textContent only); no eval; links are
 *     opened with rel="noopener noreferrer" and only when they are http or https; OSC 52 (clipboard) is not handled at all;
 *   - the answers of xterm.js to the questions of a program (device attributes, cursor position, colours...) are never sent to the shell:
 *     a read-only page has disableStdin, a page that may type drops everything that has the shape of such an answer and everything that
 *     comes out of the parser while output is written (a replayed snapshot would otherwise answer questions that are minutes old);
 *   - the page works under script-src 'self'; style-src 'self': xterm.js writes <style> elements and style attributes, which that policy
 *     blocks, so installStyleShims() routes them through CSSOM (constructable style sheets, style.cssText), which the policy allows.
 */
(function () {
    'use strict';

    // ---- the policy of the server forbids inline styles: xterm.js writes them anyway -------------------------------------------

    /**
     * xterm.js makes <style> elements with text (the colours of the theme, the size of a cell) and sets style="..." attributes with
     * setAttribute (true colour cells). Under style-src 'self' the browser refuses both. CSSOM is allowed, so: document.createElement('style')
     * gives an element that is not a <style> and puts its textContent into a constructable style sheet, and setAttribute('style') becomes
     * style.cssText.
     */
    function installStyleShims() {
        const canAdopt = 'adoptedStyleSheets' in document && typeof CSSStyleSheet === 'function' && 'replaceSync' in CSSStyleSheet.prototype;
        if (canAdopt) {
            const createElement = document.createElement;
            document.createElement = function (name, options) {
                if (typeof name === 'string' && name.toLowerCase() === 'style') return makeStyleStandIn(createElement, this);
                return createElement.call(this, name, options);
            };
        }
        const setAttribute = Element.prototype.setAttribute;
        Element.prototype.setAttribute = function (name, value) {
            if (typeof name === 'string' && name.toLowerCase() === 'style' && this.style) { this.style.cssText = String(value); return; }
            return setAttribute.call(this, name, value);
        };
    }

    /**
     * What createElement('style') gives xterm.js: not a <style> element (the browser checks the policy when one is inserted, even an empty
     * one), but an element that does nothing, whose textContent feeds a constructable style sheet of the document.
     */
    function makeStyleStandIn(createElement, owner) {
        const node = createElement.call(owner, 'x-oc-style');
        node.style.display = 'none';
        let sheet = null;
        let text = '';
        const set = (value) => {
            text = value === null || value === undefined ? '' : String(value);
            if (!sheet) {
                sheet = new CSSStyleSheet();
                document.adoptedStyleSheets = document.adoptedStyleSheets.concat(sheet);
            }
            try { sheet.replaceSync(text); } catch (e) { /* a rule that the browser does not know: the rest of the sheet is lost, the terminal still works */ }
        };
        for (const property of ['textContent', 'innerText']) Object.defineProperty(node, property, { configurable: true, get: () => text, set });
        const remove = node.remove;
        node.remove = function () {
            if (sheet) { document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet); sheet = null; }
            return remove.call(this);
        };
        return node;
    }

    installStyleShims();

    // ---- settings, texts --------------------------------------------------------------------------------------------------------

    // timings; a test may set window.__ocRemoteTiming before this file runs
    const TIMING = Object.assign({
        ping: 20000,                       // an app-level heartbeat (a browser cannot see the pings of the protocol)
        pongTimeout: 10000,
        pairTimeout: 65000,                // the server waits up to 60 s for the owner
        backoff: [500, 1000, 2000, 4000, 8000, 15000, 30000],
        jitter: 0.25,
        gesture: 120,                      // how long after a key, a touch or a click the data of the terminal counts as typed by the user
    }, window.__ocRemoteTiming || {});

    const FONT_MIN = 6, FONT_MAX = 32, AUTO_MIN = 10, AUTO_MAX = 18, FONT_DEFAULT = 14;
    const GUTTER = 14;                     // the scroll bar of xterm.js (it takes this much from the width of the terminal)
    const KEY = { session: 'oc.remote.session', font: 'oc.remote.font' };

    const LANGUAGE = /^ar\b/i.test(navigator.language || (navigator.languages && navigator.languages[0]) || '') ? 'ar' : 'en';

    const STRINGS = {
        en: {
            terminals: 'Terminals',
            pairing: 'Pairing this device…',
            pairWaiting: 'Waiting for approval in VS Code…',
            pairWaitingHint: 'Click Allow in VS Code on the computer that shares its terminals. This page waits up to 60 seconds.',
            pairSeconds: (n) => n + ' s',
            noLink: 'Open the link that VS Code shows when you start sharing. It looks like …/#p=… and works only once.',
            badLink: 'This link is not valid. Create a new one in VS Code.',
            pairDenied: 'The owner did not allow this device.',
            pairExpired: 'This link has expired or was already used. Create a new one in VS Code.',
            pairRate: 'Too many attempts. Wait a minute and use a new link.',
            pairNetwork: 'Cannot reach the computer. Check that sharing is still on and that this device can reach it.',
            pairNoAnswer: 'No answer from VS Code. Create a new link and try again.',
            pairFailed: 'Pairing failed.',
            sessionEnded: 'This device is no longer signed in. Open a new link from VS Code.',
            revoked: 'The owner removed this device. Open a new link from VS Code to connect again.',
            forbidden: 'This device is not allowed to connect.',
            useSaved: 'Use the saved session',
            connecting: 'Connecting…',
            reconnecting: (n) => 'Disconnected. Reconnecting in ' + n + ' s…',
            reconnectingNow: 'Disconnected. Reconnecting…',
            serverClosed: (reason) => 'The server closed the connection: ' + reason,
            retry: 'Retry now',
            connected: 'Connected',
            disconnected: 'Disconnected',
            readOnly: 'Read-only',
            canType: 'Can type',
            noTerminals: 'No terminals are shared right now.',
            exited: (code) => 'The process ended' + (code === null || code === undefined ? '' : ' with code ' + code) + '.',
            fontSmaller: 'Smaller text',
            fontLarger: 'Larger text',
            fontFit: 'Fit to width',
            keysLabel: 'Extra keys',
            keyboard: 'Keyboard',
            attention: 'needs attention',
        },
        ar: {
            terminals: 'الطرفيات',
            pairing: 'جارٍ إقران هذا الجهاز…',
            pairWaiting: 'بانتظار الموافقة في VS Code…',
            pairWaitingHint: 'اضغط «سماح» في VS Code على الحاسوب الذي يشارك طرفياته. تنتظر هذه الصفحة حتى 60 ثانية.',
            pairSeconds: (n) => n + ' ث',
            noLink: 'افتح الرابط الذي يعرضه VS Code عند بدء المشاركة. شكله …/#p=… ويعمل مرة واحدة فقط.',
            badLink: 'هذا الرابط غير صالح. أنشئ رابطاً جديداً من VS Code.',
            pairDenied: 'لم يسمح المالك لهذا الجهاز.',
            pairExpired: 'انتهت صلاحية هذا الرابط أو سبق استخدامه. أنشئ رابطاً جديداً من VS Code.',
            pairRate: 'محاولات كثيرة. انتظر دقيقة ثم استخدم رابطاً جديداً.',
            pairNetwork: 'تعذّر الوصول إلى الحاسوب. تأكد أن المشاركة ما زالت تعمل وأن هذا الجهاز يستطيع الوصول إليه.',
            pairNoAnswer: 'لا إجابة من VS Code. أنشئ رابطاً جديداً وحاول مجدداً.',
            pairFailed: 'فشل الإقران.',
            sessionEnded: 'لم يعد هذا الجهاز مسجّل الدخول. افتح رابطاً جديداً من VS Code.',
            revoked: 'أزال المالك هذا الجهاز. افتح رابطاً جديداً من VS Code للاتصال مجدداً.',
            forbidden: 'غير مسموح لهذا الجهاز بالاتصال.',
            useSaved: 'استخدم الجلسة المحفوظة',
            connecting: 'جارٍ الاتصال…',
            reconnecting: (n) => 'انقطع الاتصال. إعادة المحاولة بعد ' + n + ' ثانية…',
            reconnectingNow: 'انقطع الاتصال. جارٍ إعادة المحاولة…',
            serverClosed: (reason) => 'أغلق الخادم الاتصال: ' + reason,
            retry: 'أعد المحاولة الآن',
            connected: 'متصل',
            disconnected: 'غير متصل',
            readOnly: 'للقراءة فقط',
            canType: 'يمكنه الكتابة',
            noTerminals: 'لا توجد طرفيات مشتركة الآن.',
            exited: (code) => 'انتهت العملية' + (code === null || code === undefined ? '' : ' بالرمز ' + code) + '.',
            fontSmaller: 'نص أصغر',
            fontLarger: 'نص أكبر',
            fontFit: 'ملاءمة العرض',
            keysLabel: 'مفاتيح إضافية',
            keyboard: 'لوحة المفاتيح',
            attention: 'تحتاج انتباهاً',
        },
    };
    const S = STRINGS[LANGUAGE];

    // ---- small helpers ------------------------------------------------------------------------------------------------------------

    const $ = (id) => document.getElementById(id);
    const now = () => (window.performance && performance.now ? performance.now() : Date.now());
    const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

    function make(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    // localStorage can be missing, full or forbidden (a private window, blocked site data): the page works without it
    const store = {
        get(key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } },
        set(key, value) { try { window.localStorage.setItem(key, value); return true; } catch (e) { return false; } },
        remove(key) { try { window.localStorage.removeItem(key); } catch (e) { /* not available */ } },
    };

    /** Text for a tab or a message: no control characters, no characters that reorder or hide text, at most 80 characters. */
    function plain(value, max) {
        return String(value === null || value === undefined ? '' : value)
            .replace(/[\u0000-\u001f\u007f-\u009f​-\u200f\u202a-\u202e\u2066-\u2069﻿]/g, '')
            .trim()
            .slice(0, max || 80);
    }

    const isInt = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;

    function utf8Length(text) {
        let n = 0;
        for (let i = 0; i < text.length; i++) {
            const c = text.charCodeAt(i);
            if (c < 0x80) n += 1;
            else if (c < 0x800) n += 2;
            else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
            else n += 3;
        }
        return n;
    }

    function describeBrowser() {
        const ua = navigator.userAgent || '';
        const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\/|FxiOS/.test(ua) ? 'Firefox' : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
        const system = /Android/.test(ua) ? 'Android' : /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
        return (browser + (system ? ' on ' + system : '')).slice(0, 80);
    }

    // ---- the page ----------------------------------------------------------------------------------------------------------------

    const app = $('app');
    const pairScreen = $('pair');
    const pairText = $('pair-text');
    const pairHint = $('pair-hint');
    const pairSpinner = $('pair-spinner');
    const pairContinue = $('pair-continue');
    const mainScreen = $('main');
    const tabsEl = $('tabs');
    const connEl = $('conn');
    const badge = $('badge');
    const banner = $('banner');
    const bannerText = $('banner-text');
    const bannerRetry = $('banner-retry');
    const stage = $('stage');
    const host = $('term-host');
    const emptyEl = $('empty');
    const keysEl = $('keys');

    document.documentElement.lang = LANGUAGE;
    if (LANGUAGE === 'ar') {
        // only the frame is right to left; the terminal (#stage) and the extra keys keep their own direction
        for (const el of [pairScreen, $('bar'), banner, emptyEl]) el.setAttribute('dir', 'rtl');
    }
    for (const el of document.querySelectorAll('[data-i18n]')) { const text = S[el.getAttribute('data-i18n')]; if (typeof text === 'string') el.textContent = text; }
    for (const el of document.querySelectorAll('[data-i18n-label]')) {
        const text = S[el.getAttribute('data-i18n-label')];
        if (typeof text === 'string') { el.setAttribute('aria-label', text); el.setAttribute('title', text); }
    }

    // ---- the state ---------------------------------------------------------------------------------------------------------------

    let session = null;                    // { token, deviceId, role } of this browser
    let role = 'read';
    let canWrite = false;                  // role 'write' and the server did not say read-only
    let limits = { input: 16384 };
    const terminals = new Map();           // id -> { id, name, cols, rows, state, attention, exited, mode }
    let activeId = null;
    let shownEmpty = false;

    const stats = { dropped: [], inputSent: 0, snapshots: 0, reconnects: 0, closes: [] };    // for the tests
    const drop = (data) => { stats.dropped.push(data); if (stats.dropped.length > 50) stats.dropped.shift(); };

    // ---- screens -----------------------------------------------------------------------------------------------------------------

    function showPair(kind, text, hint, options) {
        const opts = options || {};
        mainScreen.hidden = true;
        pairScreen.hidden = false;
        pairScreen.classList.toggle('error', kind === 'error');
        pairText.textContent = text;
        pairHint.textContent = hint || '';
        pairSpinner.hidden = !opts.spinner;
        pairContinue.hidden = !(kind === 'error' && session && opts.canContinue !== false);
        applyViewport();
    }

    function showMain() {
        pairScreen.hidden = true;
        mainScreen.hidden = false;
        applyViewport();
        scheduleLayout();
    }

    // ---- banner, connection light, role badge -----------------------------------------------------------------------------------

    function setBanner(text, kind, retry) {
        banner.hidden = !text;
        bannerText.textContent = text || '';
        banner.classList.toggle('info', kind === 'info');
        bannerRetry.hidden = !retry;
        stage.classList.toggle('stale', !!text && kind !== 'info');
        scheduleLayout();
    }

    function setLight(kind) {
        connEl.className = 'conn' + (kind === 'ok' ? ' ok' : kind === 'bad' ? ' bad' : '');
        connEl.setAttribute('aria-label', kind === 'ok' ? S.connected : kind === 'bad' ? S.disconnected : S.connecting);
    }

    function setRole(newRole, readOnly) {
        role = newRole === 'write' ? 'write' : 'read';
        canWrite = role === 'write' && readOnly !== true;
        badge.textContent = canWrite ? S.canType : S.readOnly;
        badge.classList.toggle('write', canWrite);
        keysEl.hidden = !canWrite;
        applyInputMode();
        applyViewport();
    }

    // ---- the terminal ------------------------------------------------------------------------------------------------------------

    let term = null;
    let patcher = null;
    let fontAuto = true;
    let userFont = FONT_DEFAULT;
    let currentFont = FONT_DEFAULT;
    let writing = 0;                       // writes to xterm.js that are not parsed yet
    let muted = 0;                         // snapshots that are being replayed
    let generation = 0;                    // changes when the counters above are reset (a callback of an older write must not count)
    let lastGesture = -1e9;                // when the user last touched the terminal (key, paste, mouse, touch, focus)
    let received = new Map();              // id -> bytes that this connection delivered (for the acknowledgements)
    let acked = new Map();

    try {
        const saved = Number(store.get(KEY.font));
        if (Number.isFinite(saved) && saved >= FONT_MIN && saved <= FONT_MAX) { userFont = saved; fontAuto = false; }
    } catch (e) { /* the default */ }

    // Text for the cells: the first font decides the size of a cell, so the fixed-width ones come first; the fonts for Arabic and Hebrew
    // follow (before the generic family, which on some systems is a font that draws them squeezed).
    const FONT_STACK = ["'Cascadia Mono'", 'Consolas', 'Menlo', "'SF Mono'", "'DejaVu Sans Mono'", "'Roboto Mono'", "'Noto Sans Mono'", "'Droid Sans Mono'", "'Liberation Mono'", 'monospace',
        "'Segoe UI'", "'Noto Naskh Arabic'", "'Noto Sans Arabic'", "'Geeza Pro'", 'Tahoma', 'sans-serif'].join(', ');

    const THEME = {
        background: '#1e1e1e', foreground: '#cccccc', cursor: '#cccccc', cursorAccent: '#1e1e1e',
        selectionBackground: '#264f78', selectionInactiveBackground: '#3a3d41',
        black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510', blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
        brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#e5e5e5',
    };

    /** The shapes that xterm.js answers a question of a program with (and that no key of a keyboard has). */
    const REPLY_SHAPES = [
        /^\x1b\[[?>]?[\d;]*c$/,                  // device attributes (DA1, DA2)
        /^\x1b\[\d+;\d+R$/,                      // cursor position
        /^\x1b\[\?\d+;\d+R$/,                    // cursor position (DECXCPR)
        /^\x1b\](10|11|12|4);/,                  // colours
        /^\x1bP[>!]?\|/,                         // terminal name and version
        /^\x1b\[\d+(;\d+){1,2}t$/,               // window size reports
        /^\x1b\[\??[\d;]+\$y$/,                  // mode reports
        /^\x1bP[01]\$r/,                         // status string reports
        /^\x1b\[0n$/,                            // "terminal is fine"
        /^\x1b\[\?\d+u$/,                        // keyboard protocol flags
    ];
    const isReply = (data) => REPLY_SHAPES.some((shape) => shape.test(data));

    function cellSize() {
        if (!term) return null;
        const core = term._core;
        const dims = core && core._renderService && core._renderService.dimensions;
        if (dims && dims.css && dims.css.cell && dims.css.cell.width && dims.css.cell.height) return { w: dims.css.cell.width, h: dims.css.cell.height };
        const screen = term.element && term.element.querySelector('.xterm-screen');
        if (screen && term.cols && term.rows) {
            const r = screen.getBoundingClientRect();
            if (r.width && r.height) return { w: r.width / term.cols, h: r.height / term.rows };
        }
        return null;
    }

    function ensureTerminal(cols, rows) {
        if (term) return;
        term = new Terminal({
            allowProposedApi: true,
            cols,
            rows,
            fontFamily: FONT_STACK,
            fontSize: fontAuto ? FONT_DEFAULT : userFont,
            lineHeight: 1,
            cursorStyle: 'bar',
            cursorInactiveStyle: 'outline',
            cursorBlink: false,
            scrollback: 5000,
            theme: THEME,
            windowsPty: { backend: 'conpty', buildNumber: 22621 },
            fontWeight: 'normal',
            fontWeightBold: 'bold',
            macOptionIsMeta: false,
            rightClickSelectsWord: false,
            drawBoldTextInBrightColors: true,
            disableStdin: !canWrite,
            linkHandler: { allowNonHttpProtocols: false, activate: (event, text) => { if (shouldOpen(event)) openExternal(text); } },
        });
        const unicode = new Unicode11Addon.Unicode11Addon();
        term.loadAddon(unicode);
        term.unicode.activeVersion = '11';
        term.open(host);
        patcher = new OCRowPatcher(term, () => (terminals.get(activeId) || {}).mode || 'implicit');
        patcher.start();
        currentFont = term.options.fontSize;

        term.onData(handleTermData);
        // a terminal that does not have a stdin never gets here, and the legacy mouse reports (bytes above 127) would be sent as text
        term.onBinary(() => { /* not forwarded: the server takes text */ });
        term.parser.registerOscHandler(52, () => true);      // the clipboard is not read or written by the terminal of the owner
        term.registerLinkProvider(linkProvider());
        term.attachCustomKeyEventHandler(keyHandler);

        // what counts as typed by the user (see handleTermData)
        const touch = () => { lastGesture = now(); };
        for (const type of ['keydown', 'keypress', 'beforeinput', 'input', 'paste', 'cut', 'compositionstart', 'compositionupdate', 'compositionend',
            'mousedown', 'mouseup', 'mousemove', 'wheel', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'focus', 'blur', 'focusin', 'focusout']) {
            host.addEventListener(type, touch, true);
        }
        applyInputMode();
        layoutTerminal();
    }

    function applyInputMode() {
        if (!term) return;
        term.options.disableStdin = !canWrite;
        if (term.textarea) {
            // a read-only page has no use for the soft keyboard
            term.textarea.setAttribute('inputmode', canWrite ? 'text' : 'none');
            term.textarea.setAttribute('enterkeyhint', 'enter');
        }
    }

    /** Ctrl + C copies a selection (and Ctrl + Shift + C always); everything else is for the terminal. */
    function keyHandler(event) {
        if (event.type !== 'keydown') return true;
        const key = event.key && event.key.toLowerCase();
        if ((event.ctrlKey || event.metaKey) && !event.altKey && key === 'c' && (event.shiftKey || term.hasSelection())) {
            copySelection();
            return false;
        }
        return true;
    }

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
            try { document.execCommand('copy'); } catch (e) { /* not allowed */ }
            area.remove();
            if (canWrite) term.focus();
        };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(fallback);
        else fallback();
    }

    // ---- what the terminal sends -------------------------------------------------------------------------------------------------

    /**
     * The data that xterm.js produces: keys, paste, mouse reports... and the answers to the questions of the program that it parses.
     * Only the first kind is for the shell: the answers are dropped by their shape, and so is anything that comes out of the parser
     * (a write is pending) when the user did not just touch the terminal. While a snapshot is replayed nothing goes out.
     */
    function handleTermData(data) {
        if (!canWrite || typeof data !== 'string' || !data) return;
        if (isReply(data)) { drop(data); return; }
        if (muted > 0) { drop(data); return; }
        if (writing > 0 && now() - lastGesture > TIMING.gesture) { drop(data); return; }
        sendInput(applyStickyKeys(data));
    }

    function sendInput(data) {
        if (!canWrite || activeId === null || typeof data !== 'string' || !data) return false;
        const room = Math.max(256, Math.min(16384, Number(limits && limits.input) || 16384));
        const step = Math.max(64, Math.floor(room / 4));       // characters; a character is at most 4 bytes
        let ok = true;
        for (let i = 0; i < data.length;) {
            let end = Math.min(data.length, i + step);
            if (end < data.length) { const c = data.charCodeAt(end - 1); if (c >= 0xd800 && c <= 0xdbff) end--; }     // not between the halves of a pair
            ok = send({ t: 'input', id: activeId, data: data.slice(i, end) }) && ok;
            i = end;
        }
        if (ok) stats.inputSent++;
        return ok;
    }

    // ---- sticky Ctrl and Alt, the extra keys -------------------------------------------------------------------------------------

    const mods = { ctrl: 0, alt: 0 };      // 0 off, 1 for the next key, 2 locked (a second tap in a row)
    const modTapped = { ctrl: 0, alt: 0 };

    function ctrlChar(ch) {
        if (/^[a-zA-Z]$/.test(ch)) return String.fromCharCode(ch.toUpperCase().charCodeAt(0) - 64);
        switch (ch) {
            case '[': return '\x1b';
            case '\\': case '|': return '\x1c';
            case ']': return '\x1d';
            case '^': case '~': return '\x1e';
            case '_': case '-': case '/': return '\x1f';
            case '@': case ' ': return '\x00';
            case '?': return '\x7f';
            default: return ch;
        }
    }

    function renderMods() {
        for (const name of ['ctrl', 'alt']) {
            const button = keysEl.querySelector('[data-k="' + name + '"]');
            if (!button) continue;
            button.setAttribute('aria-pressed', mods[name] ? 'true' : 'false');
            button.classList.toggle('locked', mods[name] === 2);
        }
    }

    function releaseMods() {
        let changed = false;
        for (const name of ['ctrl', 'alt']) if (mods[name] === 1) { mods[name] = 0; changed = true; }
        if (changed) renderMods();
    }

    /** One typed character while Ctrl or Alt of the bar is on: the control character, or the character after Escape. */
    function applyStickyKeys(data) {
        if (!mods.ctrl && !mods.alt) return data;
        const chars = Array.from(data);
        if (chars.length !== 1) return data;
        let out = chars[0];
        if (mods.ctrl) out = ctrlChar(out);
        if (mods.alt) out = '\x1b' + out;
        releaseMods();
        return out;
    }

    function cursorKeys() { return !!(term && term.modes && term.modes.applicationCursorKeysMode); }

    /** The bytes of a key of the bar, with the Ctrl and Alt that are on (xterm's way: CSI 1 ; m final, m = 1 + Alt 2 + Ctrl 4). */
    function sequenceFor(name) {
        const m = 1 + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);
        const letters = { up: 'A', down: 'B', right: 'C', left: 'D', home: 'H', end: 'F' };
        if (letters[name]) return m > 1 ? '\x1b[1;' + m + letters[name] : (cursorKeys() ? '\x1bO' : '\x1b[') + letters[name];
        if (name === 'pgup') return m > 1 ? '\x1b[5;' + m + '~' : '\x1b[5~';
        if (name === 'pgdn') return m > 1 ? '\x1b[6;' + m + '~' : '\x1b[6~';
        if (name === 'esc') return mods.alt ? '\x1b\x1b' : '\x1b';
        if (name === 'tab') return '\t';
        return '';
    }

    function pressExtra(button) {
        if (!canWrite) return;
        const name = button.getAttribute('data-k');
        const ch = button.getAttribute('data-ch');
        if (name === 'ctrl' || name === 'alt') {
            const t = now();
            if (mods[name] === 0) { mods[name] = 1; modTapped[name] = t; }
            else if (mods[name] === 1 && t - modTapped[name] < 600) mods[name] = 2;
            else mods[name] = 0;
            renderMods();
            return;
        }
        if (name === 'kbd') {
            if (!term) return;
            if (term.textarea && document.activeElement === term.textarea) term.textarea.blur(); else term.focus();
            return;
        }
        let data;
        if (ch) {
            data = ch;
            if (mods.ctrl) data = ctrlChar(data);
            if (mods.alt) data = '\x1b' + data;
        } else data = sequenceFor(name);
        if (data) sendInput(data);
        releaseMods();
    }

    // press: acts at once (no 300 ms wait), keeps the focus in the terminal (the soft keyboard stays), and an arrow repeats while held
    const REPEAT = new Set(['up', 'down', 'left', 'right', 'pgup', 'pgdn']);
    let repeat = { timer: 0, button: null };

    function stopRepeat() {
        clearTimeout(repeat.timer);
        clearInterval(repeat.timer);
        repeat.timer = 0;
        if (repeat.button) repeat.button.classList.remove('held');
        repeat.button = null;
    }

    keysEl.addEventListener('pointerdown', (e) => {
        const button = e.target.closest && e.target.closest('button');
        if (!button || !keysEl.contains(button) || e.button > 0) return;
        e.preventDefault();
        pressExtra(button);
        if (REPEAT.has(button.getAttribute('data-k'))) {
            stopRepeat();
            repeat.button = button;
            button.classList.add('held');
            repeat.timer = setTimeout(() => { repeat.timer = setInterval(() => pressExtra(button), 70); }, 400);
        }
    });
    keysEl.addEventListener('mousedown', (e) => e.preventDefault());
    keysEl.addEventListener('click', (e) => {
        const button = e.target.closest && e.target.closest('button');
        if (button && e.detail === 0) pressExtra(button);        // the keyboard (Enter, Space on a focused button); a press was handled above
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) window.addEventListener(type, stopRepeat, true);
    window.addEventListener('blur', stopRepeat);

    // ---- links -------------------------------------------------------------------------------------------------------------------

    let lastPointerType = 'mouse';
    host.addEventListener('pointerdown', (e) => { lastPointerType = e.pointerType || 'mouse'; }, true);

    /** Opens an address (http or https only) in a new tab, without letting that page reach this one. */
    function openExternal(text) {
        let url;
        try { url = new URL(String(text)); } catch (e) { return false; }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
        const a = document.createElement('a');
        a.href = url.href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.referrerPolicy = 'no-referrer';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
        return true;
    }

    /** A touch opens a link with a tap; with a mouse it takes Ctrl (or Cmd) + click, as in the terminal of VS Code, so that selecting text still works. */
    const shouldOpen = (event) => !!event && (event.ctrlKey || event.metaKey || lastPointerType === 'touch' || lastPointerType === 'pen');

    const URL_PATTERN = /https?:\/\/[^\s<>"'`\u0000-\u001f\u007f-\u009f]+/g;

    /** The addresses in the text of the terminal (also when one runs over several rows): a tap on a touch screen, Ctrl + click with a mouse. */
    function linkProvider() {
        return {
            provideLinks(bufferLine, callback) {
                try { callback(findLinks(bufferLine)); } catch (e) { callback(undefined); }
            },
        };
    }

    function findLinks(bufferLine) {
        const buffer = term.buffer.active;
        let first = bufferLine - 1;
        while (first > 0 && buffer.getLine(first) && buffer.getLine(first).isWrapped) first--;
        let last = first;
        while (buffer.getLine(last + 1) && buffer.getLine(last + 1).isWrapped) last++;
        if (bufferLine - 1 < first || bufferLine - 1 > last) return undefined;
        // the text of the rows that belong together, and the cell of every character of it
        let text = '';
        const cells = [];
        const cell = buffer.getNullCell();
        for (let y = first; y <= last; y++) {
            const line = buffer.getLine(y);
            if (!line) break;
            for (let x = 0; x < term.cols; x++) {
                const c = line.getCell(x, cell);
                if (!c || c.getWidth() === 0) continue;
                const chars = c.getChars() || ' ';
                for (let k = 0; k < chars.length; k++) cells.push({ x, y, width: c.getWidth() });
                text += chars;
            }
        }
        const links = [];
        URL_PATTERN.lastIndex = 0;
        let match;
        while ((match = URL_PATTERN.exec(text))) {
            const uri = match[0].replace(/[.,;:!?)\]}>'"]+$/, '');
            if (uri.length < 9) continue;
            const a = cells[match.index];
            const b = cells[match.index + uri.length - 1];
            if (!a || !b) continue;
            if (a.y + 1 > bufferLine || b.y + 1 < bufferLine) continue;      // only the links that touch this row
            links.push({
                range: { start: { x: a.x + 1, y: a.y + 1 }, end: { x: b.x + b.width, y: b.y + 1 } },
                text: uri,
                decorations: { pointerCursor: true, underline: true },
                activate: (event, address) => { if (shouldOpen(event)) openExternal(address); },
            });
        }
        return links.length ? links : undefined;
    }

    // ---- size and font -----------------------------------------------------------------------------------------------------------

    let layoutFrame = 0;
    function scheduleLayout() {
        if (layoutFrame) return;
        layoutFrame = requestAnimationFrame(() => { layoutFrame = 0; layoutTerminal(); });
    }

    let pinnedBottom = true;
    stage.addEventListener('scroll', () => { pinnedBottom = stage.scrollHeight - stage.clientHeight - stage.scrollTop < 6; }, { passive: true });

    /**
     * The terminal has the columns and rows of the owner. Its font is the largest one (between AUTO_MIN and AUTO_MAX) with which all of
     * it fits in the stage, or the size that was chosen with the buttons or a pinch; what does not fit is reached by panning.
     */
    function layoutTerminal() {
        if (!term || mainScreen.hidden) return;
        // the size of the stage without its scroll bars (they come and go with the size of the terminal: measuring them would flip-flop)
        const availW = stage.offsetWidth - 6 - 2;
        const availH = stage.offsetHeight - 4;
        if (availW <= 0 || availH <= 0) return;
        const fits = (size) => {
            const c = cellSize();
            return !!c && term.cols * c.w + GUTTER <= availW + 0.5 && term.rows * c.h <= availH + 0.5;
        };
        const setFont = (size) => { if (term.options.fontSize !== size) term.options.fontSize = size; };
        if (fontAuto) {
            let size = clamp(currentFont, AUTO_MIN, AUTO_MAX);
            setFont(size);
            const c = cellSize();
            if (c) {
                // proportional first guess from the width of a cell, then step down (half pixels) until everything fits
                const ratio = c.w / size;
                const byWidth = (availW - GUTTER) / (term.cols * ratio);
                const byHeight = availH / (term.rows * (c.h / size));
                size = clamp(Math.floor(Math.min(byWidth, byHeight) * 2) / 2, AUTO_MIN, AUTO_MAX);
                setFont(size);
                for (let i = 0; i < 12 && size > AUTO_MIN && !fits(size); i++) { size -= 0.5; setFont(size); }
            }
            currentFont = size;
        } else {
            currentFont = clamp(userFont, FONT_MIN, FONT_MAX);
            setFont(currentFont);
        }
        const c = cellSize();
        if (c) {
            const width = Math.ceil(term.cols * c.w + GUTTER), height = Math.ceil(term.rows * c.h);
            host.style.width = width + 'px';
            host.style.height = height + 'px';
            stage.classList.toggle('pan', width > availW + 0.5 || height > availH + 0.5);       // scroll bars only when something is out of sight
        }
        if (pinnedBottom) stage.scrollTop = stage.scrollHeight;
    }

    function setUserFont(size, keepPoint) {
        const before = host.getBoundingClientRect();
        userFont = clamp(Math.round(size * 2) / 2, FONT_MIN, FONT_MAX);
        fontAuto = false;
        store.set(KEY.font, String(userFont));
        layoutTerminal();
        if (keepPoint && before.width && before.height) {
            // the point of the terminal under the fingers stays under them
            const after = host.getBoundingClientRect();
            const fx = (keepPoint.x - before.left) / before.width;
            const fy = (keepPoint.y - before.top) / before.height;
            stage.scrollLeft += (after.left + fx * after.width) - keepPoint.x;
            stage.scrollTop += (after.top + fy * after.height) - keepPoint.y;
        }
    }

    function fitFont() {
        fontAuto = true;
        store.remove(KEY.font);
        layoutTerminal();
    }

    $('font-down').addEventListener('click', () => setUserFont(currentFont - 1));
    $('font-up').addEventListener('click', () => setUserFont(currentFont + 1));
    $('font-fit').addEventListener('click', fitFont);

    function applyViewport() {
        const vv = window.visualViewport;
        if (!vv) return;
        app.style.left = vv.offsetLeft + 'px';
        app.style.top = vv.offsetTop + 'px';
        app.style.width = vv.width + 'px';
        app.style.height = vv.height + 'px';
    }

    let viewportFrame = 0;
    function onViewportChange() {
        if (viewportFrame) return;
        viewportFrame = requestAnimationFrame(() => { viewportFrame = 0; applyViewport(); scheduleLayout(); });
    }
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', onViewportChange);
        window.visualViewport.addEventListener('scroll', onViewportChange);
    }
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('orientationchange', onViewportChange);
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => scheduleLayout()).observe(stage);
    applyViewport();

    // ---- touch: one finger scrolls (and pans), two fingers change the font, a tap focuses ---------------------------------------

    const pointers = new Map();
    let gesture = null;

    function wheelAt(x, y, deltaY) {
        if (!term || !term.element) return;
        term.element.dispatchEvent(new WheelEvent('wheel', { deltaY, deltaMode: 0, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    }

    function panBy(dx, dy, x, y) {
        stage.scrollLeft -= dx;
        // vertical: first the part of the terminal that is out of the stage (the soft keyboard made it short), then the scrollback
        const before = stage.scrollTop;
        stage.scrollTop = clamp(before - dy, 0, Math.max(0, stage.scrollHeight - stage.clientHeight));
        const rest = dy - (before - stage.scrollTop);
        if (!rest || !term) return;
        const c = cellSize();
        gesture.carry += rest;
        const lines = Math.trunc(gesture.carry / (c ? c.h : 16));
        if (!lines) return;
        gesture.carry -= lines * (c ? c.h : 16);
        const alternate = term.buffer.active.type === 'alternate';
        if (alternate || term.modes.mouseTrackingMode !== 'none') wheelAt(x, y, -lines * (c ? c.h : 16));
        else term.scrollLines(-lines);
    }

    stage.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'touch') return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        try { stage.setPointerCapture(e.pointerId); } catch (err) { /* not an active pointer */ }
        if (pointers.size === 1) gesture = { type: 'pan', x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, moved: false, carry: 0 };
        else if (pointers.size === 2) {
            const [a, b] = Array.from(pointers.values());
            gesture = { type: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, font: currentFont, frame: 0 };
        }
    });

    stage.addEventListener('pointermove', (e) => {
        const p = pointers.get(e.pointerId);
        if (!p || !gesture) return;
        const dx = e.clientX - p.x, dy = e.clientY - p.y;
        p.x = e.clientX; p.y = e.clientY;
        if (gesture.type === 'pan' && pointers.size === 1) {
            if (!gesture.moved && Math.hypot(e.clientX - gesture.startX, e.clientY - gesture.startY) < 10) return;      // a tap, not a drag
            gesture.moved = true;
            panBy(dx, dy, e.clientX, e.clientY);
        } else if (gesture.type === 'pinch' && pointers.size === 2) {
            const [a, b] = Array.from(pointers.values());
            const dist = Math.hypot(a.x - b.x, a.y - b.y);
            const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            const g = gesture;
            if (g.frame) cancelAnimationFrame(g.frame);
            g.frame = requestAnimationFrame(() => { g.frame = 0; setUserFont(g.font * dist / g.dist, center); });
        }
    });

    function endPointer(e) {
        if (!pointers.has(e.pointerId)) return;
        pointers.delete(e.pointerId);
        const g = gesture;
        if (g && g.type === 'pan' && !g.moved && e.type === 'pointerup' && canWrite && term) term.focus();
        if (pointers.size === 0) { if (g && g.frame) cancelAnimationFrame(g.frame); gesture = null; }
        else if (g && g.type === 'pinch') gesture = { type: 'idle', carry: 0 };        // no more scrolling until every finger is up
    }
    stage.addEventListener('pointerup', endPointer);
    stage.addEventListener('pointercancel', endPointer);

    // ---- terminals, tabs ---------------------------------------------------------------------------------------------------------

    function renderTabs() {
        tabsEl.textContent = '';
        for (const t of terminals.values()) {
            const tab = make('button', 'tab' + (t.exited ? ' exited' : '') + (t.attention ? ' attention' : ''));
            tab.type = 'button';
            tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-selected', t.id === activeId ? 'true' : 'false');
            tab.dataset.id = String(t.id);
            tab.title = t.name;
            const dot = make('span', 'dot');
            if (t.state) dot.setAttribute('data-state', t.state);
            tab.appendChild(dot);
            const name = make('span', 'name', t.name);
            name.setAttribute('dir', 'auto');
            tab.appendChild(name);
            if (t.attention) tab.setAttribute('aria-description', S.attention);
            tab.addEventListener('click', () => switchTo(t.id));
            tabsEl.appendChild(tab);
        }
        const selected = tabsEl.querySelector('[aria-selected="true"]');
        if (selected && selected.scrollIntoView) selected.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    function showEmpty(show) {
        shownEmpty = show;
        emptyEl.hidden = !show;
        emptyEl.textContent = show ? S.noTerminals : '';
        host.hidden = show;
    }

    function readTerminal(entry) {
        if (!entry || typeof entry !== 'object') return null;
        if (!isInt(entry.id, 0, 1e9) || !isInt(entry.cols, 1, 1000) || !isInt(entry.rows, 1, 500)) return null;
        const mode = entry.mode === 'visual' || entry.mode === 'words' || entry.mode === 'implicit' ? entry.mode : undefined;
        return { id: entry.id, name: plain(entry.name) || 'terminal', cols: entry.cols, rows: entry.rows, mode };
    }

    function stateName(value) {
        return typeof value === 'string' && /^[a-z][a-z-]{0,19}$/.test(value) ? value : '';
    }

    /** The list of the server: keeps what the page knows (state, exit) about the terminals that are still there. */
    function setTerminals(list) {
        const next = new Map();
        for (const raw of Array.isArray(list) ? list : []) {
            const entry = readTerminal(raw);
            if (!entry) continue;
            const old = terminals.get(entry.id);
            next.set(entry.id, Object.assign({ state: '', attention: false, exited: false }, old || {}, entry, { mode: entry.mode || (old && old.mode) }));
        }
        terminals.clear();
        for (const [id, entry] of next) terminals.set(id, entry);
        const gone = activeId === null || !terminals.has(activeId);
        if (gone) {
            const first = terminals.keys().next();
            activeId = first.done ? null : first.value;
        }
        renderTabs();
        showEmpty(terminals.size === 0);
        return gone;
    }

    function resetCounters() {
        writing = 0;
        muted = 0;
        generation++;
    }

    /** Shows the terminal that is active: empty at its size, until the snapshot of the server comes. */
    function showActive() {
        const t = terminals.get(activeId);
        if (!t) return;
        ensureTerminal(t.cols, t.rows);
        resetCounters();
        term.reset();
        applySize(t.cols, t.rows);
        if (patcher) patcher.patchAll();
        if (canWrite) term.focus();
    }

    function applySize(cols, rows) {
        if (!term) return;
        if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
        layoutTerminal();
    }

    function attachActive() {
        if (activeId !== null) send({ t: 'attach', ids: [activeId] });
    }

    function switchTo(id) {
        if (id === activeId || !terminals.has(id)) return;
        if (activeId !== null) send({ t: 'detach', ids: [activeId] });
        activeId = id;
        renderTabs();
        showActive();
        pinnedBottom = true;
        attachActive();
    }

    /** Writes the text of a terminal to xterm.js; while it is parsed, what xterm.js sends back is not typed by anyone. */
    function writeToTerminal(data, isSnapshot, then) {
        if (!term) return;
        const g = generation;
        if (isSnapshot) muted++; else writing++;
        term.write(data, () => {
            if (g === generation) { if (isSnapshot) muted--; else writing--; }
            if (then) then();
        });
    }

    /** Tells the server how much arrived, so that it can slow down a client that is behind (in steps of 32 KiB). */
    function countBytes(id, bytes) {
        received.set(id, (received.get(id) || 0) + bytes);
    }

    function maybeAck(id) {
        const total = received.get(id) || 0;
        if (total - (acked.get(id) || 0) >= 32768) {
            acked.set(id, total);
            send({ t: 'ack', id, bytes: total });
        }
    }

    // ---- messages of the server --------------------------------------------------------------------------------------------------

    function onMessage(m) {
        if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
        switch (m.t) {
            case 'hello': return onHello(m);
            case 'terminals': {
                const changed = setTerminals(m.terminals);
                if (activeId === null) { if (term) { resetCounters(); term.reset(); } return; }
                if (changed) { showActive(); pinnedBottom = true; attachActive(); return; }
                const t = terminals.get(activeId);
                if (t) applySize(t.cols, t.rows);
                return;
            }
            case 'snapshot': {
                if (m.id !== activeId || typeof m.data !== 'string' || !isInt(m.cols, 1, 1000) || !isInt(m.rows, 1, 500)) return;
                const t = terminals.get(m.id);
                if (t) { t.cols = m.cols; t.rows = m.rows; }
                ensureTerminal(m.cols, m.rows);
                resetCounters();
                term.reset();
                applySize(m.cols, m.rows);
                stats.snapshots++;
                countBytes(m.id, utf8Length(m.data));
                writeToTerminal(m.data, true, () => { pinnedBottom = true; term.scrollToBottom(); layoutTerminal(); maybeAck(m.id); });
                return;
            }
            case 'output': {
                if (m.id !== activeId || typeof m.data !== 'string' || !term) return;
                countBytes(m.id, utf8Length(m.data));
                writeToTerminal(m.data, false, () => maybeAck(m.id));
                return;
            }
            case 'resize': {
                if (!isInt(m.id, 0, 1e9) || !isInt(m.cols, 1, 1000) || !isInt(m.rows, 1, 500)) return;
                const t = terminals.get(m.id);
                if (!t) return;
                t.cols = m.cols; t.rows = m.rows;
                if (m.id === activeId) applySize(m.cols, m.rows);
                return;
            }
            case 'title': {
                const t = terminals.get(m.id);
                if (!t) return;
                t.name = plain(m.name) || t.name;
                renderTabs();
                return;
            }
            case 'exit': {
                const t = terminals.get(m.id);
                if (!t) return;
                t.exited = true;
                t.state = 'exited';
                renderTabs();
                if (m.id === activeId && term) writeToTerminal('\r\n\x1b[90m[' + plain(S.exited(Number.isFinite(m.code) ? m.code : null), 120) + ']\x1b[0m\r\n', false);
                return;
            }
            case 'state': {
                const t = terminals.get(m.id);
                if (!t) return;
                t.state = stateName(m.state);
                t.attention = m.attention === true;
                if (t.state !== 'exited') t.exited = false;
                renderTabs();
                return;
            }
            case 'mode': {
                const t = terminals.get(m.id);
                if (!t || !(m.mode === 'visual' || m.mode === 'words' || m.mode === 'implicit') || t.mode === m.mode) return;
                t.mode = m.mode;
                if (m.id === activeId && term) term.refresh(0, term.rows - 1);
                return;
            }
            case 'pong':
                conn.lastPong = Date.now();
                clearTimeout(conn.pongTimer);
                conn.pongTimer = 0;
                return;
            case 'bye':
                conn.bye = plain(m.reason, 120);
                return;
            default:
                return;
        }
    }

    function onHello(m) {
        conn.attempt = 0;
        conn.authed = true;
        conn.lastPong = Date.now();
        received = new Map();
        acked = new Map();
        if (m.limits && Number.isFinite(m.limits.input)) limits = { input: m.limits.input };
        setRole(m.role, m.readOnly);
        setLight('ok');
        setBanner('', '', false);
        setTerminals(m.terminals);
        showMain();
        if (activeId === null) { if (term) { resetCounters(); term.reset(); } startHeartbeat(); return; }
        showActive();
        pinnedBottom = true;
        attachActive();
        startHeartbeat();
    }

    // ---- the connection ----------------------------------------------------------------------------------------------------------

    const conn = { ws: null, attempt: 0, timer: 0, tick: 0, pingTimer: 0, pongTimer: 0, pingN: 0, lastPong: 0, authed: false, bye: '', fatal: false, retryAt: 0 };

    function wsUrl() {
        return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    }

    function send(message) {
        const ws = conn.ws;
        if (!ws || ws.readyState !== 1 || !conn.authed && message.t !== 'auth') return false;
        try { ws.send(JSON.stringify(message)); return true; } catch (e) { return false; }
    }

    function startHeartbeat() {
        stopHeartbeat();
        conn.pingTimer = setInterval(() => {
            if (!conn.ws || conn.ws.readyState !== 1) return;
            send({ t: 'ping', n: ++conn.pingN });
            expectPong(conn.ws, TIMING.pongTimeout, false);
        }, TIMING.ping);
    }

    /** A ping is out: if no pong comes within ms the link is dead (a timer that is already running is not started again, unless sooner is true). */
    function expectPong(ws, ms, sooner) {
        if (conn.pongTimer && !sooner) return;
        clearTimeout(conn.pongTimer);
        conn.pongTimer = setTimeout(() => { conn.pongTimer = 0; if (conn.ws === ws) lost(ws, 1006); }, ms);
    }

    function stopHeartbeat() {
        clearInterval(conn.pingTimer);
        clearTimeout(conn.pongTimer);
        conn.pingTimer = 0;
        conn.pongTimer = 0;
    }

    function connect() {
        clearTimeout(conn.timer);
        clearInterval(conn.tick);
        if (conn.fatal || !session) return;
        if (conn.ws) { const old = conn.ws; conn.ws = null; detach(old); }
        conn.authed = false;
        conn.bye = '';
        showMain();
        setLight('warn');
        if (!banner.hidden && !banner.classList.contains('info')) setBanner(S.reconnectingNow, 'warn', true);
        else if (!terminals.size) setBanner(S.connecting, 'info', false);
        let ws;
        try { ws = new WebSocket(wsUrl()); } catch (e) { scheduleReconnect(); return; }
        conn.ws = ws;
        ws.onopen = () => { if (conn.ws === ws) { try { ws.send(JSON.stringify({ t: 'auth', token: session.token })); } catch (e) { /* closes soon */ } } };
        ws.onmessage = (event) => {
            if (conn.ws !== ws || typeof event.data !== 'string') return;
            let message;
            try { message = JSON.parse(event.data); } catch (e) { return; }
            onMessage(message);
        };
        ws.onclose = (event) => { if (conn.ws === ws) lost(ws, event.code); };
        ws.onerror = () => { /* a close follows */ };
    }

    function detach(ws) {
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        try { ws.close(); } catch (e) { /* closed already */ }
    }

    /** The socket is gone (closed by the server, the network, or silent for too long). */
    function lost(ws, code) {
        if (conn.ws !== ws) return;
        stats.closes.push(code);
        conn.ws = null;
        conn.authed = false;
        stopHeartbeat();
        detach(ws);
        resetCounters();
        setLight('bad');
        stopRepeat();
        if (code === 4401) return end('sessionEnded', true);
        if (code === 4430) return end('revoked', true);
        if (code === 4403) return end('forbidden', false);
        stats.reconnects++;
        scheduleReconnect(code === 4429 ? 30000 : 0);
    }

    /** A reason not to try again: this device has to be paired again (or is not allowed). */
    function end(key, forget) {
        conn.fatal = true;
        if (forget) { session = null; store.remove(KEY.session); }
        showPair('error', S[key], '', { canContinue: false });
    }

    function scheduleReconnect(minimum) {
        clearTimeout(conn.timer);
        clearInterval(conn.tick);
        const steps = TIMING.backoff;
        const base = steps[Math.min(conn.attempt, steps.length - 1)];
        conn.attempt++;
        const delay = Math.max(minimum || 0, Math.round(base * (1 + TIMING.jitter * (Math.random() * 2 - 1))));
        conn.retryAt = Date.now() + delay;
        const text = () => {
            const left = Math.max(0, Math.ceil((conn.retryAt - Date.now()) / 1000));
            const line = left > 0 ? S.reconnecting(left) : S.reconnectingNow;
            return conn.bye ? S.serverClosed(conn.bye) + ' ' + line : line;
        };
        setBanner(text(), 'warn', true);
        conn.tick = setInterval(() => setBanner(text(), 'warn', true), 1000);
        conn.timer = setTimeout(connect, delay);
    }

    /** The user, or the browser coming back (the tab was in the background, the phone woke up, the network is back): try now. */
    function wake() {
        if (conn.fatal || !session) return;
        const ws = conn.ws;
        if (ws && ws.readyState === 1 && conn.authed) {
            // the socket may be dead without a close event: ask, and the pong timer decides
            send({ t: 'ping', n: ++conn.pingN });
            expectPong(ws, Math.min(TIMING.pongTimeout, 4000), true);
            return;
        }
        if (ws && ws.readyState === 0) return;          // connecting
        conn.attempt = 0;
        connect();
    }

    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); });
    window.addEventListener('online', wake);
    window.addEventListener('pageshow', (e) => { if (e.persisted) wake(); });
    bannerRetry.addEventListener('click', () => { conn.attempt = 0; connect(); });

    // ---- pairing -----------------------------------------------------------------------------------------------------------------

    function loadSession() {
        const raw = store.get(KEY.session);
        if (!raw) return null;
        try {
            const value = JSON.parse(raw);
            if (value && typeof value.token === 'string' && value.token && value.token.length <= 512) return { token: value.token, deviceId: value.deviceId, role: value.role };
        } catch (e) { /* damaged: forget it */ }
        store.remove(KEY.session);
        return null;
    }

    /** The secret of the link, taken out of the address bar at once (it is in the fragment, which is never sent anywhere). */
    function takeSecret() {
        const hash = location.hash || '';
        if (!hash || hash === '#') return { present: false, secret: null };
        try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* the address bar keeps it; the secret is single use anyway */ }
        let secret = null;
        try { secret = new URLSearchParams(hash.replace(/^#/, '')).get('p'); } catch (e) { /* no secret */ }
        return { present: true, secret: secret && /^[A-Za-z0-9_-]{16,256}$/.test(secret) ? secret : null };
    }

    let pairTicker = 0;

    async function pair(secret) {
        showPair('wait', S.pairWaiting, S.pairWaitingHint, { spinner: true });
        const started = Date.now();
        clearInterval(pairTicker);
        pairTicker = setInterval(() => {
            const left = Math.max(0, 60 - Math.floor((Date.now() - started) / 1000));
            pairText.textContent = S.pairWaiting + ' ' + S.pairSeconds(left);
        }, 1000);
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timeout = setTimeout(() => { if (controller) controller.abort(); }, TIMING.pairTimeout);
        let response = null;
        let failure = null;
        try {
            response = await fetch('/api/pair', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ secret, label: describeBrowser() }),
                credentials: 'omit',
                cache: 'no-store',
                redirect: 'error',
                referrerPolicy: 'no-referrer',
                signal: controller ? controller.signal : undefined,
            });
        } catch (e) {
            failure = e && e.name === 'AbortError' ? 'pairNoAnswer' : 'pairNetwork';
        }
        clearTimeout(timeout);
        clearInterval(pairTicker);
        if (failure) return showPair('error', S[failure], '');
        let body = null;
        try { body = await response.json(); } catch (e) { /* no body */ }
        if (response.ok && body && typeof body.token === 'string' && body.token && body.token.length <= 512) {
            session = { token: body.token, deviceId: body.deviceId, role: body.role === 'write' ? 'write' : 'read' };
            store.set(KEY.session, JSON.stringify(session));
            start();
            return;
        }
        const reason = body && typeof body.error === 'string' ? body.error : '';
        let key = 'pairFailed';
        if (response.status === 429) key = 'pairRate';
        else if (response.status === 403 || response.status === 401) key = /time/i.test(reason) ? 'pairNoAnswer' : /expire|used|invalid|unknown|not.?found|consumed/i.test(reason) ? 'pairExpired' : 'pairDenied';
        else if (response.status === 400 || response.status === 404 || response.status === 410) key = 'pairExpired';
        showPair('error', S[key], '');
    }

    pairContinue.addEventListener('click', () => { if (session) { conn.fatal = false; start(); } });

    function start() {
        conn.fatal = false;
        conn.attempt = 0;
        setRole(session && session.role, undefined);
        showMain();
        connect();
    }

    // ---- start -------------------------------------------------------------------------------------------------------------------

    function boot() {
        const link = takeSecret();
        session = loadSession();
        if (link.present && link.secret) { pair(link.secret); return; }
        if (link.present && !session) { showPair('error', S.badLink, ''); return; }
        if (session) { start(); return; }
        showPair('info', S.noLink, '');
    }

    // for the tests (test/web-remote.test.js)
    window.__ocRemote = {
        get term() { return term; },
        get activeId() { return activeId; },
        get canWrite() { return canWrite; },
        get role() { return role; },
        get fontSize() { return currentFont; },
        get session() { return session; },
        get connection() { return { authed: conn.authed, attempt: conn.attempt, fatal: conn.fatal, socket: conn.ws ? conn.ws.readyState : null, bye: conn.bye }; },
        terminals,
        stats,
        openExternal,
        findLinks: (line) => (term ? findLinks(line) : undefined),
        isReply,
    };

    boot();
})();
