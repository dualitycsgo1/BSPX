'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const writeAtomicJson = require('../utils/spx_atomic_json.js');
const { buildControllerEntries, sortedRundown, serializeRundown, wrapRundown, createItemIdAllocator } = require('../utils/spx_rundown.js');

function graphic(index) {
  return { itemID: String(1900000000000 + index), relpath: '/PGL/predictions.html',
    type: 'old-graphic', templateIndex: 3, onair: index === 7 ? 'true' : 'false',
    DataFields: [{ field: 'caster', value: 'Caster ' + index }], privateMetadata: { index } };
}

function fixture(t) {
  const parent = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(parent, 'bspx-rundown-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), parent);
    assert.ok(path.basename(directory).startsWith('bspx-rundown-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function conflict(error) {
  assert.equal(error.status, 409);
  assert.equal(error.message, 'Rundown changed. Reload before reordering.');
  return true;
}

test('controller entries include 1000 graphics, all dividers, and current derived indexes', () => {
  const data = { templates: Array.from({ length: 1000 }, (_, index) => graphic(index)),
    dividers: [{ id: 'end', position: 1000 }, { id: 'middle', position: 500 },
      { id: 'beginning', position: 0, type: 'old-divider', templateIndex: 800 }] };
  const before = structuredClone(data);
  const entries = buildControllerEntries(data);
  assert.equal(entries.length, 1003);
  assert.equal(entries[0].id, 'beginning');
  assert.equal(entries.at(-1).id, 'end');
  assert.equal(entries[501].id, 'middle');
  const graphics = entries.filter(entry => entry.type === 'graphic');
  assert.equal(graphics.length, 1000);
  graphics.forEach((entry, index) => {
    assert.equal(entry.templateIndex, index);
    assert.deepEqual(entry, { ...data.templates[index], type: 'graphic', templateIndex: index });
  });
  assert.equal(Object.hasOwn(entries[0], 'templateIndex'), false);
  assert.deepEqual(data, before);
  assert.deepEqual(buildControllerEntries({}), []);
});

test('full reorder preserves every field and ID while recomputing divider positions', () => {
  const data = { templates: Array.from({ length: 1000 }, (_, index) => graphic(index)),
    dividers: [{ id: 'first', position: 0, title: 'First', metadata: 'keep' },
      { id: 'last', position: 1000 }], title: 'Live Saturday', controllerEntries: ['stale'] };
  const before = structuredClone(data);
  const reversed = data.templates.slice().reverse();
  const controllerOrder = [{ type: 'divider', id: 'last' },
    ...reversed.map(item => ({ type: 'graphic', id: item.itemID })),
    { type: 'divider', id: 'first' }];
  const result = sortedRundown(data, { controllerOrder });
  assert.deepEqual(result.templates, reversed);
  assert.deepEqual(result.dividers, [{ ...data.dividers[1], position: 0 }, { ...data.dividers[0], position: 1000 }]);
  assert.equal(result.title, data.title);
  assert.equal(Object.hasOwn(result, 'controllerEntries'), false);
  assert.deepEqual(data, before);
});

test('stale, partial, duplicate and unknown order requests cannot remove newly added rows', () => {
  const data = { templates: [graphic(1), graphic(2), graphic(3)], dividers: [{ id: 'd', position: 1 }] };
  const before = structuredClone(data);
  const valid = [{ type: 'graphic', id: data.templates[0].itemID }, { type: 'divider', id: 'd' },
    ...data.templates.slice(1).map(item => ({ type: 'graphic', id: item.itemID }))];
  for (const controllerOrder of [valid.slice(0, -1), [...valid, valid[0]],
    [...valid.slice(0, -1), { type: 'graphic', id: 'unknown' }],
    valid.filter(entry => entry.type !== 'divider'), [{ type: 'unknown', id: 'd' }], [null], []]) {
    assert.throws(() => sortedRundown(data, { controllerOrder }), conflict);
    assert.deepEqual(data, before);
  }
  assert.throws(() => sortedRundown(data, { newTemplateOrderArr: data.templates.slice(0, -1).map(item => item.itemID) }), conflict);
  assert.throws(() => sortedRundown(data, {}), conflict);
});

test('legacy reorder accepts numeric/string IDs and keeps divider positions and metadata', () => {
  const data = { templates: [{ itemID: 1, onair: 'true', DataFields: [] }, { itemID: '2', DataFields: [] }],
    dividers: [{ id: 'd', position: 1, title: 'Keep' }], controllerEntries: ['stale'] };
  const result = sortedRundown(data, { newTemplateOrderArr: [2, '1'] });
  assert.deepEqual(result.templates, [data.templates[1], data.templates[0]]);
  assert.deepEqual(result.dividers, data.dividers);
  assert.equal(Object.hasOwn(result, 'controllerEntries'), false);
  assert.throws(() => sortedRundown({ templates: [{ itemID: '1' }, { itemID: 1 }] }, { newTemplateOrderArr: ['1', 1] }), conflict);
  assert.throws(() => sortedRundown({ templates: [{}] }, { newTemplateOrderArr: [''] }), conflict);
  assert.deepEqual(sortedRundown({ templates: [] }, { newTemplateOrderArr: [] }), { templates: [] });
});

test('serialized atomic read-modify-write preserves all concurrent additions', async t => {
  const directory = fixture(t), file = path.join(directory, 'Main.json');
  await writeAtomicJson(file, JSON.stringify({ templates: [], metadata: 'preserved' }));
  await Promise.all(Array.from({ length: 120 }, (_, index) => serializeRundown(
    index % 2 ? file : path.join(directory, '.', 'Main.json'), async () => {
      const data = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      await new Promise(setImmediate);
      data.templates.push(graphic(index));
      await writeAtomicJson(file, JSON.stringify(data));
    })));
  const result = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(result.templates, Array.from({ length: 120 }, (_, index) => graphic(index)));
  assert.equal(result.metadata, 'preserved');
  assert.equal(fs.readdirSync(directory).filter(name => name.endsWith('.tmp')).length, 0);
});

test('independent rundown files proceed in parallel while same-file work waits', async t => {
  const directory = fixture(t), entered = deferred(), release = deferred();
  const order = [];
  const first = serializeRundown(path.join(directory, 'A.json'), async () => {
    order.push('a-start'); entered.resolve(); await release.promise; order.push('a-finish');
  });
  await entered.promise;
  const second = serializeRundown(path.join(directory, 'A.json'), () => order.push('a-next'));
  try {
    await serializeRundown(path.join(directory, 'B.json'), () => order.push('b'));
    assert.deepEqual(order, ['a-start', 'b']);
  } finally { release.resolve(); await Promise.all([first, second]); }
  assert.deepEqual(order, ['a-start', 'b', 'a-finish', 'a-next']);
});

test('a failed or synchronous throwing mutation releases the same-file lock', async t => {
  const file = path.join(fixture(t), 'Main.json'), order = [];
  const failed = serializeRundown(file, () => { throw new Error('failed mutation'); });
  const observed = assert.rejects(failed, /failed mutation/);
  const following = serializeRundown(file, () => { order.push('recovered'); return 7; });
  await observed;
  assert.equal(await following, 7);
  assert.deepEqual(order, ['recovered']);
});

test('middleware serializes full handler lifetimes and forwards resolver/handler errors', async t => {
  const file = path.join(fixture(t), 'Main.json'), entered = deferred(), release = deferred(), order = [], errors = [];
  const handler = wrapRundown(req => req.file, async req => {
    order.push(req.name);
    if (req.name === 'first') { entered.resolve(); await release.promise; }
    if (req.name === 'failed') throw new Error('handler failed');
  });
  const first = handler({ file, name: 'first' }, {}, error => errors.push(error));
  await entered.promise;
  const second = handler({ file, name: 'second' }, {}, error => errors.push(error));
  await new Promise(setImmediate);
  assert.deepEqual(order, ['first']);
  release.resolve(); await Promise.all([first, second]);
  assert.deepEqual(order, ['first', 'second']);
  await handler({ file, name: 'failed' }, {}, error => errors.push(error));
  await wrapRundown(() => { throw new Error('resolver failed'); }, () => {})({}, {}, error => errors.push(error));
  assert.deepEqual(errors.map(error => error.message), ['handler failed', 'resolver failed']);
});

test('empty-path middleware and serialization bypass any shared file lock', async () => {
  const entered = deferred(), release = deferred(), order = [];
  const first = serializeRundown('', async () => { entered.resolve(); await release.promise; order.push('first'); });
  await entered.promise;
  try {
    await serializeRundown(undefined, () => order.push('independent'));
    await wrapRundown(() => '', () => order.push('handler'))({}, {}, error => { throw error; });
    assert.deepEqual(order, ['independent', 'handler']);
  } finally { release.resolve(); await first; }
});

test('item ID allocation skips existing IDs and all earlier allocations at the same millisecond', () => {
  const existing = [{ itemID: '1792497091230' }, { itemID: 1792497091231 },
    { itemID: '1792497091233' }, { itemID: 'unrelated-id' }];
  const before = structuredClone(existing);
  const allocate = createItemIdAllocator(existing, 1792497091230);
  assert.deepEqual([allocate(), allocate(), allocate()], ['1792497091232', '1792497091234', '1792497091235']);
  const nextRequest = createItemIdAllocator([...existing, { itemID: '1792497091232' },
    { itemID: '1792497091234' }, { itemID: '1792497091235' }], 1792497091230);
  assert.equal(nextRequest(), '1792497091236');
  assert.deepEqual(existing, before);
  assert.equal(createItemIdAllocator([], '9007199254740993')(), '9007199254740993');
});
