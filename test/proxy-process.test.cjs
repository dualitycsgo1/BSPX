'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createProcessInspector } = require('../utils/spx_proxy_process.js');

function fixture(rows = {}, aliases = {}) {
    const procRoot = path.resolve('fake-proc');
    const missing = () => { throw Object.assign(new Error('process unavailable'), { code: 'ENOENT' }); };
    const entries = Object.keys(rows);
    const locate = file => {
        const relative = path.relative(procRoot, file).split(path.sep);
        const row = rows[relative[0]];
        if (!row) return missing();
        return { row, name: relative[1] };
    };
    const fs = {
        readdirSync(file) { assert.equal(file, procRoot); return ['self', 'sys', ...entries]; },
        readFileSync(file) {
            const { row, name } = locate(file);
            if (row.unreadable) return missing();
            if (name === 'cmdline') return row.argv.join('\0') + '\0';
            if (name === 'cgroup') return row.cgroup || '';
            return missing();
        },
        readlinkSync(file) {
            const { row, name } = locate(file);
            if (name !== 'cwd' || !row.cwd) return missing();
            return row.cwd;
        },
        realpathSync(file) { return aliases[file] || file; }
    };
    return createProcessInspector({ fs, procRoot, currentPid: 999 });
}

const pglDirectory = path.resolve('fixtures', 'PGL');
const pgl = path.join(pglDirectory, 'proxy.py');
const stake = path.join(pglDirectory, 'stake-proxy.py');

test('find returns the exact Python script, PID and innermost systemd service', () => {
    const inspector = fixture({
        12: { argv: ['/usr/bin/python3.11', '-u', pgl], cgroup: '0::/user.slice/user@1000.service/app.slice/pgl-proxy.service\n' }
    });
    assert.deepEqual(inspector.find(pgl), { pid: 12, scriptPath: pgl, systemd: 'pgl-proxy.service' });
    assert.equal(inspector.matches(12, pgl), true);
    assert.equal(inspector.matches(12, stake), false);
});

test('a different proxy in the same directory and filenames in data arguments never match', () => {
    const inspector = fixture({
        12: { argv: ['python3', stake, pgl], cwd: pglDirectory },
        13: { argv: ['python3', path.join(pglDirectory, 'DBUproxy.py')], cwd: pglDirectory },
        14: { argv: ['node', pgl], cwd: pglDirectory },
        15: { argv: ['not-python3', pgl], cwd: pglDirectory }
    });
    assert.equal(inspector.find(pgl), null);
    for (const pid of [12, 13, 14, 15]) assert.equal(inspector.matches(pid, pgl), false);
    assert.equal(inspector.find(stake).pid, 12);
});

test('relative scripts resolve against the actual process working directory', () => {
    const inspector = fixture({
        12: { argv: ['python', 'proxy.py'], cwd: pglDirectory },
        13: { argv: ['python3', 'proxy.py'], cwd: path.resolve('another-project') },
        14: { argv: ['python3', 'proxy.py'] }
    });
    assert.equal(inspector.find(pgl).pid, 12);
    assert.equal(inspector.matches(13, pgl), false);
    assert.equal(inspector.matches(14, pgl), false);
});

test('Python interpreter flags are parsed before the script only', () => {
    const commands = [
        ['python3', '-u', '-B', pgl],
        ['python3.11', '-uB', '-X', 'dev', '-W', 'ignore', pgl],
        ['/usr/bin/python3', '-Xutf8', '-Wignore', '--check-hash-based-pycs', 'always', pgl],
        ['python', '--check-hash-based-pycs=never', '--', pgl, '-m', 'data-only'],
        ['python3', '-I', '-E', '-s', pgl]
    ];
    for (const argv of commands) assert.equal(fixture({ 12: { argv } }).matches(12, pgl), true, argv.join(' '));
});

test('module and inline commands, unknown flags, stdin, and missing option arguments are rejected', () => {
    const commands = [
        ['python3', '-c', 'print(1)', pgl], ['python3', '-m', 'http.server', pgl],
        ['python3', '-ucprint(1)', pgl], ['python3', '-umhttp.server', pgl],
        ['python3', '--version', pgl], ['python3', '-V', pgl], ['python3', '--help', pgl],
        ['python3', '--unknown', pgl], ['python3', '-z', pgl], ['python3', '-', pgl],
        ['python3', '-X'], ['python3', '-W'], ['python3', '--'],
        ['python3', '--check-hash-based-pycs', 'unknown', pgl]
    ];
    for (const argv of commands) assert.equal(fixture({ 12: { argv } }).matches(12, pgl), false, argv.join(' '));
});

test('explicit aliases and canonical symlinks are accepted without allowing arbitrary filenames', () => {
    const oldPath = path.resolve('fixtures', 'PGL TEST', 'proxy.py');
    const symlink = path.resolve('fixtures', 'pgl-link', 'proxy.py');
    const inspector = fixture({
        12: { argv: ['python3', oldPath] }, 13: { argv: ['python3', symlink] }
    }, { [symlink]: pgl });
    assert.equal(inspector.matches(12, pgl), false);
    assert.equal(inspector.matches(12, pgl, [oldPath]), true);
    assert.equal(inspector.matches(13, pgl), true);
});

test('the current process, disappeared processes and unreadable proc files are ignored', () => {
    const inspector = fixture({
        999: { argv: ['python3', pgl] }, 12: { argv: ['python3', pgl], unreadable: true }
    });
    assert.equal(inspector.find(pgl), null);
    assert.equal(inspector.matches(999, pgl), false);
    assert.equal(inspector.matches(12, pgl), false);
    assert.equal(inspector.matches(13, pgl), false);
    assert.equal(inspector.matches('12/../999', pgl), false);
    assert.equal(inspector.unit(13), '');
});

test('missing proc filesystem does not throw and service parsing handles v1 cgroups', () => {
    const unavailable = createProcessInspector({ fs: { readdirSync() { throw new Error('no proc'); }, readFileSync() { throw new Error('no proc'); } } });
    assert.equal(unavailable.find(pgl), null);
    assert.equal(unavailable.matches(123, pgl), false);
    assert.equal(unavailable.unit(123), '');
    const inspector = fixture({ 12: { argv: ['python3', pgl], cgroup: '9:memory:/system.slice/bspx.service\n8:cpu:/system.slice/bspx.service\n' } });
    assert.equal(inspector.unit(12), 'bspx.service');
});
