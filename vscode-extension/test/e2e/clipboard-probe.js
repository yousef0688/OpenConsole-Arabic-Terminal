(async () => {
    const frame = document.querySelector('iframe#active-frame') || document.querySelector('iframe');
    const win = frame.contentWindow;
    const result = {};
    try {
        await win.navigator.clipboard.writeText('OC-WRITE-PROBE');
        result.write = 'ok';
    } catch (e) {
        result.write = 'failed: ' + e.name + ': ' + e.message;
    }
    try {
        result.copyCommand = win.document.execCommand('copy');
    } catch (e) {
        result.copyCommand = 'failed: ' + e.message;
    }
    result.allow = frame.getAttribute('allow');
    result.permissionsPolicy = frame.contentDocument.featurePolicy ? { clipboardWrite: frame.contentDocument.featurePolicy.allowsFeature('clipboard-write') } : 'n/a';
    return result;
})()
