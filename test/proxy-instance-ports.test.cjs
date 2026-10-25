'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const instances = require('../utils/spx_instances');

test('configured instance ports are read without process scans or runtime changes', t => {
    const previous = process.cwd();
    const parent = fs.realpathSync(os.tmpdir());
    const root = fs.mkdtempSync(path.join(parent, 'bspx-instance-ports-'));
    t.after(() => {
        process.chdir(previous);
        assert.equal(path.dirname(root), parent);
        assert.ok(path.basename(root).startsWith('bspx-instance-ports-'));
        fs.rmSync(root, { recursive: true, force: true });
    });
    process.chdir(root);
    assert.deepEqual(instances.configuredPorts(), []);
    fs.mkdirSync('instances');
    const put = (name, value) => fs.writeFileSync(path.join('instances', name), JSON.stringify(value));
    put('ralle.json', { general: { port: 5656 } });
    put('another.json', { general: { port: 8081 } });
    put('duplicate.json', { general: { port: '5656' } });
    put('invalid.json', { general: { port: 70000 } });
    put('state.json', ['ralle', 'another']);
    fs.writeFileSync('instances/broken.json', 'invalid');
    const before = fs.readdirSync('instances').map(name => [name, fs.readFileSync(path.join('instances', name), 'utf8')]);
    assert.deepEqual(instances.configuredPorts(), [5656, 8081]);
    assert.deepEqual(fs.readdirSync('instances').map(name => [name, fs.readFileSync(path.join('instances', name), 'utf8')]), before);
    put('third.json', { general: { port: 8093 } });
    assert.deepEqual(instances.configuredPorts(), [5656, 8081, 8093]);
});
