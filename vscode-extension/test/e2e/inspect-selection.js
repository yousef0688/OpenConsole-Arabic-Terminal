(() => {
    const frames = Array.from(document.querySelectorAll('iframe'));
    const out = [];
    for (const frame of frames) {
        const doc = frame.contentDocument;
        if (!doc) continue;
        const sel = Array.from(doc.querySelectorAll('.xterm-selection div'));
        const rows = doc.querySelector('.xterm-rows');
        out.push({
            frame: frame.id || frame.src.slice(-40),
            selectionDivs: sel.map((d) => ({ bg: getComputedStyle(d).backgroundColor, z: getComputedStyle(d.parentElement).zIndex, rect: d.getBoundingClientRect().toJSON() })),
            selectionParent: doc.querySelector('.xterm-selection') && getComputedStyle(doc.querySelector('.xterm-selection')).zIndex,
            rowsZ: rows && getComputedStyle(rows).zIndex,
            rowsPos: rows && getComputedStyle(rows).position,
            boxZ: doc.querySelector('.oc-box') && getComputedStyle(doc.querySelector('.oc-box')).zIndex,
            hasBoxes: doc.querySelectorAll('.oc-box').length,
            selectedText: (doc.defaultView.__openconsole && doc.defaultView.__openconsole.term.getSelection()) || null,
        });
    }
    return out;
})()
