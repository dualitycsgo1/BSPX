'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSupervisor } = require('../utils/spx_proxy_supervisor');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(ids = ['integration'], overrides = {}, options = {}) {
  const wanted = new Set(ids);
  const processes = new Map();
  const children = new Map();
  const launches = [];
  const terminated = [];
  const probes = [];
  const logs = [];
  let time = 0;
  let nextPid = 100;
  let intervalCallback;
  let cleared = false;
  let unref = false;
  const deps = {
    desired: () => [...wanted],
    inspect: id => processes.get(id) || { pid: 0 },
    launch(id) {
      const child = new EventEmitter();
      child.pid = nextPid++;
      launches.push({ id, time, child });
      children.set(id, child);
      processes.set(id, { pid: child.pid });
      return child;
    },
    probe(id, info) { probes.push({ id, time, pid: info.pid }); return true; },
    terminate(id, pid) { terminated.push({ id, pid, time }); processes.delete(id); },
    log(id, message) { logs.push({ id, message }); },
    ...overrides
  };
  const supervisor = createSupervisor(deps, {
    now: () => time,
    setInterval(callback) { intervalCallback = callback; return { unref() { unref = true; } }; },
    clearInterval() { cleared = true; },
    ...options
  });
  return {
    wanted, processes, children, launches, terminated, probes, logs, deps, supervisor,
    advance(ms) { time += ms; return supervisor.reconcile(); },
    exit(id, code = 1) {
      const child = children.get(id);
      processes.delete(id);
      child.emit('exit', code, null);
      return supervisor.reconcile();
    },
    interval: () => intervalCallback(),
    cleared: () => cleared,
    unref: () => unref
  };
}

test('start immediately launches every desired proxy and unrefs one polling interval', async () => {
  const f = fixture(['integration', 'stake', 'pgl']);
  await f.supervisor.start();
  await f.supervisor.start();
  await f.interval();
  assert.deepEqual(f.launches.map(item => item.id), ['integration', 'stake', 'pgl']);
  assert.equal(f.unref(), true);
  f.supervisor.shutdown();
  assert.equal(f.cleared(), true);
});

for (const code of [0, 1]) {
  test(`exit ${code} retries after the initial delay without duplicating a process`, async () => {
    const f = fixture();
    await f.supervisor.reconcile();
    await f.exit('integration', code);
    await f.advance(2999);
    assert.equal(f.launches.length, 1);
    await f.advance(1);
    assert.equal(f.launches.length, 2);
    assert.equal(f.launches[1].time, 3000);
    await f.supervisor.reconcile();
    assert.equal(f.launches.length, 2);
    f.supervisor.shutdown();
  });
}

test('an asynchronous ENOENT from spawn never becomes an unhandled child error', async () => {
  const child = new EventEmitter();
  let calls = 0;
  const f = fixture(['integration'], { launch() { calls++; return child; } });
  await f.supervisor.reconcile();
  assert.doesNotThrow(() => child.emit('error', Object.assign(new Error('spawn failed'), { code: 'ENOENT' })));
  await f.advance(2999);
  assert.equal(calls, 1);
  await f.advance(1);
  assert.equal(calls, 2);
  f.supervisor.shutdown();
  assert.doesNotThrow(() => child.emit('error', new Error('late error')));
});

test('adopts an existing process without starting a second copy', async () => {
  const f = fixture();
  f.processes.set('integration', { pid: 777, external: true });
  await f.supervisor.reconcile();
  await f.advance(3000);
  assert.equal(f.launches.length, 0);
  assert.equal(f.probes[0].pid, 777);
  f.supervisor.shutdown();
});

test('waits through startup grace, then terminates only after three local probe failures', async () => {
  const f = fixture(['integration'], { probe: () => false });
  f.processes.set('integration', { pid: 777 });
  await f.supervisor.reconcile();
  await f.advance(10000);
  await f.advance(10000);
  assert.equal(f.terminated.length, 0);
  await f.advance(10000);
  await f.advance(10000);
  assert.equal(f.terminated.length, 0);
  await f.advance(10000);
  assert.deepEqual(f.terminated, [{ id: 'integration', pid: 777, time: 50000 }]);
  await f.advance(2999);
  assert.equal(f.launches.length, 0);
  await f.advance(1);
  assert.equal(f.launches.length, 1);
  f.supervisor.shutdown();
});

test('a successful probe clears previous failures', async () => {
  let healthy = false;
  const f = fixture(['integration'], { probe: () => healthy }, { startupGraceMs: 0 });
  f.processes.set('integration', { pid: 777 });
  await f.supervisor.reconcile();
  await f.advance(10000);
  healthy = true;
  await f.advance(10000);
  healthy = false;
  await f.advance(10000);
  await f.advance(10000);
  assert.equal(f.terminated.length, 0);
  await f.advance(10000);
  assert.equal(f.terminated.length, 1);
  f.supervisor.shutdown();
});

test('rechecks the PID after health failure and never kills a replacement process', async () => {
  const pending = deferred();
  let slow = false;
  const f = fixture(['integration'], { probe: () => slow ? pending.promise : false }, { startupGraceMs: 0 });
  f.processes.set('integration', { pid: 777 });
  await f.supervisor.reconcile();
  await f.advance(10000);
  slow = true;
  const checking = f.advance(10000);
  await Promise.resolve();
  f.processes.set('integration', { pid: 888 });
  pending.resolve(false);
  await checking;
  assert.equal(f.terminated.length, 0);
  await f.supervisor.reconcile();
  assert.equal(f.launches.length, 0);
  f.supervisor.shutdown();
});

test('systemd may supply a replacement during the retry delay without a duplicate launch', async () => {
  const f = fixture(['integration'], { probe: () => false }, { startupGraceMs: 0, unhealthyThreshold: 2 });
  f.processes.set('integration', { pid: 777 });
  await f.supervisor.reconcile();
  await f.advance(10000);
  assert.equal(f.terminated.length, 1);
  f.processes.set('integration', { pid: 888 });
  await f.advance(1000);
  assert.equal(f.launches.length, 0);
  // The new process receives its own health history instead of inheriting 777's failures.
  assert.equal(f.terminated.length, 1);
  f.supervisor.shutdown();
});

test('manual stop during an outstanding probe prevents termination and resurrection', async () => {
  const pending = deferred();
  const f = fixture(['integration'], { probe: () => pending.promise }, { startupGraceMs: 0, unhealthyThreshold: 1 });
  f.processes.set('integration', { pid: 777 });
  const checking = f.supervisor.reconcile();
  await Promise.resolve();
  f.wanted.delete('integration');
  f.supervisor.forget('integration');
  pending.resolve(false);
  await checking;
  await f.advance(100000);
  assert.equal(f.terminated.length, 0);
  assert.equal(f.launches.length, 0);
  f.supervisor.shutdown();
});

test('manual stop cancels a scheduled retry and handles errors after forgetting a child', async () => {
  const f = fixture();
  await f.supervisor.reconcile();
  const old = f.children.get('integration');
  await f.exit('integration');
  f.wanted.delete('integration');
  f.supervisor.forget('integration');
  assert.doesNotThrow(() => old.emit('error', new Error('late')));
  await f.advance(100000);
  assert.equal(f.launches.length, 1);
  f.supervisor.shutdown();
});

test('a slow or broken proxy does not prevent independent proxies progressing', async () => {
  const pending = deferred();
  const f = fixture(['integration', 'stake', 'pgl'], {
    inspect(id) {
      if (id === 'integration') return pending.promise;
      if (id === 'stake') throw new Error('inspection failed');
      return { pid: 0 };
    }
  });
  const checking = f.supervisor.reconcile();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.deepEqual(f.launches.map(item => item.id), ['pgl']);
  pending.resolve({ pid: 777 });
  await checking;
  assert.equal(f.logs.some(item => item.id === 'stake'), true);
  f.supervisor.shutdown();
});

test('shutdown cancels polling and late child events without killing healthy processes', async () => {
  const f = fixture();
  await f.supervisor.start();
  const child = f.children.get('integration');
  f.supervisor.shutdown();
  child.emit('exit', 1, null);
  assert.doesNotThrow(() => child.emit('error', new Error('late')));
  await f.advance(100000);
  await f.supervisor.start();
  assert.equal(f.launches.length, 1);
  assert.equal(f.terminated.length, 0);
  assert.equal(f.cleared(), true);
});

test('failed starts back off exponentially and cap retries at 30 seconds', async () => {
  const starts = [];
  let time = 0;
  const f = fixture(['integration'], { launch() { starts.push(time); throw new Error('busy port'); } });
  await f.supervisor.reconcile();
  for (const delay of [3000, 6000, 12000, 24000, 30000, 30000]) {
    const before = starts.length;
    time += delay - 1;
    await f.advance(delay - 1);
    assert.equal(starts.length, before);
    time++;
    await f.advance(1);
    assert.equal(starts.length, before + 1);
  }
  assert.deepEqual(starts, [0, 3000, 9000, 21000, 45000, 75000, 105000]);
  f.supervisor.shutdown();
});

test('a stable, healthy run resets accumulated retry delay', async () => {
  const f = fixture();
  await f.supervisor.reconcile();
  await f.exit('integration');
  await f.advance(3000);
  await f.exit('integration');
  await f.advance(6000);
  await f.advance(60000);
  await f.exit('integration');
  await f.advance(2999);
  assert.equal(f.launches.length, 3);
  await f.advance(1);
  assert.equal(f.launches.length, 4);
  f.supervisor.shutdown();
});

test('concurrent requests serialize inspection passes and an exit invalidates an old probe', async () => {
  const pending = deferred();
  let probes = 0;
  let active = 0;
  let maximum = 0;
  const f = fixture(['integration'], {
    async probe() {
      probes++;
      active++;
      maximum = Math.max(maximum, active);
      if (probes === 1) await pending.promise;
      active--;
      return false;
    }
  }, { startupGraceMs: 0, unhealthyThreshold: 1 });
  await f.supervisor.reconcile();
  const checking = f.supervisor.reconcile();
  for (let i = 0; i < 4; i++) await Promise.resolve();
  const next = f.supervisor.kick();
  f.processes.delete('integration');
  f.children.get('integration').emit('exit', 1, null);
  pending.resolve(false);
  await Promise.all([checking, next]);
  assert.equal(maximum, 1);
  assert.equal(f.terminated.length, 0);
  assert.equal(f.launches.length, 1);
  f.supervisor.shutdown();
});
