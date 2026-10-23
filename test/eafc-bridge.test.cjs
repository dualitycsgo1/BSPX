const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const runtimeDirectory = path.resolve(__dirname, '../static/js');
const context = {
  templateRoot: 'http://bspx.example/templates/',
  preview: false,
  local: true,
  validateLayer: value => Number(value),
};
const message = {
  spxcmd: 'playTemplate', webplayout: 5, projectFormat: 'SPX',
  relpath: 'eafc/results.html', itemID: 'current-item',
  fields: [{ field: 'subTournament', value: '2' }],
};

function eafcFixture() {
  const calls = [];
  const state = { busy: false };
  const player = {
    select: async (name, data) => { calls.push(['select', name, data]); return true; },
    clear: () => calls.push(['clear']),
    getState: () => state,
  };
  const contentWindow = {
    EAFCFullscreen: player,
    update: async data => calls.push(['update', data]),
    stop: () => calls.push(['stop']),
    next: () => calls.push(['next']),
  };
  const frame = {
    contentWindow,
    set src(value) {
      this.url = value;
      queueMicrotask(() => this.onload?.());
    },
  };
  const window = { PGLFullscreenTransitions: { reset: () => calls.push(['pglReset']) } };
  vm.runInNewContext(fs.readFileSync(path.join(runtimeDirectory, 'eafc_fullscreen_bridge.js'), 'utf8'), {
    window,
    document: { getElementById: id => id === 'layer5' ? frame : null },
    location: { href: 'http://bspx.example/renderer', origin: 'http://bspx.example', search: '' },
    URL, URLSearchParams, console, setTimeout, clearTimeout,
  });
  return { api: window.EAFCFullscreenBridge, calls, frame, state };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('EAFC bridge leaves preview, other layers, remote autoplay and unrelated templates to BSPX', () => {
  const { api, calls } = eafcFixture();
  assert.equal(api.handle({ ...message, webplayout: 4 }, context), false);
  assert.equal(api.handle(message, { ...context, preview: true }), false);
  assert.equal(api.handle({ ...message, modify: 'autoPlayLocal' }, { ...context, local: false }), false);
  assert.equal(api.handle({ ...message, relpath: 'wingscup2/results.html' }, context), false);
  assert.equal(api.handle({ ...message, relpath: 'https://other.example/eafc/results.html' }, context), false);
  assert.equal(calls.length, 0);
});

test('EAFC takes use the persistent fullscreen player and forward selected qualification fields', async () => {
  const { api, calls, frame } = eafcFixture();
  assert.equal(api.handle(message, context), true);
  await flush();
  assert.equal(new URL(frame.url).pathname, '/templates/eafc/fullscreen.html');
  assert.equal(calls.filter(call => call[0] === 'pglReset').length, 1);
  const selection = calls.find(call => call[0] === 'select');
  assert.equal(selection[1], 'results');
  assert.equal(selection[2].subTournament, '2');
  assert.equal(api.getState().selected, 'eafc/results.html');
});

test('EAFC ignores an old item stop, updates the current item, and forwards its next and stop', async () => {
  const { api, calls } = eafcFixture();
  api.handle(message, context);
  await flush();
  assert.equal(api.handle({ ...message, spxcmd: 'stopTemplate', itemID: 'previous-item' }, context), true);
  assert.equal(calls.filter(call => call[0] === 'stop').length, 0);
  assert.equal(api.handle({
    ...message, spxcmd: 'updateTemplate',
    fields: JSON.stringify([{ field: 'subTournament', value: '3' }]),
  }, context), true);
  await flush();
  assert.equal(calls.find(call => call[0] === 'update')[1].subTournament, '3');
  assert.equal(api.handle({ ...message, spxcmd: 'nextTemplate' }, context), true);
  assert.equal(calls.filter(call => call[0] === 'next').length, 1);
  assert.equal(api.handle({ ...message, spxcmd: 'stopTemplate' }, context), true);
  assert.equal(calls.filter(call => call[0] === 'stop').length, 1);
});

test('EAFC clear releases the persistent selection and still reaches the normal BSPX clear handler', async () => {
  const { api, calls } = eafcFixture();
  api.handle(message, context);
  await flush();
  assert.equal(api.handle({ spxcmd: 'clearLayer', layerno: 5 }, context), false);
  assert.equal(api.getState().selected, '');
  assert.equal(calls.filter(call => call[0] === 'clear').length, 1);
});

function pglFixture() {
  const frames = [];
  const root = { append: frame => frames.push(frame) };
  const window = { dispatchEvent() {} };
  vm.runInNewContext(fs.readFileSync(path.join(runtimeDirectory, 'pgl_fullscreen_transitions.js'), 'utf8'), {
    window,
    document: {
      getElementById: id => id === 'root' ? root : null,
      createElement: () => ({ style: {}, setAttribute() {}, remove() {} }),
    },
    location: { href: 'http://bspx.example/renderer', origin: 'http://bspx.example', search: '' },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    URL, URLSearchParams, console, setTimeout, clearTimeout,
  });
  return { api: window.PGLFullscreenTransitions, frames };
}

test('PGL transitions accept predictions in the renamed PGL folder and retain the existing folder names', async () => {
  for (const relpath of ['PGL/predictions.html', 'PGL/next-match.html', 'PGL%20TEST/player.html', 'pgl-masters/team.html']) {
    const { api, frames } = pglFixture();
    try {
      assert.equal(api.handle({ ...message, relpath }, context), true, relpath);
      assert.equal(api.getState().pending.relpath, relpath);
      assert.equal(frames.length, 1);
    } finally {
      // Cancel the staged load so no timer, media player or network is involved.
      api.reset();
    }
  }
  await flush();
});

test('PGL transitions do not claim unrelated, cross-origin or preview graphics', () => {
  const { api, frames } = pglFixture();
  assert.equal(api.handle({ ...message, relpath: 'wingscup2/player.html' }, context), false);
  assert.equal(api.handle({ ...message, relpath: 'https://other.example/PGL/predictions.html' }, context), false);
  assert.equal(api.handle({ ...message, relpath: 'PGL/predictions.html' }, { ...context, preview: true }), false);
  assert.equal(frames.length, 0);
});
