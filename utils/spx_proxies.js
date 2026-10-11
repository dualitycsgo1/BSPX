// Start and stop project proxy scripts from the controller.
// Only Python files under ASSETS/templates and /proxies are allowed.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function appRoot() {
    if (process.pkg) return path.resolve(process.execPath + '/..');
    return process.cwd();
}

function roots() {
    return [
        path.join(appRoot(), 'ASSETS', 'templates'),
        path.join(appRoot(), 'proxies')
    ];
}

function stateFile() {
    return path.join(appRoot(), 'LOG', 'proxy-state.json');
}

function logDir() {
    return path.join(appRoot(), 'LOG', 'proxies');
}

function readState() {
    try {
        const data = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
        return Array.isArray(data) ? data : [];
    } catch (error) {
        return [];
    }
}

function writeState(ids) {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(ids, null, 2));
}

function isInside(file, root) {
    const rel = path.relative(root, file);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function resolveAllowed(id) {
    const abs = path.resolve(appRoot(), String(id || ''));
    const allowed = roots().some(function (root) { return isInside(abs, root); });
    if (!allowed || path.extname(abs) !== '.py' || !fs.existsSync(abs)) {
        throw new Error('Proxy-filen er ikke tilladt');
    }
    return abs;
}

function walk(dir, found) {
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) return;
            walk(full, found);
            return;
        }
        if (entry.isFile() && entry.name.endsWith('.py') && entry.name.toLowerCase().includes('proxy')) {
            found.push(full);
        }
    });
}

function commandOf(pid) {
    try {
        return fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').replace(/\0/g, ' ');
    } catch (error) {
        return '';
    }
}

function systemdUnit(pid) {
    try {
        const text = fs.readFileSync('/proc/' + pid + '/cgroup', 'utf8');
        const match = text.match(/([A-Za-z0-9_.@:-]+\.service)/);
        return match ? match[1] : '';
    } catch (error) {
        return '';
    }
}

function findPid(scriptPath) {
    if (!fs.existsSync('/proc')) return 0;
    const entries = fs.readdirSync('/proc');
    for (let i = 0; i < entries.length; i++) {
        if (!/^\d+$/.test(entries[i])) continue;
        const pid = Number(entries[i]);
        if (pid === process.pid) continue;
        const command = commandOf(pid);
        if (command.indexOf(scriptPath) !== -1 && command.indexOf('python') !== -1) return pid;
    }
    return 0;
}

function describe(scriptPath) {
    let text = '';
    try { text = fs.readFileSync(scriptPath, 'utf8'); } catch (error) { text = ''; }
    const portMatch = text.match(/port\s*[=:(]\s*(\d{2,5})/i);
    let bind = '';
    if (text.indexOf('0.0.0.0') !== -1) bind = 'netværket';
    else if (text.indexOf('127.0.0.1') !== -1 || text.indexOf('localhost') !== -1) bind = 'kun denne maskine';
    const pid = findPid(scriptPath);
    return {
        id: path.relative(appRoot(), scriptPath).split(path.sep).join('/'),
        file: path.basename(scriptPath),
        folder: path.basename(path.dirname(scriptPath)),
        port: portMatch ? portMatch[1] : '',
        bind: bind,
        running: pid > 0,
        systemd: pid > 0 ? systemdUnit(pid) : ''
    };
}

function list() {
    const found = [];
    roots().forEach(function (root) { walk(root, found); });
    const unique = Array.from(new Set(found));
    unique.sort();
    return unique.map(describe);
}

function start(id) {
    const scriptPath = resolveAllowed(id);
    const info = describe(scriptPath);
    const wanted = readState();
    if (wanted.indexOf(info.id) === -1) {
        wanted.push(info.id);
        writeState(wanted);
    }
    if (info.running) return info.file + ' kører allerede';
    fs.mkdirSync(logDir(), { recursive: true });
    const logPath = path.join(logDir(), info.id.replace(/[\/\\]/g, '_') + '.log');
    const log = fs.openSync(logPath, 'a');
    const child = spawn('python3', [scriptPath], {
        cwd: path.dirname(scriptPath),
        detached: true,
        stdio: ['ignore', log, log]
    });
    fs.closeSync(log);
    child.unref();
    if (!child.pid) throw new Error('Kunne ikke starte ' + info.file);
    return info.file + ' startet';
}

function stop(id) {
    const scriptPath = resolveAllowed(id);
    const info = describe(scriptPath);
    writeState(readState().filter(function (item) { return item !== info.id; }));
    if (!info.running) return info.file + ' var allerede stoppet';
    if (info.systemd) {
        return info.file + ' kører som ' + info.systemd + ' og starter selv igen. Slå den fra én gang med: sudo systemctl disable --now ' + info.systemd;
    }
    const pid = findPid(scriptPath);
    process.kill(pid, 'SIGTERM');
    return info.file + ' stoppet';
}

function restore() {
    readState().forEach(function (id) {
        try { start(id); } catch (error) { console.log('Proxy restore failed for ' + id + ': ' + error.message); }
    });
}

module.exports = {
    list: list,
    start: start,
    stop: stop,
    restore: restore
};
