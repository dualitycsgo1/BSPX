// Extra SPX processes started from the main server.
// Each one has its own port, rundowns and log. Templates stay shared.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function appRoot() {
    if (process.pkg) return path.resolve(process.execPath + '/..');
    return process.cwd();
}

function dir() {
    return path.join(appRoot(), 'instances');
}

function stateFile() {
    return path.join(dir(), 'state.json');
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
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(ids, null, 2));
}

function slug(name) {
    return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
}

function configPath(id) {
    return path.join(dir(), id + '.json');
}

function readConfig(id) {
    return JSON.parse(fs.readFileSync(configPath(id), 'utf8'));
}

function commandOf(pid) {
    try {
        return fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').replace(/\0/g, ' ');
    } catch (error) {
        return '';
    }
}

function findPid(id) {
    if (!fs.existsSync('/proc')) return 0;
    const marker = 'instances/' + id + '.json';
    const entries = fs.readdirSync('/proc');
    for (let i = 0; i < entries.length; i++) {
        if (!/^\d+$/.test(entries[i])) continue;
        const pid = Number(entries[i]);
        if (pid === process.pid) continue;
        const command = commandOf(pid);
        if (command.indexOf('server.js') !== -1 && command.indexOf(marker) !== -1) return pid;
    }
    return 0;
}

function list() {
    if (!fs.existsSync(dir())) return [];
    return fs.readdirSync(dir())
        .filter(function (name) { return name.endsWith('.json') && name !== 'state.json'; })
        .map(function (name) { return name.slice(0, -5); })
        .filter(function (id) { return /^[a-z0-9][a-z0-9-]{0,30}$/.test(id); })
        .sort()
        .map(function (id) {
            let port = '';
            try { port = readConfig(id).general.port; } catch (error) { port = ''; }
            const pid = findPid(id);
            return { id: id, port: port, running: pid > 0 };
        });
}

function usedPorts() {
    const ports = list().map(function (item) { return Number(item.port); });
    if (global.config && global.config.general) ports.push(Number(global.config.general.port));
    return ports;
}

function nextPort() {
    const used = usedPorts();
    for (let port = 8081; port <= 8099; port++) {
        if (used.indexOf(port) === -1) return port;
    }
    throw new Error('Ingen ledige porte mellem 8081 og 8099');
}

function remember(id) {
    const wanted = readState();
    if (wanted.indexOf(id) === -1) {
        wanted.push(id);
        writeState(wanted);
    }
}

function forget(id) {
    writeState(readState().filter(function (item) { return item !== id; }));
}

function create(name, rawPort) {
    const id = slug(name);
    if (!id) throw new Error('Giv instansen et navn');
    if (fs.existsSync(configPath(id))) throw new Error(id + ' findes allerede');
    const port = rawPort ? parseInt(rawPort, 10) : nextPort();
    if (!port || port < 1024 || port > 65535) throw new Error('Port skal være mellem 1024 og 65535');
    if (usedPorts().indexOf(port) !== -1) throw new Error('Port ' + port + ' er optaget');
    const current = global.config && global.config.general ? global.config.general : {};
    const file = {
        general: {
            username: current.username || '',
            password: current.password || '',
            hostname: id,
            greeting: '',
            langfile: current.langfile || 'english.json',
            loglevel: 'info',
            launchBrowser: false,
            apikey: current.apikey || '',
            logfolder: 'LOG-' + id + '/',
            dataroot: 'DATAROOT-' + id + '/',
            templatesource: 'spx-ip-address',
            port: port,
            resolution: current.resolution || 'HD',
            preview: 'none',
            renderer: current.renderer || 'normal',
            managerPort: Number(current.port) || 8080,
            recents: []
        },
        casparcg: { servers: [] },
        osc: { enable: false, port: 57121 },
        globalExtras: { customscript: '/ExtraFunctions/demoFunctions.js', CustomControls: [] }
    };
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(configPath(id), JSON.stringify(file, null, 2));
    return id + ' oprettet på port ' + port;
}

function start(id) {
    if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(id) || !fs.existsSync(configPath(id))) throw new Error('Ukendt instans');
    remember(id);
    if (findPid(id)) return id + ' kører allerede';
    const logDir = path.join(appRoot(), 'LOG', 'instances');
    fs.mkdirSync(logDir, { recursive: true });
    const log = fs.openSync(path.join(logDir, id + '.log'), 'a');
    const child = spawn(process.execPath, [path.join(appRoot(), 'server.js'), path.join('instances', id + '.json')], {
        cwd: appRoot(),
        detached: true,
        env: Object.assign({}, process.env, { SPX_MANAGED: '1' }),
        stdio: ['ignore', log, log]
    });
    fs.closeSync(log);
    child.unref();
    if (!child.pid) throw new Error('Kunne ikke starte ' + id);
    return id + ' startet';
}

function stop(id) {
    if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(id)) throw new Error('Ukendt instans');
    forget(id);
    const pid = findPid(id);
    if (!pid) return id + ' var allerede stoppet';
    process.kill(pid, 'SIGTERM');
    return id + ' stoppet';
}

function remove(id) {
    if (findPid(id)) throw new Error('Stop ' + id + ' før den slettes');
    forget(id);
    if (fs.existsSync(configPath(id))) fs.unlinkSync(configPath(id));
    return id + ' fjernet. Rundowns i DATAROOT-' + id + ' ligger der stadig.';
}

function restore() {
    readState().forEach(function (id) {
        try { start(id); } catch (error) { console.log('Instance restore failed for ' + id + ': ' + error.message); }
    });
}

module.exports = {
    list: list,
    create: create,
    start: start,
    stop: stop,
    remove: remove,
    restore: restore
};
