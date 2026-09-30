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
