'use strict';
// The commands of the log helper: a thin layer between the editor and src/turbolog.js (which holds all the logic and does not know vscode).
// Behaviour inspired by Turbo Console Log (Chakroun Anas); independent implementation, no code used.
//
// ---------------------------------------------------------------------------------------------------------------------------------
// FOR package.json "contributes" (the same list as JSON is in src/turbolog.contributes.json)
//
// Commands (all work on the active text editor; JS, TS, JSX, TSX, Vue, Svelte, Astro, HTML script blocks and Python)
//   openconsole.log.insert         OpenConsole: Insert Log Message           console.log (Python: print)
//   openconsole.log.info           OpenConsole: Insert Info Log Message      console.info (Python: logging.info)
//   openconsole.log.debug          OpenConsole: Insert Debug Log Message     console.debug (Python: logging.debug)
//   openconsole.log.table          OpenConsole: Insert Table Log Message     console.table (Python: print)
//   openconsole.log.warn           OpenConsole: Insert Warn Log Message      console.warn (Python: logging.warning)
//   openconsole.log.error          OpenConsole: Insert Error Log Message     console.error (Python: logging.error)
//   openconsole.log.custom         OpenConsole: Insert Custom Log Message    the function of the setting logFunction
//   openconsole.log.commentAll     OpenConsole: Comment Log Messages         all the marked logs of the file
//   openconsole.log.uncommentAll   OpenConsole: Uncomment Log Messages
//   openconsole.log.deleteAll      OpenConsole: Delete Log Messages
//   openconsole.log.correctAll     OpenConsole: Correct Log Messages         refresh the file name and the line number in the logs
//
// Default keybindings (when: editorTextFocus && !editorReadonly). One chord prefix, ctrl+alt+l (cmd+alt+l on macOS), then a letter:
//   l insert, i info, d debug, t table, w warn, e error, m custom, c comment all, u uncomment all, x delete all, r correct all
// Chords are used so that no single key can clash with a built-in command, and the prefix is the "ctrl+alt+l" family of the brief.
// Not checked on every keyboard layout: on layouts that use AltGr (ctrl+alt) for letters, ctrl+alt+l can type a character; rebind it then.
//
// Settings (all under "openconsole.log."; "openconsole.log.<name>")
//   wrapLogMessage                    boolean  false  A line of dashes above and below each log.
//   logMessagePrefix                  string   "▶"    The first element of the message. Together with the delimiter it marks a log as ours (see below).
//   logMessageSuffix                  string   ":"    Put right after the variable name in the message.
//   includeFilename                   boolean  false  The name of the file in the message.
//   includeLineNum                    boolean  false  The line number of the log line in the message (1-based). "Correct Log Messages" refreshes it.
//   addSemicolonInTheEnd              boolean  false  A semicolon after the JavaScript or TypeScript log (never in Python).
//   insertEnclosingClass              boolean  true   The name of the class that holds the variable.
//   insertEnclosingFunction           boolean  true   The name of the function or method that holds the variable.
//   insertEmptyLineBeforeLogMessage   boolean  false  An empty line above the log.
//   insertEmptyLineAfterLogMessage    boolean  false  An empty line below the log.
//   delimiterInsideMessage            string   "›"    Put, with a space each side, between the elements of the message.
//   quote                             enum     "     " (double), ' (single) or ` (backtick) for the message; it changes by itself when the variable has quotes.
//   logFunction                       string   "log"  The function that "Insert Custom Log Message" calls (for example logger.debug).
//
// A log is "ours" (found by comment, uncomment, delete and correct) when it starts a line, is a call of console.log/info/debug/warn/error/table, of
// print or logging.* (Python), or of logFunction, ends the line, and its text has the prefix AND the delimiter. If you change either setting,
// the logs that were made before are no longer found. The editor's tab size and "insert spaces" are used for lines that have to be indented anew.
// ---------------------------------------------------------------------------------------------------------------------------------

const turbolog = require('./turbolog');

const INSERT_KINDS = {
    'openconsole.log.insert': 'log',
    'openconsole.log.info': 'info',
    'openconsole.log.debug': 'debug',
    'openconsole.log.table': 'table',
    'openconsole.log.warn': 'warn',
    'openconsole.log.error': 'error',
    'openconsole.log.custom': 'custom',
};
const MASS = {
    'openconsole.log.commentAll': { run: turbolog.commentLogs, none: 'no log messages to comment' },
    'openconsole.log.uncommentAll': { run: turbolog.uncommentLogs, none: 'no commented log messages found' },
    'openconsole.log.deleteAll': { run: turbolog.deleteLogs, none: 'no log messages to delete' },
    'openconsole.log.correctAll': { run: turbolog.correctLogs, none: 'no log message needs a correction (turn on includeFilename or includeLineNum to have them)' },
};

/**
 * @param {object} vscode the vscode module (or a stand-in)
 * @param {{subscriptions: object[]}} context
 * @param {{readConfig?: (section: string) => ({get: Function}|object)}} [options] readConfig gives the settings of the section "openconsole.log"
 *   (an object with get(key, fallback), or a plain object of values); by default vscode.workspace.getConfiguration is used.
 */
function register(vscode, context, options) {
    const readConfig = options && typeof options.readConfig === 'function' ? options.readConfig : null;
    const say = (text) => { try { vscode.window.showInformationMessage('OpenConsole: ' + text); } catch { /* no window */ } };

    function settings(editor) {
        let cfg = null;
        try { cfg = readConfig ? readConfig('openconsole.log') : vscode.workspace.getConfiguration('openconsole.log'); } catch { cfg = null; }
        const out = {};
        for (const [key, fallback] of Object.entries(turbolog.defaultOptions)) {
            let v;
            if (cfg && typeof cfg.get === 'function') v = cfg.get(key, fallback);
            else if (cfg && typeof cfg === 'object') v = cfg[key];
            out[key] = v === undefined || v === null ? fallback : v;
        }
        const o = editor && editor.options;
        if (o) {
            if (Number.isInteger(o.tabSize)) out.tabSize = o.tabSize;
            if (typeof o.insertSpaces === 'boolean') out.insertSpaces = o.insertSpaces;
        }
        return out;
    }
    function toWorkspaceEdit(document, edits) {
        const we = new vscode.WorkspaceEdit();
        for (const e of edits) {
            const from = document.positionAt(e.offset);
            if (e.deleteLength > 0) {
                const range = new vscode.Range(from, document.positionAt(e.offset + e.deleteLength));
                if (e.text) we.replace(document.uri, range, e.text); else we.delete(document.uri, range);
            } else we.insert(document.uri, from, e.text);
        }
        return we;
    }
    const activeEditor = () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) say('open a file first');
        return editor;
    };

    async function insert(kind) {
        const editor = activeEditor();
        if (!editor) return;
        const doc = editor.document;
        const selections = (editor.selections || []).map((sel) => ({
            selectionStart: doc.offsetAt(sel.start), selectionEnd: doc.offsetAt(sel.end), languageId: doc.languageId, fileName: doc.fileName,
        }));
        if (!selections.length) selections.push({ selectionStart: 0, selectionEnd: 0, languageId: doc.languageId, fileName: doc.fileName });
        const result = turbolog.insertLog(doc.getText(), selections, settings(editor), kind);
        if (!result.edits.length) { say(result.reason || 'nothing to log here'); return; }
        await vscode.workspace.applyEdit(toWorkspaceEdit(doc, result.edits));
    }
    async function mass(id) {
        const editor = activeEditor();
        if (!editor) return;
        const doc = editor.document;
        const spec = MASS[id];
        const result = spec.run(doc.getText(), doc.languageId, settings(editor), doc.fileName);
        if (!result.edits.length) { say(result.skipped ? 'the logs that were found cannot be changed without changing what the code does' : spec.none); return; }
        await vscode.workspace.applyEdit(toWorkspaceEdit(doc, result.edits));
    }

    for (const [id, kind] of Object.entries(INSERT_KINDS)) context.subscriptions.push(vscode.commands.registerCommand(id, () => insert(kind)));
    for (const id of Object.keys(MASS)) context.subscriptions.push(vscode.commands.registerCommand(id, () => mass(id)));
}

module.exports = { register, INSERT_KINDS };
