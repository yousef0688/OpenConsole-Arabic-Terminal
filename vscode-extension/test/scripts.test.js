'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('../src/scripts');

// ---- fixtures: every test makes its own folder under the temporary folder of the system, and all of them are removed at the end
const made = [];
function fixture(files) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-scripts-')));
    made.push(dir);
    for (const [rel, content] of Object.entries(files)) {
        const file = path.join(dir, ...rel.split('/'));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
    }
    return dir;
}
after(() => { for (const dir of made) try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* left behind in the temporary folder */ } });

const pkg = (name, scripts, extra = {}) => ({ name, version: '1.0.0', scripts, ...extra });
const names = (entries) => entries.map((e) => e.packageName);
const rel = (dir, entry) => path.relative(dir, entry.packageDir).split(path.sep).join('/') || '.';

// ---- discoverScripts ---------------------------------------------------------------------------------------------------------------

test('npm: the scripts of the package.json of the folder, with the package manager from the lock file', () => {
    const dir = fixture({ 'package.json': pkg('app', { dev: 'vite', 'build:prod': 'vite build', test: 'node --test' }), 'package-lock.json': '{}' });
    const [entry, ...more] = S.discoverScripts([dir]);
    assert.equal(more.length, 0);
    assert.equal(entry.folder, dir);
    assert.equal(entry.packageDir, dir);
    assert.equal(entry.packageName, 'app');
    assert.equal(entry.manager, 'npm');
    assert.equal(entry.nx, false);
    assert.deepEqual(entry.scripts, [{ name: 'dev', command: 'vite' }, { name: 'build:prod', command: 'vite build' }, { name: 'test', command: 'node --test' }]);
});

test('a folder without package.json, a broken one, or a package without scripts gives nothing, and nothing throws', () => {
    const empty = fixture({ 'readme.md': 'x' });
    const broken = fixture({ 'package.json': '{ not json' });
    const noScripts = fixture({ 'package.json': pkg('lib', {}) });
    const weird = fixture({ 'package.json': { name: 'w', scripts: ['a', 'b'] } });
    assert.deepEqual(S.discoverScripts([empty, broken, noScripts, weird]), []);
    assert.deepEqual(S.discoverScripts([path.join(os.tmpdir(), 'oc-scripts-does-not-exist-' + process.pid)]), []);
    assert.deepEqual(S.discoverScripts([null, 5, '', {}, 'a\0b']), []);
    assert.deepEqual(S.discoverScripts('not a list'), []);
    assert.deepEqual(S.discoverScripts([]), []);
});

test('yarn workspaces: packages/*, a literal folder, "!" exclusions; node_modules, links and packages without scripts are skipped', () => {
    const dir = fixture({
        'package.json': pkg('root', { lint: 'eslint .' }, { workspaces: ['packages/*', 'apps/web', '!packages/legacy', 'tools/*'] }),
        'yarn.lock': '',
        'packages/api/package.json': pkg('@acme/api', { dev: 'node api.js', build: 'tsc' }),
        'packages/ui/package.json': pkg('@acme/ui', { storybook: 'sb dev' }),
        'packages/legacy/package.json': pkg('@acme/legacy', { old: 'echo old' }),
        'packages/empty/package.json': pkg('@acme/empty', {}),
        'packages/node_modules/dep/package.json': pkg('dep', { postinstall: 'echo hi' }),
        'packages/.hidden/package.json': pkg('hidden', { x: 'y' }),
        'apps/web/package.json': pkg('web', { start: 'next start' }),
        'apps/other/package.json': pkg('other', { start: 'not listed' }),
        'node_modules/pkgx/package.json': pkg('pkgx', { start: 'no' }),
    });
    const entries = S.discoverScripts([dir]);
    assert.deepEqual(entries.map((e) => rel(dir, e)), ['.', 'apps/web', 'packages/api', 'packages/ui']);
    assert.deepEqual(names(entries), ['root', 'web', '@acme/api', '@acme/ui']);
    for (const e of entries) assert.equal(e.manager, 'yarn', e.packageName + ' uses the lock file of the root');
    assert.deepEqual(entries[2].scripts.map((s) => s.name), ['dev', 'build']);
});

test('workspaces as {packages: [...]} and "**" (up to four levels) work', () => {
    const dir = fixture({
        'package.json': pkg('root', { a: 'b' }, { workspaces: { packages: ['libs/**'], nohoist: ['**/x'] } }),
        'libs/one/package.json': pkg('one', { t: 'x' }),
        'libs/group/two/package.json': pkg('two', { t: 'x' }),
        'libs/a/b/c/d/e/too-deep/package.json': pkg('deep', { t: 'x' }),
    });
    const found = names(S.discoverScripts([dir]));
    assert.deepEqual(found.slice().sort(), ['one', 'root', 'two']);
    assert.ok(!found.includes('deep'), 'more than four levels down is not looked at');
});

test('pnpm: pnpm-workspace.yaml with comments, quotes, CRLF, "!" and other keys; nx.json and project.json are noted', () => {
    const yaml = [
        '# the workspace',
        'packages:',
        "  - 'packages/*'   # all of them",
        '  - "apps/*"',
        '  - tools/cli',
        "  - '!packages/skip-me'",
        '  - "!**/__fixtures__/**"',
        'catalog:',
        '  react: ^19',
        '  - not-a-package',
        '',
    ].join('\r\n');
    const dir = fixture({
        'package.json': pkg('mono', { build: 'nx run-many -t build' }),
        'pnpm-workspace.yaml': yaml,
        'pnpm-lock.yaml': 'lockfileVersion: 9',
        'nx.json': '{}',
        'packages/core/package.json': pkg('core', { build: 'tsc' }),
        'packages/skip-me/package.json': pkg('skip', { build: 'tsc' }),
        'apps/site/package.json': pkg('site', { dev: 'astro dev' }),
        'apps/__fixtures__/package.json': pkg('fixture', { dev: 'no' }),
        'tools/cli/package.json': pkg('cli', { run: 'node cli.js' }, { packageManager: 'yarn@4.1.0' }),
        'tools/cli/project.json': '{}',
        'other/package.json': pkg('other', { x: 'y' }),
    });
    const entries = S.discoverScripts([dir]);
    assert.deepEqual(entries.map((e) => rel(dir, e)), ['.', 'apps/site', 'packages/core', 'tools/cli']);
    const byName = Object.fromEntries(entries.map((e) => [e.packageName, e]));
    assert.equal(byName.mono.manager, 'pnpm');
    assert.equal(byName.core.manager, 'pnpm');
    assert.equal(byName.cli.manager, 'yarn', 'the packageManager field of the package wins over the lock file of the root');
    assert.ok(entries.every((e) => e.nx), 'nx.json at the root');
    // without nx.json only the package with a project.json is an Nx project
    const plain = fixture({ 'package.json': pkg('p', { a: 'b' }, { workspaces: ['x'] }), 'x/package.json': pkg('x', { a: 'b' }), 'x/project.json': '{}' });
    assert.deepEqual(S.discoverScripts([plain]).map((e) => [e.packageName, e.nx]), [['p', false], ['x', true]]);
});

test('the yaml reader alone', () => {
    const parse = S.parsePnpmWorkspacePackages;
    assert.deepEqual(parse('packages:\n  - a\n  - "b/*"\n  - \'c/**\'\n'), ['a', 'b/*', 'c/**']);
    assert.deepEqual(parse('packages:\n- a\n- b\nother:\n- c\n'), ['a', 'b'], 'a list that starts in the first column; the next key ends it');
    assert.deepEqual(parse("packages: ['a', \"b/*\", c]\n"), ['a', 'b/*', 'c']);
    assert.deepEqual(parse('packages: []\n'), []);
    assert.deepEqual(parse('\uFEFFpackages:\r\n  - a # note\r\n  - "# not a comment"\r\n'), ['a', '# not a comment']);
    assert.deepEqual(parse('catalog:\n  - x\n'), []);
    assert.deepEqual(parse(''), []);
});

test('the package manager: the packageManager field, then lock files (pnpm, yarn, bun, npm), then pnpm-workspace.yaml, then npm', () => {
    const one = (files) => S.discoverScripts([fixture({ 'package.json': pkg('p', { a: 'b' }, files['package.json'] || {}), ...Object.fromEntries(Object.entries(files).filter(([k]) => k !== 'package.json')) })])[0].manager;
    assert.equal(one({}), 'npm');
    assert.equal(one({ 'package-lock.json': '{}' }), 'npm');
    assert.equal(one({ 'yarn.lock': '' }), 'yarn');
    assert.equal(one({ 'pnpm-lock.yaml': '' }), 'pnpm');
    assert.equal(one({ 'bun.lockb': '' }), 'bun');
    assert.equal(one({ 'bun.lock': '' }), 'bun');
    assert.equal(one({ 'pnpm-workspace.yaml': 'packages: []' }), 'pnpm');
    assert.equal(one({ 'package-lock.json': '{}', 'package.json': { packageManager: 'bun@1.1.0' } }), 'bun');
    assert.equal(one({ 'yarn.lock': '', 'package.json': { packageManager: 'pnpm@9.1.0+sha256.abc' } }), 'pnpm');
    assert.equal(one({ 'yarn.lock': '', 'package.json': { packageManager: 'deno@2' } }), 'yarn', 'an unknown manager is ignored');
});

test('workspace patterns cannot leave the workspace folder: "..", absolute paths, drives, odd names', () => {
    const base = fixture({
        'ws/package.json': pkg('ws', { a: 'b' }, { workspaces: ['../outside', '../*', 'packages/../../outside', 'C:/Windows', '/outside', 'D:\\x', '\\\\server\\share', 'pkgs/.. /x', 'pkgs/...', 'ok/*'] }),
        'ws/ok/inside/package.json': pkg('inside', { a: 'b' }),
        'outside/package.json': pkg('outside', { a: 'b' }),
        'ws/pnpm-workspace.yaml': "packages:\n  - '../outside'\n  - '../**'\n",
    });
    const ws = path.join(base, 'ws');
    assert.deepEqual(names(S.discoverScripts([ws])), ['ws', 'inside']);
    // the absolute path of the other folder
    fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify(pkg('ws', { a: 'b' }, { workspaces: [path.join(base, 'outside'), path.join(base, 'outside').replace(/\\/g, '/')] })));
    assert.deepEqual(names(S.discoverScripts([ws])), ['ws']);
});

test('a link inside the workspace that leads out is not followed', (t) => {
    const base = fixture({
        'ws/package.json': pkg('ws', { a: 'b' }, { workspaces: ['link', 'links/*'] }),
        'outside/pkg/package.json': pkg('outside', { a: 'b' }),
    });
    try {
        fs.symlinkSync(path.join(base, 'outside', 'pkg'), path.join(base, 'ws', 'link'), 'junction');
        fs.mkdirSync(path.join(base, 'ws', 'links'));
        fs.symlinkSync(path.join(base, 'outside', 'pkg'), path.join(base, 'ws', 'links', 'p'), 'junction');
    } catch (e) { return t.skip('links cannot be made here: ' + e.code); }
    assert.deepEqual(names(S.discoverScripts([path.join(base, 'ws')])), ['ws']);
});

test('script names that are not safe are not offered; non-string commands are skipped; several folders and a folder twice', () => {
    const a = fixture({ 'package.json': pkg('a', { ok: 'x', 'bad name': 'x', 'a;b': 'x', 'ok:2': 'y', num: 5, nested: { x: 1 }, 'x$(calc)': 'x' }) });
    const b = fixture({ 'package.json': pkg('b', { go: 'run' }) });
    const entries = S.discoverScripts([a, b, a, path.join(a, '.')]);
    assert.deepEqual(names(entries), ['a', 'b']);
    assert.deepEqual(entries[0].scripts.map((s) => s.name), ['ok', 'ok:2']);
});

test('the file system can be replaced (readFileSync, readdirSync, existsSync, lstatSync)', () => {
    const root = path.resolve('/virtual/ws');
    const files = new Map([[path.join(root, 'package.json'), JSON.stringify(pkg('v', { a: 'b' }, { workspaces: ['pk/*'] }))], [path.join(root, 'pk', 'x', 'package.json'), JSON.stringify(pkg('x', { c: 'd' }))], [path.join(root, 'yarn.lock'), '']]);
    const dirs = new Map([[path.join(root, 'pk'), ['x']]]);
    const fake = {
        readFileSync: (p) => { if (!files.has(p)) throw Object.assign(new Error('nope'), { code: 'ENOENT' }); return files.get(p); },
        existsSync: (p) => files.has(p) || dirs.has(p),
        lstatSync: (p) => ({ isDirectory: () => dirs.has(p) || p === path.join(root, 'pk', 'x') }),
        readdirSync: (p) => { if (!dirs.has(p)) throw new Error('nope'); return dirs.get(p).map((name) => ({ name, isDirectory: () => true })); },
    };
    const entries = S.discoverScripts([root], fake);
    assert.deepEqual(names(entries), ['v', 'x']);
    assert.equal(entries[1].manager, 'yarn');
});

// ---- commandLine ---------------------------------------------------------------------------------------------------------------------

const SHELLS = ['powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh', undefined];

test('the line to type for each package manager', () => {
    assert.equal(S.commandLine({ manager: 'npm' }, 'dev', 'powershell'), 'npm run dev');
    assert.equal(S.commandLine({ manager: 'pnpm' }, 'build:prod', 'cmd'), 'pnpm run build:prod');
    assert.equal(S.commandLine({ manager: 'yarn' }, 'test-unit', 'bash'), 'yarn run test-unit');
    assert.equal(S.commandLine({ manager: 'bun' }, 'start', 'pwsh'), 'bun run start');
    assert.equal(S.commandLine({ manager: 'npm' }, 'docs/build', 'zsh'), 'npm run docs/build');
    assert.equal(S.commandLine({ manager: 'npm' }, 'بناء', 'powershell'), 'npm run بناء', 'letters of other scripts are plain words too');
    for (const shell of SHELLS) assert.equal(S.commandLine({ manager: 'npm' }, 'x', shell), 'npm run x', 'the same in every shell');
});

const INJECTIONS = [
    'x; rm -rf /', 'x;calc', 'x && calc', 'x||calc', 'x | calc', 'x & calc', '& calc', 'x`calc`', '`calc`', 'x$(calc)', '$(calc)', '${PATH}', '$env:PATH', 'x\ncalc', 'x\r\ncalc',
    'x\u0000y', 'x\u001b[31m', "x'y", 'x"y', "x';calc;'", 'x y', ' x', 'x ', '-rf', '--prefix=/', '-', '.hidden', '@splat', 'x>out', 'x<in', 'x>>f', '%PATH%', '!x', '^x',
    'x*', 'x?', '~x', 'x#y', 'x\\y', 'x(y)', 'x{y}', 'x[y]', 'x=y', 'x,y', 'x+y', 'x@y', '', ' ', '\t', 'x\ty', 'x\u202ey', 'x\u200by', 'x\u2028y', 'x\u0085y', '\u2018x\u2019', '\uff1bcalc',
    'x'.repeat(121), 'a'.repeat(5000),
];

test('names with a shell character, a newline, a quote, a first dash ... are refused for every shell and manager, never quoted', () => {
    for (const manager of ['npm', 'pnpm', 'yarn', 'bun']) {
        for (const shell of SHELLS) {
            for (const evil of INJECTIONS) {
                assert.throws(() => S.commandLine({ manager }, evil, shell), (e) => e instanceof S.ScriptsError && e.code === 'EBADSCRIPT', `${manager}/${shell}: ${JSON.stringify(evil.slice(0, 30))}`);
                assert.equal(S.isSafeScriptName(evil), false);
            }
        }
    }
    for (const bad of [undefined, null, 5, {}, [], ['x'], { toString: () => 'x' }]) assert.throws(() => S.commandLine({ manager: 'npm' }, bad, 'bash'), { code: 'EBADSCRIPT' });
});

test('a manager that is not npm, pnpm, yarn or bun is refused (also names that live in Object.prototype)', () => {
    for (const manager of ['deno', 'npm; calc', '', undefined, null, 'constructor', '__proto__', 'toString']) assert.throws(() => S.commandLine({ manager }, 'x', 'bash'), { code: 'EBADMANAGER' }, String(manager));
    assert.throws(() => S.commandLine(null, 'x', 'bash'), { code: 'EBADMANAGER' });
    assert.throws(() => S.commandLine(undefined, 'x', 'bash'), { code: 'EBADMANAGER' });
});

test('random strings of odd characters: the answer is a plain "<manager> run <word>" or an error', () => {
    let seed = 12345;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const alphabet = [...'abcXYZ019_-.:/ ;&|<>()$`\'"\\\n\r\t%!^*?~#@{}[]=,+'] .concat(['\u202e', '\u200b', 'é', 'ب', '\u0300', '\u2018', '\uff1b', '\u0000']);
    const plain = /^(npm|pnpm|yarn|bun) run [\p{L}\p{N}_][\p{L}\p{N}\p{M}_.:/-]*$/u;
    let accepted = 0;
    for (let i = 0; i < 4000; i++) {
        const name = Array.from({ length: 1 + rnd(12) }, () => alphabet[rnd(alphabet.length)]).join('');
        let line = null;
        try { line = S.commandLine({ manager: 'pnpm' }, name, 'powershell'); } catch (e) { assert.equal(e.code, 'EBADSCRIPT'); }
        if (line !== null) { accepted++; assert.match(line, plain, JSON.stringify(name)); assert.ok(!/[\s;&|<>()$`'"\\%!^*?~#@{}[\],=+\u0000-\u001f]/.test(line.slice('pnpm run '.length)), JSON.stringify(name)); }
    }
    assert.ok(accepted > 50, 'the test does accept some names');
});

// ---- planRun and terminalName ------------------------------------------------------------------------------------------------------

const item = (pkgName, script) => ({ folder: '/w', packageName: pkgName, packageDir: path.resolve('/w', pkgName), manager: 'npm', script, command: '' });

test('planRun: batches of at most four, in the order of the selection', () => {
    const selection = Array.from({ length: 10 }, (_, i) => item('p' + i, 'dev'));
    const plan = S.planRun(selection);
    assert.deepEqual(plan.batches.map((b) => b.length), [4, 4, 2]);
    assert.deepEqual(plan.batches.flat().map((i) => i.packageName), selection.map((i) => i.packageName));
    assert.equal(plan.maxParallel, 4);
    assert.equal(plan.total, 10);
    assert.deepEqual(plan.skipped, []);
    assert.equal(plan.batches[0][0], selection[0], 'the items themselves, not copies');
});

test('planRun: the cap can be changed; 1 is one after the other; 0 or Infinity is all at once; nonsense means 4', () => {
    const sel = Array.from({ length: 7 }, (_, i) => item('p' + i, 'build'));
    assert.deepEqual(S.planRun(sel, { maxParallel: 3 }).batches.map((b) => b.length), [3, 3, 1]);
    assert.deepEqual(S.planRun(sel, { maxParallel: 1 }).batches.map((b) => b.length), [1, 1, 1, 1, 1, 1, 1]);
    assert.deepEqual(S.planRun(sel, { maxParallel: 7 }).batches.map((b) => b.length), [7]);
    assert.deepEqual(S.planRun(sel, { maxParallel: 0 }).batches.map((b) => b.length), [7]);
    assert.deepEqual(S.planRun(sel, { maxParallel: Infinity }).batches.map((b) => b.length), [7]);
    assert.deepEqual(S.planRun(sel, { maxParallel: '2' }).batches.map((b) => b.length), [2, 2, 2, 1]);
    assert.deepEqual(S.planRun(sel, { maxParallel: 2.9 }).batches.map((b) => b.length), [2, 2, 2, 1]);
    for (const bad of [-1, NaN, 'many', {}, [], null, undefined, true, '']) assert.deepEqual(S.planRun(sel, { maxParallel: bad }).batches.map((b) => b.length), [4, 3], String(bad));
    assert.equal(S.planRun(sel, { maxParallel: 1000 }).maxParallel, S.LIMITS.MAX_PARALLEL, 'a cap above the limit is cut');
    assert.deepEqual(S.planRun(sel, null).batches.map((b) => b.length), [4, 3]);
});

test('planRun: empty and wrong selections, the same script twice, too many scripts', () => {
    assert.deepEqual(S.planRun([]).batches, []);
    assert.deepEqual(S.planRun(undefined).batches, []);
    assert.deepEqual(S.planRun('x').batches, []);
    assert.deepEqual(S.planRun([null, 5, 'x', [1]]).batches, []);
    const dup = S.planRun([item('a', 'dev'), item('a', 'dev'), item('a', 'test'), item('b', 'dev')]);
    assert.deepEqual(dup.batches.flat().map((i) => i.packageName + ':' + i.script), ['a:dev', 'a:test', 'b:dev']);
    assert.deepEqual(dup.skipped.map((s) => s.reason), ['duplicate']);
    const many = S.planRun(Array.from({ length: 50 }, (_, i) => item('p' + i, 'dev')), { maxParallel: 0 });
    assert.equal(many.total, S.LIMITS.MAX_RUN_ITEMS);
    assert.equal(many.batches.flat().length, S.LIMITS.MAX_RUN_ITEMS);
    assert.equal(many.skipped.length, 50 - S.LIMITS.MAX_RUN_ITEMS);
    assert.ok(many.skipped.every((s) => s.reason === 'too-many'));
    assert.equal(S.planRun(Array.from({ length: 50 }, (_, i) => item('p' + i, 'dev')), { maxItems: 5 }).total, 5);
});

test('terminalName is "<package>: <script>", on one line', () => {
    assert.equal(S.terminalName(item('api', 'dev')), 'api: dev');
    assert.equal(S.terminalName({ packageName: '@acme/ui', script: 'build:prod' }), '@acme/ui: build:prod');
    assert.equal(S.terminalName({ packageDir: path.resolve('/w/tools'), script: 'x' }), 'tools: x', 'the folder name when the package has no name');
    assert.equal(S.terminalName({ packageName: 'a\nb\u001b', script: 'c' }), 'a b: c');
    assert.ok(S.terminalName({ packageName: 'x'.repeat(500), script: 'y' }).length <= 121);
    assert.equal(S.terminalName(null), 'package: script');
});

test('makeItem and allItems tie the discovered entries to planRun, terminalName and commandLine', () => {
    const dir = fixture({ 'package.json': pkg('mono', { a: 'x', b: 'y' }, { workspaces: ['p/*'] }), 'p/one/package.json': pkg('one', { c: 'z' }), 'pnpm-lock.yaml': '' });
    const items = S.allItems(S.discoverScripts([dir]));
    assert.deepEqual(items.map(S.terminalName), ['mono: a', 'mono: b', 'one: c']);
    assert.deepEqual(items.map((i) => S.commandLine(i, i.script, 'powershell')), ['pnpm run a', 'pnpm run b', 'pnpm run c']);
    assert.equal(items[2].command, 'z');
    assert.equal(items[2].packageDir, path.join(dir, 'p', 'one'));
    assert.equal(S.planRun(items, { maxParallel: 2 }).batches.length, 2);
});

// ---- groups --------------------------------------------------------------------------------------------------------------------------

const WS = path.join(os.tmpdir(), 'oc-ws-for-groups');       // the checks of parseGroups look at the text of the paths, the folder need not exist
const group = (terminals, name = 'dev') => ({ groups: [{ name, terminals }] });
const parse = (data, ws = WS) => S.parseGroups(typeof data === 'string' ? data : JSON.stringify(data), ws);
const term = (extra) => ({ name: 't', command: 'npm run dev', ...extra });

test('a groups.json is read: cwd gets a normal form, optional fields stay, the rest is filled in', () => {
    const { groups, errors } = parse(group([
        { name: 'api', cwd: 'packages/api', command: 'npm run dev', profile: 'PowerShell', agent: 'claude', color: '#3b82f6' },
        { name: 'web', cwd: 'packages\\web\\', command: 'npm run dev', color: 'blue' },
        { name: ' shell ' },
        { name: 'abs', cwd: path.join(WS, 'tools', 'x'), command: 'echo مرحبا' },
        { name: 'dots', cwd: './a/b/../c', command: '' },
    ]));
    assert.deepEqual(errors, []);
    assert.deepEqual(groups, [{
        name: 'dev',
        terminals: [
            { name: 'api', cwd: 'packages/api', command: 'npm run dev', profile: 'PowerShell', agent: 'claude', color: '#3b82f6' },
            { name: 'web', cwd: 'packages/web', command: 'npm run dev', color: 'blue' },
            { name: 'shell', cwd: '.', command: '' },
            { name: 'abs', cwd: 'tools/x', command: 'echo مرحبا' },
            { name: 'dots', cwd: 'a/c', command: '' },
        ],
    }]);
});

test('serializeGroups writes what parseGroups reads back, and writes only what is needed', () => {
    const { groups } = parse(group([{ name: 'api', cwd: 'packages/api', command: 'npm run dev', agent: 'pi' }, { name: 'shell' }]));
    const text = S.serializeGroups(groups, WS);
    assert.ok(text.endsWith('}\n'));
    assert.deepEqual(JSON.parse(text), { groups: [{ name: 'dev', terminals: [{ name: 'api', cwd: 'packages/api', command: 'npm run dev', agent: 'pi' }, { name: 'shell' }] }] });
    assert.deepEqual(parse(text), { groups, errors: [] });
    assert.deepEqual(S.parseGroups('\uFEFF' + text, WS).groups, groups, 'a BOM at the start is no problem');
    assert.throws(() => S.serializeGroups([{ name: 'x', terminals: [{ name: 't', cwd: '../out' }] }], WS), (e) => e.code === 'EBADGROUPS' && /outside the workspace folder/.test(e.message));
    assert.throws(() => S.serializeGroups('nope', WS), { code: 'EBADGROUPS' });
});

test('cwd: ".." and every other way out of the workspace folder is refused', () => {
    const parent = path.dirname(WS);
    const escapes = [
        '..', '../', '../x', '..\\x', 'a/../..', 'a\\..\\..\\x', './../x', 'packages/../../x', 'a/b/../../../x',
        path.join(parent, 'other'), path.join(parent, 'other').replace(/\\/g, '/'), parent, path.resolve('/'), WS + '-sibling',
        'C:\\Windows', 'C:/Windows/System32', 'c:\\', 'D:\\x', '\\\\server\\share\\x', '//server/share/x', '\\\\?\\C:\\Windows', '/etc/passwd', '\\Windows', '/',
        'C:foo', 'a:b', 'x/y:stream', 'a/.. /..', '.. /x', '.../x', 'x./y', 'x /y', 'a/..\u202e/b',
    ];
    for (const cwd of escapes) {
        const { groups, errors } = parse(group([term({ cwd })]));
        assert.deepEqual(groups, [], 'refused: ' + JSON.stringify(cwd));
        assert.equal(errors.length, 1, JSON.stringify(cwd) + ' -> ' + errors.join(' | '));
        assert.match(errors[0], /^groups\[0\] "dev": terminals\[0\] "t": cwd /, errors[0]);
    }
    assert.match(parse(group([term({ cwd: '../x' })])).errors[0], /outside the workspace folder/);
    // what stays inside is fine, also when it goes up and down again, or names the folder with its absolute path
    for (const [cwd, value] of [['.', '.'], ['', '.'], ['./', '.'], ['packages/../packages/api', 'packages/api'], [WS, '.'], [path.join(WS, 'a'), 'a'], ['..a/b', '..a/b'], ['a/..b', 'a/..b'], ['my folder/x y', 'my folder/x y'], ['مجلد/ملف', 'مجلد/ملف']]) {
        const { groups, errors } = parse(group([term({ cwd })]));
        assert.deepEqual(errors, [], JSON.stringify(cwd));
        assert.equal(groups[0].terminals[0].cwd, value, JSON.stringify(cwd));
    }
    // a terminal without cwd, and the other folder when the workspace is somewhere else
    assert.equal(parse(group([{ name: 'x' }])).groups[0].terminals[0].cwd, '.');
    assert.deepEqual(parse(group([term({ cwd: WS + '2' })])).groups, []);
    assert.deepEqual(parse(group([term({ cwd: 5 })])).groups, []);
    assert.deepEqual(parse(group([term({ cwd: 'a\nb' })])).groups, []);
    assert.deepEqual(parse(group([term({ cwd: 'x'.repeat(501) })])).groups, []);
    assert.match(parse(group([term({ cwd: 'x' })]), '').errors[0], /no workspace folder/);
});

test('command: a string of at most 2000 characters, on one line, without controls', () => {
    assert.deepEqual(parse(group([term({ command: 'x'.repeat(2000) })])).errors, []);
    assert.match(parse(group([term({ command: 'x'.repeat(2001) })])).errors[0], /command is longer than 2000/);
    for (const command of [123, true, ['npm', 'run'], { a: 1 }]) assert.match(parse(group([term({ command })])).errors[0], /command must be a string/, JSON.stringify(command));
    for (const command of ['a\nb', 'a\r\nb', 'a\u0003', 'a\u001b[31m', 'a\u0000b', 'a\tb', 'a\u2028b', 'a\u202eb', 'a\u2067b']) assert.equal(parse(group([term({ command })])).groups.length, 0, JSON.stringify(command));
    assert.deepEqual(parse(group([term({ command: 'echo "a b" && npm test -- --grep "مرحبا" | more' })])).errors, [], 'quotes, &&, | and Arabic are fine: it is the line of the user (a tab is refused: typed into a shell it is the Tab key)');
    assert.equal(parse(group([{ name: 'x', command: undefined }])).groups[0].terminals[0].command, '');
});

test('at most 20 terminals in a group; at least one; unique names; known fields only', () => {
    const many = (n) => Array.from({ length: n }, (_, i) => ({ name: 't' + i, command: 'echo ' + i }));
    assert.equal(parse(group(many(20))).groups[0].terminals.length, 20);
    assert.match(parse(group(many(21))).errors[0], /has 21 terminals, at most 20/);
    assert.match(parse(group([])).errors[0], /"terminals" is empty/);
    assert.match(parse({ groups: [{ name: 'x', terminals: 'a' }] }).errors[0], /"terminals" must be an array/);
    assert.match(parse(group([{ name: 'a' }, { name: 'A' }])).errors[0], /the name is used by another terminal/);
    assert.match(parse({ groups: [{ name: 'x', terminals: [{ name: 'a' }] }, { name: 'X', terminals: [{ name: 'a' }] }] }).errors[0], /the name is used by another group/);
    assert.match(parse(group([term({ comand: 'oops' })])).errors[0], /unknown field "comand"/);
    assert.match(parse({ groups: [{ name: 'x', terminals: [{ name: 'a' }], extra: 1 }] }).errors[0], /unknown field "extra"/);
    assert.match(parse({ groups: [], extra: 1 }).errors[0], /unknown field "extra"/);
    assert.deepEqual(parse({ $schema: 'x', groups: [] }), { groups: [], errors: [] });
    assert.match(parse(group([{ name: '' }])).errors[0], /name is empty/);
    assert.match(parse(group([{}])).errors[0], /name is missing/);
    assert.match(parse(group([{ name: 'x'.repeat(61) }])).errors[0], /name is longer than 60/);
    assert.match(parse(group([{ name: 'a\nb' }])).errors[0], /name has a control character/);
    for (const color of ['red;calc', 'url(x)', '#12', '#ggg', 'a b', 5]) assert.equal(parse(group([term({ color })])).groups.length, 0, String(color));
    assert.equal(parse(group([term({ color: '#abc' }), { name: 'u', color: '#AABBCCDD' }])).groups.length, 1);
    assert.match(parse(group([term({ profile: 'p'.repeat(101) })])).errors[0], /profile is longer/);
    assert.match(parse(group([term({ agent: 7 })])).errors[0], /agent must be a string/);
});

test('"__proto__" and friends are unknown fields; nothing is polluted', () => {
    const text = '{"groups":[{"name":"x","terminals":[{"name":"t","__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":2}}}]}],"__proto__":{"polluted":3}}';
    const { groups, errors } = S.parseGroups(text, WS);
    assert.deepEqual(groups, []);
    assert.ok(errors.some((e) => /unknown field "__proto__"/.test(e)), errors.join(' | '));
    assert.equal({}.polluted, undefined);
});

test('a bad file: not JSON, wrong shape, too large; and good groups next to a bad one stay', () => {
    assert.match(parse('{ not json').errors[0], /not valid JSON/);
    assert.match(parse('').errors[0], /not valid JSON/);
    assert.deepEqual(parse('[]').groups, []);
    assert.match(parse('[]').errors[0], /top level must be an object/);
    assert.match(parse('null').errors[0], /top level must be an object/);
    assert.match(parse('{}').errors[0], /"groups" must be an array/);
    assert.match(parse({ groups: {} }).errors[0], /"groups" must be an array/);
    assert.match(S.parseGroups(undefined, WS).errors[0], /no text/);
    assert.match(S.parseGroups(' '.repeat(300 * 1024), WS).errors[0], /larger than 256 KB/);
    assert.match(parse({ groups: [5] }).errors[0], /groups\[0\] must be an object/);
    const mixed = parse({ groups: [{ name: 'good', terminals: [{ name: 'a' }] }, { name: 'evil', terminals: [{ name: 'ok' }, { name: 'out', cwd: '../../x' }] }, { name: 'also good', terminals: [{ name: 'b' }] }] });
    assert.deepEqual(mixed.groups.map((g) => g.name), ['good', 'also good']);
    assert.equal(mixed.errors.length, 1);
    assert.match(mixed.errors[0], /^groups\[1\] "evil": terminals\[1\] "out": cwd "..\/..\/x" is outside the workspace folder$/);
    assert.match(parse({ groups: Array.from({ length: 51 }, (_, i) => ({ name: 'g' + i, terminals: [{ name: 't' }] })) }).errors[0], /at most 50 groups/);
});

test('loadGroups and saveGroups on a real folder; a missing file is not an error', () => {
    const dir = fixture({ 'readme.md': 'x' });
    assert.deepEqual(S.loadGroups(dir), { groups: [], errors: [], file: path.join(dir, '.openconsole', 'groups.json'), exists: false });
    const groups = parse(group([{ name: 'api', cwd: 'packages/api', command: 'npm run dev' }, { name: 'shell' }])).groups;
    const file = S.saveGroups(dir, groups);
    assert.equal(file, path.join(dir, '.openconsole', 'groups.json'));
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['groups.json'], 'no temporary file is left');
    const loaded = S.loadGroups(dir);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.exists, true);
    assert.deepEqual(loaded.groups, groups);
    assert.throws(() => S.saveGroups(dir, [{ name: 'bad', terminals: [{ name: 't', cwd: '../x' }] }]), { code: 'EBADGROUPS' });
    assert.deepEqual(S.loadGroups(dir).groups, groups, 'the refused save did not change the file');
    fs.writeFileSync(file, '{"groups":[{"name":"x","terminals":[{"name":"t","cwd":"..\\\\..\\\\Windows"}]}]}');
    const bad = S.loadGroups(dir);
    assert.deepEqual(bad.groups, []);
    assert.match(bad.errors[0], /outside the workspace folder/);
    const notAFile = fixture({ '.openconsole/groups.json/inner.txt': 'x' });
    assert.equal(S.loadGroups(notAFile).errors.length, 1, 'a folder where the file should be is told, not thrown');
});

test('groupDigest changes when anything that is started changes', () => {
    const base = parse(group([{ name: 'a', cwd: 'x', command: 'npm run dev' }])).groups[0];
    const digest = S.groupDigest(base);
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.equal(S.groupDigest(JSON.parse(JSON.stringify(base))), digest);
    for (const change of [{ command: 'npm run dev ' }, { cwd: 'y' }, { name: 'b' }, { profile: 'cmd' }, { agent: 'x' }]) {
        assert.notEqual(S.groupDigest({ ...base, terminals: [{ ...base.terminals[0], ...change }] }), digest, JSON.stringify(change));
    }
    assert.notEqual(S.groupDigest({ ...base, name: 'other' }), digest);
    assert.notEqual(S.groupDigest({ ...base, terminals: [...base.terminals, { name: 'c' }] }), digest);
    assert.equal(typeof S.groupDigest(null), 'string');
});

test('resolveCwd checks the folder on disk: it must exist, be a folder, and not lead out through a link', (t) => {
    const base = fixture({ 'ws/packages/api/x.txt': 'x', 'ws/file.txt': 'x', 'outside/secret.txt': 'x' });
    const ws = path.join(base, 'ws');
    assert.equal(S.resolveCwd(ws, 'packages/api'), path.join(ws, 'packages', 'api'));
    assert.equal(S.resolveCwd(ws, '.'), ws);
    assert.equal(S.resolveCwd(ws, path.join(ws, 'packages')), path.join(ws, 'packages'));
    for (const bad of ['..', '../outside', path.join(base, 'outside'), 'nope', 'file.txt', 'C:\\Windows', 5]) assert.throws(() => S.resolveCwd(ws, bad), { code: 'EBADCWD' }, String(bad));
    try { fs.symlinkSync(path.join(base, 'outside'), path.join(ws, 'link'), 'junction'); } catch (e) { return t.skip('links cannot be made here: ' + e.code); }
    assert.throws(() => S.resolveCwd(ws, 'link'), (e) => e.code === 'EBADCWD' && /leads outside/.test(e.message));
});
