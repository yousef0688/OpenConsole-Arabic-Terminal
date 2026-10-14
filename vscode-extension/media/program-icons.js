/*
 * Which icon a terminal gets in the list: the agent that runs in it (Claude Code, Gemini, opencode...), else the program that runs under
 * the shell (node, python, git, docker...), else the kind of shell (PowerShell, Command Prompt, Git Bash...), else none (the plain
 * terminal icon). The pictures are the icons of Material Icon Theme (MIT, by Material Extensions), copied into media/vendor/material-icons.js
 * by scripts/build.js; this file only chooses a name.
 *
 * Works in the browser (global OCProgramIcons) and in Node (module.exports), for the tests.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.OCProgramIcons = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // the names of the icons of the theme that are used (scripts/build.js copies exactly these)
    const NAMES = [
        'powershell', 'console', 'git', 'nodejs', 'python', 'docker', 'npm', 'yarn', 'pnpm', 'bun', 'deno', 'go', 'rust', 'java', 'csharp',
        'php', 'ruby', 'vim', 'claude', 'gemini-ai', 'opencode', 'copilot',
    ];

    // pi has no icon in the theme: media/custom-icons.js draws one
    const CUSTOM = ['pi'];
    const AGENTS = { claude: 'claude', gemini: 'gemini-ai', opencode: 'opencode', copilot: 'copilot', pi: 'pi' };

    // by the name of the program (without .exe / .cmd)
    const PROGRAMS = {
        node: 'nodejs', nodejs: 'nodejs', npm: 'npm', npx: 'npm', yarn: 'yarn', pnpm: 'pnpm', pnpx: 'pnpm', bun: 'bun', bunx: 'bun', deno: 'deno',
        python: 'python', python3: 'python', pythonw: 'python', py: 'python', pip: 'python', git: 'git', docker: 'docker', 'docker-compose': 'docker',
        go: 'go', cargo: 'rust', rustc: 'rust', rustup: 'rust', java: 'java', javaw: 'java', dotnet: 'csharp', php: 'php', ruby: 'ruby', irb: 'ruby',
        rake: 'ruby', vim: 'vim', nvim: 'vim', gvim: 'vim', vi: 'vim', claude: 'claude', gemini: 'gemini-ai', opencode: 'opencode', copilot: 'copilot',
    };

    const own = (map, key) => (Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined);
    const programName = (name) => String(name || '').toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');

    /** The icon of a kind of shell, from the name that the list shows ("powershell", "Git Bash", "Ubuntu (WSL)"...), or null. */
    function shellIcon(title) {
        const text = String(title || '').toLowerCase();
        if (/powershell|pwsh/.test(text)) return 'powershell';
        if (/git ?bash/.test(text)) return 'git';
        if (/command prompt|^cmd$|wsl|ubuntu|debian|kali|alpine|bash|zsh|fish|\bsh\b|linux/.test(text)) return 'console';
        return null;
    }

    /**
     * The name of the icon for a terminal, or null for the plain terminal icon.
     * @param {{ agent?: string, programs?: string[], title?: string }} terminal  agent: "claude", "gemini"... or "shell"/empty
     */
    function pick(terminal) {
        const t = terminal || {};
        if (own(AGENTS, t.agent)) return AGENTS[t.agent];
        for (const program of Array.isArray(t.programs) ? t.programs : []) {
            const icon = own(PROGRAMS, programName(program));
            if (icon) return icon;
        }
        return shellIcon(t.title);
    }

    return { pick, shellIcon, programName, NAMES, CUSTOM, AGENTS, PROGRAMS };
});
