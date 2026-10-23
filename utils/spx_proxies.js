'use strict';
// The main BSPX process supervises project helpers; project data stays local.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { createProcessInspector } = require('./spx_proxy_process');
const { createSupervisor } = require('./spx_proxy_supervisor');
const { probeHttp, isPortBusy } = require('./spx_proxy_health');
const { createServiceOwnership } = require('./spx_proxy_services');

const CRITICAL = [
    ['ASSETS/templates/eafc/integration/proxy.py', 'ASSETS/templates/eafc/proxy.py'],
    ['ASSETS/templates/PGL/stake-odds-proxy.py'],
    ['ASSETS/templates/PGL/proxy.py']
];

function createProxyManager(options = {}) {
    const root = path.resolve(options.root || (process.pkg ? path.dirname(process.execPath) : process.cwd()));
    const env = options.env || process.env;
    const io = options.fs || fs;
    const spawnChild = options.spawn || spawn;
    const signal = options.kill || ((pid, kind) => process.kill(pid, kind));
    const inspector = options.inspector || createProcessInspector();
    const services = options.services || createServiceOwnership();
    const health = options.probeHttp || probeHttp;
    const busy = options.isPortBusy || isPortBusy;
    const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const now = options.now || Date.now;
    const stateFile = path.join(root, 'LOG', 'proxy-state.json');
    const logs = path.join(root, 'LOG', 'proxies');
    const roots = [path.join(root, 'ASSETS', 'templates'), path.join(root, 'proxies')];
    const paused = new Set(), owned = new Map();
    let supervisor = null, lastMaintenance = 0;

    function assertMain() {
        if (env.SPX_MANAGED === '1') throw new Error('Proxyer styres fra BSPX-hovedserveren');
    }
    function inside(file, base) {
        const rel = path.relative(base, file);
        return Boolean(rel && !rel.startsWith('..') && !path.isAbsolute(rel));
    }
    function relative(file) { return path.relative(root, file).split(path.sep).join('/'); }
    function canonical(id) {
        id = String(id || '').split(path.sep).join('/');
        const group = CRITICAL.find(group => group.includes(id));
        return group ? group.find(candidate => io.existsSync(path.join(root, candidate))) || id : id;
    }
    function resolveAllowed(id) {
        const file = path.resolve(root, canonical(id));
        if (!roots.some(base => inside(file, base)) || path.extname(file) !== '.py' || !io.existsSync(file)) throw new Error('Proxy-filen er ikke tilladt');
        const real = io.realpathSync(file);
        if (!roots.some(base => io.existsSync(base) && inside(real, io.realpathSync(base))) || !io.statSync(real).isFile()) throw new Error('Proxy-filen skal ligge i projektets tilladte mappe');
        return file;
    }
    function aliases(id) {
        const group = CRITICAL.find(group => group.includes(canonical(id)));
        return (group || []).map(candidate => path.join(root, candidate)).filter(file => {
            try {
                const real = io.realpathSync(file);
                return roots.some(base => io.existsSync(base) && inside(real, io.realpathSync(base)));
            } catch (_) { return false; }
        });
    }
    function readState() {
        try {
            const raw = JSON.parse(io.readFileSync(stateFile, 'utf8'));
            const wanted = Array.isArray(raw) ? raw : raw.wanted;
            const disabled = Array.isArray(raw) ? [] : raw.disabled;
            if (!Array.isArray(wanted) || !Array.isArray(disabled)) return { wanted: [], disabled: [] };
            return {
                wanted: [...new Set(wanted.filter(id => typeof id === 'string').map(canonical))],
                disabled: [...new Set(disabled.filter(id => typeof id === 'string').map(canonical))]
            };
        } catch (_) { return { wanted: [], disabled: [] }; }
    }
    function writeState(state) {
        io.mkdirSync(path.dirname(stateFile), { recursive: true });
        const temporary = stateFile + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
        try {
            io.writeFileSync(temporary, JSON.stringify({ version: 2, wanted: state.wanted, disabled: state.disabled }, null, 2) + '\n');
            io.renameSync(temporary, stateFile);
        } finally { try { io.unlinkSync(temporary); } catch (_) {} }
    }
    function desired() { return readState().wanted.filter(id => !paused.has(id)); }
    function logPath(id) { return path.join(logs, id.replace(/[\/\\]/g, '_') + '.log'); }
    function log(id, message) {
        try {
            io.mkdirSync(logs, { recursive: true });
            io.appendFileSync(logPath(id), new Date(now()).toISOString() + ' [BSPX] ' + String(message).replace(/[\r\n]/g, ' ').slice(0, 300) + '\n');
        } catch (_) {}
    }
    function maintenance() {
        if (now() - lastMaintenance < 60000) return;
        lastMaintenance = now();
        for (const id of desired()) {
            try {
                const file = logPath(id);
                const size = io.statSync(file).size;
                if (size > 5 * 1024 * 1024) {
                    const tail = Buffer.alloc(5 * 1024 * 1024);
                    const descriptor = io.openSync(file, 'r');
                    let length;
                    try { length = io.readSync(descriptor, tail, 0, tail.length, size - tail.length); }
                    finally { io.closeSync(descriptor); }
                    io.writeFileSync(file + '.1', tail.subarray(0, length));
                    io.truncateSync(file, 0); // Child descriptors are opened with O_APPEND.
                }
            } catch (_) {}
        }
    }
    function portOf(file) {
        const text = io.readFileSync(file, 'utf8');
        const match = text.match(/^\s*port\s*=\s*['"]?(\d{2,5})\b/im) ||
            text.match(/^\s*port\s*=[^\r\n]*\belse\s+(\d{2,5})\s*(?:#.*)?$/im) ||
            text.match(/['"](?:0\.0\.0\.0|127\.0\.0\.1|localhost)['"]\s*,\s*(\d{2,5})\b/);
        return match && Number(match[1]) <= 65535 ? Number(match[1]) : 0;
    }
    function inspect(id) {
        const script = resolveAllowed(id);
        const child = owned.get(canonical(id));
        const found = inspector.find(script, aliases(id));
        const info = found || (child && child.pid && child.exitCode == null && child.signalCode == null ?
            { pid: child.pid, scriptPath: script, systemd: '' } : { pid: 0, scriptPath: script, systemd: '' });
        if (externalService(id, info)) services.remember(script, info.systemd, aliases(id));
        return { ...info, port: portOf(info.scriptPath || script) };
    }
    function externalService(id, info) {
        const child = owned.get(canonical(id));
        const mainUnit = typeof inspector.unit === 'function' ? inspector.unit(process.pid) : '';
        return Boolean(info.systemd && child?.pid !== info.pid && info.systemd !== 'bspx.service' && info.systemd !== mainUnit);
    }
    async function launch(id) {
        assertMain();
        id = canonical(id);
        const script = resolveAllowed(id), first = inspect(id);
        if (first.pid) return null;
        const service = await services.ownerFor(script, aliases(id));
        if (service) {
            log(id, 'Waiting for existing systemd owner: ' + service);
            const error = new Error('Proxyen genstartes af ' + service);
            error.code = 'SYSTEMD_OWNED';
            throw error;
        }
        if (first.port && await busy(first.port)) throw new Error('Proxy-porten er optaget; ingen anden proces bliver stoppet');
        if (!desired().includes(id)) throw new Error('Proxy-start er annulleret');
        if (inspect(id).pid) return null;
        io.mkdirSync(logs, { recursive: true });
        const descriptor = io.openSync(logPath(id), 'a');
        let child;
        try {
            child = spawnChild('python3', ['-u', script], {
                cwd: path.dirname(script), detached: true, stdio: ['ignore', descriptor, descriptor],
                env: { ...env, PYTHONUNBUFFERED: '1' }, windowsHide: true
            });
        } finally { io.closeSync(descriptor); }
        child.on('error', () => {});
        owned.set(id, child);
        const release = () => { if (owned.get(id) === child) owned.delete(id); };
        child.once('exit', release); child.once('error', release); child.unref();
        return child;
    }
    async function terminate(id, pid, hard = true) {
        const script = resolveAllowed(id);
        const matches = () => inspector.matches(pid, script, aliases(id));
        if (!matches()) return;
        // A watchdog SIGKILL is also a failure for sidecar Restart=on-failure.
        // Only this exact, revalidated Python proxy PID can receive a signal.
        try { signal(pid, hard ? 'SIGKILL' : 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        if (!hard) {
            const deadline = now() + 2000;
            while (matches() && now() < deadline) await sleep(50);
            if (matches()) {
                try { signal(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
            }
        }
    }
    function monitor() {
        assertMain();
        if (!supervisor) supervisor = (options.createSupervisor || createSupervisor)({
            desired, inspect, launch,
            probe: (_id, info) => info.port ? health(info.port) : Promise.resolve(true),
            terminate: (id, pid) => terminate(id, pid, true), log, maintenance
        }, options.supervisorOptions || {});
        return supervisor;
    }
    async function start(id) {
        assertMain();
        id = relative(resolveAllowed(id));
        const state = readState();
        if (!state.wanted.includes(id)) state.wanted.push(id);
        state.disabled = state.disabled.filter(value => value !== id);
        writeState(state);
        await monitor().start();
        return path.basename(id) + ': automatisk overvågning er aktiveret';
    }
    async function stop(id) {
        assertMain();
        id = relative(resolveAllowed(id));
        let info = inspect(id);
        const service = externalService(id, info) ? info.systemd : await services.ownerFor(resolveAllowed(id), aliases(id));
        info = inspect(id); // A proxy may have started or changed during the lookup.
        const currentService = service || (externalService(id, info) ? info.systemd : '');
        if (currentService) throw new Error('Proxyen styres af ' + currentService + '. Stop den via sudo systemctl stop ' + currentService);
        const state = readState();
        state.wanted = state.wanted.filter(value => value !== id);
        if (!state.disabled.includes(id)) state.disabled.push(id);
        writeState(state); // Disable recovery before signalling the child.
        supervisor?.forget(id);
        info = inspect(id);
        if (externalService(id, info)) throw new Error('Proxyen styres af ' + info.systemd + '. Stop den via sudo systemctl stop ' + info.systemd);
        if (info.pid) await terminate(id, info.pid, false);
        return path.basename(id) + ' stoppet; automatisk opstart er slået fra indtil Start';
    }
    function rewritePort(text, port) {
        let count = 0;
        const next = text.replace(/(\bport\s*=[^\r\n]*\belse\s+)(\d{2,5})/gi, (_all, prefix) => {
            count++; return prefix + port;
        }).replace(/(\bport\s*[:=]\s*['"]?)(\d{2,5})(['"]?)/gi, (_all, prefix, _old, suffix) => {
            count++; return prefix + port + suffix;
        }).replace(/(['"](?:0\.0\.0\.0|127\.0\.0\.1|localhost)['"]\s*,\s*)(\d{2,5})/g, (_all, prefix) => {
            count++; return prefix + port;
        }).replace(/(\.listen\(\s*)(\d{2,5})/g, (_all, prefix) => { count++; return prefix + port; });
        if (!count) throw new Error('Fandt ikke et port-sted i filen');
        return next;
    }
    async function setPort(id, rawPort) {
        assertMain();
        const port = Number(rawPort);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port skal være mellem 1024 og 65535');
        const script = resolveAllowed(id);
        id = relative(script);
        let info = inspect(id);
        const service = externalService(id, info) ? info.systemd : await services.ownerFor(script, aliases(id));
        info = inspect(id);
        const currentService = service || (externalService(id, info) ? info.systemd : '');
        if (currentService) throw new Error('Porten for ' + currentService + ' ændres i den tilhørende tjeneste');
        const before = io.readFileSync(script, 'utf8'), next = rewritePort(before, port);
        if (next === before) return path.basename(id) + ' bruger allerede port ' + port;
        paused.add(id); supervisor?.forget(id);
        try {
            io.writeFileSync(script, next);
            if (info.pid) await terminate(id, info.pid, false);
        } finally { paused.delete(id); }
        const latest = readState();
        // A Stop issued while termination was pending must win over this edit.
        if (info.pid && !latest.disabled.includes(id)) await start(id);
        else if (latest.wanted.includes(id) && !latest.disabled.includes(id)) await monitor().kick();
        return path.basename(id) + ' gemt på port ' + port;
    }
    function walk(dir, found) {
        if (!io.existsSync(dir)) return;
        for (const entry of io.readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, entry.name);
            if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) walk(file, found);
            else if (entry.isFile() && entry.name.toLowerCase().endsWith('.py') && entry.name.toLowerCase().includes('proxy') && !entry.name.startsWith('._')) found.push(file);
        }
    }
    function list() {
        const found = [];
        roots.forEach(base => walk(base, found));
        const ids = [...new Set(found.map(file => canonical(relative(file))))].sort();
        return ids.flatMap(id => {
            try {
                const file = resolveAllowed(id), info = inspect(id);
                const text = io.readFileSync(info.scriptPath || file, 'utf8');
                return [{ id, file: path.basename(file), folder: path.basename(path.dirname(file)),
                    port: info.port || '', bind: text.includes('0.0.0.0') ? 'netværket' : 'kun denne maskine',
                    running: info.pid > 0, systemd: info.systemd || '', supervised: desired().includes(id),
                    note: info.pid ? '' : 'Se LOG/proxies/' }];
            } catch (_) { return []; }
        });
    }
    function restore() {
        if (env.SPX_MANAGED === '1') return;
        const state = readState();
        for (const group of CRITICAL) {
            const id = group.find(candidate => io.existsSync(path.join(root, candidate)));
            if (id) {
                const selected = canonical(id);
                if (!state.disabled.includes(selected) && !state.wanted.includes(selected)) state.wanted.push(selected);
            }
        }
        writeState(state);
        monitor().start().catch(() => {});
    }
    function shutdown() { supervisor?.shutdown(); supervisor = null; }
    return { list, start, stop, setPort, restore, shutdown };
}
module.exports = { ...createProxyManager(), createProxyManager };
