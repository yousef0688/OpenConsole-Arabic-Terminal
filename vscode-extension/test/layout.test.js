'use strict';
// Run with:  node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../media/arabic-layout.js');

const A = (...cps) => String.fromCodePoint(...cps);
const salam = A(0x627, 0x644, 0x633, 0x644, 0x627, 0x645);   // السلام
const alaykum = A(0x639, 0x644, 0x64A, 0x643, 0x645);         // عليكم
const marhaba = A(0x645, 0x631, 0x62D, 0x628, 0x627);         // مرحبا
const alam = A(0x639, 0x627, 0x644, 0x645);                    // عالم

/** One unit per character; a combining mark joins the unit before it; wide characters take two columns. */
function unitsOf(str) {
    const units = [];
    for (const ch of str) {
        const cp = ch.codePointAt(0);
        const isMark = (cp >= 0x0300 && cp <= 0x036F) || (cp >= 0x064B && cp <= 0x065F) || cp === 0x0670;
        if (isMark && units.length) { units[units.length - 1].text += ch; continue; }
        const wide = (cp >= 0x4E00 && cp <= 0x9FFF);
        units.push({ text: ch, width: wide ? 2 : 1 });
    }
    return units;
}

function describe(analysis) {
    return analysis.boxes.map(b => `${b.rtl ? 'R' : 'L'}${b.reverse ? '~' : ''}[${b.u0},${b.u1})@${b.vcol}+${b.cells}`).join(' ');
}

test('a row without right-to-left text is left alone', () => {
    const u = unitsOf('PS C:\\Users\\pc> dir');
    assert.equal(L.rowHasRtl(u), false);
    const a = L.analyzeImplicit(u);
    assert.equal(a.hasRtl, false);
    assert.equal(a.boxes.length, 1);
});

test('an Arabic phrase between Latin words is mirrored inside its own columns', () => {
    const u = unitsOf('abc ' + salam + ' ' + alaykum + ' def');       // 4 + 6 + 1 + 5 + 4 = 20 columns
    const a = L.analyzeImplicit(u);
    assert.equal(a.hasRtl, true);
    assert.equal(describe(a), 'L[0,4)@0+4 R[4,16)@4+12 L[16,20)@16+4');
    // the first word ends up on the right of the run, the second on the left (mirrored inside columns 4..15)
    assert.equal(a.vcol[4], 15);      // the first letter of "السلام" (logical column 4) is at the right end
    assert.equal(a.vcol[9], 10);      // its last letter
    assert.equal(a.vcol[10], 9);      // the space in between
    assert.equal(a.vcol[11], 8);      // the first letter of "عليكم"
    assert.equal(a.vcol[15], 4);      // its last letter is at the left end
});

test('a phrase at the start of the line', () => {
    const u = unitsOf(salam + ' ' + alaykum);
    const a = L.analyzeImplicit(u);
    assert.equal(describe(a), 'R[0,12)@0+12');
    assert.equal(a.vcol[0], 11);
    assert.equal(a.vcol[11], 0);
});

test('digits stay in their own order inside an Arabic phrase', () => {
    const u = unitsOf(A(0x646, 0x633, 0x62E, 0x629) + ' 123 ok');    // نسخة 123 ok
    const a = L.analyzeImplicit(u);
    // the run is "نسخة 123" (8 columns), " ok" stays on the right
    assert.equal(describe(a), 'R[0,8)@0+8 L[8,11)@8+3');
    assert.ok(a.levels[5] === 2 && a.levels[6] === 2 && a.levels[7] === 2, 'the digits are one level deeper');
});

test('box drawing characters end a run, so table columns are not swapped', () => {
    const u = unitsOf('\u2502 ' + marhaba + ' \u2502 ' + alam + ' \u2502');
    const a = L.analyzeImplicit(u);
    const rtl = a.boxes.filter(b => b.rtl);
    assert.equal(rtl.length, 2, 'two separate runs');
    assert.equal(rtl[0].vcol, 2);       // the first cell stays where it is
    assert.ok(rtl[1].vcol > rtl[0].vcol);
});

test('marks stay with their letter and combining units keep one column', () => {
    const u = unitsOf(A(0x627, 0x644, 0x633, 0x64E, 0x651, 0x644, 0x627, 0x645));   // السَّلام
    assert.equal(u.length, 6);
    const a = L.analyzeImplicit(u);
    assert.equal(describe(a), 'R[0,6)@0+6');
});

test('wide characters keep their two columns', () => {
    const u = unitsOf(A(0x4E2D) + ' ' + salam);           // a CJK character (2 columns), a space, an Arabic word
    assert.equal(u[0].width, 2);
    const a = L.analyzeImplicit(u);
    // units: 0 = the wide character (2 columns), 1 = the space, 2..7 = the word
    assert.equal(describe(a), 'L[0,2)@0+3 R[2,8)@3+6');
});

test('visual mode: words of Arabic letters are turned back, columns do not move', () => {
    const rev = (s) => Array.from(s).reverse().join('');
    const u = unitsOf('claude> ' + rev(salam + ' ' + alaykum));     // what a program that reorders the text writes
    const a = L.analyzeVisual(u);
    assert.equal(a.hasRtl, true);
    const words = a.boxes.filter(b => b.rtl);
    assert.equal(words.length, 2);
    assert.ok(words.every(b => b.reverse));
    assert.equal(words[0].vcol, 8);                 // right after "claude> "
    assert.equal(words[0].cells, 5);                // "مكيلع" (the reversed "عليكم") comes first on the screen
    assert.equal(words[1].vcol, 14);
    assert.equal(words[1].cells, 6);
});

test('cursor: typing at the end of an Arabic word', () => {
    const u = unitsOf('PS> ' + salam);            // the cursor is in column 10, right after the word
    const a = L.analyzeImplicit(u);
    assert.equal(L.cursorColumn(a, u, 10, 'bar', 10), 4);       // the bar is at the left edge of the word
    assert.equal(L.cursorColumn(a, u, 10, 'block', 10), 3);     // a block sits just left of the word
});

test('cursor: on a letter inside an Arabic word, and in plain text', () => {
    const u = unitsOf('PS> ' + salam);
    const a = L.analyzeImplicit(u);
    // logical unit 4 is the first letter; it is drawn at the right end (column 9)
    assert.equal(L.cursorColumn(a, u, 4, 'block', 4), 9);
    assert.equal(L.cursorColumn(a, u, 4, 'bar', 4), 10);
    // plain text: unchanged
    assert.equal(L.cursorColumn(a, u, 1, 'block', 1), 1);
    const plain = unitsOf('PS> dir');
    assert.equal(L.cursorColumn(L.analyzeImplicit(plain), plain, 7, 'bar', 7), 7);
});

test('words mode: every word is mirrored in its own columns and the words stay in the order they were typed', () => {
    const u = unitsOf('> ' + marhaba + ' with ' + salam + ' ' + alam);
    const a = L.analyzeWords(u);
    assert.equal(a.hasRtl, true);
    const rtl = a.boxes.filter(b => b.rtl);
    assert.deepEqual(rtl.map(b => [b.u0, b.u1, b.vcol, b.cells]), [[2, 7, 2, 5], [13, 19, 13, 6], [20, 24, 20, 4]]);
    assert.ok(rtl.every(b => b.reverse === false), 'the browser lays the letters of a word out right to left itself');
    // the same sentence in implicit mode puts the last word first
    const implicit = L.analyzeImplicit(unitsOf('> ' + salam + ' ' + alam)).boxes.filter(b => b.rtl);
    assert.equal(implicit.length, 1, 'implicit mode: one run for the whole stretch');
    const words = L.analyzeWords(unitsOf('> ' + salam + ' ' + alam)).boxes.filter(b => b.rtl);
    assert.equal(words.length, 2, 'words mode: one box per word');
    assert.deepEqual(words.map(b => b.vcol), [2, 9]);
});

test('words mode: a word that is typed does not move what comes before it', () => {
    const before = L.analyzeWords(unitsOf('> ' + marhaba + ' ' + salam.slice(0, 3)));
    const after = L.analyzeWords(unitsOf('> ' + marhaba + ' ' + salam));
    const first = (a) => a.boxes.filter(b => b.rtl)[0];
    assert.deepEqual([first(before).vcol, first(before).cells], [first(after).vcol, first(after).cells]);
    // in implicit mode the first word is pushed to the right by every letter that is typed
    const impl = (s) => L.analyzeImplicit(unitsOf('> ' + marhaba + ' ' + s)).boxes.filter(b => b.rtl)[0];
    assert.notEqual(impl(salam.slice(0, 3)).cells, impl(salam).cells);
});

test('words mode: numbers, Latin text and the digits of Arabic stay left to right', () => {
    const digits = A(0x662, 0x660, 0x662, 0x666);      // ٢٠٢٦
    const u = unitsOf(marhaba + ' ' + digits + ' 2026 abc');
    const a = L.analyzeWords(u);
    const rtl = a.boxes.filter(b => b.rtl);
    assert.equal(rtl.length, 1, 'only the word is mirrored');
    assert.deepEqual([rtl[0].u0, rtl[0].u1], [0, 5]);
    for (let i = 5; i < u.length; i++) assert.equal(a.vcol[i], i, 'unit ' + i + ' stays in its column');
});

test('words mode: a row without right-to-left letters has nothing to do', () => {
    assert.equal(L.analyzeWords(unitsOf('PS C:\> dir /b')).hasRtl, false);
});

test('words mode: the unit under the cursor is drawn on its own but keeps its place inside the word', () => {
    const u = unitsOf('> ' + salam);                    // السلام in columns 2..7
    const whole = L.analyzeWords(u);
    const split = L.analyzeWords(u, { before: 4, after: 5 });
    for (let i = 0; i < u.length; i++) assert.equal(split.vcol[i], whole.vcol[i]);
    assert.equal(whole.vcol[2], 7, 'the first letter is at the right end of the word');
    assert.equal(whole.vcol[7], 2, 'the last letter is at the left end');
    assert.ok(split.boxes.some(b => b.u0 === 4 && b.u1 === 5));
});

test('words mode: cursor at the end of a word being typed is at its left edge', () => {
    const u = unitsOf('> ' + marhaba + ' ' + salam);
    const a = L.analyzeWords(u);
    assert.equal(L.cursorColumn(a, u, u.length, 'bar', 14), 8, 'the bar is at the left edge of the word: where the next letter appears');
    assert.equal(L.cursorColumn(a, u, u.length, 'block', 14), 7, 'a block sits just left of the word');
    // after the space the cursor is where the cursor is
    const spaced = unitsOf('> ' + marhaba + ' ');
    assert.equal(L.cursorColumn(L.analyzeWords(spaced), spaced, spaced.length, 'bar', 8), 8);
});

test('visual mode, typing at the end in Claude Code: the cursor goes to the free cell at the left end of the text, and only then', () => {
    const word = A(0x643, 0x641, 0x64A, 0x643);               // the word as Claude Code writes it: visual order of "كيفك"
    const row = (text) => unitsOf(text).map((u, i) => Object.assign(u, { col: i }));
    const prompt = String.fromCharCode(0x276F);
    const typing = row(prompt + '  ' + word);                  // the prompt, a gap, the free cell, the word: the cursor of the terminal is on its last cell
    assert.deepEqual(L.visualEndCaret(typing, 6), { col: 3 });
    assert.equal(L.visualEndCaret(typing, 5), null, 'only when the cursor is on the last cell');
    assert.equal(L.visualEndCaret(typing, 2), null);
    assert.equal(L.visualEndCaret(typing, 99), null);
    assert.deepEqual(L.visualEndCaret(row(prompt + '  ' + A(0x643)), 3), { col: 3 }, 'the first letter typed');

    // after the Left arrow the text starts right after the gap: the cursor is inside the text, not at its end
    assert.equal(L.visualEndCaret(row(prompt + ' ' + word), 5), null);
    // not a prompt row, no Arabic, or Latin text first
    assert.equal(L.visualEndCaret(row(word + ' ' + word), 8), null);
    assert.equal(L.visualEndCaret(row(prompt + '  hello'), 7), null);
    assert.equal(L.visualEndCaret(row(prompt + '  abc ' + word), 10), null, 'the next letter of Latin text comes at the right of it');
    assert.equal(L.visualEndCaret(row('  ' + word), 5), null, 'a space is not a prompt symbol');
    assert.equal(L.visualEndCaret(row(A(0x645) + '  ' + word), 6), null, 'an Arabic letter is not a prompt symbol');
    assert.equal(L.visualEndCaret([], 0), null);
    // Claude Code writes a no-break space after its prompt symbol, and the real row looks like this
    assert.deepEqual(L.visualEndCaret(row(prompt + String.fromCharCode(0xA0) + ' ' + word), 6), { col: 3 });
});
