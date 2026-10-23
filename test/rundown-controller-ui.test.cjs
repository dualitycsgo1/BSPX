'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function initialize(search = '', count = 1000) {
  const source = fs.readFileSync(path.join(__dirname, '../static/js/spx_gc.js'), 'utf8');
  const start = source.indexOf('function spxInit()');
  const end = source.indexOf('} // end spxInit', start) + '} // end spxInit'.length;
  assert.ok(start >= 0 && end > start, 'spxInit source was not found');
  const calls = [], list = { style: {} };
  const rows = Array.from({ length: count }, (_, index) => ({
    id: String(1900000000000 + index),
    classList: { add(value) { calls.push(['class', index, value]); } },
    getAttribute(name) { assert.equal(name, 'data-spx-epoch'); return this.id; },
    scrollIntoView(options) { calls.push(['scroll', index, options.block]); }
  }));
  const location = { search, href: 'http://localhost/gc/PGTEST/Main' + search + '#keep' };
  const context = { URL, URLSearchParams, Array, document: {
    getElementById(id) { assert.equal(id, 'itemList'); return list; },
    querySelector(selector) { assert.equal(selector, '.itemrow'); return rows[0] || null; },
    querySelectorAll(selector) { assert.equal(selector, '#itemList > .itemrow'); return rows; }
  }, window: { location, history: { replaceState(...args) { calls.push(['history', ...args]); } } },
  Sortable: { create(target, options) { assert.equal(target, list); calls.push(['sortable', options.draggable]); } },
  itemList: list, sortable: '', ife: id => { assert.equal(id, 'identifier'); return { value: 'controller' }; },
  isControllerView: () => true,
  setMasterButtonStates(row) { calls.push(['buttons', row.id]); },
  selectControllerItem(row) { calls.push(['select', row.id]); },
  AppState(value) { calls.push(['state', value]); },
  spx_system(command) { calls.push(['system', command]); },
  SaveControllerOrder() { throw Error('Initializing must not reorder the rundown.'); },
  focusRow() { throw Error('Initializing this controller must not preview or play a graphic.'); }
  };
  vm.runInNewContext(source.slice(start, end) + '\nspxInit();', context);
  return { calls, rows, list };
}

test('a newly appended graphic in a 1000-row rundown is selected and scrolled into view without playout', () => {
  const result = initialize('?keep=value&added=1900000000999');
  assert.deepEqual(result.calls.filter(call => call[0] === 'select'), [['select', '1900000000999']]);
  assert.deepEqual(result.calls.filter(call => call[0] === 'scroll'), [['scroll', 999, 'nearest']]);
  assert.deepEqual(result.calls.filter(call => call[0] === 'system'), [['system', 'CHECKCONNECTIONS']]);
  assert.equal(result.list.style.opacity, 1);
  const history = result.calls.find(call => call[0] === 'history');
  assert.equal(history[3], 'http://localhost/gc/PGTEST/Main?keep=value#keep');
});

test('normal controller reload does not select a different graphic or scroll to the bottom', () => {
  const { calls } = initialize('?keep=value');
  assert.equal(calls.some(call => ['select', 'scroll', 'history'].includes(call[0])), false);
  assert.deepEqual(calls.filter(call => call[0] === 'system'), [['system', 'CHECKCONNECTIONS']]);
});

test('a removed or unknown added item does not select another row and safely clears its URL marker', () => {
  const { calls } = initialize('?added=missing&keep=value');
  assert.equal(calls.some(call => ['select', 'scroll'].includes(call[0])), false);
  assert.equal(calls.find(call => call[0] === 'history')[3], 'http://localhost/gc/PGTEST/Main?keep=value#keep');
  assert.doesNotThrow(() => initialize('?added=missing', 0));
});
