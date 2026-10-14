'use strict';
// The tests that use git make real repositories in a new folder of the temporary folder of the system (and remove it at the end);
// no repository of the user is touched. The configuration of git of the user is switched off, so no identity or hook of theirs matters.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const W = require('../src/worktrees');

const GIT = W.findGit();
const SKIP = GIT ? false : 'git was not found in PATH: the tests with real repositories are skipped';
if (SKIP) console.warn('# ' + SKIP);

const key = (p) => { let r; try { r = fs.realpathSync.native(p); } catch { r = path.resolve(p); } return process.platform === 'win32' ? r.toLowerCase() : r; };
const same = (a, b, message) => assert.equal(key(a), key(b), message || `${a} is ${b}`);

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-wt-test-')));
const saved = {};
const FORCED_ENV = { GIT_CONFIG_GLOBAL: path.join(TMP, 'empty-gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
before(() => {
    fs.writeFileSync(FORCED_ENV.GIT_CONFIG_GLOBAL, '');
    for (const [k, v] of Object.entries(FORCED_ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
});
after(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* left in the temporary folder */ }
});

/** git for the set-up of a test: an identity through -c (no global one is needed), no signing, no line-end conversion. */
function sh(cwd, ...args) {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|PREFIX)$/i.test(k)) delete env[k];
    const r = spawnSync(GIT, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, env, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr || r.error}`);
    return r.stdout.trim();
}
const write = (dir, rel, text) => { const f = path.join(dir, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const exists = (p) => fs.existsSync(p);

/** A repository "proj" with a first commit on "main", in its own folder of TMP (so the sibling folder for the worktrees is its own too). */
function makeRepo(name = 'proj') {
    const home = fs.mkdtempSync(path.join(TMP, 'case-'));
    const repo = path.join(home, name);
    fs.mkdirSync(repo);
    sh(repo, 'init', '-q');
    sh(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    write(repo, 'a.txt', 'one\ntwo\nthree\n');
    write(repo, 'dir/b.txt', 'b\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'first');
    return { home, repo, head: sh(repo, 'rev-parse', 'HEAD') };
}

// ---- no git needed -------------------------------------------------------------------------------------------------------------------

test('names: letters, digits, "-" and "_" only, lowercase, no first "-", at most 40', () => {
    const s = W.sanitizeWorktreeName;
    assert.equal(s('Fix Login!!'), 'fix-login');
    assert.equal(s('  spaced   out  '), 'spaced-out');
    assert.equal(s('under_score-and-dash'), 'under_score-and-dash');
    assert.equal(s('-rf'), 'rf');
    assert.equal(s('--force'), 'force');
    assert.equal(s('---'), '');
    assert.equal(s('../../evil'), 'evil');
    assert.equal(s('..\\..\\Windows\\System32'), 'windows-system32');
    assert.equal(s('oc/other'), 'oc-other');
    assert.equal(s('a;b && c'), 'a-b-c');
    assert.equal(s('$(calc)'), 'calc');
    assert.equal(s('x`y`'), 'x-y');
    assert.equal(s('line\nbreak'), 'line-break');
    assert.equal(s('nul\u0000byte'), 'nul-byte');
    assert.equal(s('a.b'), 'a-b');
    assert.equal(s('release@{1}'), 'release-1');
    assert.equal(s('x'.repeat(100)), 'x'.repeat(40));
    assert.equal(s('a'.repeat(39) + '-bbb'), 'a'.repeat(39), 'no "-" is left at the end when the cut falls on it');
    assert.equal(s('إصلاح الدخول'), 'إصلاح-الدخول', 'letters of other scripts are letters');
    assert.equal(s('🔥🔥'), '');
    assert.equal(s(''), '');
    for (const bad of [undefined, null, 5, {}, ['a']]) assert.equal(s(bad), '');
    for (const input of ['x y', '--a', '../x', 'A_B-c', 'q\\r', '\u202eabc']) assert.match(s(input), /^[\p{L}\p{N}\p{M}_][\p{L}\p{N}\p{M}_-]*$/u, input);
});

test('the list of git is read: main first, a branch, detached, locked, prunable, bare, a path with spaces', () => {
    const text = [
        'worktree C:/work/my repo', 'HEAD 1111111111111111111111111111111111111111', 'branch refs/heads/main', '',
        'worktree C:/work/.openconsole-worktrees/my repo-fix', 'HEAD 2222222222222222222222222222222222222222', 'branch refs/heads/oc/fix', 'locked agent is running', '',
        'worktree C:/work/detached', 'HEAD 3333333333333333333333333333333333333333', 'detached', 'prunable gitdir file points to non-existent location', '',
        'worktree C:/bare.git', 'bare', '',
    ].join('\n');
    const list = W.parseWorktreeList(text);
    assert.equal(list.length, 4);
    assert.deepEqual(list.map((w) => w.isMain), [true, false, false, false]);
    assert.equal(list[0].path, path.normalize('C:/work/my repo'));
    assert.equal(list[0].branch, 'main');
    assert.equal(list[0].branchRef, 'refs/heads/main');
    assert.equal(list[0].head, '1'.repeat(40));
    assert.equal(list[1].branch, 'oc/fix');
    assert.equal(list[1].locked, true);
    assert.equal(list[1].lockReason, 'agent is running');
    assert.equal(list[2].detached, true);
    assert.equal(list[2].branch, null);
    assert.equal(list[2].prunable, true);
    assert.equal(list[3].bare, true);
    assert.deepEqual(W.parseWorktreeList(''), []);
    assert.equal(W.parseWorktreeList('worktree /x\nlocked\n')[0].locked, true);
});

test('the status of git is read: staged, unstaged, untracked, conflicts, renames, upstream and ahead/behind', () => {
    const text = [
        '# branch.oid abc', '# branch.head oc/x', '# branch.upstream origin/main', '# branch.ab +2 -3',
        '1 M. N... 100644 100644 100644 h1 h2 staged.txt',
        '1 .M N... 100644 100644 100644 h1 h2 unstaged file.txt',
        '1 MM N... 100644 100644 100644 h1 h2 both.txt',
        '2 R. N... 100644 100644 100644 h1 h2 R100 new name.txt', 'old name.txt',
        'u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict.txt',
        '? untracked.txt', '? dir/',
    ].join('\0') + '\0';
    assert.deepEqual(W.parseStatus(text), { branch: 'oc/x', detached: false, head: 'abc', upstream: 'origin/main', ahead: 2, behind: 3, staged: 3, unstaged: 2, untracked: 2, conflicts: 1, changed: 7 });
    const initial = W.parseStatus('# branch.oid (initial)\0# branch.head (detached)\0');
    assert.deepEqual([initial.head, initial.branch, initial.detached, initial.ahead, initial.upstream, initial.changed], [null, null, true, null, null, 0]);
});

test('git is looked up in PATH by full path; a relative folder of PATH is not trusted', () => {
    assert.equal(W.findGit({ PATH: '.' + path.delimiter + 'relative' + path.delimiter + '' }), null);
    if (GIT) assert.ok(path.isAbsolute(GIT) && fs.existsSync(GIT), GIT);
    W.findGit();                                                                     // the cache is for one value of PATH only
});

test('without a repository or a folder: the answers are false and errors, no crash', async () => {
    const plain = fs.mkdtempSync(path.join(TMP, 'plain-'));
    for (const bad of [undefined, null, '', 5, {}, path.join(TMP, 'does-not-exist')]) assert.equal(await W.isGitRepo(bad), false, String(bad));
    assert.equal(await W.isGitRepo(plain), false);
    if (!SKIP) {
        await assert.rejects(W.listWorktrees(plain), { code: 'ENOTREPO' });
        await assert.rejects(W.listWorktrees(path.join(TMP, 'does-not-exist')), { code: 'ENODIR' });
        await assert.rejects(W.listWorktrees(''), { code: 'ENODIR' });
        await assert.rejects(W.worktreeStatus(path.join(TMP, 'does-not-exist')), { code: 'ENODIR' });
        await assert.rejects(W.diffStat(plain, 'main'), { code: 'ENOTREPO' });
        assert.equal(await W.gitAvailable(), true);
    }
});

// ---- real repositories ---------------------------------------------------------------------------------------------------------------

test('isGitRepo: a folder in a repository, a linked worktree; not a plain folder, not the inside of .git', { skip: SKIP }, async () => {
    const { repo } = makeRepo();
    assert.equal(await W.isGitRepo(repo), true);
    assert.equal(await W.isGitRepo(path.join(repo, 'dir')), true);
    assert.equal(await W.isGitRepo(path.join(repo, '.git')), false);
    assert.equal(await W.isGitRepo(path.dirname(repo)), false);
});

test('listWorktrees: a fresh repository has one, the main one, on main', { skip: SKIP }, async () => {
    const { repo, head } = makeRepo();
    const list = await W.listWorktrees(repo);
    assert.equal(list.length, 1);
    same(list[0].path, repo);
    assert.equal(list[0].isMain, true);
    assert.equal(list[0].branch, 'main');
    assert.equal(list[0].head, head);
    assert.deepEqual([list[0].detached, list[0].bare, list[0].locked, list[0].prunable], [false, false, false, false]);
    assert.equal((await W.listWorktrees(path.join(repo, 'dir'))).length, 1, 'from a subfolder as well');
});

test('createWorktree: a new branch oc/<name> in <repo>/../.openconsole-worktrees/<repo>-<name>, at the commit of HEAD', { skip: SKIP }, async () => {
    const { home, repo, head } = makeRepo();
    const wt = await W.createWorktree(repo, { name: 'Fix Login!' });
    assert.equal(wt.branch, 'oc/fix-login');
    assert.equal(wt.name, 'fix-login');
    same(wt.path, path.join(home, '.openconsole-worktrees', 'proj-fix-login'));
    assert.equal(wt.baseCommit, head);
    assert.equal(wt.base, 'HEAD');
    same(wt.repo, repo);
    assert.ok(exists(path.join(wt.path, 'a.txt')) && exists(path.join(wt.path, 'dir', 'b.txt')), 'the files are checked out');
    assert.ok(exists(path.join(wt.path, '.git')), 'a linked worktree has a .git file');
    assert.equal(sh(wt.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'oc/fix-login');
    const list = await W.listWorktrees(repo);
    assert.equal(list.length, 2);
    assert.equal(list[0].isMain, true);
    same(list[1].path, wt.path);
    assert.equal(list[1].branch, 'oc/fix-login');
    assert.equal(list[1].isMain, false);
    assert.equal(list[1].head, head);
    assert.deepEqual((await W.listWorktrees(wt.path)).map((w) => w.branch), ['main', 'oc/fix-login'], 'the same list from inside the new worktree');
    assert.equal(await W.isGitRepo(wt.path), true);
    assert.equal(sh(repo, 'status', '--porcelain'), '', 'the main worktree is untouched');
});

test('createWorktree: another base, another root, a name from another script, an odd name', { skip: SKIP }, async () => {
    const { home, repo, head } = makeRepo();
    sh(repo, 'branch', 'release');
    write(repo, 'later.txt', 'x');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'second');
    const second = sh(repo, 'rev-parse', 'HEAD');
    const fromRelease = await W.createWorktree(repo, { name: 'from-release', base: 'release', root: path.join(home, 'elsewhere') });
    assert.equal(fromRelease.baseCommit, head);
    same(fromRelease.path, path.join(home, 'elsewhere', 'proj-from-release'));
    assert.ok(!exists(path.join(fromRelease.path, 'later.txt')));
    const fromCommit = await W.createWorktree(repo, { name: 'by-sha', base: second });
    assert.equal(fromCommit.baseCommit, second);
    assert.ok(exists(path.join(fromCommit.path, 'later.txt')));
    const arabic = await W.createWorktree(repo, { name: 'إصلاح الدخول' });
    assert.equal(arabic.branch, 'oc/إصلاح-الدخول');
    assert.ok(exists(path.join(arabic.path, 'a.txt')));
    assert.ok((await W.listWorktrees(repo)).some((w) => w.branch === 'oc/إصلاح-الدخول'));
    // an option or a path cannot be made of a name: they all end up as names inside the root
    for (const name of ['--force', '../../escape', '..\\..\\escape2', '$(calc)', '-b evil']) {
        const made = await W.createWorktree(repo, { name });
        assert.equal(path.dirname(key(made.path)), key(path.join(home, '.openconsole-worktrees')), name);
        assert.match(made.branch, /^oc\/[\p{L}\p{N}_-]+$/u);
    }
    assert.ok(!exists(path.join(home, 'escape')) && !exists(path.join(path.dirname(home), 'escape')));
});

test('createWorktree: a name that is already taken (branch, folder, or the worktree before) gets -2, -3 ...', { skip: SKIP }, async () => {
    const { home, repo } = makeRepo();
    const first = await W.createWorktree(repo, { name: 'task' });
    const second = await W.createWorktree(repo, { name: 'task' });
    const third = await W.createWorktree(repo, { name: 'TASK' });
    assert.deepEqual([first.branch, second.branch, third.branch], ['oc/task', 'oc/task-2', 'oc/task-3']);
    assert.deepEqual([first.name, second.name, third.name], ['task', 'task-2', 'task-3']);
    same(second.path, path.join(home, '.openconsole-worktrees', 'proj-task-2'));
    assert.equal(new Set([first.path, second.path, third.path].map(key)).size, 3);
    // a branch with that name made by hand, and a folder with that name made by hand
    sh(repo, 'branch', 'oc/manual');
    fs.mkdirSync(path.join(home, '.openconsole-worktrees', 'proj-folder'), { recursive: true });
    assert.equal((await W.createWorktree(repo, { name: 'manual' })).branch, 'oc/manual-2');
    const folder = await W.createWorktree(repo, { name: 'folder' });
    assert.equal(folder.branch, 'oc/folder-2');
    assert.equal(fs.readdirSync(path.join(home, '.openconsole-worktrees', 'proj-folder')).length, 0, 'the folder of the user was left alone');
    // a long name keeps room for the number
    const long = 'x'.repeat(60);
    const a = await W.createWorktree(repo, { name: long });
    const b = await W.createWorktree(repo, { name: long });
    assert.equal(a.name.length, 40);
    assert.equal(b.name.length, 40);
    assert.match(b.name, /-2$/);
});

test('createWorktree: several at the same moment get different names', { skip: SKIP }, async () => {
    const { repo } = makeRepo();
    const made = await Promise.all([1, 2, 3, 4].map(() => W.createWorktree(repo, { name: 'agent' })));
    assert.deepEqual(made.map((m) => m.branch).sort(), ['oc/agent', 'oc/agent-2', 'oc/agent-3', 'oc/agent-4']);
    assert.equal((await W.listWorktrees(repo)).length, 5);
});

test('createWorktree: refused names and bases, and no repository', { skip: SKIP }, async () => {
    const { repo, home } = makeRepo();
    for (const name of ['', '   ', '---', '🔥', '...', undefined, null, 5]) await assert.rejects(W.createWorktree(repo, { name }), { code: 'EBADNAME' }, String(name));
    for (const base of ['--help', '-b', 'a b', 'x\ny', '', 5, null]) await assert.rejects(W.createWorktree(repo, { name: 'ok', base }), { code: 'EBADBASE' }, String(base));
    await assert.rejects(W.createWorktree(repo, { name: 'ok', base: 'no-such-branch' }), { code: 'EBADBASE' });
    await assert.rejects(W.createWorktree(repo, { name: 'ok', root: 5 }), { code: 'EBADPATH' });
    await assert.rejects(W.createWorktree(repo, { name: 'ok', root: 'a\0b' }), { code: 'EBADPATH' });
    await assert.rejects(W.createWorktree(home, { name: 'ok' }), { code: 'ENOTREPO' });
    await assert.rejects(W.createWorktree(path.join(home, 'missing'), { name: 'ok' }), { code: 'ENODIR' });
    await assert.rejects(W.createWorktree(repo), { code: 'EBADNAME' });
    assert.equal((await W.listWorktrees(repo)).length, 1, 'nothing was made');
    assert.deepEqual(sh(repo, 'branch', '--list', 'oc/*'), '');
    // a repository without a commit has no HEAD to start from
    const fresh = fs.mkdtempSync(path.join(TMP, 'fresh-'));
    sh(fresh, 'init', '-q');
    await assert.rejects(W.createWorktree(fresh, { name: 'ok' }), (e) => e.code === 'EBADBASE' && /first commit/.test(e.message));
});

test('createWorktree: the base HEAD is the HEAD of the folder that is given (another worktree), not of the main one', { skip: SKIP }, async () => {
    const { repo } = makeRepo();
    const one = await W.createWorktree(repo, { name: 'one' });
    write(one.path, 'extra.txt', 'x');
    sh(one.path, 'add', '-A');
    sh(one.path, 'commit', '-q', '-m', 'in one');
    const fromOne = await W.createWorktree(one.path, { name: 'child' });
    assert.equal(fromOne.baseCommit, sh(one.path, 'rev-parse', 'HEAD'));
    assert.ok(exists(path.join(fromOne.path, 'extra.txt')));
    same(fromOne.repo, repo, 'the repository is the main one, the folder is next to it');
});

test('worktreeStatus: clean, then staged, unstaged and untracked files are counted', { skip: SKIP }, async () => {
    const { repo, head } = makeRepo();
    const wt = await W.createWorktree(repo, { name: 'state' });
    let s = await W.worktreeStatus(wt.path);
    assert.deepEqual(s, { clean: true, dirty: false, branch: 'oc/state', detached: false, head, upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicts: 0, changed: 0 });
    write(wt.path, 'a.txt', 'one\nTWO\nthree\n');                       // unstaged
    write(wt.path, 'new-staged.txt', 'x\n'); sh(wt.path, 'add', 'new-staged.txt');   // staged
    write(wt.path, 'dir/b.txt', 'b2\n'); sh(wt.path, 'add', 'dir/b.txt'); write(wt.path, 'dir/b.txt', 'b3\n');   // both
    write(wt.path, 'loose.txt', 'y\n');                                 // untracked
    write(wt.path, 'folder/x.txt', '1'); write(wt.path, 'folder/y.txt', '2');   // an untracked folder counts once
    s = await W.worktreeStatus(wt.path);
    assert.equal(s.clean, false);
    assert.equal(s.dirty, true);
    assert.deepEqual([s.staged, s.unstaged, s.untracked, s.conflicts, s.changed], [2, 2, 2, 0, 5]);
    assert.equal((await W.worktreeStatus(repo)).clean, true, 'the main worktree has its own state');
    // a file with spaces and non-ASCII letters in the name
    write(wt.path, 'ملف عربي.txt', 'x');
    assert.equal((await W.worktreeStatus(wt.path)).untracked, 3);
});

test('worktreeStatus: ahead and behind when there is an upstream, conflicts, a detached HEAD', { skip: SKIP }, async () => {
    const { repo } = makeRepo();
    const wt = await W.createWorktree(repo, { name: 'sync' });
    sh(wt.path, 'branch', '--set-upstream-to=main');
    write(wt.path, 'a.txt', 'one\nBRANCH\nthree\n');
    sh(wt.path, 'commit', '-q', '-am', 'on the branch');
    let s = await W.worktreeStatus(wt.path);
    assert.deepEqual([s.upstream, s.ahead, s.behind, s.clean], ['main', 1, 0, true]);
    write(repo, 'a.txt', 'one\nMAIN\nthree\n');
    sh(repo, 'commit', '-q', '-am', 'on main');
    s = await W.worktreeStatus(wt.path);
    assert.deepEqual([s.ahead, s.behind], [1, 1]);
    const merge = spawnSync(GIT, ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'merge', 'main'], { cwd: wt.path, encoding: 'utf8', windowsHide: true });
    assert.notEqual(merge.status, 0, 'the merge has a conflict');
    s = await W.worktreeStatus(wt.path);
    assert.equal(s.conflicts, 1);
    assert.equal(s.clean, false);
    sh(wt.path, 'merge', '--abort');
    sh(wt.path, 'checkout', '-q', '--detach');
    s = await W.worktreeStatus(wt.path);
    assert.deepEqual([s.detached, s.branch, s.upstream, s.ahead], [true, null, null, null]);
});

test('diffStat: what the worktree changed against the base: committed, not committed, binary, new files', { skip: SKIP }, async () => {
    const { repo, head } = makeRepo();
    const wt = await W.createWorktree(repo, { name: 'stat' });
    let d = await W.diffStat(wt.path, 'main');
    assert.deepEqual([d.files, d.insertions, d.deletions, d.commitsAhead, d.untracked, d.binary, d.entries.length, d.truncated], [0, 0, 0, 0, 0, 0, 0, false]);
    assert.equal(d.mergeBase, head);
    write(wt.path, 'a.txt', 'one\nTWO\nthree\nfour\n');                 // +2 -1
    fs.writeFileSync(path.join(wt.path, 'image.bin'), Buffer.from([0, 1, 2, 0, 255]));
    sh(wt.path, 'add', '-A');
    sh(wt.path, 'commit', '-q', '-m', 'agent work');
    write(wt.path, 'dir/b.txt', 'b\nmore\n');                           // +1, not committed
    write(wt.path, 'loose.txt', 'new\n');                               // not known to git
    // main moves on: the merge base stays, so only the work of the worktree is counted
    write(repo, 'main-only.txt', 'x'); sh(repo, 'add', '-A'); sh(repo, 'commit', '-q', '-m', 'main moves');
    d = await W.diffStat(wt.path, 'main');
    assert.deepEqual([d.files, d.insertions, d.deletions, d.binary, d.commitsAhead, d.untracked], [3, 3, 1, 1, 1, 1]);
    assert.equal(d.mergeBase, head);
    assert.deepEqual(d.entries.map((e) => e.path).sort(), ['a.txt', 'dir/b.txt', 'image.bin']);
    assert.deepEqual(d.entries.find((e) => e.path === 'a.txt'), { path: 'a.txt', insertions: 2, deletions: 1, binary: false });
    assert.equal(d.entries.find((e) => e.path === 'image.bin').binary, true);
    // a base can also be a commit
    assert.equal((await W.diffStat(wt.path, head)).files, 3);
    await assert.rejects(W.diffStat(wt.path, '--output=x'), { code: 'EBADBASE' });
    await assert.rejects(W.diffStat(wt.path, 'no-such-base'), { code: 'EBADBASE' });
    assert.ok(!exists(path.join(wt.path, 'x')) && !exists(path.join(process.cwd(), 'x')), 'a base that looks like an option was not run as one');
});

test('git of another repository is not used when GIT_DIR and GIT_WORK_TREE are in the environment', { skip: SKIP }, async () => {
    const { repo } = makeRepo();
    const other = makeRepo('other');
    const before = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = path.join(other.repo, '.git');
    process.env.GIT_WORK_TREE = other.repo;
    try {
        same((await W.listWorktrees(repo))[0].path, repo);
        const wt = await W.createWorktree(repo, { name: 'env' });
        assert.equal((await W.listWorktrees(other.repo)).length, 1, 'the other repository got nothing');
        assert.equal(sh(other.repo, 'branch', '--list', 'oc/*'), '');
        same(wt.repo, repo);
    } finally {
        if (before.dir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = before.dir;
        if (before.tree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = before.tree;
    }
});

test('a file called git.exe in the repository is not run instead of git', { skip: SKIP }, async () => {
    const { repo } = makeRepo();
    fs.writeFileSync(path.join(repo, 'git.exe'), 'not a program');
    fs.writeFileSync(path.join(repo, 'git'), 'not a program');
    assert.equal(await W.isGitRepo(repo), true);
    assert.equal((await W.listWorktrees(repo)).length, 1);
    const wt = await W.createWorktree(repo, { name: 'plant' });
    fs.writeFileSync(path.join(wt.path, 'git.exe'), 'not a program');
    assert.equal((await W.worktreeStatus(wt.path)).untracked, 1);
});

// ---- removing ------------------------------------------------------------------------------------------------------------------------

test('removeWorktree: a clean worktree is removed, the branch stays', { skip: SKIP }, async () => {
    const { repo } = makeRepo();
    const wt = await W.createWorktree(repo, { name: 'gone' });
    const result = await W.removeWorktree(repo, wt.path);
    assert.deepEqual([result.removed, result.branch, result.branchDeleted], [true, 'oc/gone', false]);
    same(result.path, wt.path);
    assert.ok(!exists(wt.path), 'the folder is gone');
    assert.equal((await W.listWorktrees(repo)).length, 1);
    assert.equal(sh(repo, 'branch', '--list', 'oc/gone').replace(/^\*?\s+/, ''), 'oc/gone', 'the branch is still there');
    await assert.rejects(W.removeWorktree(repo, wt.path), { code: 'EFOREIGN' }, 'it is not listed any more');
});

test('removeWorktree: the main worktree is never removed, however its path is written', { skip: SKIP }, async () => {
    const { home, repo } = makeRepo();
    const wt = await W.createWorktree(repo, { name: 'other' });
    const spellings = [repo, repo + path.sep, path.join(repo, '.'), path.join(repo, 'dir', '..'), path.join(home, 'x', '..', path.basename(repo)), path.join(wt.path, '..', '..', path.basename(repo))];
    if (process.platform === 'win32') spellings.push(repo.toUpperCase(), repo.toLowerCase(), repo.replace(/\\/g, '/'));
    for (const spelling of spellings) {
        await assert.rejects(W.removeWorktree(repo, spelling, { force: true }), { code: 'EMAIN' }, spelling);
        await assert.rejects(W.removeWorktree(wt.path, spelling, { force: true, deleteBranch: true }), { code: 'EMAIN' }, 'from the other worktree: ' + spelling);
    }
    assert.ok(exists(path.join(repo, 'a.txt')) && exists(path.join(repo, '.git')), 'the main worktree is intact');
    assert.equal(sh(repo, 'branch', '--list', 'main').includes('main'), true);
    assert.equal(sh(repo, 'status', '--porcelain'), '');
});

test('removeWorktree: what is not a worktree of this repository is refused and left alone', { skip: SKIP }, async () => {
    const { home, repo } = makeRepo();
    const wt = await W.createWorktree(repo, { name: 'mine' });
    const foreign = makeRepo('foreign');
    const theirs = await W.createWorktree(foreign.repo, { name: 'theirs' });
    const plain = fs.mkdtempSync(path.join(TMP, 'plain-'));
    write(plain, 'keep.txt', 'keep');
    const root = path.join(home, '.openconsole-worktrees');
    const refused = [
        theirs.path,                                              // a worktree of another repository
        theirs.path.replace(/\\/g, '/'),
        foreign.repo,
        plain,                                                    // any folder
        os.tmpdir(), home, root, path.dirname(root), path.parse(home).root,
        path.join(wt.path, 'dir'),                                // a folder inside a worktree
        path.join(wt.path, 'a.txt'),
        path.join(wt.path, '..'),                                 // the folder with the worktrees
        path.join(wt.path, '..', '..'),
        path.join(wt.path, '..', '..', '..'),
        path.join(wt.path, '..', path.basename(theirs.path)),     // the name of the other one, in the folder of this one
        path.join(root, 'proj-nope'),
        wt.path + '-2',
        wt.path.slice(0, -1),
        path.join(wt.path, '..', '..', 'proj-mine'),
        path.join(wt.path, '..', '..', '..', path.basename(path.dirname(foreign.repo)), 'foreign', '..', 'foreign'),
    ];
    for (const target of refused) {
        await assert.rejects(W.removeWorktree(repo, target, { force: true }), (e) => e.code === 'EFOREIGN' || e.code === 'EMAIN', target);
    }
    for (const bad of ['', '   ', 'relative', '..', '.\\x', '../proj-mine', undefined, null, 5, {}, 'a\0b']) {
        await assert.rejects(W.removeWorktree(repo, bad, { force: true }), { code: 'EBADPATH' }, String(bad));
    }
    assert.ok(exists(path.join(theirs.path, 'a.txt')), 'the worktree of the other repository is intact');
    assert.ok(exists(path.join(plain, 'keep.txt')));
    assert.ok(exists(path.join(wt.path, 'a.txt')), 'and so is the own one');
    assert.equal((await W.listWorktrees(repo)).length, 2);
    assert.equal((await W.listWorktrees(foreign.repo)).length, 2);
});

test('removeWorktree: a worktree with changes needs force; a locked one needs force too', { skip: SKIP }, async () => {
    const { repo } = makeRepo();
    const dirty = await W.createWorktree(repo, { name: 'dirty' });
    write(dirty.path, 'work.txt', 'not committed');
    await assert.rejects(W.removeWorktree(repo, dirty.path), { code: 'EDIRTY' });
    await assert.rejects(W.removeWorktree(repo, dirty.path, { force: false }), { code: 'EDIRTY' });
    await assert.rejects(W.removeWorktree(repo, dirty.path, { force: 'yes' }), { code: 'EDIRTY' }, 'only true is force');
    assert.ok(exists(path.join(dirty.path, 'work.txt')), 'nothing was lost');
    assert.equal((await W.removeWorktree(repo, dirty.path, { force: true })).removed, true);
    assert.ok(!exists(dirty.path));

    const locked = await W.createWorktree(repo, { name: 'locked' });
    sh(repo, 'worktree', 'lock', '--reason', 'an agent runs', locked.path);
    await assert.rejects(W.removeWorktree(repo, locked.path), (e) => e.code === 'ELOCKED' && /an agent runs/.test(e.message));
    assert.ok(exists(locked.path));
    assert.equal((await W.removeWorktree(repo, locked.path, { force: true })).removed, true);
    assert.ok(!exists(locked.path));
    assert.equal((await W.listWorktrees(repo)).length, 1);
});

test('removeWorktree: from inside the worktree itself, and with the branch deleted', { skip: SKIP }, async () => {
    const { repo } = makeRepo();
    const wt = await W.createWorktree(repo, { name: 'self' });
    const result = await W.removeWorktree(wt.path, wt.path, { deleteBranch: true });
    assert.deepEqual([result.removed, result.branchDeleted], [true, true]);
    assert.ok(!exists(wt.path));
    assert.equal(sh(repo, 'branch', '--list', 'oc/self'), '');

    const work = await W.createWorktree(repo, { name: 'unmerged' });
    write(work.path, 'x.txt', 'x'); sh(work.path, 'add', '-A'); sh(work.path, 'commit', '-q', '-m', 'unmerged work');
    const kept = await W.removeWorktree(repo, work.path, { deleteBranch: true });
    assert.equal(kept.removed, true);
    assert.equal(kept.branchDeleted, false, 'git does not delete a branch with work that is not merged');
    assert.ok(kept.branchError && /not fully merged|unmerged/i.test(kept.branchError), kept.branchError);
    assert.notEqual(sh(repo, 'branch', '--list', 'oc/unmerged'), '');
    const again = await W.createWorktree(repo, { name: 'unmerged' });
    assert.equal(again.branch, 'oc/unmerged-2', 'the kept branch keeps its name');
    write(again.path, 'y.txt', 'y'); sh(again.path, 'add', '-A'); sh(again.path, 'commit', '-q', '-m', 'more unmerged work');
    const forced = await W.removeWorktree(repo, again.path, { force: true, deleteBranch: true });
    assert.equal(forced.branchDeleted, true, 'with force the branch goes too');

    // only the branches of OpenConsole are ever deleted
    sh(repo, 'worktree', 'add', '-q', '-b', 'feature-by-hand', path.join(path.dirname(repo), 'by-hand'));
    const byHand = await W.removeWorktree(repo, path.join(path.dirname(repo), 'by-hand'), { deleteBranch: true, force: true });
    assert.equal(byHand.removed, true);
    assert.equal(byHand.branchDeleted, false);
    assert.notEqual(sh(repo, 'branch', '--list', 'feature-by-hand'), '');
});
