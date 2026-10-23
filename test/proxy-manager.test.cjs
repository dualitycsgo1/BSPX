'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createProxyManager } = require('../utils/spx_proxies');

const EAFC = 'ASSETS/templates/eafc/integration/proxy.py';
const EAFC_ALIAS = 'ASSETS/templates/eafc/proxy.py';
const STAKE = 'ASSETS/templates/PGL/stake-odds-proxy.py';
const PGL = 'ASSETS/templates/PGL/proxy.py';
const CUSTOM = 'proxies/custom/proxy.py';

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function fixture(t, options = {}) {
    const parent = fs.realpathSync(os.tmpdir());
    const root = fs.mkdtempSync(path.join(parent, 'bspx-proxy-manager-'));
    t.after(() => {
        assert.equal(path.dirname(root), parent);
        assert.ok(path.basename(root).startsWith('bspx-proxy-manager-'));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const write = (id, contents) => {
        const file = path.join(root, id);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, contents);
        return file;
    };
    const ports = { [EAFC]: 5101, [STAKE]: 5102, [PGL]: 5103, ...options.files };
    for (const [id, port] of Object.entries(ports)) write(id, `HOST = '0.0.0.0'\nport = ${port}\n`);
    const statePath = path.join(root, 'LOG', 'proxy-state.json');
    if (options.saved !== undefined) write('LOG/proxy-state.json', JSON.stringify(options.saved));
    const state = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const processes = new Map(), signals = [], children = [], factories = [];
    const inspector = {
        find(script, aliases = []) {
            const allowed = new Set([script, ...aliases].map(file => path.resolve(file)));
            return [...processes.values()].find(info => allowed.has(path.resolve(info.scriptPath))) || null;
        },
        matches(pid, script, aliases = []) {
            const info = processes.get(pid);
            return Boolean(info && [script, ...aliases].includes(info.scriptPath));
        }
    };
    const spawn = (_command, _args, settings) => {
        const child = Object.assign(new EventEmitter(), { pid: 200 + children.length, exitCode: null, signalCode: null, settings });
        child.unref = () => {};
        children.push(child);
        return child;
    };
    const createSupervisor = deps => {
        const supervisor = {
            deps, starts: 0, kicks: 0, forgotten: [], closed: false,
            async start() { this.starts += 1; },
            async kick() { this.kicks += 1; },
            forget(id) { this.forgotten.push(id); },
            shutdown() { this.closed = true; }
        };
        factories.push(supervisor);
        return supervisor;
    };
    const managerOptions = {
        root, env: {}, inspector, spawn, createSupervisor,
        isPortBusy: async () => false, probeHttp: async () => true,
        kill(pid, kind) { signals.push([pid, kind]); processes.delete(pid); },
        ...options.manager
    };
    const manager = createProxyManager(managerOptions);
    t.after(() => manager.shutdown());
    return { root, write, manager, managerOptions, state, statePath, processes, signals, children, factories,
        get deps() { assert.ok(factories.length, 'monitor has started'); return factories.at(-1).deps; } };
}

test('an external service keeps sole launch ownership after its exact proxy PID disappears', async t => {
    const owners = new Map();
    const services = {
        remember(script, unit) { owners.set(script, unit); },
        async ownerFor(script) { return owners.get(script) || null; }
    };
    const item = fixture(t, { manager: { services } });
    item.processes.set(44, { pid: 44, scriptPath: path.join(item.root, EAFC), systemd: 'eafc-proxy.service' });
    item.manager.restore();
    assert.equal(item.deps.inspect(EAFC).pid, 44);
    item.processes.delete(44);
    for (let attempt = 0; attempt < 3; attempt++) {
        await assert.rejects(item.deps.launch(EAFC), { code: 'SYSTEMD_OWNED' });
    }
    assert.equal(item.children.length, 0, 'BSPX never races the existing service restart');
    item.processes.set(45, { pid: 45, scriptPath: path.join(item.root, EAFC), systemd: 'eafc-proxy.service' });
    assert.equal(item.deps.inspect(EAFC).pid, 45, 'The service replacement can be adopted');
    assert.deepEqual(item.signals, []);
});

test('an installed owner without a running PID blocks competing launch, Stop and port edits', async t => {
    const services = { remember() {}, async ownerFor() { return 'eafc-proxy.service'; } };
    const item = fixture(t, { manager: { services } });
    item.manager.restore();
    const original = fs.readFileSync(path.join(item.root, EAFC), 'utf8');
    await assert.rejects(item.deps.launch(EAFC), { code: 'SYSTEMD_OWNED' });
    await assert.rejects(item.manager.stop(EAFC), /sudo systemctl stop eafc-proxy\.service/);
    await assert.rejects(item.manager.setPort(EAFC, 6000), /eafc-proxy\.service/);
    assert.equal(fs.readFileSync(path.join(item.root, EAFC), 'utf8'), original);
    assert.equal(item.state().wanted.includes(EAFC), true);
    assert.equal(item.children.length, 0);
});

test('Stop terminates the current proxy started while ownership lookup was pending', async t => {
    const lookup = deferred();
    const services = { remember() {}, ownerFor() { return lookup.promise; } };
    const item = fixture(t, { manager: { services } });
    item.manager.restore();
    const stopping = item.manager.stop(PGL);
    item.processes.set(81, { pid: 81, scriptPath: path.join(item.root, PGL), systemd: '' });
    lookup.resolve(null);
    await stopping;
    assert.deepEqual(item.signals, [[81, 'SIGTERM']]);
    assert.equal(item.state().disabled.includes(PGL), true);
    assert.equal(item.processes.size, 0);
});

test('port edit refreshes the proxy PID after a pending ownership lookup', async t => {
    const lookup = deferred();
    const services = { remember() {}, ownerFor() { return lookup.promise; } };
    const item = fixture(t, { manager: { services } });
    item.manager.restore();
    const changing = item.manager.setPort(PGL, 6300);
    item.processes.set(82, { pid: 82, scriptPath: path.join(item.root, PGL), systemd: '' });
    lookup.resolve(null);
    await changing;
    assert.deepEqual(item.signals, [[82, 'SIGTERM']]);
    assert.equal(item.processes.size, 0);
    assert.match(fs.readFileSync(path.join(item.root, PGL), 'utf8'), /port = 6300/);
    assert.equal(item.state().wanted.includes(PGL), true);
});

test('restore starts monitoring all three critical proxies and preserves saved custom helpers', async t => {
    const item = fixture(t, { files: { [CUSTOM]: 5200 }, saved: [CUSTOM, EAFC_ALIAS] });
    item.manager.restore();
    assert.deepEqual(new Set(item.state().wanted), new Set([CUSTOM, EAFC, STAKE, PGL]));
    assert.deepEqual(item.state().disabled, []);
    assert.equal(item.factories.length, 1);
    assert.equal(item.factories[0].starts, 1);
    assert.equal(item.children.length, 0, 'restore delegates starts to the single supervisor');
    item.manager.restore();
    assert.equal(item.factories.length, 1);
    assert.equal(item.state().wanted.length, 4);
});

test('EAFC aliases produce one entry and adopt the existing script with its actual health port', async t => {
    const probed = [];
    const item = fixture(t, { files: { [EAFC_ALIAS]: 5999 }, manager: { probeHttp: async port => { probed.push(port); return true; } } });
    item.processes.set(44, { pid: 44, scriptPath: path.join(item.root, EAFC_ALIAS), systemd: 'eafc-proxy.service' });
    item.manager.restore();
    const entries = item.manager.list().filter(row => row.id.includes('/eafc/'));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, EAFC);
    assert.equal(entries[0].running, true);
    assert.equal(entries[0].port, 5999);
    const info = item.deps.inspect(EAFC);
    assert.equal(info.scriptPath, path.join(item.root, EAFC_ALIAS));
    await item.deps.probe(EAFC, info);
    assert.deepEqual(probed, [5999]);
    assert.equal(await item.deps.launch(EAFC), null);
    assert.equal(item.children.length, 0);
});

test('Stop persists disabled state before signalling, survives restore and Start re-enables recovery', async t => {
    const item = fixture(t);
    item.processes.set(45, { pid: 45, scriptPath: path.join(item.root, PGL), systemd: '' });
    item.manager.restore();
    // Observe the state at the signal boundary using a second manager adapter.
    const manager = createProxyManager({ ...item.managerOptions, kill(pid, kind) {
        assert.equal(item.state().wanted.includes(PGL), false);
        assert.equal(item.state().disabled.includes(PGL), true);
        item.signals.push([pid, kind]);
        item.processes.delete(pid);
    } });
    t.after(() => manager.shutdown());
    await manager.stop(PGL);
    assert.deepEqual(item.signals, [[45, 'SIGTERM']]);
    manager.restore();
    assert.equal(item.state().wanted.includes(PGL), false);
    await manager.start(PGL);
    assert.equal(item.state().wanted.includes(PGL), true);
    assert.equal(item.state().disabled.includes(PGL), false);
});

test('managed instances neither restore nor mutate shared proxy state', async t => {
    const item = fixture(t, { manager: { env: { SPX_MANAGED: '1' } } });
    item.manager.restore();
    assert.equal(fs.existsSync(item.statePath), false);
    for (const operation of [() => item.manager.start(PGL), () => item.manager.stop(PGL), () => item.manager.setPort(PGL, 6000)]) {
        await assert.rejects(operation(), /hovedserveren/);
    }
    assert.equal(item.factories.length, 0);
    assert.equal(item.children.length, 0);
    assert.deepEqual(item.signals, []);
});

test('paths outside allowed roots and escaping symlinks cannot be started', async t => {
    const item = fixture(t);
    const outside = item.write('outside.py', 'port = 6100\n');
    await assert.rejects(item.manager.start(outside), /ikke tilladt/);
    await assert.rejects(item.manager.start('../elsewhere/proxy.py'), /ikke tilladt/);
    const symlink = path.join(item.root, 'proxies', 'escape-proxy.py');
    fs.mkdirSync(path.dirname(symlink), { recursive: true });
    try { fs.symlinkSync(outside, symlink); }
    catch (error) {
        if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.diagnostic('Symlink creation unavailable on this host'); return; }
        throw error;
    }
    await assert.rejects(item.manager.start(symlink), /tilladte mappe/);
    assert.equal(item.children.length, 0);
});

test('an occupied port blocks launch without spawning or terminating another process', async t => {
    const checked = [];
    const item = fixture(t, { manager: { isPortBusy: async port => { checked.push(port); return true; } } });
    await item.manager.start(PGL);
    await assert.rejects(item.deps.launch(PGL), /optaget/);
    assert.deepEqual(checked, [5103]);
    assert.equal(item.children.length, 0);
    assert.deepEqual(item.signals, []);
});

test('Stop during an outstanding port check cancels the late child launch', async t => {
    const pending = deferred();
    const item = fixture(t, { manager: { isPortBusy: () => pending.promise } });
    await item.manager.start(PGL);
    const launch = item.deps.launch(PGL);
    await item.manager.stop(PGL);
    pending.resolve(false);
    await assert.rejects(launch, /annulleret/);
    assert.equal(item.children.length, 0);
    assert.equal(item.state().wanted.includes(PGL), false);
});

test('spawn failures close the log descriptor and asynchronous child errors stay handled', async t => {
    const closed = [];
    const io = Object.create(fs);
    io.closeSync = descriptor => { closed.push(descriptor); return fs.closeSync(descriptor); };
    const failure = fixture(t, { manager: { fs: io, spawn() { throw Object.assign(new Error('missing Python'), { code: 'ENOENT' }); } } });
    await failure.manager.start(PGL);
    await assert.rejects(failure.deps.launch(PGL), /missing Python/);
    assert.equal(closed.length, 1);
    assert.throws(() => fs.fstatSync(closed[0]), { code: 'EBADF' });

    const success = fixture(t);
    await success.manager.start(PGL);
    const child = await success.deps.launch(PGL);
    assert.equal(success.deps.inspect(PGL).pid, child.pid);
    assert.doesNotThrow(() => child.emit('error', Object.assign(new Error('spawn failure'), { code: 'ENOENT' })));
    assert.equal(success.deps.inspect(PGL).pid, 0);
});

test('watchdog signals only a currently matching proxy PID', async t => {
    const item = fixture(t);
    await item.manager.start(PGL);
    item.processes.set(50, { pid: 50, scriptPath: path.join(item.root, STAKE), systemd: '' });
    await item.deps.terminate(PGL, 50);
    assert.deepEqual(item.signals, []);
    item.processes.set(50, { pid: 50, scriptPath: path.join(item.root, PGL), systemd: '' });
    await item.deps.terminate(PGL, 50);
    assert.deepEqual(item.signals, [[50, 'SIGKILL']]);
});

test('manual Stop waits asynchronously and does not escalate after PID identity changes', async t => {
    const sleeping = deferred(), enteredSleep = deferred();
    const item = fixture(t, { manager: { sleep() { enteredSleep.resolve(); return sleeping.promise; } } });
    const manager = createProxyManager({ ...item.managerOptions, kill(pid, kind) { item.signals.push([pid, kind]); } });
    t.after(() => manager.shutdown());
    item.processes.set(55, { pid: 55, scriptPath: path.join(item.root, PGL), systemd: '' });
    const stopping = manager.stop(PGL);
    await enteredSleep.promise;
    let unrelatedTaskRan = false;
    await new Promise(resolve => setImmediate(() => { unrelatedTaskRan = true; resolve(); }));
    assert.equal(unrelatedTaskRan, true);
    item.processes.set(55, { pid: 55, scriptPath: path.join(item.root, STAKE), systemd: '' });
    sleeping.resolve();
    await stopping;
    assert.deepEqual(item.signals, [[55, 'SIGTERM']]);
});

test('systemd-owned helpers reject manual stop or port changes without changing state', async t => {
    const item = fixture(t);
    item.processes.set(60, { pid: 60, scriptPath: path.join(item.root, EAFC), systemd: 'eafc-proxy.service' });
    item.manager.restore();
    const before = fs.readFileSync(item.statePath, 'utf8');
    await assert.rejects(item.manager.stop(EAFC), /eafc-proxy\.service/);
    await assert.rejects(item.manager.setPort(EAFC, 6000), /eafc-proxy\.service/);
    assert.equal(fs.readFileSync(item.statePath, 'utf8'), before);
    assert.match(fs.readFileSync(path.join(item.root, EAFC), 'utf8'), /port = 5101/);
    assert.deepEqual(item.signals, []);
});

test('port changes for a stopped, disabled helper preserve the manual stop', async t => {
    const item = fixture(t);
    item.manager.restore();
    await item.manager.stop(PGL);
    await item.manager.setPort(PGL, 6200);
    assert.match(fs.readFileSync(path.join(item.root, PGL), 'utf8'), /port = 6200/);
    assert.equal(item.state().wanted.includes(PGL), false);
    assert.equal(item.state().disabled.includes(PGL), true);
    assert.equal(item.children.length, 0);
});

test('Stop issued during a running port change keeps recovery disabled', async t => {
    const waiting = [], boundaries = [deferred(), deferred()];
    const item = fixture(t, { manager: { sleep() {
        const pending = deferred(); waiting.push(pending);
        boundaries[waiting.length - 1]?.resolve();
        return pending.promise;
    } } });
    const manager = createProxyManager({ ...item.managerOptions, kill(pid, kind) { item.signals.push([pid, kind]); } });
    t.after(() => manager.shutdown());
    manager.restore();
    item.processes.set(65, { pid: 65, scriptPath: path.join(item.root, PGL), systemd: '' });
    const changing = manager.setPort(PGL, 6300);
    await boundaries[0].promise;
    assert.equal(waiting.length, 1);
    const stopping = manager.stop(PGL);
    await boundaries[1].promise;
    assert.equal(waiting.length, 2);
    item.processes.delete(65);
    waiting.forEach(pending => pending.resolve());
    await Promise.all([changing, stopping]);
    assert.equal(item.state().wanted.includes(PGL), false);
    assert.equal(item.state().disabled.includes(PGL), true);
});

test('integration health and port edits understand the conditional command-line default', async t => {
    const probed = [];
    const item = fixture(t, { manager: { probeHttp: async port => { probed.push(port); return true; } } });
    const original = 'import sys\nHOST = "0.0.0.0"\nPORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8787\nTIMEOUT = 30\n';
    const script = item.write(EAFC, original);
    item.processes.set(70, { pid: 70, scriptPath: script, systemd: '' });
    item.manager.restore();
    const info = item.deps.inspect(EAFC);
    assert.equal(info.port, 8787);
    await item.deps.probe(EAFC, info);
    assert.deepEqual(probed, [8787]);
    await item.manager.setPort(EAFC, 9101);
    assert.equal(fs.readFileSync(script, 'utf8'), original.replace('else 8787', 'else 9101'));
    assert.equal(item.deps.inspect(EAFC).port, 9101);
    assert.deepEqual(item.signals, [[70, 'SIGTERM']]);
});

test('a proxy in the main BSPX custom systemd unit remains controllable', async t => {
    const item = fixture(t);
    item.managerOptions.inspector.unit = pid => pid === process.pid ? 'production-graphics.service' : '';
    item.processes.set(75, { pid: 75, scriptPath: path.join(item.root, PGL), systemd: 'production-graphics.service' });
    item.manager.restore();
    await item.manager.stop(PGL);
    assert.deepEqual(item.signals, [[75, 'SIGTERM']]);
    assert.equal(item.state().wanted.includes(PGL), false);
    assert.equal(item.state().disabled.includes(PGL), true);
});
