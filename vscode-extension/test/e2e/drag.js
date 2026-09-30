'use strict';
// node test/e2e/drag.js <match> x1 y1 x2 y2   drags the mouse over the page (to select text in the terminal)
const PORT = process.env.CDP_PORT || '9333';
const [match, x1, y1, x2, y2] = process.argv.slice(2);

(async () => {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    const target = list.find((t) => t.webSocketDebuggerUrl && (t.title + t.url).includes(match));
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
    await new Promise((r) => (ws.onopen = r));
    const send = (method, params) => new Promise((resolve) => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
    const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', Object.assign({ type, x: +x, y: +y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 }, extra));
    await mouse('mouseMoved', x1, y1, { button: 'none', buttons: 0 });
    await mouse('mousePressed', x1, y1);
    const steps = 12;
    for (let i = 1; i <= steps; i++) await mouse('mouseMoved', +x1 + (x2 - x1) * i / steps, +y1 + (y2 - y1) * i / steps);
    await mouse('mouseReleased', x2, y2);
    console.log('dragged');
    ws.close();
    process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
