'use strict';
// The page that is shown in the terminal view: xterm.js, the right-to-left layout and media/main.js.

function makeNonce() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
    return out;
}

/**
 * @param {import('vscode').Webview} webview
 * @param {import('vscode').Uri} extensionUri
 * @param {(base: import('vscode').Uri, ...parts: string[]) => import('vscode').Uri} joinPath
 */
function getHtml(webview, extensionUri, joinPath) {
    const nonce = makeNonce();
    const media = (...parts) => webview.asWebviewUri(joinPath(extensionUri, 'media', ...parts));
    const csp = [
        "default-src 'none'",
        `img-src ${webview.cspSource} data:`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `font-src ${webview.cspSource}`,
        `script-src 'nonce-${nonce}'`,
    ].join('; ');
    const script = (file) => `<script nonce="${nonce}" src="${media(...file)}"></script>`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('vendor', 'xterm.css')}">
<link rel="stylesheet" href="${media('main.css')}">
<title>OpenConsole</title>
</head>
<body>
<div id="app">
<div id="terminals"></div>
<div id="list" hidden></div>
</div>
<div id="message" hidden></div>
${script(['vendor', 'xterm.js'])}
${script(['vendor', 'addon-fit.js'])}
${script(['vendor', 'addon-unicode11.js'])}
${script(['vendor', 'addon-web-links.js'])}
${script(['vendor', 'addon-search.js'])}
${script(['vendor', 'bidi.js'])}
${script(['vendor', 'material-icons.js'])}
${script(['custom-icons.js'])}
${script(['program-icons.js'])}
${script(['arabic-layout.js'])}
${script(['row-patcher.js'])}
${script(['image-chips.js'])}
${script(['suggest.js'])}
${script(['links.js'])}
${script(['filelinks.js'])}
${script(['find.js'])}
${script(['agent-state.js'])}
${script(['agent-rules.js'])}
${script(['agent-view.js'])}
${script(['main.js'])}
</body>
</html>`;
}

module.exports = { getHtml };
