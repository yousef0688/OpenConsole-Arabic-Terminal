'use strict';
// Tests of the log helper. « » mark the selection, ¦ marks a cursor without a selection.
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/turbolog');
const { insertLog, findLogs, commentLogs, uncommentLogs, deleteLogs, correctLogs, applyEdits, defaultOptions } = T;

function parse(src) {
    const sels = [];
    let out = '';
    for (let i = 0; i < src.length; i++) {
        if (src[i] === '«') { const start = out.length; const j = src.indexOf('»', i); out += src.slice(i + 1, j); sels.push([start, out.length]); i = j; }
        else if (src[i] === '¦') sels.push([out.length, out.length]);
        else out += src[i];
    }
    return { text: out, sels };
}
const join = (lines, eol = '\n') => (Array.isArray(lines) ? lines.join(eol) : lines);
/** insert a log into the marked source, give back the new text (and the whole result) */
function ins(lines, opts = {}, kind = 'log', lang = 'javascript', fileName = 'sample.js', eol = '\n') {
    const { text, sels } = parse(join(lines, eol));
    const r = insertLog(text, sels.map(([a, b]) => ({ selectionStart: a, selectionEnd: b, languageId: lang, fileName })), opts, kind);
    return { r, text, out: applyEdits(text, r.edits) };
}
const L = (lines, ...rest) => ins(lines, ...rest).out.split('\n');
const py = (lines, opts, kind) => ins(lines, opts, kind, 'python', 'sample.py');

// -------------------------------------------------------------------------------------------------------------------------------
// Fixtures that follow the behaviour spec (A1-A16)

const FIXTURES = [
    ['A1 number literal: after the declaration',
        ['function test() {', '  const «count» = 10;', '  return count;', '}'],
        ['function test() {', '  const count = 10;', '  console.log("▶ › test › count:", count)', '  return count;', '}']],
    ['A2 destructuring',
        ['function test() {', '  const { «user» } = state;', '  return user;', '}'],
        ['function test() {', '  const { user } = state;', '  console.log("▶ › test › user:", user)', '  return user;', '}']],
    ['A3 JSX in parentheses: after the closing line',
        ['export function Header({ title }: { title: string }) {', '  const «header» = (', '    <header>', '      <h1>{title}</h1>', '    </header>', '  );', '  return header;', '}'],
        ['export function Header({ title }: { title: string }) {', '  const header = (', '    <header>', '      <h1>{title}</h1>', '    </header>', '  );', '  console.log("▶ › Header › header:", header)', '  return header;', '}'],
        'typescriptreact'],
    ['A4 parameter, brace at the end of the line',
        ['function greet(«name») {', '  return name;', '}'],
        ['function greet(name) {', '  console.log("▶ › greet › name:", name)', '  return name;', '}']],
    ['A5 Vue method parameter',
        ['<template><div /></template>', '<script>', 'export default {', '  methods: {', '    greet(«name», age) {', '      return `Hello ${name}, you are ${age} years old`;', '    },', '  },', '};', '</script>'],
        ['<template><div /></template>', '<script>', 'export default {', '  methods: {', '    greet(name, age) {', '      console.log("▶ › greet › name:", name)', '      return `Hello ${name}, you are ${age} years old`;', '    },', '  },', '};', '</script>'],
        'vue'],
    ['A6 concise arrow: it becomes a block',
        ['const double = («x») => x * 2;'],
        ['const double = (x) => {', '  console.log("▶ › double › x:", x)', '  return x * 2;', '};'],
        'javascript', { tabSize: 2 }],
    ['A7 return: before it',
        ['function getName(person) {', '  return «person.name»;', '}'],
        ['function getName(person) {', '  console.log("▶ › getName › person.name:", person.name)', '  return person.name;', '}']],
    ['A8 call in a return',
        ['function processData(data) {', '  return transform(«data.value»);', '}'],
        ['function processData(data) {', '  console.log("▶ › processData › data.value:", data.value)', '  return transform(data.value);', '}']],
    ['A9 shorthand property in a returned object',
        ['function createUser(name) {', '  return { «name», active: true };', '}'],
        ['function createUser(name) {', '  console.log("▶ › createUser › name:", name)', '  return { name, active: true };', '}']],
    ['A10 deeply nested shorthand in a return',
        ['function deepNested(value) {', '  return { nested: { deep: { «value» } } };', '}'],
        ['function deepNested(value) {', '  console.log("▶ › deepNested › value:", value)', '  return { nested: { deep: { value } } };', '}']],
    ['A11 if condition: before the if',
        ['if («process.env.GITHUB_ACTIONS» === "true") {', '  console.log("Existing code");', '}'],
        ['console.log("▶ › process.env.GITHUB_ACTIONS:", process.env.GITHUB_ACTIONS)', 'if (process.env.GITHUB_ACTIONS === "true") {', '  console.log("Existing code");', '}']],
    ['A12 multi-line condition',
        ['if (', '  «process.env.GITHUB_ACTIONS» === "true" &&', '  process.env.GITHUB_EVENT_NAME === "pull_request"', ') {', '  deployToPreview();', '}'],
        ['console.log("▶ › process.env.GITHUB_ACTIONS:", process.env.GITHUB_ACTIONS)', 'if (', '  process.env.GITHUB_ACTIONS === "true" &&', '  process.env.GITHUB_EVENT_NAME === "pull_request"', ') {', '  deployToPreview();', '}']],
    ['A13 braceless if: before the if, not between the if and its body',
        ['function test() {', '  if («user.isActive»)', '    return "active";', '}'],
        ['function test() {', '  console.log("▶ › test › user.isActive:", user.isActive)', '  if (user.isActive)', '    return "active";', '}']],
    ['A14 nested condition, the outer if',
        ['if («app.config.database.host» === "localhost") {', '  if (app.config.debug) {', '    run();', '  }', '}'],
        ['console.log("▶ › app.config.database.host:", app.config.database.host)', 'if (app.config.database.host === "localhost") {', '  if (app.config.debug) {', '    run();', '  }', '}']],
    ['A15 else if: the first line of its own body',
        ['if (a) {', '  x();', '} else if («b.value») {', '  y();', '}'],
        ['if (a) {', '  x();', '} else if (b.value) {', '  console.log("▶ › b.value:", b.value)', '  y();', '}']],
    ['A16 an assignment of a value: the next line',
        ['const normalAssignment = «someValue»;', 'console.log(normalAssignment);'],
        ['const normalAssignment = someValue;', 'console.log("▶ › someValue:", someValue)', 'console.log(normalAssignment);']],
];
for (const [name, src, want, lang = 'javascript', opts = {}] of FIXTURES) {
    test(`fixture ${name}`, () => {
        const file = lang === 'vue' ? 'a.vue' : lang === 'typescriptreact' ? 'a.tsx' : 'a.js';
        assert.deepEqual(ins(src, opts, 'log', lang, file).out.split('\n'), want);
    });
}

// -------------------------------------------------------------------------------------------------------------------------------
// Derived JavaScript cases

const DERIVED = [
    ['object literal on a property line', ['const «config» = {', '  host: "localhost",', '  port: 80,', '};'], ['const config = {', '  host: "localhost",', '  port: 80,', '};', 'console.log("▶ › config:", config)']],
    ['array literal', ['const «items» = [', '  1,', '  2,', '];'], ['const items = [', '  1,', '  2,', '];', 'console.log("▶ › items:", items)']],
    ['multi-line call with await', ['async function f() {', '  const «result» = await fetchData(', '    url,', '    { retries: 3 },', '  );', '  return result;', '}'],
        ['async function f() {', '  const result = await fetchData(', '    url,', '    { retries: 3 },', '  );', '  console.log("▶ › f › result:", result)', '  return result;', '}']],
    ['named function assignment: after the closing line', ['const «format» = (value) => {', '  return String(value);', '};'], ['const format = (value) => {', '  return String(value);', '};', 'console.log("▶ › format:", format)']],
    ['reassignment', ['let data;', '«data» = await load(path);', 'use(data);'], ['let data;', 'data = await load(path);', 'console.log("▶ › data:", data)', 'use(data);']],
    ['ternary init', ['const «label» = isOk ? "yes" : "no";', 'use(label);'], ['const label = isOk ? "yes" : "no";', 'console.log("▶ › label:", label)', 'use(label);']],
    ['binary expression over two lines', ['const «total» = price * qty +', '  tax;', 'use(total);'], ['const total = price * qty +', '  tax;', 'console.log("▶ › total:", total)', 'use(total);']],
    ['template string', ['const «message» = `Hello ${name}`;'], ['const message = `Hello ${name}`;', 'console.log("▶ › message:", message)']],
    ['declaration list: after the whole list', ['const «a» = 1,', '  b = 2;', 'use(a);'], ['const a = 1,', '  b = 2;', 'console.log("▶ › a:", a)', 'use(a);']],
    ['no semicolons: the statement ends at the line break', ['const «a» = foo()', 'const b = 2', 'use(a)'], ['const a = foo()', 'console.log("▶ › a:", a)', 'const b = 2', 'use(a)']],
    ['member reassignment', ['this.user = «data.user»;'], ['this.user = data.user;', 'console.log("▶ › data.user:", data.user)']],
    ['class method parameter (class and method name)', ['class Cart {', '  add(«item») {', '    this.items.push(item);', '  }', '}'], ['class Cart {', '  add(item) {', '    console.log("▶ › Cart › add › item:", item)', '    this.items.push(item);', '  }', '}']],
    ['callback parameter: the nearest named function', ['function render(list) {', '  list.forEach((«item») => {', '    draw(item);', '  });', '}'], ['function render(list) {', '  list.forEach((item) => {', '    console.log("▶ › render › item:", item)', '    draw(item);', '  });', '}']],
    ['throw: before it', ['function check(msg) {', '  throw new Error(«msg»);', '}'], ['function check(msg) {', '  console.log("▶ › check › msg:", msg)', '  throw new Error(msg);', '}']],
    ['usage in a multi-line call: before', ['send(', '  «user»,', '  options,', ');'], ['console.log("▶ › user:", user)', 'send(', '  user,', '  options,', ');']],
    ['usage in a one-line call: after', ['send(«user», options);'], ['send(user, options);', 'console.log("▶ › user:", user)']],
    ['object of a method chain over several lines: before', ['const ids = «items»', '  .map((i) => i.id)', '  .filter(Boolean);'], ['console.log("▶ › items:", items)', 'const ids = items', '  .map((i) => i.id)', '  .filter(Boolean);']],
    ['object of a one-line method call: after', ['const ids = «items».map((i) => i.id);'], ['const ids = items.map((i) => i.id);', 'console.log("▶ › items:", items)']],
    ['object key: the path from the declared variable', ['const person = {', '  family: { «mother»: "A" },', '};'], ['const person = {', '  family: { mother: "A" },', '};', 'console.log("▶ › person.family.mother:", person.family.mother)']],
    ['object key in a returned object: its value', ['function f(user) {', '  return {', '    «name»: user.name,', '  };', '}'], ['function f(user) {', '  console.log("▶ › f › user.name:", user.name)', '  return {', '    name: user.name,', '  };', '}']],
    ['object key with a call as value: refused', ['function f() {', '  return {', '    «id»: nextId(),', '  };', '}'], null],
    ['for-of variable: the first line of the body', ['for (const «item» of items) {', '  use(item);', '}'], ['for (const item of items) {', '  console.log("▶ › item:", item)', '  use(item);', '}']],
    ['for-of iterable: before the loop', ['for (const item of «items») {', '  use(item);', '}'], ['console.log("▶ › items:", items)', 'for (const item of items) {', '  use(item);', '}']],
    ['catch parameter', ['try { run(); } catch («err») {', '  report(err);', '}'], ['try { run(); } catch (err) {', '  console.log("▶ › err:", err)', '  report(err);', '}']],
    ['while head', ['while («queue.length») {', '  step();', '}'], ['console.log("▶ › queue.length:", queue.length)', 'while (queue.length) {', '  step();', '}']],
    ['switch discriminant', ['switch («kind») {', '  case 1:', '    break;', '}'], ['console.log("▶ › kind:", kind)', 'switch (kind) {', '  case 1:', '    break;', '}']],
    ['braceless body is climbed out of (after)', ['if (ok)', '  «x» = compute();', 'use(x);'], ['if (ok)', '  x = compute();', 'console.log("▶ › x:", x)', 'use(x);']],
    ['braceless if/else: after the whole statement', ['if (ok)', '  «x» = 1;', 'else', '  x = 2;', 'use(x);'], ['if (ok)', '  x = 1;', 'else', '  x = 2;', 'console.log("▶ › x:", x)', 'use(x);']],
    ['block that ends on the same line: the log stays inside it', ['function f() {', '  if (ok) { const «y» = 1; }', '}'], ['function f() {', '  if (ok) { const y = 1;', '    console.log("▶ › f › y:", y)', '  }', '}']],
    ['one-line function body is expanded', ['function f(«a») { return a; }'], ['function f(a) {', '    console.log("▶ › f › a:", a)', '    return a;', '}']],
    ['empty one-line function body', ['function f(«a») {}'], ['function f(a) {', '    console.log("▶ › f › a:", a)', '}']],
    ['name of an arrow function assigned to a constant', ['const handler = async (event) => {', '  const «body» = event.body;', '};'], ['const handler = async (event) => {', '  const body = event.body;', '  console.log("▶ › handler › body:", body)', '};']],
    ['parameter used in a concise arrow body', ['const ids = items.map((i) => «i».id);'], ['const ids = items.map((i) => {', '    console.log("▶ › i:", i)', '    return i.id;', '});']],
    ['member chain: the cursor in a property gives the path', ['const a = user.profile.nam¦e;'], ['const a = user.profile.name;', 'console.log("▶ › user.profile.name:", user.profile.name)']],
    ['class field: the log goes into the constructor', ['class A {', '  «count» = 1;', '  constructor() {', '    this.go();', '  }', '}'], ['class A {', '  count = 1;', '  constructor() {', '    console.log("▶ › A › this.count:", this.count)', '    this.go();', '  }', '}']],
    ['class field without a constructor: refused', ['class A {', '  «count» = 1;', '}'], null],
    ['word under the cursor', ['const total = 1;', 'use(tot¦al);'], ['const total = 1;', 'use(total);', 'console.log("▶ › total:", total)']],
    ['selection that is not on a statement (a comment): the next line', ['// «note»', 'foo();'], ['// note', 'console.log("▶ › note:", note)', 'foo();']],
    ['export const', ['export const «x» = 1;', 'use(x);'], ['export const x = 1;', 'console.log("▶ › x:", x)', 'use(x);']],
    ['type annotation on the constant (TypeScript)', ['const handler: Handler = (e) => {', '  const «n» = 1;', '};'], ['const handler: Handler = (e) => {', '  const n = 1;', '  console.log("▶ › handler › n:", n)', '};']],
    ['JSX callback with a block body', ['function List({ items }) {', '  return (', '    <ul>', '      {items.map((item) => {', '        const «label» = item.name;', '        return <li>{label}</li>;', '      })}', '    </ul>', '  );', '}'],
        ['function List({ items }) {', '  return (', '    <ul>', '      {items.map((item) => {', '        const label = item.name;', '        console.log("▶ › List › label:", label)', '        return <li>{label}</li>;', '      })}', '    </ul>', '  );', '}']],
    ['strings with brackets and regexes do not confuse the scanner', ['function f(s) {', '  const «r» = /[}]\\)/.test("}{ )");', '  return r;', '}'], ['function f(s) {', '  const r = /[}]\\)/.test("}{ )");', '  console.log("▶ › f › r:", r)', '  return r;', '}']],
];
for (const [name, src, want] of DERIVED) {
    test(`derived: ${name}`, () => {
        const res = ins(src, { tabSize: 4 });
        if (want === null) { assert.deepEqual(res.r.edits, []); assert.ok(res.r.reason, 'a reason is given'); return; }
        assert.deepEqual(res.out.split('\n'), want);
    });
}

test('object key: the path is used for string keys too', () => {
    assert.deepEqual(L(['const cfg = {', '  "a-b": { «c»: 1 },', '};']), ['const cfg = {', '  "a-b": { c: 1 },', '};', 'console.log(`▶ › cfg["a-b"].c:`, cfg["a-b"].c)']);
});

// -------------------------------------------------------------------------------------------------------------------------------
// Format

test('the defaults', () => {
    assert.equal(defaultOptions.logMessagePrefix, '▶');
    assert.equal(defaultOptions.delimiterInsideMessage, '›');
    assert.equal(defaultOptions.logMessageSuffix, ':');
    assert.equal(defaultOptions.quote, '"');
    assert.equal(defaultOptions.insertEnclosingClass, true);
    assert.equal(defaultOptions.insertEnclosingFunction, true);
    for (const k of ['wrapLogMessage', 'includeFilename', 'includeLineNum', 'addSemicolonInTheEnd', 'insertEmptyLineBeforeLogMessage', 'insertEmptyLineAfterLogMessage']) assert.equal(defaultOptions[k], false, k);
    assert.equal(defaultOptions.logFunction, 'log');
});

test('file name and line number: the line of the log (1-based)', () => {
    const src = ['class Cart {', '  add(«item») {', '    this.items.push(item);', '  }', '}'];
    assert.equal(L(src, { includeFilename: true, includeLineNum: true }, 'log', 'javascript', 'src\\cart.js')[2], '    console.log("▶ › cart.js:3 › Cart › add › item:", item)');
    assert.equal(L(src, { includeLineNum: true })[2], '    console.log("▶ › :3 › Cart › add › item:", item)');
    assert.equal(L(src, { includeFilename: true }, 'log', 'javascript', '/a/b/cart.js')[2], '    console.log("▶ › cart.js › Cart › add › item:", item)');
});

test('class and function names can be turned off', () => {
    const src = ['class Cart {', '  add(«item») {', '    go();', '  }', '}'];
    assert.equal(L(src, { insertEnclosingClass: false })[2], '    console.log("▶ › add › item:", item)');
    assert.equal(L(src, { insertEnclosingFunction: false })[2], '    console.log("▶ › Cart › item:", item)');
    assert.equal(L(src, { insertEnclosingFunction: false, insertEnclosingClass: false })[2], '    console.log("▶ › item:", item)');
});

test('quotes: the rule for selections that contain quotes', () => {
    assert.equal(L('const o = {};\nuse(«o["name"]»);')[2], 'console.log(`▶ › o["name"]:`, o["name"])');
    assert.equal(L("const o = {};\nuse(«o['name']»);")[2], 'console.log("▶ › o[\'name\']:", o[\'name\'])');
    assert.equal(L('use(«{a:1}»);')[1], 'console.log(`▶ › {a:1}:`, {a:1})');
    assert.equal(L('use(«x»);', { quote: "'", addSemicolonInTheEnd: true })[1], "console.log('▶ › x:', x);");
    assert.equal(L('use(«x»);', { quote: '`' })[1], 'console.log(`▶ › x:`, x)');
    assert.equal(L('use(«a.replace(/\\d/g, "")»);')[1], 'console.log(`▶ › a.replace(/\\\\d/g, ""):`, a.replace(/\\d/g, ""))', 'a backslash in the message is doubled, so it shows as written');
});

test('prefix, delimiter and suffix', () => {
    assert.equal(L('use(«x»);', { logMessagePrefix: 'LOG', delimiterInsideMessage: '|', logMessageSuffix: ' =' })[1], 'console.log("LOG | x =", x)');
    assert.equal(L('use(«x»);', { logMessagePrefix: '' })[1], 'console.log("x:", x)');
    assert.equal(L('use(«x»);', { logMessagePrefix: '', includeLineNum: true })[1], 'console.log(":2 › x:", x)');
});

test('empty line before and after, and the line number of the log counts the empty line', () => {
    const out = L(['a();', 'const «x» = 1;', 'b();'], { insertEmptyLineBeforeLogMessage: true, insertEmptyLineAfterLogMessage: true, includeLineNum: true });
    assert.deepEqual(out, ['a();', 'const x = 1;', '', 'console.log("▶ › :4 › x:", x)', '', 'b();']);
});

test('wrapLogMessage: a separator above and below', () => {
    const out = L(['const «docNavItem» = 1;'], { wrapLogMessage: true, addSemicolonInTheEnd: true });
    assert.equal(out.length, 4);
    assert.equal(out[1], out[3]);
    assert.match(out[1], /^console\.log\("▶ › -+▶"\);$/);
    assert.equal(out[2], 'console.log("▶ › docNavItem:", docNavItem);');
    const short = L(['const «a» = 1;'], { wrapLogMessage: true });
    assert.equal(short.length, 4, 'a short message does not throw');
    const w = L(['const «a» = 1;'], { wrapLogMessage: true, includeLineNum: true });
    assert.match(w[2], /:3 › a:/, 'the line number is the one of the main log, below the separator');
});

test('custom log function', () => {
    assert.equal(L('use(«x»);', { logFunction: 'logger.debug' }, 'custom')[1], 'logger.debug("▶ › x:", x)');
    assert.equal(L('use(«x»);', {}, 'custom')[1], 'log("▶ › x:", x)');
});

test('the kinds', () => {
    for (const k of ['info', 'debug', 'warn', 'error']) assert.equal(L('use(«x»);', {}, k)[1], `console.${k}("▶ › x:", x)`);
    assert.equal(L('use(«x»);', {}, 'table')[1], 'console.table(x) // ▶ › x:', 'console.table has no label argument: the message is a comment');
    assert.equal(L('use(«x»);', { addSemicolonInTheEnd: true }, 'table')[1], 'console.table(x); // ▶ › x:');
});

test('nothing to log: no edit and a reason', () => {
    for (const src of ['use(  «   »);', 'foo();\n¦\nbar();']) {
        const r = ins(src).r;
        assert.deepEqual(r.edits, []);
        assert.ok(r.reason);
    }
    const r = ins('«hello»', {}, 'log', 'markdown', 'a.md').r;
    assert.deepEqual(r.edits, []);
    assert.match(r.reason, /JavaScript/);
});

test('indentation: the longer of the statement line and the line at the insertion point', () => {
    const tabs = L(['function f() {', '\tif (a) {', '\t\tconst «x» = 1;', '\t}', '}']);
    assert.equal(tabs[3], '\t\tconsole.log("▶ › f › x:", x)', 'a statement before a dedented brace keeps its own indent');
    const deeper = L(['function f(«a») {', '\t\t\treturn a;', '}']);
    assert.equal(deeper[1], '\t\t\tconsole.log("▶ › f › a:", a)', 'the first body line sets the indent');
    const unit = L(['const f = («x») => x;'], { tabSize: 3 });
    assert.equal(unit[1], '   console.log("▶ › f › x:", x)', 'a file without indentation: the tab size of the editor');
    const tabUnit = L(['\tconst f = («x») => x;']);
    assert.equal(tabUnit[1], '\t\tconsole.log("▶ › f › x:", x)');
    assert.equal(L(['function f() {', '  const g = («x») => x;', '}'])[2], '    console.log("▶ › g › x:", x)', 'two spaces are the unit of this file');
});

test('CRLF text keeps CRLF', () => {
    const { text, out } = ins(['function t() {', '  const «a» = 1;', '  return a;', '}'], {}, 'log', 'javascript', 'a.js', '\r\n');
    assert.ok(text.includes('\r\n'));
    assert.equal(out, ['function t() {', '  const a = 1;', '  console.log("▶ › t › a:", a)', '  return a;', '}'].join('\r\n'));
    assert.ok(!/[^\r]\n/.test(out), 'no bare line feed was added');
});

test('a log at the end of a file without a final line break', () => {
    assert.equal(ins(['const «a» = 1;']).out, 'const a = 1;\nconsole.log("▶ › a:", a)');
    assert.equal(ins(['const «a» = 1;', '']).out, 'const a = 1;\nconsole.log("▶ › a:", a)\n');
    const r = ins(['const «a» = 1;']);
    assert.equal(deleteLogs(r.out, 'javascript').count, 1);
    assert.equal(applyEdits(r.out, deleteLogs(r.out, 'javascript').edits), 'const a = 1;');
});

test('the result tells the variable and the line of the log', () => {
    const r = ins(['function f() {', '  const «a» = 1;', '}']).r;
    assert.equal(r.variable, 'a');
    assert.equal(r.insertedLine, 2);
});

// -------------------------------------------------------------------------------------------------------------------------------
// Several cursors in one edit

test('several cursors: one edit list against the original offsets, and the line numbers of the messages count the earlier logs', () => {
    const src = ['function f() {', '  const «a» = 1;', '  const «b» = 2;', '  return a + b;', '}'];
    const { r, text, out } = ins(src, { includeLineNum: true });
    assert.deepEqual(out.split('\n'), ['function f() {', '  const a = 1;', '  console.log("▶ › :3 › f › a:", a)', '  const b = 2;', '  console.log("▶ › :5 › f › b:", b)', '  return a + b;', '}']);
    for (let i = 1; i < r.edits.length; i++) assert.ok(r.edits[i].offset >= r.edits[i - 1].offset + r.edits[i - 1].deleteLength, 'sorted and not overlapping');
    assert.equal(r.inserts.length, 2);
    assert.deepEqual(r.inserts.map((x) => x.line), [2, 4]);
    assert.equal(text.split('\n').length, 5);
});

test('several cursors at the same spot: both logs, in the order of the cursors', () => {
    const out = L(['const «a» = 1, «b» = 2;']);
    assert.deepEqual(out, ['const a = 1, b = 2;', 'console.log("▶ › a:", a)', 'console.log("▶ › b:", b)']);
});

test('several parameters of a one-line function: one rewrite, both logs', () => {
    const out = L(['function f(«a», «b») { return a + b; }']);
    assert.deepEqual(out, ['function f(a, b) {', '    console.log("▶ › f › a:", a)', '    console.log("▶ › f › b:", b)', '    return a + b;', '}']);
});

test('the same variable selected twice gives one log', () => {
    const { r } = ins(['const «a» = 1;']);
    const text = 'const a = 1;';
    const again = insertLog(text, [{ selectionStart: 6, selectionEnd: 7, languageId: 'javascript' }, { selectionStart: 6, selectionEnd: 7, languageId: 'javascript' }], {}, 'log');
    assert.equal(applyEdits(text, again.edits), 'const a = 1;\nconsole.log("▶ › a:", a)');
    assert.equal(r.edits.length, 1);
});

test('selections given as line and character', () => {
    const text = 'function t() {\n  const count = 10;\n  return count;\n}';
    const r = insertLog(text, { line: 1, character: 10, languageId: 'javascript', fileName: 'a.js' }, {}, 'log');
    assert.equal(applyEdits(text, r.edits).split('\n')[2], '  console.log("▶ › t › count:", count)');
});

// -------------------------------------------------------------------------------------------------------------------------------
// Vue, Svelte, Astro, HTML: script blocks only

test('a cursor outside the script block is refused, inside it works', () => {
    const vue = ['<template>', '  <div>{{ «msg» }}</div>', '</template>', '<script setup>', 'const msg = "a";', '</script>'];
    const r = ins(vue, {}, 'log', 'vue', 'a.vue').r;
    assert.deepEqual(r.edits, []);
    assert.match(r.reason, /script/);
    const ok = ins(['<template><i/></template>', '<script setup lang="ts">', 'const «msg» = "a";', '</script>'], {}, 'log', 'vue', 'a.vue').out.split('\n');
    assert.equal(ok[3], 'console.log("▶ › msg:", msg)');
    const html = ins(['<html><body>', '<script>', 'function go(«n») {', '  run(n);', '}', '</script>', '</body></html>'], {}, 'log', 'html', 'a.html').out.split('\n');
    assert.equal(html[3], '  console.log("▶ › go › n:", n)');
});

// -------------------------------------------------------------------------------------------------------------------------------
// Python

const PY = [
    ['assignment: after the statement', ['def f(a):', '    «x» = a + 1', '    return x'], ['def f(a):', '    x = a + 1', '    print("▶ › f › x:", x)', '    return x']],
    ['function parameter: the first body line', ['def f(«a», b):', '    return a'], ['def f(a, b):', '    print("▶ › f › a:", a)', '    return a']],
    ['parameter: the docstring stays first', ['def f(«a»):', '    """Doc."""', '    return a'], ['def f(a):', '    """Doc."""', '    print("▶ › f › a:", a)', '    return a']],
    ['for target: the first body line', ['for «item» in items:', '    use(item)'], ['for item in items:', '    print("▶ › item:", item)', '    use(item)']],
    ['if condition: before it', ['if «user.active»:', '    run()'], ['print("▶ › user.active:", user.active)', 'if user.active:', '    run()']],
    ['walrus: the first body line', ['if («n» := compute()) > 3:', '    run(n)'], ['if (n := compute()) > 3:', '    print("▶ › n:", n)', '    run(n)']],
    ['return: before it', ['def f(x):', '    return «x»'], ['def f(x):', '    print("▶ › f › x:", x)', '    return x']],
    ['multi-line dict', ['«cfg» = {', '    "a": 1,', '}', 'use(cfg)'], ['cfg = {', '    "a": 1,', '}', 'print("▶ › cfg:", cfg)', 'use(cfg)']],
    ['with ... as: the first body line', ['with open(path) as «fh»:', '    data = fh.read()'], ['with open(path) as fh:', '    print("▶ › fh:", fh)', '    data = fh.read()']],
    ['except ... as: the first body line', ['try:', '    run()', 'except ValueError as «e»:', '    handle(e)'], ['try:', '    run()', 'except ValueError as e:', '    print("▶ › e:", e)', '    handle(e)']],
    ['match subject: before it', ['match «cmd»:', '    case "go":', '        run()'], ['print("▶ › cmd:", cmd)', 'match cmd:', '    case "go":', '        run()']],
    ['quote rule: double quotes in the selection', ['d = {}', 'use(«d["k"]»)'], ['d = {}', 'use(d["k"])', 'print(\'▶ › d["k"]:\', d["k"])']],
    ['class and method name', ['class Cart:', '    def add(self, «item»):', '        self.items.append(item)'], ['class Cart:', '    def add(self, item):', '        print("▶ › Cart › add › item:", item)', '        self.items.append(item)']],
    ['block that ends: the indent of the statement, not of the next line', ['def f():', '    if a:', '        «x» = 1', 'y = 2'], ['def f():', '    if a:', '        x = 1', '        print("▶ › f › x:", x)', 'y = 2']],
    ['one-line def is expanded', ['def f(«a»): return a'], ['def f(a):', '    print("▶ › f › a:", a)', '    return a']],
    ['usage in a multi-line statement: after its last line', ['x = foo(', '    «a»,', '    b,', ')', 'use(x)'], ['x = foo(', '    a,', '    b,', ')', 'print("▶ › a:", a)', 'use(x)']],
    ['elif condition: the first line of its body', ['if a:', '    pass', 'elif «b.ok»:', '    run()'], ['if a:', '    pass', 'elif b.ok:', '    print("▶ › b.ok:", b.ok)', '    run()']],
    ['decorated function: before the decorators', ['@app.route("/")', 'def «index»():', '    pass'], ['@app.route("/")', 'def index():', '    pass', 'print("▶ › index:", index)']],
];
for (const [name, src, want] of PY) {
    test(`python: ${name}`, () => {
        const got = py(src).out.split('\n');
        assert.deepEqual(got, want);
        assert.ok(!got.some((l) => l.endsWith(';')), 'never a semicolon');
    });
}

test('python: no semicolon even when the setting asks for it', () => {
    assert.equal(py(['«x» = 1'], { addSemicolonInTheEnd: true }).out.split('\n')[1], 'print("▶ › x:", x)');
});

test('python: logging adds the import, and %s', () => {
    const out = py(['import os', '', 'def f(a):', '    «x» = a', '    return x'], {}, 'debug').out.split('\n');
    assert.deepEqual(out, ['import logging', 'import os', '', 'def f(a):', '    x = a', '    logging.debug("▶ › f › x: %s", x)', '    return x']);
    assert.equal(py(['x = 1', 'use(«x»)'], {}, 'info').out.split('\n').filter((l) => l === 'import logging').length, 1);
    const have = py(['import logging', 'x = 1', 'use(«x»)'], {}, 'warn').out.split('\n');
    assert.deepEqual(have, ['import logging', 'x = 1', 'use(x)', 'logging.warning("▶ › x: %s", x)']);
    assert.equal(py(['«x» = 1'], {}, 'error').out.split('\n')[3],'logging.error("▶ › x: %s", x)');
    const doc = py(['"""Module doc."""', '', 'x = 1', 'use(«x»)'], {}, 'info').out.split('\n');
    assert.deepEqual(doc.slice(0, 5), ['"""Module doc."""', '', 'import logging', '', 'x = 1']);
    const both = py(['«a» = 1', '«b» = 2'], {}, 'debug').out.split('\n');
    assert.equal(both.filter((l) => l === 'import logging').length, 1, 'one import for two logs');
    assert.deepEqual(py(['x = 1', 'use(«x % 2»)'], {}, 'debug').out.split('\n').slice(-1), ['logging.debug("▶ › x %% 2: %s", x % 2)'], 'a percent sign in the message is doubled');
});

test('python: custom function, "log" falls back to print', () => {
    assert.equal(py(['«x» = 1'], { logFunction: 'logger.info' }, 'custom').out.split('\n')[1], 'logger.info("▶ › x:", x)');
    assert.equal(py(['«x» = 1'], {}, 'custom').out.split('\n')[1], 'print("▶ › x:", x)');
});

test('python: wrap, file name and line number', () => {
    const out = py(['«x» = 1'], { wrapLogMessage: true, includeFilename: true, includeLineNum: true }).out.split('\n');
    assert.equal(out.length, 4);
    assert.equal(out[2], 'print("▶ › sample.py:3 › x:", x)');
    assert.match(out[1], /^print\("▶ › -+▶"\)$/);
});

// -------------------------------------------------------------------------------------------------------------------------------
// Find, comment, uncomment, delete

const JS_FILE = ['function f(a) {', '  const b = a + 1;', '  return b;', '}'];
const LOGGED = ['function f(a) {', '  console.log("▶ › f › a:", a)', '  const b = a + 1;', '  console.log("▶ › f › b:", b)', '  return b;', '}'].join('\n');

test('findLogs: the extent runs to the closing parenthesis, the marker is prefix and delimiter', () => {
    const text = ['a();', 'console.log("▶ › x:",', '  foo(1, ")"),', '  y);', 'console.log("plain", x);', '// console.warn("▶ › z:", z)', 'const s = "console.log(\'▶ › q\')";', '/* console.log("▶ › block") */', 'b();'].join('\n');
    const logs = findLogs(text, 'javascript');
    assert.deepEqual(logs.map((l) => [l.startLine, l.endLine, l.commented]), [[1, 3, false], [5, 5, true]]);
    assert.match(logs[0].text, /foo\(1, "\)"\)/);
});

test('findLogs: not a log when other code is on the line, or inside a string, template or comment block', () => {
    const text = ['foo(); console.log("▶ › a", a);', 'console.log("▶ › b", b); foo();', 'const t = `', 'console.log("▶ › c", c)', '`;', '/*', 'console.log("▶ › d", d)', '*/', 'const v = cond ? console.log("▶ › e") : 0;', 'x =', '  console.log("▶ › f", f);'].join('\n');
    assert.deepEqual(findLogs(text, 'javascript'), []);
});

test('findLogs: both the prefix and the delimiter are needed', () => {
    const text = 'console.log("▶ only the prefix", x)\nconsole.log("only › the delimiter", x)\nconsole.log("▶ › both", x)';
    assert.deepEqual(findLogs(text, 'javascript').map((l) => l.startLine), [2]);
    assert.equal(deleteLogs(text, 'javascript').count, 1);
});

test('indentation: a line that is less indented than the line after it takes the indent of the line after it', () => {
    assert.deepEqual(L(['function f() {', '// «note»', '    foo();', '}']), ['function f() {', '// note', '    console.log("▶ › f › note:", note)', '    foo();', '}']);
});

test('findLogs: the setting of the marker decides', () => {
    const text = 'console.log("LOG | x", x)\nconsole.log("▶ › y", y)';
    assert.deepEqual(findLogs(text, 'javascript', { logMessagePrefix: 'LOG', delimiterInsideMessage: '|' }).map((l) => l.startLine), [0]);
    assert.deepEqual(findLogs(text, 'javascript', { logMessagePrefix: '', delimiterInsideMessage: '' }), [], 'an empty marker would take every log: nothing is taken');
    assert.deepEqual(findLogs('myLogger("▶ › a", a)\nlog("▶ › b", b)', 'javascript', { logFunction: 'myLogger' }).map((l) => l.startLine), [0]);
});

test('comment, uncomment: insert -> comment -> uncomment gives the same text', () => {
    const c = commentLogs(LOGGED, 'javascript');
    assert.equal(c.count, 2);
    const commented = applyEdits(LOGGED, c.edits);
    assert.equal(commented.split('\n')[1], '  // console.log("▶ › f › a:", a)');
    assert.equal(commentLogs(commented, 'javascript').count, 0, 'commenting twice does nothing');
    const u = uncommentLogs(commented, 'javascript');
    assert.equal(u.count, 2);
    assert.equal(applyEdits(commented, u.edits), LOGGED);
    assert.equal(uncommentLogs(LOGGED, 'javascript').count, 0);
});

test('comment and uncomment keep the inner indentation of a multi-line log, and touch only the marked logs', () => {
    const text = ['function f() {', '    console.log("▶ › x:",', '        foo(', '            1,', '        ),', '    );', '    console.log("plain", 2);', '}'].join('\n');
    const commented = applyEdits(text, commentLogs(text, 'javascript').edits);
    assert.deepEqual(commented.split('\n').slice(1, 7), ['    // console.log("▶ › x:",', '    //     foo(', '    //         1,', '    //     ),', '    // );', '    console.log("plain", 2);']);
    assert.equal(applyEdits(commented, uncommentLogs(commented, 'javascript').edits), text);
});

test('delete: insert -> delete gives the original text, in one edit list', () => {
    const d = deleteLogs(LOGGED, 'javascript');
    assert.equal(d.count, 2);
    assert.equal(applyEdits(LOGGED, d.edits), JS_FILE.join('\n'));
    for (let i = 1; i < d.edits.length; i++) assert.ok(d.edits[i].offset >= d.edits[i - 1].offset + d.edits[i - 1].deleteLength);
    const commented = applyEdits(LOGGED, commentLogs(LOGGED, 'javascript').edits);
    assert.equal(applyEdits(commented, deleteLogs(commented, 'javascript').edits), JS_FILE.join('\n'), 'commented logs are deleted too');
    assert.deepEqual(deleteLogs(JS_FILE.join('\n'), 'javascript').edits, []);
});

test('delete: blank lines go only when the settings that make them are on', () => {
    const o = { insertEmptyLineBeforeLogMessage: true, insertEmptyLineAfterLogMessage: true };
    const src = ['a();', 'const «x» = 1;', 'b();'];
    const inserted = ins(src, o).out;
    assert.equal(applyEdits(inserted, deleteLogs(inserted, 'javascript', o).edits), src.join('\n').replace(/[«»]/g, ''));
    const keep = ['a();', '', 'console.log("▶ › x", x)', '', 'b();'].join('\n');
    assert.equal(applyEdits(keep, deleteLogs(keep, 'javascript').edits), 'a();\n\n\nb();', 'without the settings the blank lines stay');
});

test('wrapped logs are deleted and commented as a whole', () => {
    const o = { wrapLogMessage: true, addSemicolonInTheEnd: true };
    const { text, out } = ins(['a();', 'const «x» = 1;'], o);
    assert.equal(findLogs(out, 'javascript', o).length, 3);
    assert.equal(applyEdits(out, deleteLogs(out, 'javascript', o).edits), text);
    const c = applyEdits(out, commentLogs(out, 'javascript', o).edits);
    assert.equal(applyEdits(c, uncommentLogs(c, 'javascript', o).edits), out);
});

test('the round trip holds for the table kind, for CRLF and tabs', () => {
    for (const eol of ['\n', '\r\n']) {
        const { text, out } = ins(['function t() {', '\tconst «a» = 1;', '\treturn a;', '}'], {}, 'table', 'javascript', 'a.js', eol);
        assert.ok(out.includes('console.table(a)'));
        assert.equal(applyEdits(out, deleteLogs(out, 'javascript').edits), text);
        const c = applyEdits(out, commentLogs(out, 'javascript').edits);
        assert.ok(c.includes('// console.table(a) // ▶ › t › a:'));
        assert.equal(applyEdits(c, uncommentLogs(c, 'javascript').edits), out);
    }
});

test('a log that is the body of a braceless if is not commented or deleted (the next statement would become the body)', () => {
    const text = ['if (debug)', '  console.log("▶ › x", x);', 'run();', 'console.log("▶ › y", y);'].join('\n');
    const c = commentLogs(text, 'javascript');
    assert.equal(c.count, 1);
    assert.equal(c.skipped, 1);
    const d = deleteLogs(text, 'javascript');
    assert.equal(applyEdits(text, d.edits), 'if (debug)\n  console.log("▶ › x", x);\nrun();');
    // no semicolons: a log after a call is a statement of its own
    const asi = ['const a = foo()', 'console.log("▶ › a", a)'].join('\n');
    assert.equal(deleteLogs(asi, 'javascript').count, 1);
});

test('python: comment, uncomment, delete, and a block that would become empty', () => {
    const text = ['def f(a):', '    print("▶ › f › a:", a)', '    if a:', '        print("▶ › only", a)', '    return a'].join('\n');
    const c = commentLogs(text, 'python');
    assert.equal(c.count, 1);
    assert.equal(c.skipped, 1, 'the only statement of the if is not commented');
    const commented = applyEdits(text, c.edits);
    assert.equal(commented.split('\n')[1], '    # print("▶ › f › a:", a)');
    assert.equal(applyEdits(commented, uncommentLogs(commented, 'python').edits), text);
    const d = applyEdits(text, deleteLogs(text, 'python').edits);
    assert.equal(d, ['def f(a):', '    if a:', '        pass', '    return a'].join('\n'));
    assert.ok(findLogs(text, 'python').length === 2);
});

test('python: insert -> delete is the original text', () => {
    const { text, out } = py(['def f(a):', '    «x» = a', '    return x']);
    assert.equal(applyEdits(out, deleteLogs(out, 'python').edits), text);
    const lg = py(['def f(a):', '    «x» = a', '    return x'], {}, 'debug');
    assert.equal(applyEdits(lg.out, deleteLogs(lg.out, 'python').edits), 'import logging\n\n' + lg.text, 'the import that was added stays');
});

// -------------------------------------------------------------------------------------------------------------------------------
// Correct

test('correct: the file name and the line number are refreshed', () => {
    const o = { includeFilename: true, includeLineNum: true };
    const { out } = ins(['function t() {', '  const «a» = 1;', '  return a;', '}'], o, 'log', 'javascript', 'old.js');
    assert.ok(out.includes('old.js:3'));
    const moved = '// header\n// more\n' + out;
    const c = correctLogs(moved, 'javascript', o, 'new.js');
    assert.equal(c.count, 1);
    assert.ok(applyEdits(moved, c.edits).includes('console.log("▶ › new.js:5 › t › a:", a)'));
    assert.equal(correctLogs(applyEdits(moved, c.edits), 'javascript', o, 'new.js').count, 0, 'nothing is left to correct');
});

test('correct: only what the settings ask for, an exact match of the number', () => {
    const text = 'x();\nconsole.log("▶ › :12 › a:", a)\nconsole.log("▶ › :2 › b:", b)';
    const lineOnly = correctLogs(text, 'javascript', { includeLineNum: true }, 'a.js');
    assert.equal(applyEdits(text, lineOnly.edits), 'x();\nconsole.log("▶ › :2 › a:", a)\nconsole.log("▶ › :3 › b:", b)');
    assert.equal(correctLogs(text, 'javascript', {}, 'a.js').count, 0, 'both settings off: nothing to do');
    const name = 'console.log("▶ › old.js › a:", a)\nconsole.log("▶ › Cart › add › item:", item)';
    assert.equal(applyEdits(name, correctLogs(name, 'javascript', { includeFilename: true }, 'new.js').edits), 'console.log("▶ › new.js › a:", a)\nconsole.log("▶ › Cart › add › item:", item)', 'a class name is not taken for a file name');
    const mixed = 'console.log("▶ › a.js:7 › x:", x)\n// console.log("▶ › a.js:1 › y:", y)';
    assert.equal(applyEdits(mixed, correctLogs(mixed, 'javascript', { includeFilename: true, includeLineNum: true }, 'b.js').edits), 'console.log("▶ › b.js:1 › x:", x)\n// console.log("▶ › b.js:2 › y:", y)', 'commented logs are corrected too');
});

test('correct: Python', () => {
    const o = { includeFilename: true, includeLineNum: true };
    const { out } = py(['def f():', '    «x» = 1'], o);
    const moved = '#!/usr/bin/env python\n' + out;
    assert.ok(applyEdits(moved, correctLogs(moved, 'python', o, 'z.py').edits).includes('print("▶ › z.py:4 › f › x:", x)'));
});

// -------------------------------------------------------------------------------------------------------------------------------
// Robustness

test('unbalanced and odd code never throws and still gives an edit', () => {
    for (const src of ['function f(«a» {', 'const «a» = (', 'if («a») {', '«a»', 'class {', 'foo(«a»', '`unterminated «a»', 'const «a» = <div>', 'x = {«a»: ']) {
        const r = ins(src).r;
        assert.ok(Array.isArray(r.edits), src);
    }
});

test('detectLanguage', () => {
    assert.equal(T.detectLanguage('typescript'), 'js');
    assert.equal(T.detectLanguage('python'), 'py');
    assert.equal(T.detectLanguage('plaintext', 'a.py'), 'py');
    assert.equal(T.detectLanguage(undefined, 'a.mjs'), 'js');
    assert.equal(T.detectLanguage('markdown', 'a.md'), null);
    assert.equal(T.detectLanguage('rust'), null);
});

test('applyEdits refuses overlapping edits and keeps the order of inserts at one place', () => {
    assert.throws(() => applyEdits('abcdef', [{ offset: 1, deleteLength: 3, text: '' }, { offset: 2, deleteLength: 0, text: 'x' }]));
    assert.equal(applyEdits('abc', [{ offset: 1, deleteLength: 0, text: 'X' }, { offset: 1, deleteLength: 0, text: 'Y' }]), 'aXYbc');
});

// -------------------------------------------------------------------------------------------------------------------------------
// The glue, with a stand-in for vscode

const { register } = require('../src/turbolog-commands');

function makeVscode({ text, languageId = 'javascript', fileName = 'C:\\proj\\sample.js', selections, config = {}, tabSize = 4 }) {
    const state = { text, applied: [], messages: [], commands: new Map() };
    const lineStarts = () => { const s = [0]; const re = /\r\n|\r|\n/g; let m; while ((m = re.exec(state.text))) s.push(m.index + m[0].length); return s; };
    const offsetAt = (p) => lineStarts()[p.line] + p.character;
    const positionAt = (o) => { const s = lineStarts(); let l = 0; while (l + 1 < s.length && s[l + 1] <= o) l++; return { line: l, character: o - s[l] }; };
    class Position { constructor(line, character) { this.line = line; this.character = character; } }
    class Range { constructor(a, b) { this.start = a; this.end = b; } }
    class WorkspaceEdit {
        constructor() { this.ops = []; }
        insert(uri, pos, text) { this.ops.push({ uri, range: new Range(pos, pos), text }); }
        replace(uri, range, text) { this.ops.push({ uri, range, text }); }
        delete(uri, range) { this.ops.push({ uri, range, text: '' }); }
    }
    const document = { languageId, fileName, uri: { fsPath: fileName }, getText: () => state.text, offsetAt, positionAt };
    const editor = { document, options: { tabSize, insertSpaces: true }, selections: (selections || []).map(([a, b]) => ({ start: positionAt(a), end: positionAt(b) })) };
    const vscode = {
        Position, Range, WorkspaceEdit,
        window: { activeTextEditor: editor, showInformationMessage: (m) => { state.messages.push(m); return Promise.resolve(); } },
        commands: { registerCommand: (id, fn) => { state.commands.set(id, fn); return { dispose() {} }; } },
        workspace: {
            getConfiguration: (section) => ({ get: (key, fallback) => (section === 'openconsole.log' && key in config ? config[key] : fallback) }),
            applyEdit: (we) => {
                state.applied.push(we);
                const ops = we.ops.map((o) => ({ s: offsetAt(o.range.start), e: offsetAt(o.range.end), text: o.text }));
                state.text = applyEdits(state.text, ops.map((o) => ({ offset: o.s, deleteLength: o.e - o.s, text: o.text })));
                return Promise.resolve(true);
            },
        },
    };
    return { vscode, state, editor };
}

test('glue: every command is registered', () => {
    const { vscode, state } = makeVscode({ text: '', selections: [] });
    const context = { subscriptions: [] };
    assert.equal(register(vscode, context, {}), undefined);
    for (const id of ['insert', 'info', 'debug', 'table', 'warn', 'error', 'custom', 'commentAll', 'uncommentAll', 'deleteAll', 'correctAll']) assert.ok(state.commands.has('openconsole.log.' + id), id);
    assert.equal(context.subscriptions.length, 11);
});

test('glue: insert uses the selections of the editor in one WorkspaceEdit and the settings of openconsole.log', async () => {
    const { text, sels } = parse('function t() {\n  const «a» = 1;\n  const «b» = 2;\n  return a + b;\n}');
    const { vscode, state } = makeVscode({ text, selections: sels, config: { includeLineNum: true, logMessagePrefix: '#' , delimiterInsideMessage: '-'} });
    register(vscode, { subscriptions: [] }, {});
    await state.commands.get('openconsole.log.insert')();
    assert.equal(state.applied.length, 1, 'one WorkspaceEdit: one undo step');
    assert.deepEqual(state.text.split('\n'), ['function t() {', '  const a = 1;', '  console.log("# - :3 - t - a:", a)', '  const b = 2;', '  console.log("# - :5 - t - b:", b)', '  return a + b;', '}']);
});

test('glue: kinds and the custom function', async () => {
    const { vscode, state } = makeVscode({ text: 'use(x);', selections: [[4, 5]], config: { logFunction: 'trace' } });
    register(vscode, { subscriptions: [] }, {});
    await state.commands.get('openconsole.log.warn')();
    assert.equal(state.text, 'use(x);\nconsole.warn("▶ › x:", x)');
    await state.commands.get('openconsole.log.custom')();
    assert.ok(state.text.endsWith('trace("▶ › x:", x)') || state.text.split('\n').includes('trace("▶ › x:", x)'));
});

test('glue: a readConfig of the caller can give the settings', async () => {
    const { vscode, state } = makeVscode({ text: 'use(x);', selections: [[4, 5]] });
    register(vscode, { subscriptions: [] }, { readConfig: () => ({ get: (k, f) => (k === 'quote' ? "'" : f) }) });
    await state.commands.get('openconsole.log.insert')();
    assert.equal(state.text, "use(x);\nconsole.log('▶ › x:', x)");
});

test('glue: comment, uncomment, delete, correct; a message when there is nothing to do', async () => {
    const { vscode, state } = makeVscode({ text: LOGGED, config: { includeFilename: true, includeLineNum: true } });
    register(vscode, { subscriptions: [] }, {});
    await state.commands.get('openconsole.log.commentAll')();
    assert.equal(state.text.split('\n')[1], '  // console.log("▶ › f › a:", a)');
    await state.commands.get('openconsole.log.uncommentAll')();
    assert.equal(state.text, LOGGED);
    await state.commands.get('openconsole.log.correctAll')();
    assert.equal(state.messages.length, 1, 'nothing to correct: the logs have no file name and line number');
    assert.match(state.messages[0], /\w/);
    state.messages.length = 0;
    await state.commands.get('openconsole.log.deleteAll')();
    assert.equal(state.text, JS_FILE.join('\n'));
    await state.commands.get('openconsole.log.deleteAll')();
    assert.equal(state.messages.length, 1, 'nothing found: one message');
    assert.equal(state.applied.length, 3, 'a command that finds nothing applies no edit');
});

test('glue: correct changes the file name and the line number', async () => {
    const text = '// x\nconsole.log("▶ › old.js:1 › a:", a)';
    const { vscode, state } = makeVscode({ text, fileName: '/p/new.js', config: { includeFilename: true, includeLineNum: true } });
    register(vscode, { subscriptions: [] }, {});
    await state.commands.get('openconsole.log.correctAll')();
    assert.equal(state.text, '// x\nconsole.log("▶ › new.js:2 › a:", a)');
});

test('glue: no editor, an unsupported file and nothing to log give a message and no edit', async () => {
    const a = makeVscode({ text: 'x', selections: [[0, 1]], languageId: 'markdown', fileName: 'a.md' });
    register(a.vscode, { subscriptions: [] }, {});
    await a.state.commands.get('openconsole.log.insert')();
    assert.equal(a.state.applied.length, 0);
    assert.equal(a.state.messages.length, 1);
    const b = makeVscode({ text: 'x', selections: [[0, 1]] });
    b.vscode.window.activeTextEditor = undefined;
    register(b.vscode, { subscriptions: [] }, {});
    for (const id of ['insert', 'commentAll', 'deleteAll']) await b.state.commands.get('openconsole.log.' + id)();
    assert.equal(b.state.messages.length, 3);
});

test('glue: Python through the editor', async () => {
    const { vscode, state } = makeVscode({ text: 'def f(a):\n    x = a\n    return x', languageId: 'python', fileName: 'f.py', selections: [[14, 15]] });
    register(vscode, { subscriptions: [] }, {});
    await state.commands.get('openconsole.log.debug')();
    assert.equal(state.text, 'import logging\n\ndef f(a):\n    x = a\n    logging.debug("▶ › f › x: %s", x)\n    return x');
});

test('the contributes file lists every command, a key for each and a setting for each option', () => {
    const c = require('../src/turbolog.contributes.json');
    const ids = c.commands.map((x) => x.command);
    for (const id of ['insert', 'info', 'debug', 'table', 'warn', 'error', 'custom', 'commentAll', 'uncommentAll', 'deleteAll', 'correctAll']) assert.ok(ids.includes('openconsole.log.' + id), id);
    for (const k of c.keybindings) { assert.ok(ids.includes(k.command)); assert.ok(k.key && k.when); }
    assert.equal(new Set(c.keybindings.map((k) => k.key)).size, c.keybindings.length, 'no key twice');
    for (const key of Object.keys(defaultOptions)) {
        const p = c.configuration.properties['openconsole.log.' + key];
        assert.ok(p, key);
        assert.deepEqual(p.default, defaultOptions[key], key + ' has the default of the code');
        assert.ok(p.type && (p.description || p.markdownDescription), key);
    }
});
