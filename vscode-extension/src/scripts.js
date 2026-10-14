'use strict';
// Run many package.json scripts at once (one terminal each) and the saved groups of terminals (.openconsole/groups.json).
// Pure Node built-ins, nothing of vscode in here: the host asks, this file reads folders and answers with plain data.
//
// The safety rules, because the files that are read here belong to the repository and not to the user:
//   1. A script name is typed into a terminal only when it is one plain word (isSafeScriptName); everything else is refused, not quoted,
//      so there is no shell for which the quoting could be wrong.
//   2. A folder that a workspace pattern or the cwd of a group names must stay inside the workspace folder (no "..", no absolute path
//      elsewhere, no names that Windows reads differently, no link that leads out: resolveCwd).
//   3. The commands of a group are text of the repository: show them to the user before they are run (groupDigest tells when they changed).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const MAX_PACKAGES_PER_FOLDER = 300;
const MAX_SCRIPTS_PER_PACKAGE = 200;
const MAX_GLOB_DEPTH = 4;               // how many folders "**" may go down
const MAX_VISITED_FOLDERS = 3000;       // the most folders that are looked at to expand the workspace patterns of one folder
const MAX_PATTERNS = 100;
const MAX_SCRIPT_NAME = 120;
const MAX_COMMAND_PREVIEW = 500;

const DEFAULT_MAX_PARALLEL = 4;
const MAX_PARALLEL = 20;
const MAX_RUN_ITEMS = 30;

const GROUPS_FILE = path.join('.openconsole', 'groups.json');
const MAX_FILE_BYTES = 256 * 1024;
const MAX_GROUPS = 50;
const MAX_TERMINALS = 20;
const MAX_COMMAND = 2000;
const MAX_NAME = 60;
const MAX_CWD = 500;
const MAX_FIELD = 100;
const TERMINAL_FIELDS = ['name', 'cwd', 'command', 'profile', 'agent', 'color'];
const GROUP_FIELDS = ['name', 'terminals'];
const TOP_FIELDS = ['groups', '$schema'];

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';
const pathKey = (p) => (CASE_INSENSITIVE ? p.toLowerCase() : p);

// C0 and C1 controls (newline, escape, ...), DEL, line and paragraph separators
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// the characters that make text read in another order than it is written (Trojan Source); Arabic itself and the plain RLM/LRM are fine
const BIDI_OVERRIDE = /[\u202a-\u202e\u2066-\u2069]/;

class ScriptsError extends Error {
    constructor(code, message) { super(message); this.name = 'ScriptsError'; this.code = code; }
}

/** Short, one-line, printable form of a value for an error message. */
function show(value, max = 60) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    const flat = String(text === undefined ? value : text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
    return JSON.stringify(flat.length > max ? flat.slice(0, max - 1) + '…' : flat);
}

/** True when target is root or lies below it (compared the way the platform compares paths, so "C:\a" and "c:\A" are one). */
function isInside(root, target) {
    const rel = path.relative(root, target);
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

/** Segments of a relative path that Windows would read as something else than they say ("..." or ".. " become ".."), or a drive/stream. */
function hasUnsafeSegment(segments) {
    return segments.some((seg) => seg.includes('\0') || seg.includes(':') || (seg !== '.' && seg !== '..' && /[. ]$/.test(seg)));
}

// ------------------------------------------------------------------------------------------------------------------------------------
// package.json scripts
// ------------------------------------------------------------------------------------------------------------------------------------

// One plain word that every shell (PowerShell, cmd, bash, zsh, fish) passes on unchanged: letters, digits, "_", and ". : / -" inside.
// Not allowed: a space, a quote, $ ` ; & | < > ( ) { } [ ] % ! ^ * ? ~ # \ @ + = , a newline or any other control, and a first "-" or "."
// (an option for npm) or "@" (splatting in PowerShell).
const SAFE_SCRIPT_NAME = /^[\p{L}\p{N}_][\p{L}\p{N}\p{M}_.:/-]*$/u;

/** Whether a script name may be typed into a terminal as it is. */
function isSafeScriptName(name) {
    return typeof name === 'string' && name.length > 0 && name.length <= MAX_SCRIPT_NAME && SAFE_SCRIPT_NAME.test(name);
}

const RUNNERS = { npm: 'npm run', pnpm: 'pnpm run', yarn: 'yarn run', bun: 'bun run' };

/**
 * The line to type into a terminal (without the Enter) that runs one script of the package in entry.packageDir.
 * Throws a ScriptsError (code EBADSCRIPT or EBADMANAGER) for a name that is not one plain word: nothing is quoted, so the answer is the
 * same for every shell and the argument shell is only there for the caller that has one at hand. "yarn run x" and not "yarn x" because a
 * script may be called like a command of yarn (add, install, remove ...).
 * @param {{manager: string}} entry an entry of discoverScripts (or an item of makeItem)
 * @param {string} scriptName
 * @param {string} [shell] powershell | pwsh | cmd | bash | sh | zsh | ...
 */
function commandLine(entry, scriptName, shell) {
    void shell;
    const manager = entry && typeof entry === 'object' ? entry.manager : undefined;
    if (typeof manager !== 'string' || !has(RUNNERS, manager)) throw new ScriptsError('EBADMANAGER', `Unknown package manager ${show(manager)}`);
    if (!isSafeScriptName(scriptName)) throw new ScriptsError('EBADSCRIPT', `The script name ${show(scriptName)} has characters that are not safe to type into a terminal`);
    return `${RUNNERS[manager]} ${scriptName}`;
}

function readText(file, fsApi, maxBytes = MAX_PACKAGE_JSON_BYTES) {
    try {
        const text = fsApi.readFileSync(file, 'utf8');
        if (typeof text !== 'string' || text.length > maxBytes) return null;
        return text.replace(/^\uFEFF/, '');
    } catch { return null; }
}

function readPackageJson(file, fsApi) {
    const text = readText(file, fsApi);
    if (text === null) return null;
    try {
        const data = JSON.parse(text);
        return isPlainObject(data) ? data : null;
    } catch { return null; }
}

const exists = (fsApi, p) => { try { return !!fsApi.existsSync(p); } catch { return false; } };

function isRealDirectory(fsApi, p) {
    try { return (fsApi.lstatSync || fsApi.statSync).call(fsApi, p).isDirectory(); } catch { return false; }   // a link is not followed
}

/** The names of the folders in a folder (links are not followed, node_modules is skipped), sorted. */
function listFolders(fsApi, dir) {
    try {
        return fsApi.readdirSync(dir, { withFileTypes: true })
            .filter((d) => d.isDirectory() && d.name !== 'node_modules')
            .map((d) => d.name)
            .sort();
    } catch { return []; }
}

/** The patterns after "packages:" in a pnpm-workspace.yaml. Only what that file is made of: block or flow list, quotes, comments. */
function parsePnpmWorkspacePackages(text) {
    const out = [];
    const unquote = (raw) => {
        const v = raw.trim();
        if (v.length >= 2 && v[0] === "'" && v[v.length - 1] === "'") return v.slice(1, -1).replace(/''/g, "'");
        if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') return v.slice(1, -1).replace(/\\(["\\])/g, '$1');
        return v;
    };
    const stripComment = (line) => {
        let quote = '';
        for (let i = 0; i < line.length; i++) {
            const c = line[i];
            if (quote) { if (c === quote) quote = ''; continue; }
            if (c === '"' || c === "'") quote = c;
            else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
        }
        return line;
    };
    let inList = false;
    for (const raw of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
        const line = stripComment(raw).replace(/\s+$/, '');
        if (!line.trim()) continue;
        if (/^\S/.test(line) && !line.startsWith('-')) {          // a key at the start of the line
            const key = /^packages\s*:\s*(.*)$/.exec(line);
            inList = !!key && !key[1].trim();
            const flow = key && /^\[(.*)\]$/.exec(key[1].trim());
            if (flow) for (const m of flow[1].matchAll(/"([^"]*)"|'([^']*)'|([^,\s][^,]*)/g)) out.push((m[1] ?? m[2] ?? m[3]).trim());
            continue;
        }
        if (!inList) continue;
        const item = /^\s*-\s+(.+)$/.exec(line);
        if (item) out.push(unquote(item[1]));
    }
    return out.filter(Boolean);
}

function workspacePatterns(rootPkg, folder, fsApi) {
    const patterns = [];
    const w = rootPkg && rootPkg.workspaces;
    for (const p of Array.isArray(w) ? w : (isPlainObject(w) && Array.isArray(w.packages) ? w.packages : [])) patterns.push(p);
    const yaml = readText(path.join(folder, 'pnpm-workspace.yaml'), fsApi, 256 * 1024);
    if (yaml !== null) patterns.push(...parsePnpmWorkspacePackages(yaml));
    return [...new Set(patterns.filter((p) => typeof p === 'string' && p.length > 0 && p.length <= 200))].slice(0, MAX_PATTERNS);
}

function segmentToRegExpSource(segment) {
    return segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
}

/** A glob of a workspace list (for the "!" ones) as a RegExp for the path of a folder relative to the workspace, with "/" in it. */
function globToRegExp(glob) {
    const segments = glob.split('/').filter((s) => s !== '' && s !== '.');
    let source = '^';
    segments.forEach((seg, i) => {
        const last = i === segments.length - 1;
        if (seg === '**') {
            if (!last) source += '(?:[^/]+/)*';
            else if (source === '^') source += '.*';
            else source = source.replace(/\/$/, '') + '(?:/.*)?';       // "a/**" is a, and everything below it
            return;
        }
        source += segmentToRegExpSource(seg) + (last ? '' : '/');
    });
    return new RegExp(source + '$', CASE_INSENSITIVE ? 'i' : '');
}

/** The folders that the patterns "dir/*", "dir/**", "a/b", "dir/pkg-*" name below folder (never the folder itself, never above it). */
function expandWorkspaces(folder, patterns, fsApi) {
    const includes = [];
    const excludes = [];
    for (const original of patterns) {
        const negated = original.startsWith('!');
        const body = (negated ? original.slice(1) : original).replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
        const segments = body.split('/');
        // a path that leaves the workspace or is no relative path is not a pattern of this workspace
        if (!body || body.startsWith('/') || /^[A-Za-z]:/.test(body) || segments.some((s) => s === '' || s === '..') || hasUnsafeSegment(segments.filter((s) => s !== '*' && s !== '**' && !/[*?]/.test(s)))) continue;
        if (negated) excludes.push(globToRegExp(body)); else includes.push(segments);
    }

    const found = new Map();
    const budget = { visited: 0 };
    const walk = (base, segments, depth) => {
        if (budget.visited++ > MAX_VISITED_FOLDERS || found.size >= MAX_PACKAGES_PER_FOLDER * 2) return;
        if (!segments.length) { found.set(pathKey(base), base); return; }
        const [seg, ...rest] = segments;
        if (seg === '.') return walk(base, rest, depth);
        if (seg === '**') {
            walk(base, rest, depth);                                      // no folder at all
            if (depth < MAX_GLOB_DEPTH) for (const name of listFolders(fsApi, base)) if (!name.startsWith('.')) walk(path.join(base, name), segments, depth + 1);
            return;
        }
        if (!/[*?]/.test(seg)) {
            if (seg !== 'node_modules' && isRealDirectory(fsApi, path.join(base, seg))) walk(path.join(base, seg), rest, depth);
            return;
        }
        const re = new RegExp('^' + segmentToRegExpSource(seg) + '$', CASE_INSENSITIVE ? 'i' : '');
        for (const name of listFolders(fsApi, base)) if (re.test(name) && (!name.startsWith('.') || seg.startsWith('.'))) walk(path.join(base, name), rest, depth);
    };
    for (const segments of includes) walk(folder, segments, 0);

    const rootKey = pathKey(folder);
    return [...found.values()]
        .filter((dir) => pathKey(dir) !== rootKey && isInside(folder, dir))
        .filter((dir) => {
            const rel = path.relative(folder, dir).split(path.sep).join('/');
            return !excludes.some((re) => re.test(rel));
        })
        .sort((a, b) => (pathKey(a) < pathKey(b) ? -1 : pathKey(a) > pathKey(b) ? 1 : 0));
}

function managerFromField(pkg) {
    const field = pkg && typeof pkg.packageManager === 'string' ? pkg.packageManager : '';
    const name = field.split('@')[0].trim().toLowerCase();
    return has(RUNNERS, name) ? name : null;
}

function managerFromLockfile(dir, fsApi) {
    if (exists(fsApi, path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
    if (exists(fsApi, path.join(dir, 'yarn.lock'))) return 'yarn';
    if (exists(fsApi, path.join(dir, 'bun.lockb')) || exists(fsApi, path.join(dir, 'bun.lock'))) return 'bun';
    if (exists(fsApi, path.join(dir, 'package-lock.json')) || exists(fsApi, path.join(dir, 'npm-shrinkwrap.json'))) return 'npm';
    return null;
}

/** packageManager field of the package, then of the workspace root, then the lock file next to the package, then at the root. */
function detectManager(dir, folder, pkg, rootPkg, fsApi) {
    return managerFromField(pkg) || managerFromField(rootPkg) || managerFromLockfile(dir, fsApi)
        || (pathKey(dir) !== pathKey(folder) ? managerFromLockfile(folder, fsApi) : null)
        || (exists(fsApi, path.join(folder, 'pnpm-workspace.yaml')) ? 'pnpm' : 'npm');
}

function readScripts(pkg) {
    const out = [];
    if (!isPlainObject(pkg.scripts)) return out;
    for (const name of Object.keys(pkg.scripts)) {
        const command = pkg.scripts[name];
        if (typeof command !== 'string' || !isSafeScriptName(name)) continue;
        out.push({ name, command: command.length > MAX_COMMAND_PREVIEW ? command.slice(0, MAX_COMMAND_PREVIEW - 1) + '…' : command });
        if (out.length >= MAX_SCRIPTS_PER_PACKAGE) break;
    }
    return out;
}

const cleanName = (name) => (typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').trim().slice(0, MAX_NAME) : '');

function discoverFolder(folder, fsApi, out, seenDirs) {
    const rootPkg = readPackageJson(path.join(folder, 'package.json'), fsApi);
    const nxWorkspace = exists(fsApi, path.join(folder, 'nx.json'));
    const candidates = [];
    if (rootPkg) candidates.push({ dir: folder, pkg: rootPkg });
    for (const dir of expandWorkspaces(folder, workspacePatterns(rootPkg, folder, fsApi), fsApi)) {
        if (candidates.length >= MAX_PACKAGES_PER_FOLDER) break;
        const pkg = readPackageJson(path.join(dir, 'package.json'), fsApi);
        if (pkg) candidates.push({ dir, pkg });
    }
    for (const { dir, pkg } of candidates) {
        if (seenDirs.has(pathKey(dir))) continue;
        const scripts = readScripts(pkg);
        if (!scripts.length) continue;
        seenDirs.add(pathKey(dir));
        out.push({
            folder,
            packageName: cleanName(pkg.name) || path.basename(dir) || dir,
            packageDir: dir,
            scripts,
            manager: detectManager(dir, folder, pkg, rootPkg, fsApi),
            nx: nxWorkspace || exists(fsApi, path.join(dir, 'project.json')),
        });
    }
}

/**
 * The packages with scripts in the workspace folders: the package.json of the folder and of the packages that its "workspaces" (npm, yarn,
 * bun: a list or {packages: [...]}) or its pnpm-workspace.yaml name, with "dir/*", "dir/**" (up to 4 levels), "a/b" and "!exclude" patterns.
 * Folders named node_modules, links, and anything outside the folder are skipped; so are the scripts that commandLine would refuse.
 * Packages without scripts are left out. Nothing here throws: a folder that cannot be read has no entries.
 * `nx` is true when the folder has an nx.json or the package a project.json (only noted: the targets of Nx are not read).
 * @param {string[]} workspaceFolders
 * @param {object} [fsApi] needs readFileSync, readdirSync(withFileTypes), existsSync and lstatSync or statSync
 * @returns {{folder: string, packageName: string, packageDir: string, scripts: {name: string, command: string}[], manager: 'npm'|'pnpm'|'yarn'|'bun', nx: boolean}[]}
 */
function discoverScripts(workspaceFolders, fsApi = fs) {
    const out = [];
    const seenFolders = new Set();
    const seenDirs = new Set();
    for (const raw of Array.isArray(workspaceFolders) ? workspaceFolders : []) {
        if (typeof raw !== 'string' || !raw.trim() || raw.includes('\0')) continue;
        const folder = path.resolve(raw);
        if (seenFolders.has(pathKey(folder))) continue;
        seenFolders.add(pathKey(folder));
        try { discoverFolder(folder, fsApi, out, seenDirs); } catch { /* a folder that cannot be read has no scripts */ }
    }
    return out;
}

// ------------------------------------------------------------------------------------------------------------------------------------
// the plan of a run
// ------------------------------------------------------------------------------------------------------------------------------------

/** The thing to start for one script: what planRun, terminalName and commandLine take. */
function makeItem(entry, scriptName) {
    const script = (entry.scripts || []).find((s) => s.name === scriptName);
    return { folder: entry.folder, packageName: entry.packageName, packageDir: entry.packageDir, manager: entry.manager, script: scriptName, command: script ? script.command : '' };
}

/** Every script of the entries as an item, in the order of the entries. */
function allItems(entries) {
    return (entries || []).flatMap((entry) => (entry.scripts || []).map((s) => makeItem(entry, s.name)));
}

/** The name of the terminal of an item: "<package>: <script>". */
function terminalName(item) {
    const pkg = cleanName(item && item.packageName) || (item && typeof item.packageDir === 'string' ? path.basename(item.packageDir) : '') || 'package';
    const name = `${pkg}: ${cleanName(item && item.script) || 'script'}`;
    return name.length > MAX_NAME * 2 ? name.slice(0, MAX_NAME * 2 - 1) + '…' : name;
}

function normalizeCap(value) {
    if ((typeof value !== 'number' && typeof value !== 'string') || value === '') return DEFAULT_MAX_PARALLEL;
    const n = Number(value);
    if (n === 0 || n === Infinity) return Infinity;                      // no cap
    if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_PARALLEL;
    return Math.min(Math.floor(n), MAX_PARALLEL);
}

/**
 * Splits a selection into batches of at most maxParallel items (default 4, 0 or Infinity = all in one batch), in the order of the selection.
 * The first batch is started at once, the next ones as places become free (what a place is, is up to the caller: a script that ends, or
 * a server that is "ready"). The same script of the same package twice is started once; more than maxItems (30) are left out.
 * @param {object[]} selection items (makeItem)
 * @param {{maxParallel?: number, maxItems?: number}} [options]
 * @returns {{batches: object[][], maxParallel: number, total: number, skipped: {item: object, reason: 'duplicate'|'too-many'}[]}}
 */
function planRun(selection, options = {}) {
    const cap = normalizeCap(options && options.maxParallel);
    const maxItems = Number.isInteger(options && options.maxItems) && options.maxItems > 0 ? Math.min(options.maxItems, 100) : MAX_RUN_ITEMS;
    const items = [];
    const skipped = [];
    const seen = new Set();
    for (const item of Array.isArray(selection) ? selection : []) {
        if (!isPlainObject(item)) continue;
        const key = typeof item.packageDir === 'string' && typeof item.script === 'string' ? pathKey(path.resolve(item.packageDir)) + '\n' + item.script : null;
        if (key !== null && seen.has(key)) { skipped.push({ item, reason: 'duplicate' }); continue; }
        if (items.length >= maxItems) { skipped.push({ item, reason: 'too-many' }); continue; }
        if (key !== null) seen.add(key);
        items.push(item);
    }
    const size = cap === Infinity ? Math.max(items.length, 1) : cap;
    const batches = [];
    for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
    return { batches, maxParallel: cap === Infinity ? 0 : cap, total: items.length, skipped };
}

// ------------------------------------------------------------------------------------------------------------------------------------
// saved groups: .openconsole/groups.json
// ------------------------------------------------------------------------------------------------------------------------------------

/**
 * A cwd of a group as a path relative to the workspace folder with "/" ("." for the folder itself).
 * @returns {{ok: true, value: string} | {ok: false, error: string}}
 */
function normalizeCwd(workspaceFolder, cwd) {
    if (cwd === undefined || cwd === null) return { ok: true, value: '.' };
    if (typeof cwd !== 'string') return { ok: false, error: 'cwd must be a string' };
    if (cwd.length > MAX_CWD) return { ok: false, error: `cwd is longer than ${MAX_CWD} characters` };
    if (CONTROL.test(cwd) || BIDI_OVERRIDE.test(cwd)) return { ok: false, error: 'cwd has a control character' };
    if (typeof workspaceFolder !== 'string' || !workspaceFolder) return { ok: false, error: 'there is no workspace folder to check cwd against' };
    const text = cwd.trim().replace(/\\/g, '/');
    if (!text) return { ok: true, value: '.' };
    // a drive letter is the only place for ":" (the rest of the path is looked at without it); other colons are streams of NTFS
    const absolute = /^[A-Za-z]:(\/|$)/.test(text) || text.startsWith('/');
    const rest = absolute ? text.replace(/^[A-Za-z]:/, '') : text;
    if (/^[A-Za-z]:/.test(text) && !absolute) return { ok: false, error: `cwd ${show(cwd)} is a path relative to a drive, which is not allowed` };
    if (hasUnsafeSegment(rest.split('/'))) return { ok: false, error: `cwd ${show(cwd)} has a name that is not safe (a ":" or a name that ends with a dot or a space)` };
    const root = path.resolve(workspaceFolder);
    const target = path.resolve(root, text);
    if (!isInside(root, target)) return { ok: false, error: `cwd ${show(cwd)} is outside the workspace folder` };
    const rel = path.relative(root, target).split(path.sep).join('/');
    return { ok: true, value: rel || '.' };
}

/**
 * The folder to start a terminal of a group in: the cwd checked again against the folder as it is on disk, so a link (or a junction)
 * that leads out of the workspace is found as well. Throws a ScriptsError (EBADCWD) when it is outside, missing, or not a folder.
 */
function resolveCwd(workspaceFolder, cwd, fsApi = fs) {
    const normalized = normalizeCwd(workspaceFolder, cwd);
    if (!normalized.ok) throw new ScriptsError('EBADCWD', normalized.error);
    const abs = path.resolve(workspaceFolder, normalized.value);
    const realpath = fsApi.realpathSync.native || fsApi.realpathSync;
    const real = (p) => realpath(p);
    let realAbs;
    let realRoot;
    try { realAbs = real(abs); realRoot = real(path.resolve(workspaceFolder)); } catch { throw new ScriptsError('EBADCWD', `cwd ${show(cwd)} does not exist`); }
    if (!isInside(realRoot, realAbs)) throw new ScriptsError('EBADCWD', `cwd ${show(cwd)} leads outside the workspace folder (a link?)`);
    let isDir = false;
    try { isDir = fsApi.statSync(abs).isDirectory(); } catch { /* not a folder */ }
    if (!isDir) throw new ScriptsError('EBADCWD', `cwd ${show(cwd)} is not a folder`);
    return abs;
}

function checkText(value, field, { max, required = false, pattern, patternMessage, allowBidi = true }) {
    if (value === undefined || value === null) return required ? { error: `${field} is missing` } : { value: undefined };
    if (typeof value !== 'string') return { error: `${field} must be a string` };
    if (value.length > max) return { error: `${field} is longer than ${max} characters` };
    if (CONTROL.test(value)) return { error: `${field} has a control character (a newline, for example)` };
    if (!allowBidi && BIDI_OVERRIDE.test(value)) return { error: `${field} has a character that changes the direction of the text` };
    if (required && !value.trim()) return { error: `${field} is empty` };
    if (pattern && !pattern.test(value)) return { error: `${field} ${patternMessage}` };
    return { value };
}

function validateTerminal(raw, folder, at) {
    const errors = [];
    if (!isPlainObject(raw)) return { errors: [`${at} must be an object`] };
    for (const key of Object.keys(raw)) if (!TERMINAL_FIELDS.includes(key)) errors.push(`${at}: unknown field ${show(key)}`);
    const out = {};
    const name = checkText(raw.name, `${at}: name`, { max: MAX_NAME, required: true });
    if (name.error) errors.push(name.error); else out.name = name.value.trim();
    const label = out.name ? `${at} ${show(out.name)}` : at;
    const cwd = normalizeCwd(folder, raw.cwd);
    if (!cwd.ok) errors.push(`${label}: ${cwd.error}`); else out.cwd = cwd.value;
    // a command is typed into the terminal as it is: one line, no controls (an escape or a Ctrl+C), and not longer than a line should be
    const command = checkText(raw.command, `${label}: command`, { max: MAX_COMMAND, allowBidi: false });
    if (command.error) errors.push(command.error); else out.command = command.value === undefined ? '' : command.value;
    for (const [field, max, pattern, message] of [
        ['profile', MAX_FIELD],
        ['agent', 50],
        ['color', 40, /^(#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|[A-Za-z][A-Za-z0-9.-]*)$/, 'must be a color like "#3b82f6" or a name like "blue"'],
    ]) {
        const checked = checkText(raw[field], `${label}: ${field}`, { max, pattern, patternMessage: message });
        if (checked.error) errors.push(checked.error);
        else if (checked.value !== undefined && checked.value !== '') out[field] = checked.value;
    }
    return errors.length ? { errors } : { terminal: out };
}

/**
 * Checks the content of a groups.json that is already parsed. A group with any fault is left out as a whole (nothing of it is started),
 * the good groups stay, and every fault is told in a sentence that says where it is.
 * @param {any} data
 * @param {string} workspaceFolder the folder that the cwd of every terminal must stay in
 * @returns {{groups: {name: string, terminals: {name: string, cwd: string, command: string, profile?: string, agent?: string, color?: string}[]}[], errors: string[]}}
 */
function validateGroups(data, workspaceFolder) {
    const errors = [];
    const groups = [];
    if (!isPlainObject(data)) return { groups, errors: ['groups.json: the top level must be an object like {"groups": [...]}'] };
    for (const key of Object.keys(data)) if (!TOP_FIELDS.includes(key)) errors.push(`groups.json: unknown field ${show(key)}`);
    if (!Array.isArray(data.groups)) return { groups, errors: [...errors, 'groups.json: "groups" must be an array'] };
    if (data.groups.length > MAX_GROUPS) errors.push(`groups.json: at most ${MAX_GROUPS} groups are read, the others are left out`);
    const names = new Set();
    data.groups.slice(0, MAX_GROUPS).forEach((raw, i) => {
        const at = `groups[${i}]`;
        if (!isPlainObject(raw)) { errors.push(`${at} must be an object`); return; }
        const mine = [];
        for (const key of Object.keys(raw)) if (!GROUP_FIELDS.includes(key)) mine.push(`${at}: unknown field ${show(key)}`);
        const name = checkText(raw.name, `${at}: name`, { max: MAX_NAME, required: true });
        if (name.error) mine.push(name.error);
        const label = name.value ? `${at} ${show(name.value.trim())}` : at;
        if (name.value && names.has(name.value.trim().toLowerCase())) mine.push(`${label}: the name is used by another group`);
        const terminals = [];
        if (!Array.isArray(raw.terminals)) mine.push(`${label}: "terminals" must be an array`);
        else if (raw.terminals.length === 0) mine.push(`${label}: "terminals" is empty`);
        else if (raw.terminals.length > MAX_TERMINALS) mine.push(`${label}: has ${raw.terminals.length} terminals, at most ${MAX_TERMINALS} are allowed`);
        else {
            const terminalNames = new Set();
            raw.terminals.forEach((t, j) => {
                const result = validateTerminal(t, workspaceFolder, `${label}: terminals[${j}]`);
                if (result.errors) { mine.push(...result.errors); return; }
                const key = result.terminal.name.toLowerCase();
                if (terminalNames.has(key)) { mine.push(`${label}: terminals[${j}] ${show(result.terminal.name)}: the name is used by another terminal of the group`); return; }
                terminalNames.add(key);
                terminals.push(result.terminal);
            });
        }
        if (mine.length) { errors.push(...mine); return; }
        names.add(name.value.trim().toLowerCase());
        groups.push({ name: name.value.trim(), terminals });
    });
    return { groups, errors };
}

/**
 * The text of a groups.json as groups. Never throws.
 * @param {string} jsonText
 * @param {string} workspaceFolder
 * @returns {{groups: object[], errors: string[]}} see validateGroups
 */
function parseGroups(jsonText, workspaceFolder) {
    if (typeof jsonText !== 'string') return { groups: [], errors: ['groups.json: no text to read'] };
    if (jsonText.length > MAX_FILE_BYTES) return { groups: [], errors: [`groups.json is larger than ${MAX_FILE_BYTES / 1024} KB`] };
    let data;
    try { data = JSON.parse(jsonText.replace(/^\uFEFF/, '')); } catch (e) { return { groups: [], errors: [`groups.json is not valid JSON: ${String(e && e.message).slice(0, 200)}`] }; }
    return validateGroups(data, workspaceFolder);
}

/**
 * Reads <dir>/.openconsole/groups.json. A missing file is no error ({exists: false}). Never throws.
 * @param {string} dir the workspace folder
 * @returns {{groups: object[], errors: string[], file: string, exists: boolean}}
 */
function loadGroups(dir, fsApi = fs) {
    const file = path.join(dir, GROUPS_FILE);
    let text;
    try { text = fsApi.readFileSync(file, 'utf8'); } catch (e) {
        if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return { groups: [], errors: [], file, exists: false };
        return { groups: [], errors: [`groups.json cannot be read: ${String(e && e.message).slice(0, 200)}`], file, exists: true };
    }
    return { ...parseGroups(text, dir), file, exists: true };
}

/**
 * Groups as the text of a groups.json (2 spaces, a newline at the end, only the known fields, in a fixed order), after the same checks that
 * parseGroups makes. Throws a ScriptsError (EBADGROUPS) with every fault in the message when something is wrong.
 */
function serializeGroups(groups, workspaceFolder) {
    const { groups: checked, errors } = validateGroups({ groups }, workspaceFolder);
    if (errors.length) throw new ScriptsError('EBADGROUPS', errors.join('\n'));
    const plain = checked.map((g) => ({
        name: g.name,
        terminals: g.terminals.map((t) => {
            const o = { name: t.name };
            if (t.cwd !== '.') o.cwd = t.cwd;
            if (t.command) o.command = t.command;
            for (const f of ['profile', 'agent', 'color']) if (t[f]) o[f] = t[f];
            return o;
        }),
    }));
    return JSON.stringify({ groups: plain }, null, 2) + '\n';
}

/** Writes <dir>/.openconsole/groups.json (a temporary file first, then renamed). Returns the file. Throws like serializeGroups. */
function saveGroups(dir, groups, fsApi = fs) {
    const text = serializeGroups(groups, dir);
    const file = path.join(dir, GROUPS_FILE);
    fsApi.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fsApi.writeFileSync(tmp, text, 'utf8');
    fsApi.renameSync(tmp, file);
    return file;
}

/** A fingerprint of what a group starts (names, folders, commands ...): when it changes, the user is asked again. */
function groupDigest(group) {
    const terminals = ((group && group.terminals) || []).map((t) => TERMINAL_FIELDS.map((f) => (t && typeof t[f] === 'string' ? t[f] : '')));
    return crypto.createHash('sha256').update(JSON.stringify([group && group.name, terminals])).digest('hex');
}

module.exports = {
    discoverScripts, commandLine, isSafeScriptName, makeItem, allItems, terminalName, planRun,
    loadGroups, parseGroups, validateGroups, serializeGroups, saveGroups, groupDigest, resolveCwd, normalizeCwd,
    parsePnpmWorkspacePackages, ScriptsError, GROUPS_FILE,
    LIMITS: { MAX_TERMINALS, MAX_COMMAND, MAX_GROUPS, DEFAULT_MAX_PARALLEL, MAX_PARALLEL, MAX_RUN_ITEMS },
};
