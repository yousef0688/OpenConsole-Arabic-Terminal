(async () => {
    // The page of the extension lives in an iframe inside the webview frame that DevTools shows.
    const frame = document.querySelector('iframe#active-frame') || document.querySelector('iframe');
    const win = frame.contentWindow;
    const doc = frame.contentDocument;
    // A screenshot on the clipboard: a paste event that carries a PNG file and no text (a 1x1 pixel image).
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const bytes = Uint8Array.from(win.atob(b64), (c) => c.charCodeAt(0));
    const file = new win.File([bytes], 'shot.png', { type: 'image/png' });
    const dt = new win.DataTransfer();
    dt.items.add(file);
    const ev = new win.ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    doc.querySelector('#terminal .xterm-helper-textarea').dispatchEvent(ev);
    return { defaultPrevented: ev.defaultPrevented, files: dt.files.length };
})()
