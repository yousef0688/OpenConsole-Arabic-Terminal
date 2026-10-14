'use strict';
// The motion of the buttons and of the list, in a real browser with a real mouse (the pointer is moved with the debugging protocol, so
// :hover and :active really apply). test/webview-multi.html with "#shot" stops with two terminals and the list on the screen.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { browser, withPage, waitUntil, sleep } = require('./browser-helper');

const page = pathToFileURL(path.join(__dirname, 'webview-multi.html')).href + '#shot';
const skip = !browser && 'no Chrome or Edge found';

/** Opens the page with two terminals, and waits until the scenario is done. */
async function withTwoTerminals(fn) {
    return withPage(page, async (p) => {
        await waitUntil(() => p.evaluate("!!(document.getElementById('result') || {}).textContent"), 'the scenario to finish', 60000);
        await sleep(500);
        return fn(p);
    }, { width: 900, height: 320 });
}

const center = (p, selector) => p.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const move = (p, x, y) => p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
const style = (p, selector, props) => p.evaluate(`(() => { const cs = getComputedStyle(document.querySelector(${JSON.stringify(selector)})); const out = {}; for (const k of ${JSON.stringify(props)}) out[k] = cs[k]; return out; })()`);
/** The numbers of a computed transform: "matrix(a, b, c, d, e, f)" -> [a, b, c, d, e, f] ('none' is the identity). */
const matrix = (transform) => (transform === 'none' ? [1, 0, 0, 1, 0, 0] : transform.replace(/^matrix\(|\)$/g, '').split(',').map(Number));
const close = (a, b, tolerance = 0.03) => Math.abs(a - b) <= tolerance;

test('the buttons of a row spring in when the row is pointed at, one after the other', { skip }, async () => {
    await withTwoTerminals(async (p) => {
        const row = '#list .item[data-id="1"]';
        const away = await center(p, '#terminals');
        await move(p, away.x, away.y);
        await sleep(100);
        assert.equal((await style(p, row + ' .split', ['display'])).display, 'none', 'the buttons of a row that is not pointed at take no room');

        // watch the buttons frame by frame while the pointer comes to the row
        await p.evaluate(`window.__samples = []; (function loop(t0) {
            const read = (name) => { const cs = getComputedStyle(document.querySelector('${row} .' + name)); return [cs.display, +cs.opacity, cs.transform]; };
            window.__samples.push({ t: Math.round(performance.now() - t0), split: read('split'), close: read('close') });
            if (performance.now() - t0 < 1100) requestAnimationFrame(() => loop(t0));
        })(performance.now())`);
        const label = await center(p, row + ' .label');
        await move(p, label.x, label.y);
        await sleep(1300);
        const samples = await p.evaluate('window.__samples');
        const shown = samples.filter((s) => s.split[0] !== 'none');
        assert.ok(shown.length > 5, 'the buttons were shown: ' + JSON.stringify(samples.slice(0, 3)));
        assert.ok(shown[0].split[1] < 0.5, 'the first button starts transparent: ' + shown[0].split[1]);
        assert.ok(shown[0].close[1] < 0.5, 'and so does the second');
        assert.equal(shown[shown.length - 1].split[1], 1);
        assert.equal(shown[shown.length - 1].close[1], 1);
        assert.ok(shown.some((s) => s.split[1] > 0.5 && s.close[1] < 0.5), 'the bin follows a moment after the split button (they do not appear together)');
        const grown = shown.some((s) => matrix(s.split[2])[0] > 1.05);
        assert.ok(grown, 'the button overshoots its size on the way in (a spring)');
        assert.deepEqual(matrix(shown[shown.length - 1].split[2]), [1, 0, 0, 1, 0, 0], 'and settles in its place');
        assert.equal((await style(p, row + ' .close', ['animationDelay'])).animationDelay, '0.09s');
    });
});

test('a button grows when it is pointed at and sinks when it is pressed; the pressed button is not clicked when the pointer leaves it', { skip }, async () => {
    await withTwoTerminals(async (p) => {
        const row = '#list .item[data-id="1"]';
        const label = await center(p, row + ' .label');
        await move(p, label.x, label.y);
        await sleep(500);
        const split = await center(p, row + ' .split');
        await move(p, split.x, split.y);
        await sleep(500);
        assert.ok(close(matrix((await style(p, row + ' .split', ['transform'])).transform)[0], 1.12), 'pointed at: it is 12% bigger');

        const terminalsBefore = await p.evaluate('window.__openconsole.terminals.size');
        await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: split.x, y: split.y, button: 'left', buttons: 1, clickCount: 1 });
        await sleep(300);
        assert.ok(close(matrix((await style(p, row + ' .split', ['transform'])).transform)[0], 0.84), 'pressed: it sinks to 84%');
        const away = await center(p, '#terminals');
        await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: away.x, y: away.y, button: 'left', buttons: 1 });
        await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: away.x, y: away.y, button: 'left', buttons: 0, clickCount: 1 });
        await sleep(300);
        assert.equal(await p.evaluate('window.__openconsole.terminals.size'), terminalsBefore, 'let go somewhere else: no click, no new terminal');
    });
});

test('the icons move: the divider of Split divides in two, the lid of the bin lifts and the bin turns red', { skip }, async () => {
    await withTwoTerminals(async (p) => {
        const row = '#list .item[data-id="1"]';
        const label = await center(p, row + ' .label');
        await move(p, label.x, label.y);
        await sleep(500);

        // at rest
        assert.equal(matrix((await style(p, row + ' .split .half-l', ['transform'])).transform)[4], 0);
        assert.equal(matrix((await style(p, row + ' .close .lid', ['transform'])).transform)[1], 0);
        const calm = await style(p, row + ' .close', ['color']);

        const split = await center(p, row + ' .split');
        await move(p, split.x, split.y);
        await sleep(600);
        const left = matrix((await style(p, row + ' .split .half-l', ['transform'])).transform)[4];
        const right = matrix((await style(p, row + ' .split .half-r', ['transform'])).transform)[4];
        assert.ok(close(left, -1.8, 0.05) && close(right, 1.8, 0.05), 'the two halves of the divider move apart: ' + left + ' / ' + right);

        const bin = await center(p, row + ' .close');
        await move(p, bin.x, bin.y);
        await sleep(600);
        const lid = matrix((await style(p, row + ' .close .lid', ['transform'])).transform);
        assert.ok(lid[1] < -0.3 && lid[1] > -0.45, 'the lid is tilted by about 22 degrees (sin = ' + lid[1] + ')');
        const [r, g, b] = (await style(p, row + ' .close', ['color'])).color.match(/[0-9.]+/g).map(Number);
        const [r0, g0] = calm.color.match(/[0-9.]+/g).map(Number);
        assert.ok(r > g + 40 && r > b + 40, 'the bin is red: ' + [r, g, b]);
        assert.ok(Math.abs(r0 - g0) < 10, 'and it was not red before: ' + calm.color);
        const background = (await style(p, row + ' .close', ['backgroundColor'])).backgroundColor;
        assert.match(background, /\/ 0?\.\d+\)|rgba\(.*,\s*0?\.\d+\)/, 'with a see-through red behind it: ' + background);

        // the pointer leaves: everything goes back
        await move(p, label.x, label.y);
        await sleep(600);
        assert.ok(close(matrix((await style(p, row + ' .close .lid', ['transform'])).transform)[1], 0, 0.01), 'the lid is down again');
        assert.equal(matrix((await style(p, row + ' .split .half-l', ['transform'])).transform)[4], 0, 'and the divider whole');
    });
});

test('a terminal that is added slides into the list; the entries of the menu come in one after the other', { skip }, async () => {
    await withTwoTerminals(async (p) => {
        // a new terminal: its row comes in, the others are left as they are
        await p.evaluate(`window.__rows = []; window.dispatchEvent(new MessageEvent('message', { data: { t: 'new' } }));
            (function loop(t0) { const row = document.querySelector('#list .item[data-id="3"]'); const first = document.querySelector('#list .item[data-id="1"]');
                window.__rows.push({ t: Math.round(performance.now() - t0), entering: row ? [row.classList.contains('entering'), +getComputedStyle(row).opacity, getComputedStyle(row).transform] : null, other: first ? first.classList.contains('entering') : null });
                if (performance.now() - t0 < 900) requestAnimationFrame(() => loop(t0)); })(performance.now())`);
        await sleep(1200);
        const rows = (await p.evaluate('window.__rows')).filter((s) => s.entering);
        assert.ok(rows.length > 3, 'the new row appeared');
        assert.equal(rows[0].entering[0], true, 'it is marked as coming in');
        assert.ok(rows[0].entering[1] < 0.6, 'and starts transparent: ' + rows[0].entering[1]);
        assert.ok(matrix(rows[0].entering[2])[4] > 5, 'and to the right of its place: ' + rows[0].entering[2]);
        assert.ok(rows.every((s) => s.other === false), 'the rows that were there did not come in again');
        assert.equal(await p.evaluate("document.querySelector('#list .item[data-id=\"3\"]').classList.contains('entering')"), true);
        assert.equal(matrix(rows[rows.length - 1].entering[2])[4], 0, 'it settles in its place');

        // the menu
        await p.evaluate(`window.__entries = []; window.dispatchEvent(new MessageEvent('message', { data: { t: 'menu', items: [1, 2, 3, 4, 5, 6].map((n) => ({ id: 'e' + n, label: 'Entry ' + n })) } }));
            (function loop(t0) { window.__entries.push({ t: Math.round(performance.now() - t0), o: Array.from(document.querySelectorAll('#menu .entry')).map((e) => +getComputedStyle(e).opacity) });
                if (performance.now() - t0 < 1000) requestAnimationFrame(() => loop(t0)); })(performance.now())`);
        await sleep(1200);
        const frames = await p.evaluate('window.__entries');
        const delays = await p.evaluate("Array.from(document.querySelectorAll('#menu .entry')).map((e) => getComputedStyle(e).animationDelay)");
        assert.deepEqual(delays, ['0.07s', '0.092s', '0.114s', '0.136s', '0.158s', '0.18s'], 'every entry waits a little longer than the one before');
        assert.ok(frames.some((f) => f.o[0] > 0.6 && f.o[5] < 0.3), 'for a moment the first entries are there and the last ones are not: ' + JSON.stringify(frames.find((f) => f.t > 60)));
        assert.deepEqual(frames[frames.length - 1].o, [1, 1, 1, 1, 1, 1], 'in the end all are there');
    });
});

test('with "reduce motion" there are no animations and no transitions', { skip }, async () => {
    await withTwoTerminals(async (p) => {
        await p.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
        const row = '#list .item[data-id="1"]';
        const label = await center(p, row + ' .label');
        await move(p, label.x, label.y);
        await sleep(200);
        const split = await style(p, row + ' .split', ['animationName', 'transitionDuration']);
        assert.equal(split.animationName, 'none');
        assert.equal(split.transitionDuration, '0s');
        const lid = await style(p, row + ' .close .lid', ['transitionDuration']);
        assert.equal(lid.transitionDuration, '0s');
        await p.evaluate(`window.dispatchEvent(new MessageEvent('message', { data: { t: 'menu', items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } }))`);
        assert.equal((await style(p, '#menu', ['animationName'])).animationName, 'none');
        assert.equal((await style(p, '#menu .entry', ['animationName'])).animationName, 'none');
        // and the buttons are there at once, whole
        assert.equal((await style(p, row + ' .split', ['opacity'])).opacity, '1');
    });
});

test('the setting openconsole.motionSpeed stretches or shrinks all the motion', { skip }, async () => {
    await withTwoTerminals(async (p) => {
        const baseConfig = "fontFamily: 'Consolas, monospace', fontSize: 14, lineHeight: 1, cursorStyle: 'bar', textFont: 'Segoe UI', shellName: 'powershell', windowsBuildNumber: 22621";
        // the menu of four entries: how long it takes to open, and how long the fourth entry waits
        const measure = async (motionSpeed) => {
            await p.evaluate(`window.dispatchEvent(new MessageEvent('message', { data: { t: 'config', config: { ${baseConfig}${motionSpeed === undefined ? '' : ', motionSpeed: ' + JSON.stringify(motionSpeed)} } } }))`);
            await p.evaluate(`window.dispatchEvent(new MessageEvent('message', { data: { t: 'menu', items: ['A', 'B', 'C', 'D'].map((x) => ({ id: x, label: x })) } }))`);
            return p.evaluate(`({ open: parseFloat(getComputedStyle(document.getElementById('menu')).animationDuration), wait: parseFloat(getComputedStyle(document.querySelectorAll('#menu .entry')[3]).animationDelay) })`);
        };
        const near = (a, b) => Math.abs(a - b) < 0.002;
        let m = await measure();
        assert.ok(near(m.open, 0.26) && near(m.wait, 0.136), 'normal speed: ' + JSON.stringify(m));
        m = await measure(2);
        assert.ok(near(m.open, 0.52) && near(m.wait, 0.272), 'twice as long: ' + JSON.stringify(m));
        m = await measure(0.5);
        assert.ok(near(m.open, 0.13) && near(m.wait, 0.068), 'half as long: ' + JSON.stringify(m));
        m = await measure(0);
        assert.ok(m.open === 0 && m.wait === 0, 'none: ' + JSON.stringify(m));
        m = await measure(99);
        assert.ok(near(m.open, 1.04), 'never more than four times as long: ' + JSON.stringify(m));
        m = await measure('fast');
        assert.ok(near(m.open, 0.26), 'something that is not a number is the normal speed: ' + JSON.stringify(m));
        m = await measure(-3);
        assert.ok(near(m.open, 0.26), 'so is a negative one: ' + JSON.stringify(m));
        assert.equal(await p.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--oc-speed').trim()"), '1');
    });
});
