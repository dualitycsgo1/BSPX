'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const applicationFile = path.join(__dirname, '..', 'routes', 'routes-application.js');
const dataroot = path.resolve('/bspx-controller-test/DATAROOT');
const mainFile = path.join(dataroot, 'PGL', 'data', 'Main.json');
const secondFile = path.join(dataroot, 'PGL', 'data', 'Other.json');
const profileFile = path.join(dataroot, 'PGL', 'profile.json');
const frozenNow = 1792497091230;
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function graphic(index, overrides = {}) {
  return {
    itemID: String(1900000000000 + index), description: 'Graphic ' + index,
    relpath: '/PGL/graphic-' + index + '.html', type: 'stale-type', templateIndex: 9999,
    playserver: '-', playchannel: '1', playlayer: '5', webplayout: '5', out: 'manual',
    onair: 'false', dataformat: 'json',
    DataFields: [{ field: 'name', ftype: 'textfield', value: 'Caster ' + index, title: 'Name' }],
    privateMetadata: { index, preserve: ['all', 'fields'] }, ...overrides
  };
}

// Execute the actual registered handlers without opening a server, renderer,
// socket, production dataroot, or installing the application's dependencies.
function application({ count = 3, profileCount = 2 } = {}) {
  const records = new Map([
    [mainFile, { title: 'Saturday live', metadata: { keep: true }, project: 'PGL', rundown: 'Main',
      templates: Array.from({ length: count }, (_, index) => graphic(index)),
      controllerEntries: [graphic(-1)],
      dividers: [{ id: 'first', position: 0, title: 'Opening', metadata: { keep: true } },
        { id: 'last', position: count, title: 'Closing' }] }],
    [secondFile, { title: 'Other live', project: 'PGL', rundown: 'Other', templates: [graphic(9000)] }],
    [profileFile, { projectFormat: 'SPX', templates: Array.from({ length: profileCount }, (_, index) =>
      graphic(5000 + index, { itemID: 'profile-id-' + index, onair: 'true' })) }]
  ]);
  const routes = new Map(), writes = [], playout = [], sockets = [], logs = [];
  const state = { rundownData: clone(records.get(mainFile)),
    config: { general: { dataroot, preview: 'none', resolution: 'HD' } } };
  const logger = Object.fromEntries(['debug', 'verbose', 'info', 'warn', 'error'].map(level =>
    [level, (...args) => logs.push({ level, args })]));
  const router = Object.fromEntries(['get', 'post', 'delete'].map(method => [method,
    (route, ...handlers) => routes.set(method.toUpperCase() + ' ' + route, handlers.at(-1))]));
  const mockFs = {
    existsSync(file) { return records.has(path.normalize(file)) || /\.html?$/.test(file); },
    readFileSync(file) {
      const record = records.get(path.normalize(file));
      assert.notEqual(record, undefined, 'read only an in-memory fixture: ' + file);
      return JSON.stringify(record);
    }
  };
  const spx = {
    getEasterEggImage: () => ['', ''], getStartUpFolder: () => '/bspx-controller-test',
    getDatarootFolder: () => dataroot, GetFilesAndFolders: () => ({}), setRecents() {},
    getNotificationsMiddleware() {}, CCGServersConfigured: false,
    RemoveFilepathKey(data) { delete data.filepath; return data; },
    cleanUpString: value => value,
    generateCollapsedHeadline: fields => JSON.stringify(fields),
    async appendProjectFile(data, file) {
      data.project = path.basename(path.dirname(path.dirname(file)));
      data.rundown = path.basename(file, '.json');
      return data;
    },
    async writeFile(file, data) {
      // A delayed write makes overlapping read-modify-write requests observable.
      const snapshot = clone(data);
      await new Promise(setImmediate);
      records.set(path.normalize(file), snapshot);
      writes.push({ file: path.normalize(file), data: snapshot });
    }
  };
  class FrozenDate extends Date { static now() { return frozenNow; } }
  const modules = {
    express: { Router: () => router }, path, fs: mockFs,
    moment: () => ({ format: () => '2026-10-23' }),
    '../utils/logger': logger, '../utils/spx_server_functions.js': spx,
    '../utils/spx_getconf.js': {}, '../utils/playout_casparCG.js': {
      playoutController: data => playout.push({ renderer: 'caspar', data: clone(data) })
    },
    '../utils/playout_webplayer.js': {
      webPlayoutController: data => playout.push({ renderer: 'web', data: clone(data) })
    },
    '../utils/spx_auth.js': { CheckLogin() {}, Logout() {} }, jsdom: { JSDOM: class {} },
    cors: () => () => {}, console: { timeStamp() {} }, http: {}, axios: {},
    '../utils/spx_proxies.js': {}, '../utils/spx_instances.js': {}, '../utils/spx_layernames.js': {},
    '../utils/spx_rundown.js': require('../utils/spx_rundown.js')
  };
  const context = vm.createContext({
    require(name) {
      assert.ok(Object.hasOwn(modules, name), 'explicitly stub every application dependency: ' + name);
      return modules[name];
    },
    module: { exports: {} }, config: state.config, global: state, Date: FrozenDate,
    console: { ...console, error: (...args) => logs.push({ level: 'console-error', args }) },
    process: { env: {} }, io: { emit: (...args) => sockets.push(clone(args)) },
    setTimeout() { return 1; }, clearTimeout() {}, Buffer, URL, __dirname: path.dirname(applicationFile)
  });
  vm.runInContext(fs.readFileSync(applicationFile, 'utf8'), context, { filename: applicationFile });

  async function request(method, route, body = {}, extra = {}) {
    const handler = routes.get(method + ' ' + route);
    assert.equal(typeof handler, 'function', 'actual application route is registered: ' + route);
    const response = { statusCode: 200, complete: false,
      status(code) { this.statusCode = code; return this; },
      send(value) { this.body = clone(value); this.complete = true; return this; },
      json(value) { return this.send(value); },
      redirect(url) { this.location = url; this.statusCode = 302; this.complete = true; },
      render(view, data) { this.view = view; this.data = clone(data); this.complete = true; }
    };
    await handler({ body: clone(body), params: { foldername: 'PGL', filename: 'Main' },
      query: {}, session: {}, ...extra }, response, error => { throw error; });
    assert.equal(response.complete, true, 'handler must send a response, logs: ' + JSON.stringify(logs));
    return response;
  }
  function add(templateindex = 0, command = 'addItemToRundown') {
    return request('POST', '/gc/:foldername/:filename/', {
      command, foldername: 'PGL', listname: 'Main', datafile: mainFile, templateindex
    });
  }
  return { records, writes, playout, sockets, state, logs, request, add,
    read: (file = mainFile) => clone(records.get(file)) };
}

test('controller GET rebuilds all 1,205 graphic rows from the canonical rundown, beyond the profile count', async () => {
  const app = application({ count: 1205, profileCount: 3 });
  const before = app.read();
  before.templates[3].DataFields = [];
  delete before.templates[4].DataFields;
  app.records.set(mainFile, before);
  const response = await app.request('GET', '/gc/:foldername/:filename/:mode?');
  assert.equal(response.statusCode, 200);
  assert.equal(response.data.filedata.templates.length, 1205);
  const entries = response.data.filedata.controllerEntries;
  assert.equal(entries.length, 1207);
  assert.equal(entries[0].id, 'first');
  assert.equal(entries.at(-1).id, 'last');
  const graphics = entries.filter(entry => entry.type === 'graphic');
  assert.equal(graphics.length, 1205);
  graphics.forEach((entry, index) => {
    assert.equal(entry.templateIndex, index);
    assert.equal(entry.itemID, before.templates[index].itemID);
    assert.deepEqual(entry.privateMetadata, before.templates[index].privateMetadata);
  });
  assert.deepEqual(graphics[3].DataFields, [], 'a graphic with zero editor fields still renders');
  assert.deepEqual(graphics[4].DataFields, [], 'legacy graphics without DataFields still render');
  const mini = await app.request('GET', '/gc/:foldername/:filename/:mode?', {}, {
    params: { foldername: 'PGL', filename: 'Main', mode: 'light' }
  });
  assert.equal(mini.view, 'view-controllermini');
  assert.equal(mini.data.filedata.controllerEntries.filter(entry => entry.type === 'graphic').length, 1205);
  assert.deepEqual(app.read(), before, 'render normalization must not change the canonical data on disk');
  assert.equal(app.writes.length, 0, 'rendering must not rewrite a live rundown');
  assert.equal(app.playout.length, 0);
});

test('repeated and concurrent additions at the same millisecond keep all rows, unique IDs, field values and metadata', async () => {
  const app = application({ count: 1001 });
  const before = app.read(), profileBefore = app.read(profileFile);
  const responses = await Promise.all(Array.from({ length: 32 }, (_, index) => app.add(index % 2)));
  responses.forEach(response => {
    assert.equal(response.statusCode, 302);
    assert.match(response.location, /\/gc\/PGL\/Main\?added=/);
  });
  const after = app.read();
  assert.equal(after.templates.length, before.templates.length + 32);
  assert.deepEqual(after.templates.slice(0, before.templates.length), before.templates);
  assert.deepEqual(after.dividers, before.dividers);
  assert.deepEqual(after.metadata, before.metadata);
  assert.equal(new Set(after.templates.map(item => item.itemID)).size, after.templates.length);
  after.templates.slice(before.templates.length).forEach((item, index) => {
    const prototype = profileBefore.templates[index % 2];
    assert.deepEqual(item.DataFields, prototype.DataFields);
    assert.deepEqual(item.privateMetadata, prototype.privateMetadata);
    assert.equal(item.onair, 'false', 'newly appended graphics must never start on air');
  });
  assert.deepEqual(app.read(profileFile), profileBefore, 'adding must not mutate the project template definitions');
  assert.equal(app.state.rundownData.templates.length, after.templates.length);
  assert.equal(app.playout.length, 0);
});

test('add all can repeat beyond the project template count without ID collisions or losing existing content', async () => {
  const app = application({ count: 17, profileCount: 23 });
  const before = app.read(), profileBefore = app.read(profileFile);
  await Promise.all(Array.from({ length: 4 }, () => app.add(0, 'addAllItemsToRundown')));
  const after = app.read();
  assert.equal(after.templates.length, 17 + 4 * 23);
  assert.equal(new Set(after.templates.map(item => item.itemID)).size, after.templates.length);
  assert.deepEqual(after.templates.slice(0, 17), before.templates);
  assert.deepEqual(after.dividers, before.dividers);
  assert.deepEqual(after.metadata, before.metadata);
  after.templates.slice(17).forEach((item, index) => {
    const original = profileBefore.templates[index % 23];
    assert.equal(item.relpath, original.relpath);
    assert.deepEqual(item.DataFields, original.DataFields);
    assert.equal(item.onair, 'false');
  });
  assert.equal(app.state.rundownData.templates.length, after.templates.length);
});

test('a stale controller reorder receives 409 and cannot delete an item added by another tab', async () => {
  const app = application();
  const stale = app.read();
  await app.add();
  const afterAdd = app.read(), writesBefore = app.writes.length;
  const response = await app.request('POST', '/gc/sortTemplates', {
    rundownfile: mainFile,
    controllerOrder: [{ type: 'divider', id: 'first' },
      ...stale.templates.map(item => ({ type: 'graphic', id: item.itemID })),
      { type: 'divider', id: 'last' }]
  });
  assert.equal(response.statusCode, 409);
  assert.match(response.body, /reload|changed/i);
  assert.deepEqual(app.read(), afterAdd);
  assert.equal(app.writes.length, writesBefore);
});

test('a valid controller reorder keeps every field and updates divider positions without stale serialized entries', async () => {
  const app = application({ count: 75 });
  const before = app.read(), reversed = before.templates.slice().reverse();
  const response = await app.request('POST', '/gc/sortTemplates', {
    rundownfile: mainFile,
    controllerOrder: [{ type: 'divider', id: 'last' },
      ...reversed.map(item => ({ type: 'graphic', id: item.itemID })),
      { type: 'divider', id: 'first' }]
  });
  assert.equal(response.statusCode, 200);
  const after = app.read();
  assert.deepEqual(after.templates, reversed);
  assert.deepEqual(after.dividers, [{ ...before.dividers[1], position: 0 }, { ...before.dividers[0], position: 75 }]);
  assert.deepEqual(after.metadata, before.metadata);
  assert.equal(Object.hasOwn(after, 'controllerEntries'), false);
});

test('saving a field after an addition preserves the new row, other values and all metadata', async () => {
  const app = application();
  const before = app.read();
  const responses = await Promise.all([
    app.add(),
    app.request('POST', '/gc/saveItemChanges', { rundownfile: mainFile,
      epoch: before.templates[0].itemID, DataFields: [{ field: 'name', value: 'Updated caster' }] })
  ]);
  assert.equal(responses[1].statusCode, 200);
  const after = app.read();
  assert.equal(after.templates.length, before.templates.length + 1);
  assert.equal(after.templates[0].DataFields[0].value, 'Updated caster');
  assert.deepEqual(after.templates.slice(1, before.templates.length), before.templates.slice(1));
  assert.deepEqual(after.templates[0].privateMetadata, before.templates[0].privateMetadata);
  assert.deepEqual(after.dividers, before.dividers);
});

test('play and stop use the requested rundown on disk, not another open controller cache', async () => {
  const app = application();
  const before = app.read(), otherBefore = app.read(secondFile);
  const other = app.read(secondFile);
  // Identical IDs in separate rundowns must still select the requested file.
  other.templates[0].itemID = before.templates[0].itemID;
  app.records.set(secondFile, other);
  app.state.rundownData = clone(other);
  const play = await app.request('POST', '/gc/playout', {
    datafile: mainFile, command: 'play', epoch: before.templates[0].itemID
  });
  assert.equal(play.statusCode, 200, JSON.stringify(play.body));
  assert.equal(app.playout.length, 1);
  assert.equal(app.playout[0].renderer, 'web');
  assert.equal(app.playout[0].data.relpath, before.templates[0].relpath);
  assert.equal(app.playout[0].data.spxcmd, 'playTemplate');
  const afterPlay = app.read();
  assert.equal(afterPlay.templates.length, before.templates.length);
  assert.equal(afterPlay.templates[0].onair, 'true');
  assert.deepEqual(app.read(secondFile), other);
  assert.equal(otherBefore.title, other.title);
  app.state.rundownData = { templates: [] };
  const stop = await app.request('POST', '/gc/playout', {
    datafile: mainFile, command: 'stop', epoch: before.templates[0].itemID
  });
  assert.equal(stop.statusCode, 200, JSON.stringify(stop.body));
  assert.equal(app.read().templates[0].onair, 'false');
  assert.equal(app.playout.at(-1).data.spxcmd, 'stopTemplate');
  assert.deepEqual(app.read().templates.slice(1), before.templates.slice(1));
});

test('a concurrent add and play cannot overwrite one another with a cached rundown', async () => {
  const app = application({ count: 12 });
  const before = app.read();
  const responses = await Promise.all([
    app.add(),
    app.request('POST', '/gc/playout', { datafile: mainFile, command: 'play', epoch: before.templates[0].itemID })
  ]);
  assert.equal(responses[1].statusCode, 200, JSON.stringify(responses[1].body));
  const after = app.read();
  assert.equal(after.templates.length, 13);
  assert.equal(after.templates[0].onair, 'true');
  assert.deepEqual(after.templates.slice(1, 12), before.templates.slice(1));
  assert.deepEqual(after.dividers, before.dividers);
  assert.deepEqual(after.metadata, before.metadata);
  assert.equal(app.playout.length, 1);
});
