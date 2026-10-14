'use strict';
// The commands that were typed and the folders that the terminals were in: for the suggestion that shows what you are going to type,
// for "Run Recent Command" and for "Go to Recent Directory". They come from two places: the history file of PowerShell (PSReadLine),
// and what is typed in these terminals (kept in the state of the extension, at most a few hundred).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_FILE_COMMANDS = 1500;       // the newest commands that are taken from the history file of PowerShell
const MAX_OWN_COMMANDS = 300;
const MAX_DIRECTORIES = 40;
const MAX_COMMAND_LENGTH = 400;       // longer lines (a pasted script) are not suggested
const READ_LAST_BYTES = 512 * 1024;

/** The history file of PowerShell (PSReadLine): one command per line, the newest at the end. */
function psReadLineHistoryFile(env = process.env) {
    const appData = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt');
}

/** The text of a history file as a list of commands, oldest first, without empty or repeated ones (the newest copy stays). */
function parseHistoryText(text) {
    const lines = String(text).split(/\r?\n/);
    const out = [];
    const seen = new Set();
    for (let i = lines.length - 1; i >= 0; i--) {
        const command = lines[i].trim();
        // a line that ends with a backtick goes on in the next line: it is half a command, and is left out
        if (!command || command.length > MAX_COMMAND_LENGTH || command.endsWith('`') || seen.has(command)) continue;
        seen.add(command);
        out.push(command);
        if (out.length >= MAX_FILE_COMMANDS) break;
    }
    return out.reverse();
}

/** The last part of a file (the start of the first line may be cut: it is dropped). */
function readTail(file, bytes = READ_LAST_BYTES) {
    let fd = null;
    try {
        fd = fs.openSync(file, 'r');
        const size = fs.fstatSync(fd).size;
        const length = Math.min(size, bytes);
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, size - length);
        const text = buffer.toString('utf8');
        return size > length ? text.slice(text.indexOf('\n') + 1) : text;
    }
    catch { return ''; }
    finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } } }
}

class CommandHistory {
    /** @param {{get: Function, update: Function}} [state] the state of the extension (context.globalState) */
    constructor(state, options = {}) {
        this.state = state || null;
        this.file = options.file === undefined ? psReadLineHistoryFile() : options.file;
        this.own = this.state ? (this.state.get('openconsole.commands', []) || []).filter((c) => typeof c === 'string') : [];
        this.folders = this.state ? (this.state.get('openconsole.directories', []) || []).filter((c) => typeof c === 'string') : [];
        this.fromFile = null;
    }

    /** All the commands, oldest first: the ones of the history file of PowerShell, then the ones typed here (they are the newest). */
    all() {
        if (this.fromFile === null) this.fromFile = this.file ? parseHistoryText(readTail(this.file)) : [];
        const own = new Set(this.own);
        return this.fromFile.filter((c) => !own.has(c)).concat(this.own);
    }

    add(command) {
        const text = String(command || '').trim();
        if (!text || text.length > MAX_COMMAND_LENGTH) return false;
        this.own = this.own.filter((c) => c !== text);
        this.own.push(text);
        if (this.own.length > MAX_OWN_COMMANDS) this.own = this.own.slice(-MAX_OWN_COMMANDS);
        if (this.state) this.state.update('openconsole.commands', this.own);
        return true;
    }

    addDirectory(directory) {
        const dir = String(directory || '').trim();
        if (!dir) return false;
        this.folders = this.folders.filter((d) => d.toLowerCase() !== dir.toLowerCase());
        this.folders.push(dir);
        if (this.folders.length > MAX_DIRECTORIES) this.folders = this.folders.slice(-MAX_DIRECTORIES);
        if (this.state) this.state.update('openconsole.directories', this.folders);
        return true;
    }

    /** The folders, the newest first, that still exist. */
    directories() {
        return this.folders.filter((d) => { try { return fs.existsSync(d); } catch { return false; } }).reverse();
    }

    /** Forgets what was typed here (the history file of PowerShell is not touched). */
    clear() {
        this.own = [];
        this.folders = [];
        if (this.state) {
            this.state.update('openconsole.commands', []);
            this.state.update('openconsole.directories', []);
        }
    }
}

module.exports = { CommandHistory, parseHistoryText, readTail, psReadLineHistoryFile };
