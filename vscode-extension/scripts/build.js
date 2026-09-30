'use strict';
// Copies the browser files of xterm.js, its add-ons and bidi-js into media/vendor (the extension ships these, not node_modules),
// together with their licenses.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'media', 'vendor');
fs.mkdirSync(out, { recursive: true });

const files = [
    ['node_modules/@xterm/xterm/lib/xterm.js', 'xterm.js'],
    ['node_modules/@xterm/xterm/css/xterm.css', 'xterm.css'],
    ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
    ['node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js', 'addon-unicode11.js'],
    ['node_modules/bidi-js/dist/bidi.js', 'bidi.js'],
];
for (const [from, to] of files) {
    const source = path.join(root, from);
    if (!fs.existsSync(source)) throw new Error(`${from} is missing: run "npm install" first`);
    fs.copyFileSync(source, path.join(out, to));
}

const versions = {};
let notice = 'Third-party software shipped in media/vendor\n===============================================\n\n';
for (const [pkg, licenseFile] of [
    ['@xterm/xterm', 'LICENSE'], ['@xterm/addon-fit', 'LICENSE'], ['@xterm/addon-unicode11', 'LICENSE'], ['bidi-js', 'LICENSE.txt'],
]) {
    const meta = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', pkg, 'package.json'), 'utf8'));
    versions[pkg] = meta.version;
    const licensePath = path.join(root, 'node_modules', pkg, licenseFile);
    const license = fs.existsSync(licensePath) ? fs.readFileSync(licensePath, 'utf8').trim() : `(${meta.license})`;
    notice += `${pkg} ${meta.version} (${meta.license})\n${'-'.repeat(40)}\n${license}\n\n`;
}
fs.writeFileSync(path.join(out, 'LICENSES.txt'), notice);
console.log('media/vendor updated:', JSON.stringify(versions));
