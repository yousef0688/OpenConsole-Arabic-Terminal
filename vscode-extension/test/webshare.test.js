'use strict';
// The part that joins the terminals to the web server (src/webshare.js): the ring that a late browser is played back from, the files
// that the server may send, the address of a tunnel, and which terminals are shared. The server itself is tested in web-server.test.js,
// and the whole thing with a real browser in rig.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { WebShare, Ring, parsePublicUrl } = require('../src/webshare');

test('the ring keeps the end of what a terminal wrote', () => {
    const ring = new Ring(100);
    ring.push('hello\r\nworld\r\n');
    assert.equal(ring.snapshot().endsWith('hello\r\nworld\r\n'), true, 'a small amount is played back whole');
    for (let i = 0; i < 50; i++) ring.push('line ' + i + '\r\n');
    const snapshot = ring.snapshot();
    assert.ok(snapshot.length < 140, 'at most about the size of the ring: ' + snapshot.length);
    assert.ok(snapshot.endsWith('line 49\r\n'));
    assert.ok(/^\u001b\[0m\u001b\[\?25h(line \d+\r\n)/.test(snapshot), 'it starts at a whole line, not in the middle of one: ' + JSON.stringify(snapshot.slice(0, 30)));
});

test('a replay starts at the last time the screen was cleared', () => {
    const ring = new Ring(10000);
    ring.push('old stuff\r\n\u001b[2Jfresh screen\r\nprompt> ');
    const snapshot = ring.snapshot();
    assert.ok(!snapshot.includes('old stuff'), 'what was before the clear is not sent');
    assert.ok(snapshot.includes('fresh screen'));
    ring.push('\u001b[?1049hfull screen program');
    assert.ok(ring.snapshot().includes('\u001b[?1049hfull screen program'));
    assert.ok(!ring.snapshot().includes('fresh screen'), 'the alternate screen coming up is a start as well');
    ring.clear();
    assert.equal(ring.snapshot(), '\u001b[0m\u001b[?25h');
});

test('a ring that was cut in the middle of an escape sequence does not start inside it', () => {
    const ring = new Ring(30);
    ring.push('x'.repeat(100) + '\r\n\u001b[31mred text\u001b[0m\r\nlast\r\n');
    const text = ring.snapshot().replace('\u001b[0m\u001b[?25h', '');
    assert.ok(!/^[0-9;]*m/.test(text), 'no half of a sequence at the start: ' + JSON.stringify(text));
});

test('the address of a tunnel: only http and https with a host', () => {
    assert.deepEqual(parsePublicUrl('https://abc.trycloudflare.com/some/path'), { origin: 'https://abc.trycloudflare.com', host: 'abc.trycloudflare.com' });
    assert.deepEqual(parsePublicUrl(' http://my-pc.tailnet.ts.net:8443 '), { origin: 'http://my-pc.tailnet.ts.net:8443', host: 'my-pc.tailnet.ts.net:8443' });
    for (const bad of ['', '   ', 'ftp://x.example', 'javascript:alert(1)', 'not a url', 'https://', undefined, null, 42]) assert.equal(parsePublicUrl(bad), null, String(bad));
});

function fakeTerminals() {
    const terminals = [1, 2, 3].map((n) => ({ webId: n, name: 'term' + n, cols: 80 + n, rows: 24, ring: new Ring(1000), written: [], write(data) { this.written.push(data); return true; } }));
    terminals[0].ring.push('one\r\n');
    return terminals;
}

test('only the shared terminals are listed, played back and written to', () => {
    const terminals = fakeTerminals();
    const share = new WebShare({ mediaDir: path.join('C:', 'media'), terminals: () => terminals });
    assert.deepEqual(share.bridge.list(), [], 'nothing is shared until the owner says so');
    share.setShared([1, 3]);
    assert.deepEqual(share.bridge.list(), [{ id: 1, name: 'term1', cols: 81, rows: 24 }, { id: 3, name: 'term3', cols: 83, rows: 24 }]);
    assert.ok(share.bridge.snapshot(1).data.endsWith('one\r\n'));
    assert.equal(share.bridge.snapshot(1).cols, 81);
    assert.equal(share.bridge.snapshot(2), null, 'a terminal that is not shared has no replay');
    assert.equal(share.bridge.write(2, 'rm -rf\r'), false);
    assert.deepEqual(terminals[1].written, [], 'and nothing reaches it');
    assert.equal(share.bridge.write(3, 'ls\r'), true);
    assert.deepEqual(terminals[2].written, ['ls\r']);
    assert.equal(share.bridge.write(99, 'x'), false);
    terminals.pop();                                                            // the terminal was closed
    assert.deepEqual(share.bridge.list().map((t) => t.id), [1]);
    share.forget(1);
    assert.deepEqual(share.bridge.list(), []);
});

test('the files of the page: the page itself, the files of the extension, the vendor files', () => {
    const share = new WebShare({ mediaDir: path.join('C:', 'ext', 'media'), terminals: () => [] });
    assert.equal(share.assets('/'), path.join('C:', 'ext', 'media', 'remote.html'));
    assert.equal(share.assets('/app/remote.js'), path.join('C:', 'ext', 'media', 'remote.js'));
    assert.equal(share.assets('/vendor/xterm.js'), path.join('C:', 'ext', 'media', 'vendor', 'xterm.js'));
    for (const bad of ['/app/../x', '/app/a/b', '/other/x', '/app/', '', '/app/%2e%2e', '/vendor/..\\x']) assert.equal(share.assets(bad), null, bad);
});

test('nothing runs, nothing is sent and no link is made before it is started', async () => {
    const share = new WebShare({ mediaDir: 'x', terminals: () => [] });
    assert.equal(share.active, false);
    assert.throws(() => share.pairingLink(), /not sharing/);
    share.output(1, 'x'); share.resize(1, 80, 24); share.title(1, 'a'); share.exit(1, 0); share.state(1, 'idle', false);   // no server: no effect, no crash
    await share.stop();
});

test('started: only on this computer, with a link whose secret is after the "#", the address of the tunnel in it when there is one', async () => {
    const terminals = fakeTerminals();
    const share = new WebShare({ mediaDir: path.join(__dirname, '..', 'media'), terminals: () => terminals });
    try {
        const started = await share.start({ publicUrl: 'https://abc.trycloudflare.com', maxClients: 2 });
        assert.ok(started.port > 0);
        assert.equal(started.base, 'https://abc.trycloudflare.com');
        assert.equal(share.server.bindAddress, '127.0.0.1', 'it listens on this computer only');
        assert.ok(share.server.allowedHosts().includes('abc.trycloudflare.com'));
        const link = share.pairingLink();
        assert.match(link.url, /^https:\/\/abc\.trycloudflare\.com\/#p=[A-Za-z0-9_-]{40,}$/);
        assert.match(link.local, new RegExp('^http://127\\.0\\.0\\.1:' + started.port + '/#p='));
        assert.notEqual(share.pairingLink().url, link.url, 'every link is new');
        share.setShared([1]);
        assert.equal(share.isShared(1), true);
        assert.equal(share.isShared(2), false);
        await share.start({});                                                      // a second start changes nothing
        assert.equal(share.server.port, started.port);
    }
    finally { await share.stop(); }
    assert.equal(share.active, false);
    assert.equal(share.shared.size, 0, 'stopping forgets what was shared: the next time the owner chooses again');
});
