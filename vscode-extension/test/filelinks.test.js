'use strict';
// File paths in the output of a terminal (media/filelinks.js): which ones are found, and which words that look like them are not.
const test = require('node:test');
const assert = require('node:assert/strict');
const { find, linkProvider, rowText } = require('../media/filelinks');

const texts = (line) => find(line).map((m) => m.text);
const one = (line) => { const found = find(line); assert.equal(found.length, 1, JSON.stringify(found) + ' in ' + line); return found[0]; };

test('relative paths, with a line and a column', () => {
    assert.deepEqual(one('src/app.ts:12:5'), { start: 0, end: 15, text: 'src/app.ts:12:5', path: 'src/app.ts', line: 12, col: 5 });
    assert.deepEqual(one('error in ./lib/util.js:7 here'), { start: 9, end: 24, text: './lib/util.js:7', path: './lib/util.js', line: 7, col: 0 });
    assert.equal(one('packages/ui/index.tsx').path, 'packages/ui/index.tsx');
    assert.equal(one('..\\..\\x\\y.cs(10,3): error CS1002').line, 10);
    assert.equal(one('..\\..\\x\\y.cs(10,3): error CS1002').col, 3);
    assert.equal(one('src/a.ts(8): bad').line, 8);
});

test('Windows paths with a drive, and the two kinds of slash', () => {
    const m = one('at C:\\Users\\pc\\proj\\src\\a.ts:12:5 (node)');
    assert.equal(m.path, 'C:\\Users\\pc\\proj\\src\\a.ts');
    assert.equal(m.line, 12);
    assert.equal(m.col, 5);
    assert.equal(one('D:/work/x/y.py:3').path, 'D:/work/x/y.py');
    assert.equal(one('~/notes/todo.md').path, '~/notes/todo.md');
});

test('a name without a folder counts only with a line', () => {
    assert.equal(one('index.js:10:5').path, 'index.js');
    assert.deepEqual(texts('see node.js and v1.2.3 and e.g. this'), []);
    assert.deepEqual(texts('README.md'), [], 'a bare name is not clear enough');
});

test('the punctuation around a path is not part of it', () => {
    assert.equal(one('(src/foo.js:3)').text, 'src/foo.js:3');
    assert.equal(one('"src/foo.js"').text, 'src/foo.js');
    assert.equal(one('see src/foo.js.').text, 'src/foo.js');
    assert.equal(one('src/foo.js, next').text, 'src/foo.js');
    assert.equal(one('<src/foo.js:4:2>').text, 'src/foo.js:4:2');
    assert.equal(one('src/a.test.ts:9').path, 'src/a.test.ts', 'the last dot starts the extension');
    assert.deepEqual(texts('src/foo.extension_name'), [], 'an extension that goes on in a word is not an extension');
});

test('an address is never taken for a path', () => {
    assert.deepEqual(texts('open https://example.com/docs/a.html now'), []);
    assert.deepEqual(texts('http://localhost:3000/app/main.js'), []);
    assert.deepEqual(texts('file:///C:/x/y.ts'), []);
    assert.deepEqual(texts('git@github.com:user/repo.git'), []);
});

test('numbers that look like paths are not', () => {
    assert.deepEqual(texts('10.0.0.1 and 1/2.5 and 192.168.1.1/24'), []);
});

test('several paths in one row, and paths next to Arabic text', () => {
    assert.deepEqual(texts('a/b.ts:1 b/c.ts:2'), ['a/b.ts:1', 'b/c.ts:2']);
    const m = one('الخطأ في src/مثال.ts أو src/app.ts:5 هنا');
    assert.equal(m.path, 'src/app.ts');
});

test('hostile text is only text: no crash, and a very long run is dropped', () => {
    assert.deepEqual(find(null), []);
    assert.deepEqual(find(''), []);
    assert.deepEqual(texts('a/'.repeat(600) + 'b.ts'), [], 'longer than the limit');
    const start = Date.now();
    find('a'.repeat(50000) + '/' + 'b.'.repeat(5000));
    assert.ok(Date.now() - start < 1500, 'the pattern does not take forever on a long row');
});

test('the link provider: the columns follow the cells (a wide character takes two), and a click needs Ctrl', () => {
    // a row of 40 cells: "表 src/a.ts:3 x" where the first character is a wide one (two cells)
    const cells = [{ chars: '表', width: 2 }, { chars: '', width: 0 }, ...Array.from(' src/a.ts:3 x', (c) => ({ chars: c, width: 1 }))];
    while (cells.length < 40) cells.push({ chars: '', width: 1 });
    const line = { getCell: (x) => (cells[x] ? { getWidth: () => cells[x].width, getChars: () => cells[x].chars } : undefined) };
    const term = { cols: 40, buffer: { active: { getLine: (y) => (y === 4 ? line : undefined) } } };
    const calls = [];
    const provider = linkProvider(term, { open: (m, e) => calls.push(['open', m.path, m.line, e.ctrlKey]), hover: () => calls.push(['hover']), leave: () => calls.push(['leave']) });
    let links;
    provider.provideLinks(5, (l) => { links = l; });
    assert.equal(links.length, 1);
    assert.deepEqual(links[0].range, { start: { x: 4, y: 5 }, end: { x: 13, y: 5 } }, 'cells 3..12: the wide character is cells 0 and 1, then a space');
    assert.equal(links[0].text, 'src/a.ts:3');
    links[0].activate({ button: 0, ctrlKey: false });
    links[0].activate({ button: 2, ctrlKey: true });
    assert.deepEqual(calls, [], 'a click without Ctrl, or with another button, does nothing');
    links[0].activate({ button: 0, ctrlKey: true });
    links[0].hover({}); links[0].leave();
    assert.deepEqual(calls, [['open', 'src/a.ts', 3, true], ['hover'], ['leave']]);
    let none = 'unset';
    provider.provideLinks(9, (l) => { none = l; });
    assert.equal(none, undefined, 'no such row');
    assert.equal(rowText(line, 40).text.startsWith('表 src/a.ts:3 x'), true);
});
