/*
 * What the bottom of the screen says about a program that runs in the terminal: it works (a line "esc to interrupt") or it asks
 * something and waits for an answer (a permission question, [y/n]). The rules are data, so that they can be corrected without code:
 * the setting openconsole.agentRules adds rules in front of these (the same shape), and "OpenConsole: Explain Terminal State" shows which
 * rule matched. The screens of the agents change with their versions: these are starting points, taken from what the tools show.
 *
 * A rule: { id, kind (an agent, or "any" for every program), state: "working" | "blocked", priority, region: the last N non-empty rows,
 *           all: [regular expressions that must all match], any: [regular expressions of which one must match] }
 * The rows are looked at in lower case, joined by a line break; a rule matches if all "all" and (when there are "any") one "any" matches.
 *
 * Works in the browser (global OCAgentRules) and in Node (module.exports), for the tests.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.OCAgentRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const RULES = [
        // ---- Claude Code
        { id: 'claude-permission', kind: 'claude', state: 'blocked', priority: 900, region: 30, all: ['do you want|would you like', '(^|\\n)\\s*[\\u276f>]?\\s*1\\.\\s*yes'] },
        { id: 'claude-esc-cancel', kind: 'claude', state: 'blocked', priority: 880, region: 30, all: ['esc to cancel', '(^|\\n)\\s*[\\u276f>]?\\s*\\d\\.\\s'] },
        { id: 'claude-interrupt', kind: 'claude', state: 'working', priority: 800, region: 12, any: ['esc to interrupt', 'ctrl\\+c to interrupt'] },
        { id: 'claude-spinner', kind: 'claude', state: 'working', priority: 700, region: 12, any: ['(^|\\n)\\s*[\\u2733\\u273b\\u273d\\u2736\\u2722\\u00b7*]\\s+\\S+ing[^\\n]*\\u2026'] },
        // ---- Codex CLI
        { id: 'codex-approve', kind: 'codex', state: 'blocked', priority: 900, region: 30, any: ['press enter to confirm or esc to cancel', 'allow command\\?', '\\[y/n\\]', 'enter to submit'] },
        { id: 'codex-interrupt', kind: 'codex', state: 'working', priority: 800, region: 12, any: ['esc[^\\n]*interrupt'] },
        // ---- opencode
        { id: 'opencode-permission', kind: 'opencode', state: 'blocked', priority: 900, region: 30, any: ['\\u25b3 permission required'] },
        { id: 'opencode-interrupt', kind: 'opencode', state: 'working', priority: 800, region: 12, any: ['esc[^\\n]*interrupt'] },
        // ---- Gemini CLI
        { id: 'gemini-confirm', kind: 'gemini', state: 'blocked', priority: 900, region: 30, any: ['\\u2502 apply this change', '\\u2502 allow execution', '\\u2502 do you want to proceed'] },
        { id: 'gemini-cancel', kind: 'gemini', state: 'working', priority: 800, region: 12, any: ['esc to cancel'] },
        // ---- Aider
        { id: 'aider-ask', kind: 'aider', state: 'blocked', priority: 900, region: 6, any: ['\\(y\\)es/\\(n\\)o', '\\(d\\)on\'t ask again'] },
        // ---- any program that asks on its last line (a question that ends with the choices)
        { id: 'prompt-yes-no', kind: 'any', state: 'blocked', priority: 500, region: 2, any: ['\\[y/n\\]\\s*[:?]?\\s*$', '\\(y/n\\)\\s*[:?]?\\s*$', '\\(yes/no\\)\\s*[:?]?\\s*$', 'press any key to continue', '(proceed|continue)\\s*\\?\\s*$'] },
    ];

    const compiled = new Map();
    function regex(source) {
        let re = compiled.get(source);
        if (!re) { re = new RegExp(source, 'i'); compiled.set(source, re); }
        return re;
    }

    /** The last `count` rows that have something in them, as one lower-case text. */
    function region(rows, count) {
        const out = [];
        for (let i = rows.length - 1; i >= 0 && out.length < count; i--) {
            const text = String(rows[i] || '').replace(/\s+$/, '');
            if (text) out.unshift(text);
        }
        return out.join('\n').toLowerCase();
    }

    /**
     * The state that the screen shows, or null.
     * @param {string|null} kind   the agent that runs ("claude", ...) or "shell"/null for another program
     * @param {string[]} rows      the rows of the screen, top to bottom (plain text)
     * @param {object[]} [extra]   rules of the user, tried before the others
     * @returns {{ state: string, id: string } | null}
     */
    function classify(kind, rows, extra) {
        // the rules of the user come first (priority 1000 unless they say another), and apply to every program when they name no kind
        const own = (Array.isArray(extra) ? extra : []).filter((r) => r && r.state && (!r.kind || r.kind === 'any' || r.kind === kind)).map((r) => Object.assign({ priority: 1000 }, r));
        const all = [...own, ...RULES.filter((r) => r.kind === 'any' || r.kind === kind)].sort((a, b) => (b.priority || 0) - (a.priority || 0));
        const cache = new Map();
        for (const rule of all) {
            const text = cache.get(rule.region) || (cache.set(rule.region, region(rows, rule.region || 12)), cache.get(rule.region));
            try {
                if ((rule.all || []).some((s) => !regex(s).test(text))) continue;
                if (rule.any && rule.any.length && !rule.any.some((s) => regex(s).test(text))) continue;
                if (!(rule.all && rule.all.length) && !(rule.any && rule.any.length)) continue;
                return { state: rule.state, id: rule.id || 'rule' };
            }
            catch { /* a rule of the user that is not a regular expression is left out */ }
        }
        return null;
    }

    return { RULES, classify, region };
});
