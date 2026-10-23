'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServiceOwnership } = require('../utils/spx_proxy_services');

function fixture(t) {
    const parent = fs.realpathSync(os.tmpdir());
    const root = fs.mkdtempSync(path.join(parent, 'bspx-proxy-services-'));
    t.after(() => {
        assert.equal(path.dirname(root), parent);
        assert.ok(path.basename(root).startsWith('bspx-proxy-services-'));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const write = (relative, text) => {
        const file = path.join(root, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
        return file;
    };
    const script = write('eafc/integration/proxy.py', 'port = 8787\n');
    const alias = write('eafc/proxy.py', 'port = 8787\n');
    const calls = [];
    const states = new Map();
    const execFile = (command, args, options, callback) => {
        calls.push({ command, args, options });
        const value = states.get(args.at(-1)) || 'loaded';
        if (value instanceof Error) callback(value);
        else callback(null, value + '\n');
    };
    const ownership = createServiceOwnership({ platform: 'linux', execFile });
    return { root, write, script, alias, calls, states, execFile, ownership };
}

test('an inactive installed alias sidecar retains ownership without starting any service', async t => {
    const item = fixture(t);
    item.write('eafc/eafc.sidecar', '# project helper\nname=eafc-proxy\nexec=python3 proxy.py\n');
    assert.equal(await item.ownership.ownerFor(item.script, [item.alias]), 'eafc-proxy.service');
    assert.equal(item.calls.length, 1);
    assert.equal(item.calls[0].command, 'systemctl');
    assert.deepEqual(item.calls[0].args, ['show', '--property=LoadState', '--value', '--', 'eafc-proxy.service']);
    assert.equal(item.calls[0].options.timeout, 1500);
    assert.equal(item.calls[0].options.maxBuffer, 8192);
});

test('a different proxy in the same folder or a filename in data arguments is not an owner', async t => {
    const item = fixture(t);
    item.write('eafc/other.sidecar', 'name=other-helper\nexec=python3 stake-proxy.py proxy.py\n');
    item.write('eafc/module.sidecar', 'name=module-helper\nexec=python3 -m http.server proxy.py\n');
    item.write('eafc/inline.sidecar', 'name=inline-helper\nexec=python3 -c "print(1)" proxy.py\n');
    assert.equal(await item.ownership.ownerFor(item.script, [item.alias]), null);
    assert.equal(item.calls.length, 0);
});

test('literal quoted paths and Python flags resolve to the exact target script', async t => {
    const item = fixture(t);
    const script = item.write('quoted/inner directory/proxy.py', 'port = 8787\n');
    item.write('quoted/test.sidecar', 'name=quoted-helper\nexec=/usr/bin/python3.11 -u -B -X dev "inner directory/proxy.py"\n');
    assert.equal(await item.ownership.ownerFor(script, [path.join(item.root, 'quoted', 'wrapper.py')]), 'quoted-helper.service');
});

test('shell expansion, shell operators, malformed quoting and unsafe service names are rejected', async t => {
    const item = fixture(t);
    const commands = ['python3 proxy.py && touch marker', 'python3 $SCRIPT', 'python3 `echo proxy.py`', 'python3 "proxy.py', 'bash -lc "python3 proxy.py"'];
    commands.forEach((command, index) => item.write(`eafc/unsafe${index}.sidecar`, `name=unsafe${index}\nexec=${command}\n`));
    item.write('eafc/bad-name.sidecar', 'name=../../other\nexec=python3 proxy.py\n');
    assert.equal(await item.ownership.ownerFor(item.script, [item.alias]), null);
    assert.equal(item.calls.length, 0);
});

test('a not-installed sidecar allows standalone supervision and an unknown query error fails closed', async t => {
    const item = fixture(t);
    item.write('eafc/eafc.sidecar', 'name=eafc-proxy\nexec=python3 proxy.py\n');
    item.states.set('eafc-proxy.service', 'not-found');
    assert.equal(await item.ownership.ownerFor(item.script, [item.alias]), null);
    item.states.set('eafc-proxy.service', new Error('systemd unavailable'));
    await assert.rejects(item.ownership.ownerFor(item.script, [item.alias]), /kontrollere proxy-tjenesten eafc-proxy\.service/);
});

test('a confirmed owner survives transient query errors and stable alias ordering', async t => {
    const item = fixture(t);
    item.write('eafc/eafc.sidecar', 'name=eafc-proxy\nexec=python3 proxy.py\n');
    assert.equal(await item.ownership.ownerFor(item.script, [item.alias]), 'eafc-proxy.service');
    item.states.set('eafc-proxy.service', new Error('temporary systemd error'));
    assert.equal(await item.ownership.ownerFor(item.alias, [item.script]), 'eafc-proxy.service');
});

test('a previously observed external owner remains authoritative without a sidecar', async t => {
    const item = fixture(t);
    assert.equal(item.ownership.remember(item.script, 'existing-helper.service', [item.alias]), true);
    item.states.set('existing-helper.service', new Error('temporary systemd error'));
    assert.equal(await item.ownership.ownerFor(item.alias, [item.script]), 'existing-helper.service');
    assert.equal(item.ownership.remember(item.script, 'x.service;touch-marker'), false);
});

test('a missing remembered service releases ownership and no sidecar means no systemctl calls', async t => {
    const item = fixture(t);
    assert.equal(await item.ownership.ownerFor(item.script), null);
    assert.equal(item.calls.length, 0);
    item.ownership.remember(item.script, 'removed.service');
    item.states.set('removed.service', 'LoadState=not-found');
    assert.equal(await item.ownership.ownerFor(item.script), null);
    assert.equal(await item.ownership.ownerFor(item.script), null);
    assert.equal(item.calls.length, 1);
});

test('Windows never reads service metadata or invokes systemctl', async t => {
    const item = fixture(t);
    const ownership = createServiceOwnership({ platform: 'win32', execFile() { assert.fail('No systemctl on Windows'); }, fs: { realpathSync() { assert.fail('No service metadata on Windows'); } } });
    assert.equal(ownership.remember(item.script, 'example.service'), false);
    assert.equal(await ownership.ownerFor(item.script, [item.alias]), null);
});
