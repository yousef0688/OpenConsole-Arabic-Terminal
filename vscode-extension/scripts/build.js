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
    ['node_modules/@xterm/addon-web-links/lib/addon-web-links.js', 'addon-web-links.js'],
    ['node_modules/@xterm/addon-search/lib/addon-search.js', 'addon-search.js'],
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
    ['@xterm/xterm', 'LICENSE'], ['@xterm/addon-fit', 'LICENSE'], ['@xterm/addon-unicode11', 'LICENSE'], ['@xterm/addon-web-links', 'LICENSE'], ['@xterm/addon-search', 'LICENSE'], ['bidi-js', 'LICENSE.txt'], ['material-icon-theme', 'LICENSE'],
]) {
    const meta = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', pkg, 'package.json'), 'utf8'));
    versions[pkg] = meta.version;
    const licensePath = path.join(root, 'node_modules', pkg, licenseFile);
    const license = fs.existsSync(licensePath) ? fs.readFileSync(licensePath, 'utf8').trim() : `(${meta.license})`;
    notice += `${pkg} ${meta.version} (${meta.license})\n${'-'.repeat(40)}\n${license}\n\n`;
}
fs.writeFileSync(path.join(out, 'LICENSES.txt'), notice);

// The icons of Material Icon Theme that the list of terminals uses (media/program-icons.js lists the names): one file with the pictures
// as text, so that the page needs no other request.
const iconNames = require(path.join(root, 'media', 'program-icons.js')).NAMES;
const icons = {};
for (const name of iconNames) {
    const file = path.join(root, 'node_modules', 'material-icon-theme', 'icons', name + '.svg');
    if (!fs.existsSync(file)) throw new Error(`the icon ${name} is missing in material-icon-theme`);
    icons[name] = fs.readFileSync(file, 'utf8').replace(/\s+xmlns="[^"]*"/, '').replace(/\s+xml:space="[^"]*"/, '').replace(/\s*\n\s*/g, '').trim();
}
fs.writeFileSync(path.join(out, 'material-icons.js'), '// Icons of Material Icon Theme (MIT, Material Extensions), see LICENSES.txt' + String.fromCharCode(10) + 'window.OCMaterialIcons = ' + JSON.stringify(icons) + ';' + String.fromCharCode(10));
console.log('media/vendor updated:', JSON.stringify(versions));
