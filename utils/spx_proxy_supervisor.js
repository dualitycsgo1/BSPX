'use strict';

function swallowChildError() {}

// All process discovery, HTTP probes and signals belong to the adapter. This
// module only decides when a known, desired proxy needs attention.
function createSupervisor(deps, options = {}) {
  const now = options.now || Date.now;
  const settings = {
    pollMs: 3000,
    healthIntervalMs: 10000,
    startupGraceMs: 30000,
    unhealthyThreshold: 3,
    restartDelayMs: 3000,
    maxRestartDelayMs: 30000,
    stableMs: 60000,
    ...options
  };
  const interval = options.setInterval || setInterval;
  const clear = options.clearInterval || clearInterval;
  const states = new Map();
  let timer;
  let closed = false;
  let requested = false;
  let running = null;

  function log(id, message) {
    try { if (deps.log) deps.log(id, message); } catch (_) { /* Logging must not stop supervision. */ }
  }

  function desiredIds() {
    return new Set(deps.desired() || []);
  }

  function current(id, state) {
    if (closed || states.get(id) !== state) return false;
    try { return desiredIds().has(id); } catch (_) { return false; }
  }

  function releaseChild(state) {
    const watched = state.watched;
    if (!watched) return;
    state.watched = null;
    const { child, onError, onExit } = watched;
    child.removeListener('error', onError);
    child.removeListener('exit', onExit);
    // A failed spawn may emit its error after a stop or shutdown. An EventEmitter
    // without any error listener would otherwise crash BSPX itself.
    if (child.listenerCount('error') === 0) child.on('error', swallowChildError);
  }

  function forget(id) {
    const state = states.get(id);
    if (!state) return;
    states.delete(id);
    releaseChild(state);
  }

  function stateFor(id) {
    let state = states.get(id);
    if (!state) {
      state = {
        pid: 0,
        startedAt: null,
        nextHealthAt: 0,
        failures: 0,
        healthy: false,
        nextStartAt: 0,
        delay: settings.restartDelayMs,
        watched: null,
        revision: 0
      };
      states.set(id, state);
    }
    return state;
  }

  function retry(id, state, message) {
    if (!current(id, state)) return;
    releaseChild(state);
    state.revision++;
    state.pid = 0;
    state.startedAt = null;
    state.failures = 0;
    state.healthy = false;
    state.nextHealthAt = 0;
    state.nextStartAt = now() + state.delay;
    log(id, `${message}; retry in ${state.delay} ms`);
    state.delay = Math.min(state.delay * 2, settings.maxRestartDelayMs);
  }

  function adopt(id, state, info) {
    releaseChild(state);
    state.revision++;
    state.pid = info.pid;
    state.startedAt = now();
    state.nextHealthAt = 0;
    state.failures = 0;
    state.healthy = false;
    state.nextStartAt = 0;
    log(id, 'Watching existing proxy process');
  }

  function watchChild(id, state, child) {
    if (!child || typeof child.on !== 'function' || typeof child.removeListener !== 'function' ||
        typeof child.listenerCount !== 'function') throw new TypeError('launch must return a child process');
    const onError = error => {
      if (state.watched?.child !== child || !current(id, state)) return;
      retry(id, state, `Proxy start/process error${error?.code ? ` (${error.code})` : ''}`);
      kick();
    };
    const onExit = (code, signal) => {
      if (state.watched?.child !== child || !current(id, state)) return;
      retry(id, state, `Proxy exited${signal ? ` (${signal})` : ` (${code})`}`);
      kick();
    };
    state.watched = { child, onError, onExit };
    child.on('error', onError);
    child.on('exit', onExit);
  }

  function guardUnwatchedChild(child) {
    if (child && typeof child.on === 'function' && typeof child.listenerCount === 'function' &&
        child.listenerCount('error') === 0) child.on('error', swallowChildError);
  }

  async function reconcileOne(id, state) {
    let info;
    let revision = state.revision;
    try {
      info = await deps.inspect(id);
    } catch (error) {
      if (current(id, state) && state.revision === revision) log(id, 'Could not inspect proxy process');
      return; // An unknown process state is not permission to start or kill one.
    }
    if (!current(id, state) || state.revision !== revision) return;
    const pid = Number.isSafeInteger(info?.pid) && info.pid > 0 ? info.pid : 0;
    if (!pid) {
      if (state.pid) {
        retry(id, state, 'Proxy process disappeared');
        return;
      }
      if (now() < state.nextStartAt) return;
      let child;
      try {
        child = await deps.launch(id);
        if (!current(id, state) || state.revision !== revision) {
          guardUnwatchedChild(child);
          return;
        }
        watchChild(id, state, child);
        if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
          retry(id, state, 'Proxy start returned no process');
          return;
        }
        state.revision++;
        state.pid = child.pid;
        state.startedAt = now();
        state.nextHealthAt = 0;
        state.failures = 0;
        state.healthy = false;
        state.nextStartAt = 0;
        log(id, 'Started proxy process');
      } catch (error) {
        guardUnwatchedChild(child);
        if (current(id, state) && state.revision === revision) {
          retry(id, state, `Could not start proxy${error?.code ? ` (${error.code})` : ''}`);
        }
      }
      return;
    }

    if (state.pid !== pid) adopt(id, state, { ...info, pid });
    if (!current(id, state)) return;
    if (now() < state.nextHealthAt) return;
    state.nextHealthAt = now() + settings.healthIntervalMs;
    revision = state.revision;
    let healthy = false;
    try {
      healthy = await deps.probe(id, { ...info, pid });
    } catch (_) {
      // A rejected local health request counts like an unsuccessful response.
    }
    if (!current(id, state) || state.revision !== revision || state.pid !== pid) return;
    if (healthy) {
      state.failures = 0;
      state.healthy = true;
      if (now() - state.startedAt >= settings.stableMs) state.delay = settings.restartDelayMs;
      return;
    }
    state.healthy = false;
    if (now() - state.startedAt < settings.startupGraceMs) return;
    state.failures++;
    if (state.failures < settings.unhealthyThreshold) return;

    // Discovery may change while a probe is in flight (for example a systemd
    // restart). Reinspect the exact PID before asking the adapter to signal it.
    let latest;
    try {
      latest = await deps.inspect(id);
    } catch (_) {
      if (current(id, state) && state.revision === revision) log(id, 'Could not verify unhealthy proxy process');
      return;
    }
    if (!current(id, state) || state.revision !== revision || latest?.pid !== pid) return;
    try {
      await deps.terminate(id, pid);
    } catch (_) {
      if (current(id, state) && state.revision === revision) log(id, 'Could not stop unhealthy proxy process');
      return;
    }
    if (!current(id, state) || state.revision !== revision) return;
    retry(id, state, 'Unresponsive proxy stopped');
  }

  async function pass() {
    if (closed) return;
    let wanted;
    try { wanted = desiredIds(); } catch (_) {
      log('supervisor', 'Could not read desired proxies');
      return;
    }
    for (const id of states.keys()) if (!wanted.has(id)) forget(id);
    const jobs = [...wanted].map(id => {
      const state = stateFor(id);
      return reconcileOne(id, state).catch(() => {
        if (current(id, state)) log(id, 'Unexpected proxy supervision error');
      });
    });
    if (deps.maintenance) jobs.push(Promise.resolve().then(() => {
      if (!closed) return deps.maintenance();
    }).catch(() => log('supervisor', 'Proxy maintenance failed')));
    await Promise.all(jobs);
  }

  function kick() {
    if (closed) return Promise.resolve();
    requested = true;
    if (!running) {
      running = Promise.resolve().then(async () => {
        do {
          requested = false;
          await pass();
        } while (requested && !closed);
      }).catch(() => log('supervisor', 'Unexpected supervision pass error')).finally(() => {
        running = null;
        if (requested && !closed) kick();
      });
    }
    return running;
  }

  function start() {
    if (closed) return Promise.resolve();
    if (!timer) {
      timer = interval(kick, settings.pollMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }
    return kick();
  }

  function shutdown() {
    closed = true;
    requested = false;
    if (timer) clear(timer);
    timer = null;
    for (const id of states.keys()) forget(id);
  }

  return { start, kick, reconcile: kick, forget, shutdown };
}

module.exports = { createSupervisor };
