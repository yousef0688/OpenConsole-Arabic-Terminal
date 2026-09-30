'use strict';
// Asks the running test instance to execute a VS Code command (see driver/extension.js).
//   node test/e2e/send.js openconsole.sendText "text with \r for Enter"
//   node test/e2e/send.js workbench.action.toggleMaximizedPanel
// The arguments after the command name are passed as strings; "\r" and "\n" in them become real characters.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const file = path.join(os.tmpdir(), 'oc-e2e', 'commands.jsonl');
const [command, ...args] = process.argv.slice(2);
if (!command) { console.error('usage: node send.js <command> [args...]'); process.exit(2); }
fs.mkdirSync(path.dirname(file), { recursive: true });
const unescape = (s) => s
    .replace(/\\u([0-9a-fA-F]{4})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\r/g, '\r').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
fs.appendFileSync(file, JSON.stringify({ command, args: args.map(unescape) }) + '\n');
console.log('queued', command);
