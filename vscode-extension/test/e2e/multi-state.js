(() => {
    // For test\e2e\cdp.js evalfile @0: the state of all terminals of the OpenConsole view.
    const frame = document.querySelector('iframe#active-frame') || document.querySelector('iframe');
    const win = frame.contentWindow;
    const doc = frame.contentDocument;
    const oc = win.__openconsole;
    if (!oc) return 'no __openconsole in the page';
    const text = (term) => {
        const buf = term.buffer.active;
        const lines = [];
        for (let i = Math.max(0, buf.length - 12); i < buf.length; i++) {
            const line = buf.getLine(i);
            if (line) lines.push(line.translateToString(true));
        }
        return lines.filter((l) => l.trim()).slice(-6);
    };
    const list = doc.getElementById('list');
    return {
        listHidden: list.hidden,
        listWidth: list.offsetWidth,
        items: Array.from(list.querySelectorAll('.item')).map((i) => ({ id: i.dataset.id, label: i.textContent.trim(), active: i.classList.contains('active') })),
        shownId: (Array.from(oc.terminals.values()).find((t) => t.el.classList.contains('active')) || {}).id,
        terminals: Array.from(oc.terminals.values()).map((t) => ({
            id: t.id, title: t.title, cols: t.term.cols, rows: t.term.rows, mode: t.mode, exited: t.exited,
            visible: getComputedStyle(t.el).visibility, paneWidth: t.el.clientWidth, lastLines: text(t.term),
        })),
    };
})()
