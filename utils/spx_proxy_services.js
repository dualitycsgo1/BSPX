'use strict';

const nodeFs = require('fs');
const path = require('path');
const { execFile: nodeExecFile } = require('child_process');

// Sidecar commands are metadata, never executable input to this adapter. Accept
// a literal Python invocation only; shell expansion/operators cannot identify
// a service owner reliably and must not be interpreted here.
function words(command) {
    if (/[`$;&|<>\r\n]/.test(command)) return null;
    const tokens = [];
    let token = '', quote = '', escaped = false, started = false;
    for (const character of command) {
        if (escaped) { token += character; escaped = false; started = true; continue; }
        if (character === '\\' && quote !== "'") { escaped = true; started = true; continue; }
        if (quote) {
            if (character === quote) quote = '';
            else token += character;
            continue;
        }
        if (character === '"' || character === "'") { quote = character; started = true; continue; }
        if (/\s/.test(character)) {
            if (started) { tokens.push(token); token = ''; started = false; }
            continue;
        }
        token += character; started = true;
    }
    if (quote || escaped) return null;
    if (started) tokens.push(token);
    return tokens;
}

function scriptArgument(command) {
    const argv = words(command);
    if (!argv?.length || !/^python(?:\d+(?:\.\d+)*)?$/.test(path.posix.basename(argv[0]))) return '';
    for (let index = 1; index < argv.length; index += 1) {
        const item = argv[index];
        if (item === '--') return argv[index + 1] || '';
        if (!item || item === '-') return '';
        if (!item.startsWith('-')) return item;
        if (item === '-X' || item === '-W') { if (!argv[++index]) return ''; continue; }
        if (/^-(?:[bBdEiIOPqRsSuvx]+|[WX].+)$/.test(item)) continue;
        return '';
    }
    return '';
}

function createServiceOwnership(options = {}) {
    const fs = options.fs || nodeFs;
    const execFile = options.execFile || nodeExecFile;
    const platform = options.platform || process.platform;
    const confirmed = new Map();

    function canonical(file) {
        const resolved = path.resolve(file);
        try { return path.resolve(fs.realpathSync(resolved)); }
        catch (_) { return resolved; }
    }
    function targets(script, aliases) {
        return [...new Set([script, ...(Array.isArray(aliases) ? aliases : [])]
            .filter(file => typeof file === 'string' && file.length > 0).map(canonical))];
    }
    function validUnit(unit) { return typeof unit === 'string' && /^[A-Za-z0-9_.@:\\-]+\.service$/.test(unit); }
    function remember(script, unit, aliases = []) {
        if (platform !== 'linux' || !validUnit(unit)) return false;
        targets(script, aliases).forEach(file => confirmed.set(file, unit));
        return true;
    }
    function forget(files, unit) {
        files.forEach(file => { if (confirmed.get(file) === unit) confirmed.delete(file); });
    }
    function candidates(script, aliases) {
        const files = targets(script, aliases), wanted = new Set(files), units = new Set();
        // Use the supplied entry-point directories as well as canonical paths:
        // an alias can place its sidecar beside a wrapper rather than its target.
        const directories = new Set([script, ...(Array.isArray(aliases) ? aliases : []), ...files]
            .filter(file => typeof file === 'string' && file.length > 0).map(file => path.dirname(path.resolve(file))));
        for (const directory of directories) {
            let entries;
            try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
            catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue; throw error; }
            for (const entry of entries) {
                if (!entry.isFile() || !entry.name.endsWith('.sidecar')) continue;
                let name = '', command = '';
                const text = fs.readFileSync(path.join(directory, entry.name), 'utf8');
                for (const raw of text.split(/\r?\n/)) {
                    const line = raw.split('#')[0].trim();
                    if (line.startsWith('name=')) name = line.slice(5).trim();
                    if (line.startsWith('exec=')) command = line.slice(5).trim();
                }
                if (!/^[A-Za-z0-9_-]+$/.test(name)) continue;
                const argument = scriptArgument(command);
                if (!argument || argument.startsWith('-')) continue;
                if (wanted.has(canonical(path.resolve(directory, argument)))) units.add(name + '.service');
            }
        }
        return { files, units: [...units] };
    }
    function loadState(unit) {
        return new Promise((resolve, reject) => {
            try {
                execFile('systemctl', ['show', '--property=LoadState', '--value', '--', unit], {
                    encoding: 'utf8', timeout: 1500, maxBuffer: 8192, windowsHide: true
                }, (error, stdout) => {
                    const state = String(stdout || '').trim().replace(/^LoadState=/, '');
                    // Some systemd versions also set a nonzero exit status for
                    // an explicitly reported missing unit.
                    if (state === 'not-found') { resolve(state); return; }
                    if (error) { reject(new Error('Kunne ikke kontrollere proxy-tjenesten ' + unit)); return; }
                    if (!state) reject(new Error('Proxy-tjenesten returnerede ingen status: ' + unit));
                    else resolve(state);
                });
            } catch (_) { reject(new Error('Kunne ikke kontrollere proxy-tjenesten ' + unit)); }
        });
    }
    async function ownerFor(script, aliases = []) {
        if (platform !== 'linux') return null;
        const files = targets(script, aliases);
        const previous = [...new Set(files.map(file => confirmed.get(file)).filter(Boolean))];
        for (const unit of previous) {
            try {
                if (await loadState(unit) !== 'not-found') { remember(script, unit, aliases); return unit; }
                forget(files, unit);
            } catch (_) {
                // An observed owner remains authoritative while systemd is
                // unavailable. Starting a competing Python process is unsafe.
                return unit;
            }
        }
        const discovery = candidates(script, aliases);
        for (const unit of discovery.units) {
            const state = await loadState(unit); // Unknown ownership fails closed.
            if (state !== 'not-found') { remember(script, unit, aliases); return unit; }
        }
        return null;
    }

    return { ownerFor, remember };
}

module.exports = { createServiceOwnership };
