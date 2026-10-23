'use strict';

const nodeFs = require('fs');
const path = require('path');

// Read the script Python actually executes, rather than searching its arguments
// for a filename. A proxy filename can also appear in a different script's data.
function pythonScript(argv) {
    if (!Array.isArray(argv) || !argv.length) return '';
    const interpreter = path.posix.basename(String(argv[0]).replace(/\\/g, '/'));
    if (!/^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/i.test(interpreter)) return '';
    for (let index = 1; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--') return argv[index + 1] || '';
        if (argument === '-' || !argument) return '';
        if (!argument.startsWith('-')) return argument;
        if (argument === '--check-hash-based-pycs') {
            if (!['default', 'always', 'never'].includes(argv[++index])) return '';
            continue;
        }
        if (argument.startsWith('--check-hash-based-pycs=')) {
            if (!['default', 'always', 'never'].includes(argument.split('=')[1])) return '';
            continue;
        }
        if (argument.startsWith('--')) return '';
        for (let flagIndex = 1; flagIndex < argument.length; flagIndex += 1) {
            const flag = argument[flagIndex];
            // -c and -m never execute the following filename as a script.
            // Help/version likewise do not execute a script.
            if ('cmhV?'.includes(flag)) return '';
            if (flag === 'W' || flag === 'X') {
                if (flagIndex === argument.length - 1 && !argv[++index]) return '';
                break;
            }
            if (!'bBdEiIOPqRsSuvx'.includes(flag)) return '';
        }
    }
    return '';
}

function createProcessInspector(options = {}) {
    const fs = options.fs || nodeFs;
    const procRoot = options.procRoot || '/proc';
    const currentPid = options.currentPid === undefined ? process.pid : Number(options.currentPid);

    function validPid(pid) {
        return Number.isSafeInteger(Number(pid)) && Number(pid) > 0;
    }

    function canonical(file) {
        const resolved = path.resolve(file);
        try { return path.resolve(fs.realpathSync(resolved)); }
        catch (error) { return resolved; }
    }

    function identity(pid) {
        if (!validPid(pid) || Number(pid) === currentPid) return null;
        try {
            const directory = path.join(procRoot, String(Number(pid)));
            const argv = String(fs.readFileSync(path.join(directory, 'cmdline'), 'utf8')).split('\0');
            const script = pythonScript(argv);
            if (!script || script.startsWith('-')) return null;
            const scriptPath = path.isAbsolute(script)
                ? script
                : path.resolve(fs.readlinkSync(path.join(directory, 'cwd')), script);
            return { pid: Number(pid), scriptPath: canonical(scriptPath) };
        } catch (error) {
            // Processes can disappear, or belong to another user, during a scan.
            return null;
        }
    }

    function targets(scriptPath, aliases) {
        return new Set([scriptPath, ...(Array.isArray(aliases) ? aliases : [])]
            .filter(file => typeof file === 'string' && file.length > 0).map(canonical));
    }

    function matches(pid, scriptPath, aliases = []) {
        const actual = identity(pid);
        return Boolean(actual && targets(scriptPath, aliases).has(actual.scriptPath));
    }

    function unit(pid) {
        if (!validPid(pid)) return '';
        try {
            const text = String(fs.readFileSync(path.join(procRoot, String(Number(pid)), 'cgroup'), 'utf8'));
            let found = '';
            for (const line of text.split(/\r?\n/)) {
                const groupPath = line.replace(/^[^:]*:[^:]*:/, '');
                for (const match of groupPath.matchAll(/(?:^|\/)([A-Za-z0-9_.@:\\-]+\.service)(?=\/|$)/g)) {
                    found = match[1];
                }
            }
            return found;
        } catch (error) { return ''; }
    }

    function find(scriptPath, aliases = []) {
        const wanted = targets(scriptPath, aliases);
        let entries;
        try { entries = fs.readdirSync(procRoot); }
        catch (error) { return null; }
        for (const entry of entries) {
            if (!/^\d+$/.test(String(entry))) continue;
            const actual = identity(Number(entry));
            if (actual && wanted.has(actual.scriptPath)) {
                return { ...actual, systemd: unit(actual.pid) };
            }
        }
        return null;
    }

    return { find, matches, unit };
}

module.exports = { createProcessInspector };
