'use strict';
// Only for the end-to-end tests. It executes VS Code commands that a test asks for:
//   OPENCONSOLE_E2E_STEPS     a JSON file with steps that are played once when VS Code has started:
//                             [{ "delay": 1000, "command": "openconsole.sendText", "args": ["text"] }, ...]
//   OPENCONSOLE_E2E_COMMANDS  a file that the test appends lines to (one JSON object per line, same shape without "delay").
//                             Every new line is executed. The results are written to <file>.log.
const vscode = require('vscode');
const fs = require('node:fs');

function log(file, text) {
    try { fs.appendFileSync(file + '.log', text + '\n'); } catch { /* the test is over */ }
}

async function run(logFile, step) {
    try {
        const result = await vscode.commands.executeCommand(step.command, ...(step.args || []));
        if (step.log) log(logFile, `${step.command} -> ${JSON.stringify(result)}`);
    } catch (e) {
        log(logFile, `step failed: ${step.command}: ${e && e.message}`);
    }
}

async function activate() {
    const stepsFile = process.env.OPENCONSOLE_E2E_STEPS;
    if (stepsFile && fs.existsSync(stepsFile)) {
        for (const step of JSON.parse(fs.readFileSync(stepsFile, 'utf8'))) {
            await new Promise((r) => setTimeout(r, step.delay || 0));
            await run(stepsFile, step);
        }
        log(stepsFile, 'all steps done');
    }

    const commandsFile = process.env.OPENCONSOLE_E2E_COMMANDS;
    if (commandsFile) {
        let offset = fs.existsSync(commandsFile) ? fs.statSync(commandsFile).size : 0;
        let busy = false;
        setInterval(async () => {
            if (busy || !fs.existsSync(commandsFile)) return;
            const size = fs.statSync(commandsFile).size;
            if (size <= offset) return;
            busy = true;
            const fd = fs.openSync(commandsFile, 'r');
            const buffer = Buffer.alloc(size - offset);
            fs.readSync(fd, buffer, 0, buffer.length, offset);
            fs.closeSync(fd);
            offset = size;
            for (const line of buffer.toString('utf8').split('\n')) {
                if (!line.trim()) continue;
                try { await run(commandsFile, JSON.parse(line)); } catch (e) { log(commandsFile, 'bad line: ' + line); }
            }
            busy = false;
        }, 300);
    }
}

exports.activate = activate;
