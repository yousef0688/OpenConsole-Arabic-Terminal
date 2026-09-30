'use strict';
// A minimal Chrome DevTools Protocol client (Node 22+ has WebSocket built in), to look at a VS Code that was started with
// --remote-debugging-port.
//   node test/e2e/cdp.js targets                       list the pages
//   node test/e2e/cdp.js screenshot <out.png> [match]  screenshot of the first page whose title/url contains <match>
//   node test/e2e/cdp.js eval <match> "<expression>"   evaluate JavaScript in that page and print the result as JSON
const fs = require('node:fs');

const PORT = process.env.CDP_PORT || '9333';

async function targets() {
    const res = await fetch(`http://127.0.0.1:${PORT}/json`);
    return res.json();
}

function connect(url) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        let id = 0;
        const pending = new Map();
        ws.onmessage = (e) => {
            const m = JSON.parse(e.data);
            if (m.id && pending.has(m.id)) { const { resolve: ok, reject: bad } = pending.get(m.id); pending.delete(m.id); m.error ? bad(new Error(JSON.stringify(m.error))) : ok(m.result); }
        };
        ws.onerror = (e) => reject(new Error('websocket error'));
        ws.onopen = () => resolve({
            send: (method, params = {}) => new Promise((ok, bad) => { const i = ++id; pending.set(i, { resolve: ok, reject: bad }); ws.send(JSON.stringify({ id: i, method, params })); }),
            close: () => ws.close(),
        });
    });
}

async function pick(match) {
    const list = await targets();
    if (match && match.startsWith('@')) {
        // "@0", "@1": the first, second ... webview frame
        const frames = list.filter((t) => t.type === 'iframe' && t.webSocketDebuggerUrl);
        if (!frames[+match.slice(1)]) throw new Error('no webview frame ' + match);
        return frames[+match.slice(1)];
    }
    const found = list.filter((t) => t.webSocketDebuggerUrl && (!match || (t.title + ' ' + t.url).includes(match)));
    if (!found.length) throw new Error('no target matches ' + JSON.stringify(match) + '; have: ' + list.map((t) => `${t.type}:${t.title}`).join(' | '));
    return found[0];
}

async function main() {
    const [cmd, a, b] = process.argv.slice(2);
    if (cmd === 'targets') {
        for (const t of await targets()) console.log(`${t.type}\t${t.title}\t${t.url.slice(0, 110)}`);
    } else if (cmd === 'screenshot') {
        const t = await pick(b);
        const c = await connect(t.webSocketDebuggerUrl);
        const r = await c.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(a, Buffer.from(r.data, 'base64'));
        console.log('saved', a, 'from', t.title);
        c.close();
    } else if (cmd === 'eval') {
        const t = await pick(a);
        const c = await connect(t.webSocketDebuggerUrl);
        const r = await c.send('Runtime.evaluate', { expression: b, returnByValue: true, awaitPromise: true });
        console.log(JSON.stringify(r.result.value === undefined ? r : r.result.value, null, 1));
        c.close();
    } else if (cmd === 'evalfile') {
        // evalfile <match> <file.js>   like eval, with the expression read from a file (no quoting problems)
        const t = await pick(a);
        const c = await connect(t.webSocketDebuggerUrl);
        const r = await c.send('Runtime.evaluate', { expression: fs.readFileSync(b, 'utf8'), returnByValue: true, awaitPromise: true });
        console.log(JSON.stringify(r.result.value === undefined ? r : r.result.value, null, 1));
        c.close();
    } else if (cmd === 'type') {
        // type <match> <text>   types text like the keyboard does (real key events, so it works with any keyboard layout)
        const t = await pick(a);
        const c = await connect(t.webSocketDebuggerUrl);
        for (const ch of Array.from(b)) {
            await c.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch });
            await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
        }
        console.log('typed', Array.from(b).length, 'characters');
        c.close();
    } else if (cmd === 'key') {
        // key <match> <combo>   e.g. ctrl+r, ctrl+shift+p, alt+f, a
        const t = await pick(a);
        const c = await connect(t.webSocketDebuggerUrl);
        const parts = b.toLowerCase().split('+');
        const name = parts.pop();
        const mods = (parts.includes('alt') ? 1 : 0) | (parts.includes('ctrl') ? 2 : 0) | (parts.includes('meta') ? 4 : 0) | (parts.includes('shift') ? 8 : 0);
        const special = { enter: ['Enter', 'Enter', 13], escape: ['Escape', 'Escape', 27], tab: ['Tab', 'Tab', 9], up: ['ArrowUp', 'ArrowUp', 38], down: ['ArrowDown', 'ArrowDown', 40], left: ['ArrowLeft', 'ArrowLeft', 37], right: ['ArrowRight', 'ArrowRight', 39], backspace: ['Backspace', 'Backspace', 8], delete: ['Delete', 'Delete', 46] };
        let key, code, vk;
        if (special[name]) [key, code, vk] = special[name];
        else if (/^[a-z]$/.test(name)) { key = name; code = 'Key' + name.toUpperCase(); vk = name.toUpperCase().charCodeAt(0); }
        else { key = name; code = name; vk = name.toUpperCase().charCodeAt(0); }
        await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods });
        await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods });
        console.log('sent', b);
        c.close();
    } else {
        console.log('usage: see the top of this file');
    }
    process.exit(0);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
