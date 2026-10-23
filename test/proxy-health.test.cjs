'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { probeHttp, isPortBusy } = require('../utils/spx_proxy_health.js');

async function listen(t, server) {
    const sockets = new Set();
    server.on('connection', socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.removeListener('error', reject);
            resolve();
        });
    });
    t.after(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
    });
    return server.address().port;
}

async function unusedPort() {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

test('probe uses local OPTIONS / and a nonpersistent connection', async t => {
    let observed;
    const port = await listen(t, http.createServer((request, response) => {
        observed = { method: request.method, path: request.url, connection: request.headers.connection };
        response.writeHead(204).end();
    }));
    assert.equal(await probeHttp(port), true);
    assert.deepEqual(observed, { method: 'OPTIONS', path: '/', connection: 'close' });
});

test('HTTP 500 remains responsive without retaining or awaiting the body', async t => {
    const port = await listen(t, http.createServer((request, response) => {
        response.writeHead(500, { 'Content-Length': '1000000' });
        response.flushHeaders();
        // Deliberately leave the body unfinished: headers alone establish liveness.
    }));
    assert.equal(await probeHttp(port, { timeoutMs: 1000 }), true);
});

test('incomplete dripping headers still hit the wall-clock deadline', async t => {
    const port = await listen(t, net.createServer(socket => {
        socket.on('error', () => {});
        socket.write('HTTP/1.1 200 OK\r\nX-Wait: ');
        const timer = setInterval(() => socket.write(' '), 20);
        socket.on('close', () => clearInterval(timer));
    }));
    const began = performance.now();
    assert.equal(await probeHttp(port, { timeoutMs: 120 }), false);
    assert.ok(performance.now() - began < 1500, 'probe must finish despite ongoing socket activity');
});

test('connection refusal is not responsive or busy', async () => {
    const port = await unusedPort();
    assert.equal(await probeHttp(port), false);
    assert.equal(await isPortBusy(port), false);
});

test('a listening port is busy even when it does not speak HTTP', async t => {
    const port = await listen(t, net.createServer());
    assert.equal(await isPortBusy(port), true);
    assert.equal(await probeHttp(port, { timeoutMs: 80 }), false);
});

test('invalid ports do not open sockets or throw', async () => {
    for (const port of [undefined, null, false, 0, -1, 65536, 1.5, NaN, Infinity, '8787', 'socket-path']) {
        assert.equal(await probeHttp(port), false);
        assert.equal(await isPortBusy(port), false);
    }
});
