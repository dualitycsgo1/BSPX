'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const vm = require('node:vm');
const { createProxyGateway, localProxyTarget, serverHosts } = require('../utils/spx_proxy_gateway');

async function listen(t, server) {
    const sockets = new Set();
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    t.after(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
    });
    return server.address().port;
}

function read(port, path, options = {}) {
    return new Promise((resolve, reject) => {
        const request = http.request({ hostname: '127.0.0.1', port, path, method: options.method || 'GET',
            headers: options.headers || {}, agent: false }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve({ status: response.statusCode, headers: response.headers,
                body: Buffer.concat(chunks).toString('utf8') }));
            response.on('error', reject);
        });
        request.on('error', reject);
        request.end();
    });
}

test('multiple BSPX instances share the same service and preserve request/query/status/body', async t => {
    const seen = [];
    const service = await listen(t, http.createServer((req, res) => {
        seen.push({ method: req.method, url: req.url, cookie: req.headers.cookie,
            authorization: req.headers.authorization, origin: req.headers.origin });
        res.writeHead(206, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ id: 'match-1', score: '1–0' }));
    }));
    const gateway = () => createProxyGateway({ getPorts: () => [service] });
    const first = await listen(t, http.createServer(gateway()));
    const second = await listen(t, http.createServer(gateway()));
    const target = '/' + service + '/dropdown?round=2&value=a%2Fb&empty=&fresh=1';
    for (const port of [first, second]) {
        const answer = await read(port, target, { headers: { Cookie: 'private=session',
            Authorization: 'private-token', Origin: 'http://100.72.96.30:5656' } });
        assert.equal(answer.status, 206);
        assert.equal(answer.headers['content-type'], 'application/json; charset=utf-8');
        assert.deepEqual(JSON.parse(answer.body), { id: 'match-1', score: '1–0' });
        assert.equal(answer.headers['cache-control'], 'no-store');
    }
    assert.equal(seen.length, 2, 'one upstream read per incoming read, no duplicated service or cache');
    for (const request of seen) assert.deepEqual(request, { method: 'GET',
        url: '/dropdown?round=2&value=a%2Fb&empty=&fresh=1', cookie: undefined,
        authorization: undefined, origin: undefined });
});

test('bootstrap follows current registered ports, aliases, and supplied client implementation', async t => {
    let ports = [6161, '6262', 6161, 0, 65536, 'invalid'];
    const port = await listen(t, http.createServer(createProxyGateway({ getPorts: () => ports,
        getAliases: () => ['PiServer.Local', '[::1]', '100.72.96.30'], clientSource: () => 'window.loaded=true;' })));
    const answer = await read(port, '/client.js?version=1');
    assert.equal(answer.status, 200);
    assert.match(answer.headers['content-type'], /javascript/);
    const context = { window: {} };
    vm.runInNewContext(answer.body, context);
    assert.equal(JSON.stringify(context.window.SPX_PROXY_CONFIG), JSON.stringify({ ports: [6161, 6262],
        hosts: ['piserver.local', '::1', '100.72.96.30'] }));
    assert.equal(context.window.loaded, true);
    ports = [8787];
    const changed = { window: {} };
    vm.runInNewContext((await read(port, '/client.js')).body, changed);
    assert.equal(JSON.stringify(changed.window.SPX_PROXY_CONFIG.ports), '[8787]');
    assert.equal((await read(port, '/client.js', { method: 'HEAD' })).body, '');
});

test('unknown ports, arbitrary targets, and write methods never reach a local service', async t => {
    let calls = 0;
    const service = await listen(t, http.createServer((_req, res) => { calls++; res.end('unexpected'); }));
    const port = await listen(t, http.createServer(createProxyGateway({ getPorts: () => [] })));
    assert.equal((await read(port, '/' + service + '/')).status, 403);
    assert.equal((await read(port, '/65536/')).status, 403);
    assert.equal((await read(port, '/http://example.com/')).status, 404);
    assert.equal((await read(port, '/' + service + '/?url=http://example.com/', { method: 'POST' })).status, 405);
    const preflight = await read(port, '/' + service + '/', { method: 'OPTIONS' });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], '*');
    assert.equal(calls, 0);
});

test('redirects are returned without following or forwarding Location', async t => {
    let calls = 0;
    const service = await listen(t, http.createServer((_req, res) => {
        calls++;
        res.writeHead(302, { Location: 'http://example.com/private', 'Content-Type': 'text/plain' });
        res.end('moved');
    }));
    const port = await listen(t, http.createServer(createProxyGateway({ getPorts: () => [service] })));
    const answer = await read(port, '/' + service + '/redirect');
    assert.equal(answer.status, 302);
    assert.equal(answer.body, 'moved');
    assert.equal(answer.headers.location, undefined);
    assert.equal(calls, 1);
});

test('unavailable services return sanitized errors', async t => {
    const closed = http.createServer();
    await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
    const service = closed.address().port;
    await new Promise(resolve => closed.close(resolve));
    const port = await listen(t, http.createServer(createProxyGateway({ getPorts: () => [service] })));
    const answer = await read(port, '/' + service + '/data?secret=never-show');
    assert.equal(answer.status, 502);
    assert.equal(answer.body, '{"error":"Shared proxy is unavailable"}');
    assert.doesNotMatch(answer.body, /never-show|127\.0\.0\.1/);
});

test('wall-clock deadline catches a response which continually drips data', async t => {
    const service = await listen(t, http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('[');
        const timer = setInterval(() => res.write(' '), 10);
        res.once('close', () => clearInterval(timer));
    }));
    const port = await listen(t, http.createServer(createProxyGateway({ getPorts: () => [service], timeoutMs: 90 })));
    const began = performance.now();
    const answer = await read(port, '/' + service + '/slow');
    assert.equal(answer.status, 504);
    assert.ok(performance.now() - began < 1500);
});

test('oversized declared and streamed responses are bounded before exposing partial data', async t => {
    const service = await listen(t, http.createServer((req, res) => {
        if (req.url === '/declared') res.setHeader('Content-Length', 200);
        res.write('x'.repeat(80));
        res.end('y'.repeat(80));
    }));
    const port = await listen(t, http.createServer(createProxyGateway({ getPorts: () => [service], maxBytes: 100 })));
    for (const target of ['/declared', '/streamed']) {
        const answer = await read(port, '/' + service + target);
        assert.equal(answer.status, 502);
        assert.equal(answer.body, '{"error":"Shared proxy response is too large"}');
    }
});

test('HEAD and bodyless response statuses preserve their HTTP semantics', async t => {
    const methods = [];
    const service = await listen(t, http.createServer((req, res) => {
        methods.push(req.method);
        if (req.url === '/empty') { res.writeHead(204); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '7' });
        res.end('{"x":1}');
    }));
    const port = await listen(t, http.createServer(createProxyGateway({ getPorts: () => [service] })));
    const head = await read(port, '/' + service + '/data', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.equal(head.headers['content-length'], '7');
    const empty = await read(port, '/' + service + '/empty');
    assert.equal(empty.status, 204);
    assert.equal(empty.body, '');
    assert.deepEqual(methods, ['HEAD', 'GET']);
});

test('registry failures return sanitized errors and no socket request', async t => {
    const port = await listen(t, http.createServer(createProxyGateway({ getPorts: () => { throw Error('private path'); } })));
    const answer = await read(port, '/6161/data');
    assert.equal(answer.status, 503);
    assert.equal(answer.body, '{"error":"Proxy registry is unavailable"}');
});

test('controller target normalization changes only registered proxy ports on known server hosts', () => {
    const options = { ports: [6161, 6262], hosts: ['piserver.local', '100.72.96.30', '127.0.0.1', '::1'] };
    const original = new URL('http://piserver.local:6161/dropdown?sport=cs%2F2&empty=');
    assert.equal(localProxyTarget(original, options).href, 'http://127.0.0.1:6161/dropdown?sport=cs%2F2&empty=');
    assert.equal(original.hostname, 'piserver.local', 'normalization does not mutate the caller URL');
    assert.equal(localProxyTarget('http://100.72.96.30:6262/odds/sports', options).href,
        'http://127.0.0.1:6262/odds/sports');
    assert.equal(localProxyTarget('http://[::1]:6161/dropdown', options).hostname, '127.0.0.1');
    for (const url of ['https://api.example.com:6161/matches', 'http://piserver.local:5656/gc/',
        'http://user:password@piserver.local:6161/private', 'ftp://piserver.local:6161/file']) {
        assert.equal(localProxyTarget(url, options).href, new URL(url).href);
    }
    assert.ok(serverHosts({ hostname: 'tailscale-server.example' }).includes('tailscale-server.example'));
});
