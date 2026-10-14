'use strict';
// The queue that starts scripts and the terminals of a group with at most "cap" running at a time (src/launcher.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { RunQueue } = require('../src/launcher');

function harness(items, cap) {
    const started = [];
    const dones = new Map();
    const queue = new RunQueue(items, { cap, start: (item, done) => { started.push(item); dones.set(item, done); } });
    return { queue, started, finish: (item) => dones.get(item)() };
}

test('at most "cap" run at once, the next starts when one is done, in the order given', () => {
    const { queue, started, finish } = harness(['a', 'b', 'c', 'd', 'e'], 2);
    queue.run();
    assert.deepEqual(started, ['a', 'b']);
    assert.equal(queue.running, 2);
    assert.equal(queue.waiting, 3);
    finish('b');
    assert.deepEqual(started, ['a', 'b', 'c']);
    finish('a'); finish('c');
    assert.deepEqual(started, ['a', 'b', 'c', 'd', 'e']);
    finish('d'); finish('e');
    assert.equal(queue.running, 0);
    assert.equal(queue.finished, 5);
    assert.equal(queue.waiting, 0);
});

test('a cap of 0, a negative or a strange one means all at once', () => {
    for (const cap of [0, -3, NaN, undefined, 'many']) {
        const { queue, started } = harness([1, 2, 3, 4, 5, 6], cap);
        queue.run();
        assert.equal(started.length, 6, 'cap ' + String(cap));
    }
    const { queue, started } = harness([1, 2, 3], 1.9);
    queue.run();
    assert.equal(started.length, 1, 'a cap that is not whole is rounded down');
});

test('done twice counts once, so the cap is never exceeded', () => {
    const { queue, started, finish } = harness(['a', 'b', 'c'], 1);
    queue.run();
    finish('a'); finish('a'); finish('a');
    assert.deepEqual(started, ['a', 'b'], 'only the next one started, not two');
    assert.equal(queue.running, 1);
    assert.equal(queue.finished, 1);
});

test('an item that cannot start does not hold the others back', () => {
    const started = [];
    const queue = new RunQueue(['a', 'bad', 'c'], { cap: 1, start: (item, done) => { if (item === 'bad') throw new Error('no'); started.push(item); if (item === 'a') setImmediate(done); } });
    queue.run();
    return new Promise((resolve) => setImmediate(() => setImmediate(() => {
        assert.deepEqual(started, ['a', 'c']);
        assert.equal(queue.finished, 2, 'a and the bad one');
        resolve();
    })));
});

test('cancel drops what has not started and lets what runs go on', () => {
    const { queue, started, finish } = harness(['a', 'b', 'c', 'd'], 2);
    queue.run();
    assert.equal(queue.cancel(), 2);
    finish('a');
    assert.deepEqual(started, ['a', 'b'], 'nothing new starts after a cancel');
    assert.equal(queue.running, 1);
});

test('the change is announced, and an empty list is fine', () => {
    const seen = [];
    const queue = new RunQueue([], { cap: 3, start: () => { }, onChange: (q) => seen.push(q.running) });
    queue.run();
    assert.deepEqual(seen, [0]);
    assert.equal(queue.total, 0);
});
