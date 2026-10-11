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
        if (entry.isFile() && entry.name.endsWith('.py') && entry.name.toLowerCase().includes('proxy') && !entry.name.startsWith('._')) {
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
    const base = path.basename(scriptPath);
    const dir = path.resolve(path.dirname(scriptPath));
    const entries = fs.readdirSync('/proc');
    for (let i = 0; i < entries.length; i++) {
        if (!/^\d+$/.test(entries[i])) continue;
        const pid = Number(entries[i]);
        if (pid === process.pid) continue;
        const command = commandOf(pid);
        if (command.indexOf('python') === -1 || command.indexOf(base) === -1) continue;
        if (command.indexOf(scriptPath) !== -1) return pid;
        let cwd = '';
        try { cwd = fs.readlinkSync('/proc/' + pid + '/cwd'); } catch (error) { cwd = ''; }
        if (path.resolve(cwd) === dir) return pid;
    }
    return 0;
}

function describe(scriptPath) {
    let text = '';
    try { text = fs.readFileSync(scriptPath, 'utf8'); } catch (error) { text = ''; }
    const portMatch = text.match(/port\s*[=:(,]\s*['"]?(\d{2,5})/i) || text.match(/:(\d{4,5})\b/);
    let bind = '';
    if (text.indexOf('0.0.0.0') !== -1) bind = 'netværket';
    else if (text.indexOf('127.0.0.1') !== -1 || text.indexOf('localhost') !== -1) bind = 'kun denne maskine';
    const pid = findPid(scriptPath);
    const id = path.relative(appRoot(), scriptPath).split(path.sep).join('/');
    let note = '';
    if (!pid) {
        try {
            const logPath = path.join(logDir(), id.replace(/[\/\\]/g, '_') + '.log');
            const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
            note = lines[lines.length - 1].slice(-200);
        } catch (error) { note = ''; }
    }
    return {
        id: id,
        file: path.basename(scriptPath),
        folder: path.basename(path.dirname(scriptPath)),
        port: portMatch ? portMatch[1] : '',
        bind: bind,
        running: pid > 0,
        systemd: pid > 0 ? systemdUnit(pid) : '',
        note: note
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

function sleep(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function rewritePort(text, port) {
    const re = /port\s*[:=]\s*(['"]?)\d{2,5}\1|(['"](?:0\.0\.0\.0|127\.0\.0\.1|localhost)['"]\s*,\s*)\d{2,5}|\.listen\(\s*\d{2,5}/gi;
    let count = 0;
    const next = text.replace(re, function (full) {
        count += 1;
        return full.replace(/\d{2,5}/, String(port));
    });
    if (!count) throw new Error('Fandt ikke et port-sted i filen. Den skal have port = 8787, port=8787 eller ("0.0.0.0", 8787).');
    return next;
}

function setPort(id, rawPort) {
    const port = parseInt(rawPort, 10);
    if (!port || port < 1024 || port > 65535) throw new Error('Port skal være mellem 1024 og 65535');
    const scriptPath = resolveAllowed(id);
    const before = fs.readFileSync(scriptPath, 'utf8');
    const next = rewritePort(before, port);
    if (next !== before) fs.writeFileSync(scriptPath, next);
    const info = describe(scriptPath);
    if (!info.running) return info.file + ' gemt på port ' + port + '. Den er stoppet.';
    const pid = findPid(scriptPath);
    try { process.kill(pid, 'SIGTERM'); } catch (error) { throw new Error('Kunne ikke genstarte ' + info.file); }
    const deadline = Date.now() + 2000;
    while (findPid(scriptPath) && Date.now() < deadline) sleep(100);
    if (info.systemd) return info.file + ' gemt på port ' + port + '. Tjenesten genstarter selv.';
    start(id);
    return info.file + ' gemt på port ' + port + ' og genstartet.';
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
    setPort: setPort,
    restore: restore
};
