(() => {
    const frame = document.querySelector('iframe#active-frame') || document.querySelector('iframe');
    const doc = frame.contentDocument;
    const style = doc.createElement('style');
    style.id = 'oc-test-css';
    style.textContent = '.oc-box { z-index: 2; }';
    doc.head.appendChild(style);
    return 'injected';
})()
