const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const helper = path.resolve(__dirname, '../utils/spx_atomic_json.js');
const localRequire = createRequire(helper);
const initial = { templates: [{ itemID: '1', DataFields: [{ field: 'name', value: 'Original' }] }] };

function fixture(t) {
  const parent = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(parent, 'bspx-atomic-json-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), parent);
    assert.ok(path.basename(directory).startsWith('bspx-atomic-json-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const target = path.join(directory, 'Main.json');
  fs.writeFileSync(target, JSON.stringify(initial));
  return { directory, target, read: () => JSON.parse(fs.readFileSync(target, 'utf8')) };
}

function loadAtomic(overrides = {}) {
  const filesystem = { ...fs, promises: { ...fs.promises, ...overrides } };
  const context = { module: { exports: {} }, process, setTimeout,
    require: name => name === 'fs' ? filesystem : localRequire(name) };
  vm.runInNewContext(fs.readFileSync(helper, 'utf8'), context, { filename: helper });
  return context.module.exports;
}

function loadSpx(atomic = loadAtomic()) {
  const context = { module: { exports: {} }, config: { general: { port: 8080 } }, console,
    require(name) {
      if (name === 'fs') return fs;
      if (name === './logger.js') return { verbose() {}, warn() {}, error() {} };
      if (name === './spx_atomic_json.js') return atomic;
      if (['path', 'crypto', 'http'].includes(name)) return localRequire(name);
      return {};
    } };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../utils/spx_server_functions.js'), 'utf8'), context);
  return context.module.exports;
}

function noTemporaryFiles(directory) {
  assert.deepEqual(fs.readdirSync(directory).filter(name => name.endsWith('.tmp')), []);
}

test('300 concurrent saves expose only complete JSON to continuous readers', async t => {
  const { directory, target, read } = fixture(t);
  const write = loadSpx().writeFile;
  let running = true, reads = 0;
  const failures = [];
  const observer = (async () => {
    while (running) {
      try {
        const data = read();
        assert.ok(Array.isArray(data.templates));
        if (data.iteration !== undefined) assert.equal(data.padding, String(data.iteration).padEnd(250000, 'x'));
      } catch (error) { failures.push(error.message); }
      reads++;
      // Poll continuously without holding a Windows read handle on virtually
      // every event-loop tick, which can starve rename's required sharing lock.
      await new Promise(resolve => setTimeout(resolve, 2));
    }
  })();
  try {
    await Promise.all(Array.from({ length: 300 }, (_, iteration) => write(target, {
      ...structuredClone(initial), iteration, padding: String(iteration).padEnd(250000, 'x')
    })));
  } finally { running = false; await observer; }
  assert.deepEqual(failures, []);
  assert.ok(reads > 0, 'No concurrent reads observed');
  assert.equal(read().iteration, 299);
  assert.deepEqual(read().templates, initial.templates);
  assert.ok(read().warning && read().copyright && read().updated);
  noTemporaryFiles(directory);
  t.diagnostic(`${reads} reads, zero invalid or incomplete documents`);
});

test('the previous file remains readable while replacement is pending; saves stay in order', async t => {
  const { directory, target, read } = fixture(t);
  let release, reached;
  const gate = new Promise(resolve => { release = resolve; });
  const arrived = new Promise(resolve => { reached = resolve; });
  const order = [];
  const write = loadAtomic({ async rename(from, to) {
    order.push(JSON.parse(fs.readFileSync(from, 'utf8')).iteration);
    if (order.length === 1) { reached(); await gate; }
    return fs.promises.rename(from, to);
  } });
  const first = write(target, '{"templates":[],"iteration":1}');
  const second = write(target, '{"templates":[],"iteration":2}');
  try {
    await arrived;
    for (let i = 0; i < 20; i++) assert.deepEqual(read(), initial);
    assert.deepEqual(order, [1]);
  } finally { release(); }
  await Promise.all([first, second]);
  assert.deepEqual(order, [1, 2]);
  assert.equal(read().iteration, 2);
  noTemporaryFiles(directory);
});

test('a disk write failure rejects and preserves the original file', async t => {
  const { directory, target, read } = fixture(t);
  const write = loadAtomic({ async open(...args) {
    const handle = await fs.promises.open(...args);
    return { chmod: (...values) => handle.chmod(...values), close: () => handle.close(),
      async writeFile() { throw new Error('Injected disk full'); } };
  } });
  await assert.rejects(write(target, '{"templates":[]}'), /Injected disk full/);
  assert.deepEqual(read(), initial);
  noTemporaryFiles(directory);
});

test('a rename failure preserves the original; an already queued save can recover', async t => {
  const { directory, target, read } = fixture(t);
  let attempts = 0;
  const write = loadAtomic({ async rename(...args) {
    if (++attempts <= 2) throw new Error('Injected rename refusal');
    return fs.promises.rename(...args);
  } });
  await assert.rejects(write(target, '{"templates":[]}'), /Injected rename refusal/);
  assert.deepEqual(read(), initial);
  noTemporaryFiles(directory);
  const failed = write(target, '{"templates":[],"iteration":1}');
  const handled = assert.rejects(failed, /Injected rename refusal/);
  const next = write(target, '{"templates":[],"iteration":2}');
  await handled;
  await next;
  assert.equal(read().iteration, 2);
  noTemporaryFiles(directory);
});

test('independent targets save concurrently and new files can be created', async t => {
  const { directory } = fixture(t);
  const write = loadSpx().writeFile;
  await Promise.all(['a.json', 'b.json'].map(name => write(path.join(directory, name), structuredClone(initial))));
  for (const name of ['a.json', 'b.json']) {
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, name))).templates, initial.templates);
  }
  noTemporaryFiles(directory);
});

test('invalid input and missing directories reject without changing the rundown', async t => {
  const { target, read } = fixture(t);
  const write = loadSpx().writeFile;
  await assert.rejects(write('', {}), /filepath/);
  const circular = {}; circular.self = circular;
  await assert.rejects(write(target, circular), /circular/i);
  await assert.rejects(write(path.join(path.dirname(target), 'missing', 'Main.json'), {}), /ENOENT/);
  assert.deepEqual(read(), initial);
});

test('replacement preserves existing POSIX permissions', { skip: process.platform === 'win32' }, async t => {
  const { target } = fixture(t);
  fs.chmodSync(target, 0o640);
  await loadAtomic()(target, '{"templates":[]}');
  assert.equal(fs.statSync(target).mode & 0o777, 0o640);
});

test('the existing saveItemChanges route saves the selected fields successfully', async t => {
  const { target, read } = fixture(t);
  const routes = fs.readFileSync(path.resolve(__dirname, '../routes/routes-application.js'), 'utf8');
  const start = routes.indexOf("router.post('/gc/saveItemChanges'");
  const end = routes.indexOf('}); // saveItemChanges ended', start) + '}); // saveItemChanges ended'.length;
  assert.ok(start >= 0 && end > start);
  let handler;
  const spx = loadSpx();
  vm.runInNewContext(routes.slice(start, end), { path, console, global: {},
    logger: { verbose() {}, error() {} }, spxAuth: { CheckLogin() {} },
    router: { post(_url, _auth, callback) { handler = callback; } },
    async GetJsonData(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); },
    spx: { ...spx, RemoveFilepathKey: data => data, generateCollapsedHeadline: () => 'Updated' } });
  let status, response;
  await handler({ body: { rundownfile: target, epoch: '1', DataFields: [{ field: 'name', value: 'New selection' }] } }, {
    status(code) { status = code; return this; }, send(value) { response = value; } });
  assert.equal(status, 200, String(response));
  assert.equal(read().templates[0].DataFields[0].value, 'New selection');
  assert.equal(response[0], 'Item changes saved');
});
