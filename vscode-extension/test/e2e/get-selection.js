(() => {
    const frame = document.querySelector('iframe#active-frame') || document.querySelector('iframe');
    const win = frame.contentWindow;
    const doc = frame.contentDocument;
    const oc = win.__openconsole;
    if (!oc) return 'no __openconsole in the page';
    const ta = doc.querySelector('.xterm-helper-textarea');
    return {
        hasSelection: oc.term.hasSelection(),
        selection: oc.term.getSelection(),
        textareaValue: ta && ta.value,
        textareaSelected: ta && ta.value.substring(ta.selectionStart, ta.selectionEnd),
        domSelection: String(win.getSelection()),
        activeElement: doc.activeElement && (doc.activeElement.className || doc.activeElement.tagName),
        focused: doc.hasFocus(),
    };
})()
