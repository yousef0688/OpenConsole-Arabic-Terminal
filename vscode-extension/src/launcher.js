'use strict';
// Starts a list of things (terminals that run a script, the terminals of a saved group) with at most "cap" of them running at a time:
// the next one starts when a running one reports that it is done. cap 0 (or less, or not a number) means all at once.
// It knows nothing about terminals: start(item, done) does the work and calls done() when that item has finished (a second call is ignored).

class RunQueue {
    /**
     * @param {any[]} items
     * @param {{ cap: number, start: (item: any, done: () => void) => void, onChange?: (queue: RunQueue) => void }} options
     */
    constructor(items, options) {
        this.pending = Array.from(items);
        this.start = options.start;
        this.onChange = options.onChange || (() => { });
        const cap = Number(options.cap);
        this.cap = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : Infinity;
        this.running = 0;
        this.finished = 0;
        this.total = this.pending.length;
        this.cancelled = false;
    }

    /** Starts as many as the cap allows. */
    run() {
        while (!this.cancelled && this.running < this.cap && this.pending.length) this.begin(this.pending.shift());
        this.onChange(this);
        return this;
    }

    begin(item) {
        this.running++;
        let ended = false;
        const done = () => {
            if (ended) return;
            ended = true;
            this.running--;
            this.finished++;
            this.run();
        };
        try { this.start(item, done); }
        catch { done(); }                         // an item that cannot start does not hold the others back
    }

    /** What has not started yet is dropped; what runs goes on. */
    cancel() {
        this.cancelled = true;
        const dropped = this.pending.length;
        this.pending = [];
        this.onChange(this);
        return dropped;
    }

    get waiting() { return this.pending.length; }
}

module.exports = { RunQueue };
