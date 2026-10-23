'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createProxyManager } = require('../utils/spx_proxies');
const { createProcessInspector } = require('../utils/spx_proxy_process');
const { probeHttp } = require('../utils/spx_proxy_health');

const PGL = 'ASSETS/templates/PGL/proxy.py';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function until(check, description, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(15);
  }
  assert.fail('Timed out: ' + description);
}

async function unusedLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function requestCleanExit(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/exit', agent: false }, response => {
      response.resume();
      response.once('end', resolve);
    });
    request.on('error', reject);
    request.setTimeout(500, () => request.destroy(new Error('Fixture exit request timed out')));
  });
}

test('Linux runtime adopts and restores real Python proxies after crash, clean exit and a local hang', {
  skip: process.platform !== 'linux' ? 'Requires Linux /proc and python3' : false,
  timeout: 10000
}, async t => {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporaryRoot, 'bspx-proxy-runtime-'));
  const script = path.join(root, PGL);
  const hang = path.join(path.dirname(script), 'hang.flag');
  const inspector = createProcessInspector();
  const children = [];
  const managers = [];
  let manager;
  t.after(async () => {
    for (const instance of managers) instance.shutdown();
    // Never signal a PID merely because it was once returned by spawn: Linux
    // may have reused it. Verify this fixture's exact script before cleanup.
    for (const child of children) {
      if (inspector.matches(child.pid, script)) {
        try { process.kill(child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
    const deadline = Date.now() + 1500;
    while (children.some(child => child.exitCode === null && child.signalCode === null) && Date.now() < deadline) await delay(10);
    assert.equal(inspector.find(script), null, 'No fixture proxy remains after cleanup');
    assert.equal(path.dirname(root), temporaryRoot);
    assert.ok(path.basename(root).startsWith('bspx-proxy-runtime-'));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const port = await unusedLoopbackPort();
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, [
    'import os, threading, time',
    'from pathlib import Path',
    'from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer',
    `port = ${port}`,
    'class Handler(BaseHTTPRequestHandler):',
    '    def log_message(self, *args): pass',
    '    def do_OPTIONS(self):',
    '        if Path("hang.flag").exists(): time.sleep(60)',
    '        self.send_response(204)',
    '        self.end_headers()',
    '    def do_GET(self):',
    '        self.send_response(204)',
    '        self.end_headers()',
    '        if self.path == "/exit":',
    '            def leave():',
    '                time.sleep(0.02)',
    '                os._exit(0)',
    '            threading.Thread(target=leave, daemon=True).start()',
    'class Server(ThreadingHTTPServer):',
    '    allow_reuse_address = True',
    '    daemon_threads = True',
    'Server(("127.0.0.1", port), Handler).serve_forever()',
    ''
  ].join('\n'));

  function newManager() {
    const instance = createProxyManager({
      root,
      probeHttp: value => probeHttp(value, { timeoutMs: 60 }),
      spawn(command, args, options) {
        const child = spawn(command, args, options);
        children.push(child);
        return child;
      },
      supervisorOptions: {
        pollMs: 20, healthIntervalMs: 40, startupGraceMs: 150,
        unhealthyThreshold: 3, restartDelayMs: 40, maxRestartDelayMs: 100, stableMs: 100
      }
    });
    managers.push(instance);
    return instance;
  }

  async function healthyPid(except = 0) {
    return until(async () => {
      const info = inspector.find(script);
      return info && info.pid !== except && await probeHttp(port, { timeoutMs: 80 }) ? info.pid : 0;
    }, 'a responsive fixture Python process');
  }

  manager = newManager();
  await manager.start(PGL);
  const originalPid = await healthyPid();
  assert.equal(children.length, 1);
  assert.equal(manager.list()[0].port, port);

  // Simulate BSPX starting again while its helper is already alive.
  manager.shutdown();
  manager = newManager();
  await manager.start(PGL);
  assert.equal(await healthyPid(), originalPid);
  assert.equal(children.length, 1, 'Existing proxy was adopted without a duplicate');

  assert.equal(inspector.matches(originalPid, script), true);
  process.kill(originalPid, 'SIGKILL');
  const afterCrash = await healthyPid(originalPid);
  assert.notEqual(afterCrash, originalPid);
  assert.equal(children.length, 2);

  await requestCleanExit(port);
  const afterCleanExit = await healthyPid(afterCrash);
  assert.notEqual(afterCleanExit, afterCrash);
  assert.equal(children.length, 3);
  assert.equal(children[1].exitCode, 0, 'A normal exit is recovered too');

  fs.writeFileSync(hang, 'hang only this test fixture\n');
  const replacementPid = await until(() => {
    const info = inspector.find(script);
    return info && info.pid !== afterCleanExit ? info.pid : 0;
  }, 'watchdog replacing the unresponsive local HTTP process');
  fs.unlinkSync(hang);
  assert.equal(await healthyPid(afterCleanExit), replacementPid);
  assert.equal(children[2].signalCode, 'SIGKILL', 'Only the unresponsive proxy was killed');
  assert.equal(children.length, 4);

  await manager.stop(PGL);
  await until(() => !inspector.find(script), 'manual stop to remove the fixture proxy');
  const count = children.length;
  await delay(220);
  assert.equal(children.length, count, 'Stop disables recovery before terminating the process');
  assert.equal(manager.list()[0].supervised, false);
});
