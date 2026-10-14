'use strict';
// One git worktree per agent: its own folder and branch ("oc/<name>"), so several agents can work on the same repository without
// touching each other's files. Everything here runs git with execFile (a list of arguments, never a shell string) and a timeout.
//
// The safety rules:
//   1. git is started from an absolute path found in PATH, never by the bare name: on Windows a bare name is also looked up in the cwd
//      of the child, which here is a folder of a repository (a "git.exe" in it would be run).
//   2. removeWorktree removes only what `git worktree list` of this repository names, never the main worktree, and it hands git the
//      path that git printed, not the one it was given.
//   3. Names become letters, digits, "-" and "_" (lowercase, at most 40): no path or option can be made out of them.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const READ_TIMEOUT = 15000;
const WRITE_TIMEOUT = 120000;           // a checkout of a big repository takes its time
const MAX_BUFFER = 16 * 1024 * 1024;
const MAX_NAME = 40;
const MAX_ENTRIES = 200;                // the files that diffStat lists (the totals count all)
const BRANCH_PREFIX = 'oc/';
const ROOT_FOLDER = '.openconsole-worktrees';

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';
const pathKey = (p) => (CASE_INSENSITIVE ? p.toLowerCase() : p);

class WorktreeError extends Error {
    /** @param {string} code ENOGIT ENODIR ENOTREPO EBADNAME EBADBASE EBADPATH EMAIN EFOREIGN ELOCKED EDIRTY ETIMEDOUT EGIT */
    constructor(code, message, extra) { super(message); this.name = 'WorktreeError'; this.code = code; Object.assign(this, extra); }
}

// ---- running git ------------------------------------------------------------------------------------------------------------------

const isDirectory = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

let gitCache = null;
/** The full path of git: the first absolute folder of PATH that has it (a relative folder of PATH, such as ".", is not trusted). */
function findGit(env = process.env) {
    const pathValue = String(env.PATH || env.Path || '');
    if (gitCache && gitCache.pathValue === pathValue) return gitCache.exe;
    const name = process.platform === 'win32' ? 'git.exe' : 'git';
    let exe = null;
    for (const raw of pathValue.split(path.delimiter)) {
        const dir = raw.replace(/^"|"$/g, '');
        if (!dir || !path.isAbsolute(dir)) continue;
        const candidate = path.join(dir, name);
        if (isFile(candidate)) { exe = candidate; break; }
    }
    if (!exe && process.platform === 'win32') {
        const bases = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')].filter(Boolean);
        exe = bases.map((b) => path.join(b, 'Git', 'cmd', 'git.exe')).find(isFile) || null;
    }
    gitCache = { pathValue, exe };
    return exe;
}

// what would make git work on another repository than the one it is asked about (a hook of git that runs this process has them set)
const FOREIGN_GIT_ENV = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']);

function gitEnv() {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) if (!FOREIGN_GIT_ENV.has(key.toUpperCase())) env[key] = value;
    return Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' });
}

/** Runs git. Only fails to start or a timeout reject; a git that ends with an error has {code: n}. */
function run(args, { cwd, timeout = READ_TIMEOUT } = {}) {
    return new Promise((resolve, reject) => {
        const exe = findGit();
        if (!exe) return reject(new WorktreeError('ENOGIT', 'git was not found: install Git for Windows or put it in PATH'));
        if (cwd !== undefined && !isDirectory(cwd)) return reject(new WorktreeError('ENODIR', `the folder does not exist: ${cwd}`));
        execFile(exe, ['-c', 'core.quotepath=off', ...args], { cwd, env: gitEnv(), timeout, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
            if (!error) return resolve({ code: 0, stdout, stderr });
            if (typeof error.code === 'number') return resolve({ code: error.code, stdout: stdout || '', stderr: stderr || '' });
            if (error.killed) return reject(new WorktreeError('ETIMEDOUT', `git ${args[0]} took longer than ${Math.round(timeout / 1000)} s`));
            reject(new WorktreeError('EGIT', `git could not be run: ${error.message}`));
        });
    });
}

const firstLine = (text) => String(text || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';

/** Like run, but an error of git (an exit code that is not 0) is thrown. */
async function git(args, options) {
    const result = await run(args, options);
    if (result.code !== 0) {
        const detail = firstLine(result.stderr) || `exit code ${result.code}`;
        throw new WorktreeError(/not a git repository/i.test(result.stderr) ? 'ENOTREPO' : 'EGIT', `git ${args[0]}${args[1] && !args[1].startsWith('-') ? ' ' + args[1] : ''} failed: ${detail}`, { exitCode: result.code, stderr: result.stderr });
    }
    return result;
}

/** Whether git can be run at all. */
async function gitAvailable() {
    try { return (await run(['--version'])).code === 0; } catch { return false; }
}

/** Whether dir is a folder inside the working tree of a repository (a linked worktree counts; a bare repository does not). */
async function isGitRepo(dir) {
    if (typeof dir !== 'string' || !dir || !isDirectory(dir)) return false;
    try { return (await run(['rev-parse', '--is-inside-work-tree'], { cwd: dir })).stdout.trim() === 'true'; } catch { return false; }
}

// ---- listing -------------------------------------------------------------------------------------------------------------------------

/** The text of `git worktree list --porcelain` as entries. The first one is the main worktree. */
function parseWorktreeList(text) {
    const entries = [];
    let cur = null;
    for (const line of String(text).split(/\r?\n/)) {
        if (line.startsWith('worktree ')) {
            cur = { path: path.normalize(line.slice('worktree '.length)), head: null, branch: null, branchRef: null, detached: false, bare: false, locked: false, lockReason: null, prunable: false, prunableReason: null, isMain: entries.length === 0 };
            entries.push(cur);
        } else if (!cur || line === '') {
            continue;
        } else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
        else if (line.startsWith('branch ')) { cur.branchRef = line.slice(7); cur.branch = cur.branchRef.replace(/^refs\/heads\//, ''); }
        else if (line === 'detached') cur.detached = true;
        else if (line === 'bare') cur.bare = true;
        else if (line === 'locked' || line.startsWith('locked ')) { cur.locked = true; cur.lockReason = line.slice(7) || null; }
        else if (line === 'prunable' || line.startsWith('prunable ')) { cur.prunable = true; cur.prunableReason = line.slice(9) || null; }
    }
    return entries;
}

/**
 * The worktrees of the repository that repoDir is in (the main folder, a subfolder, or a linked worktree: the answer is the same).
 * @returns {Promise<{path: string, head: string|null, branch: string|null, branchRef: string|null, detached: boolean, bare: boolean, locked: boolean, lockReason: string|null, prunable: boolean, prunableReason: string|null, isMain: boolean}[]>}
 */
async function listWorktrees(repoDir) {
    if (typeof repoDir !== 'string' || !repoDir) throw new WorktreeError('ENODIR', 'no repository folder given');
    const { stdout } = await git(['worktree', 'list', '--porcelain'], { cwd: repoDir });
    return parseWorktreeList(stdout);
}

function canonical(p) {
    try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}
const samePath = (a, b) => pathKey(canonical(path.resolve(a))) === pathKey(canonical(path.resolve(b)));

// ---- names ---------------------------------------------------------------------------------------------------------------------------

const cutCodePoints = (text, max) => Array.from(text).slice(0, max).join('');

/**
 * What a name becomes: lowercase letters (of any script), digits, "-" and "_"; every other run of characters is one "-"; no "-" at the
 * start or the end; at most 40 characters. "" when nothing is left (the caller refuses that).
 */
function sanitizeWorktreeName(name) {
    if (typeof name !== 'string') return '';
    const text = name.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}_-]+/gu, '-').replace(/-{2,}/g, '-').replace(/^-+/, '');
    return cutCodePoints(text, MAX_NAME).replace(/-+$/, '');
}

/** The name of the main folder as a part of the name of a folder: no dots at the end (".git"), no odd characters. */
function repoLabel(mainPath) {
    const base = path.basename(mainPath).replace(/\.git$/i, '');
    return cutCodePoints(base.normalize('NFC').replace(/[^\p{L}\p{N}\p{M}_.-]+/gu, '-').replace(/^[-.]+|[-.]+$/g, ''), 60) || 'repo';
}

/** A branch or commit given by the caller: one word that cannot be taken for an option of git. */
function checkRevision(value, what = 'base') {
    if (typeof value !== 'string' || !value || value.length > 200 || /[\s\u0000-\u001f\u007f]/.test(value) || value.startsWith('-')) {
        throw new WorktreeError('EBADBASE', `${what} must be a branch, tag or commit name (one word, not starting with "-")`);
    }
    return value;
}

// one creation at a time per repository, so two agents that start at once do not pick the same name
const queues = new Map();
function serial(key, task) {
    const previous = queues.get(key) || Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.catch(() => {});
    queues.set(key, tail);
    tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
    return result;
}

/**
 * Makes a new branch "oc/<name>" from base and checks it out in a new folder: <root>/<repo>-<name>, where root is by default the folder
 * ".openconsole-worktrees" next to the repository. When the branch or the folder exists the name gets "-2", "-3" ...
 * @param {string} repoDir any folder of the repository
 * @param {{name: string, base?: string, root?: string}} options base is a branch, tag or commit (default HEAD of repoDir)
 * @returns {Promise<{path: string, branch: string, name: string, base: string, baseCommit: string, repo: string}>}
 */
async function createWorktree(repoDir, options = {}) {
    const { name, base = 'HEAD', root } = options || {};
    const wanted = sanitizeWorktreeName(name);
    if (!wanted) throw new WorktreeError('EBADNAME', 'The name needs at least one letter or digit');
    checkRevision(base);
    if (root !== undefined && (typeof root !== 'string' || !root.trim() || root.includes('\0'))) throw new WorktreeError('EBADPATH', 'root must be a folder path');
    const main = (await listWorktrees(repoDir))[0];
    return serial(pathKey(canonical(main.path)), async () => {
        // the base is read where the caller is (HEAD of repoDir, which may be another worktree), the new worktree is made from the main one
        const verified = await run(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { cwd: repoDir });
        const baseCommit = verified.stdout.trim();
        if (verified.code !== 0 || !/^[0-9a-f]{40,64}$/.test(baseCommit)) {
            throw new WorktreeError('EBADBASE', `${JSON.stringify(base)} is not a commit of this repository${base === 'HEAD' ? ' (does it have a first commit?)' : ''}`);
        }
        const rootDir = root ? path.resolve(root) : path.join(path.dirname(main.path), ROOT_FOLDER);
        fs.mkdirSync(rootDir, { recursive: true });
        const label = repoLabel(main.path);
        const listed = (await listWorktrees(main.path)).map((w) => pathKey(path.resolve(w.path)));
        for (let n = 1; n <= 99; n++) {
            const suffix = n === 1 ? '' : `-${n}`;
            const finalName = cutCodePoints(wanted, MAX_NAME - suffix.length).replace(/-+$/, '') + suffix;
            const branch = BRANCH_PREFIX + finalName;
            const target = path.join(rootDir, `${label}-${finalName}`);
            if (fs.existsSync(target) || listed.includes(pathKey(target))) continue;
            if ((await run(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: main.path })).code === 0) continue;
            await git(['worktree', 'add', '-b', branch, target, baseCommit], { cwd: main.path, timeout: WRITE_TIMEOUT });
            return { path: target, branch, name: finalName, base, baseCommit, repo: main.path };
        }
        throw new WorktreeError('EGIT', `There are already 99 worktrees called "${wanted}"`);
    });
}

// ---- removing ------------------------------------------------------------------------------------------------------------------------

/**
 * Removes a worktree of this repository (git worktree remove). Refused: a path that is not an absolute path of one of the worktrees that
 * `git worktree list` shows for this repository (EFOREIGN, also for a subfolder of one or the folder above), the main worktree (EMAIN),
 * a locked one without force (ELOCKED), one with changes without force (EDIRTY, git tells it). The branch stays, unless deleteBranch is
 * true: then "oc/..." branches are deleted with -d (-D with force); a branch that git will not delete is told in branchError.
 * @param {string} repoDir any folder of the repository (the folder that is removed is allowed: git is run from the main worktree)
 * @param {string} worktreePath absolute path of the worktree
 * @param {{force?: boolean, deleteBranch?: boolean}} [options]
 * @returns {Promise<{removed: true, path: string, branch: string|null, branchDeleted: boolean, branchError?: string}>}
 */
async function removeWorktree(repoDir, worktreePath, options = {}) {
    const force = !!options && options.force === true;
    const deleteBranch = !!options && options.deleteBranch === true;
    if (typeof worktreePath !== 'string' || !worktreePath.trim() || worktreePath.includes('\0')) throw new WorktreeError('EBADPATH', 'The path of the worktree is missing');
    if (!path.isAbsolute(worktreePath)) throw new WorktreeError('EBADPATH', 'The path of the worktree must be absolute');
    const list = await listWorktrees(repoDir);
    const entry = list.find((w) => samePath(w.path, worktreePath));
    if (!entry) throw new WorktreeError('EFOREIGN', `${worktreePath} is not a worktree of this repository`);
    if (entry.isMain) throw new WorktreeError('EMAIN', 'The main worktree is not removed');
    if (entry.locked && !force) throw new WorktreeError('ELOCKED', `The worktree is locked${entry.lockReason ? ' (' + entry.lockReason + ')' : ''}`);
    const main = list[0];
    try {
        await git(['worktree', 'remove', ...(force ? (entry.locked ? ['--force', '--force'] : ['--force']) : []), entry.path], { cwd: main.path, timeout: WRITE_TIMEOUT });
    } catch (e) {
        if (e.code === 'EGIT' && /modified or untracked files|use --force/i.test(e.stderr || '')) throw new WorktreeError('EDIRTY', `The worktree has changes: ${firstLine(e.stderr)}`, { stderr: e.stderr });
        throw e;
    }
    const result = { removed: true, path: entry.path, branch: entry.branch, branchDeleted: false };
    if (deleteBranch && entry.branch && entry.branch.startsWith(BRANCH_PREFIX)) {
        try { await git(['branch', force ? '-D' : '-d', '--', entry.branch], { cwd: main.path }); result.branchDeleted = true; } catch (e) { result.branchError = e.message; }
    }
    return result;
}

// ---- state ---------------------------------------------------------------------------------------------------------------------------

function requireDirectory(dir) {
    if (typeof dir !== 'string' || !dir || !isDirectory(dir)) throw new WorktreeError('ENODIR', `the folder does not exist: ${dir}`);
}

/** The text of `git status --porcelain=v2 --branch -z` as numbers. */
function parseStatus(text) {
    const s = { branch: null, detached: false, head: null, upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicts: 0, changed: 0 };
    const parts = String(text).split('\0');
    for (let i = 0; i < parts.length; i++) {
        const line = parts[i];
        if (!line) continue;
        if (line.startsWith('# ')) {
            const [key, ...rest] = line.slice(2).split(' ');
            const value = rest.join(' ');
            if (key === 'branch.oid') s.head = value === '(initial)' ? null : value;
            else if (key === 'branch.head') { s.detached = value === '(detached)'; s.branch = s.detached ? null : value; }
            else if (key === 'branch.upstream') s.upstream = value;
            else if (key === 'branch.ab') { const m = /^\+(\d+) -(\d+)$/.exec(value); if (m) { s.ahead = Number(m[1]); s.behind = Number(m[2]); } }
        } else if (line[0] === '1' || line[0] === '2') {
            const xy = line.split(' ')[1] || '..';
            if (xy[0] !== '.') s.staged++;
            if (xy[1] !== '.') s.unstaged++;
            s.changed++;
            if (line[0] === '2') i++;                       // a rename or copy is followed by the old path
        } else if (line[0] === 'u') { s.conflicts++; s.changed++; }
        else if (line[0] === '?') { s.untracked++; s.changed++; }
    }
    return s;
}

/**
 * What changed in a worktree: staged, unstaged, untracked and conflicted entries (an untracked folder counts once), and how far ahead of
 * and behind its upstream the branch is (null when it has none: the branches that createWorktree makes have none, see diffStat).
 * @returns {Promise<{clean: boolean, dirty: boolean, branch: string|null, detached: boolean, head: string|null, upstream: string|null, ahead: number|null, behind: number|null, staged: number, unstaged: number, untracked: number, conflicts: number, changed: number}>}
 */
async function worktreeStatus(worktreePath) {
    requireDirectory(worktreePath);
    const { stdout } = await git(['status', '--porcelain=v2', '--branch', '-z'], { cwd: worktreePath });
    const status = parseStatus(stdout);
    return Object.assign(status, { dirty: status.changed > 0, clean: status.changed === 0 });
}

/**
 * What the worktree changed compared with base: the files of the working tree against the common ancestor of base and HEAD (so what was
 * committed and what is not yet, but not the new files that git does not know: they are counted in `untracked`).
 * @param {string} worktreePath
 * @param {string} base a branch, tag or commit
 * @returns {Promise<{base: string, mergeBase: string, commitsAhead: number, files: number, insertions: number, deletions: number, binary: number, untracked: number, entries: {path: string, insertions: number, deletions: number, binary: boolean}[], truncated: boolean}>}
 */
async function diffStat(worktreePath, base) {
    requireDirectory(worktreePath);
    checkRevision(base);
    const merge = await run(['merge-base', base, 'HEAD'], { cwd: worktreePath });
    const mergeBase = merge.stdout.trim();
    if (/not a git repository/i.test(merge.stderr)) throw new WorktreeError('ENOTREPO', `${worktreePath} is not in a git repository`);
    if (merge.code !== 0 || !/^[0-9a-f]{40,64}$/.test(mergeBase)) throw new WorktreeError('EBADBASE', `${JSON.stringify(base)} has nothing in common with this worktree (or is not a commit)`);
    const [numstat, count, status] = await Promise.all([
        git(['diff', '--numstat', '-z', '--no-renames', mergeBase], { cwd: worktreePath }),
        git(['rev-list', '--count', `${mergeBase}..HEAD`], { cwd: worktreePath }),
        worktreeStatus(worktreePath),
    ]);
    const entries = [];
    let insertions = 0;
    let deletions = 0;
    let binary = 0;
    let files = 0;
    for (const record of numstat.stdout.split('\0')) {
        if (!record) continue;
        const [added, deleted, ...rest] = record.split('\t');
        const isBinary = added === '-' && deleted === '-';
        const entry = { path: rest.join('\t'), insertions: isBinary ? 0 : Number(added) || 0, deletions: isBinary ? 0 : Number(deleted) || 0, binary: isBinary };
        files++;
        insertions += entry.insertions;
        deletions += entry.deletions;
        if (isBinary) binary++;
        if (entries.length < MAX_ENTRIES) entries.push(entry);
    }
    return { base, mergeBase, commitsAhead: Number(count.stdout.trim()) || 0, files, insertions, deletions, binary, untracked: status.untracked, entries, truncated: files > entries.length };
}

module.exports = {
    isGitRepo, listWorktrees, createWorktree, removeWorktree, worktreeStatus, diffStat,
    gitAvailable, sanitizeWorktreeName, parseWorktreeList, parseStatus, findGit, WorktreeError,
    BRANCH_PREFIX, ROOT_FOLDER,
};
