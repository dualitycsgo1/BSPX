'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../static/js/spx_proxy_client.js'), 'utf8');

function browser(origin = 'http://100.72.96.30:5656') {
    const calls = [], opened = [];
    function XMLHttpRequest() {}
    XMLHttpRequest.prototype.open = function () {
        opened.push({ receiver: this, args: [...arguments] });
        return 'opened';
    };
    const root = {
        URL, Request, Headers, AbortController, XMLHttpRequest,
        location: new URL(origin + '/gc/PGL/Main'),
        SPX_PROXY_CONFIG: { ports: [6161, 6262, 8787], hosts: ['piserver.local', '127.0.0.1', 'localhost', '::1', '192.168.1.12'] },
        fetch: async (input, init) => {
            calls.push({ input, init });
            return { ok: true, status: 200 };
        }
    };
    root.window = root;
    vm.createContext(root);
    function load() { vm.runInContext(source, root, { filename: 'spx_proxy_client.js' }); }
    load();
    return { root, calls, opened, load };
}

test('server aliases and registered ports resolve through each instance origin', () => {
    for (const port of [5656, 8080, 8099]) {
        const { root } = browser('http://100.72.96.30:' + port);
        assert.equal(root.SPXProxy.resolve('http://piserver.local:6161/dropdown?fresh=1&limit=60'), '/bspx-proxy/6161/dropdown?fresh=1&limit=60');
        assert.equal(root.SPXProxy.resolve('http://127.0.0.1:6262/odds/sports'), '/bspx-proxy/6262/odds/sports');
        assert.equal(root.SPXProxy.resolve('http://100.72.96.30:8787/api/matches'), '/bspx-proxy/8787/api/matches');
        assert.equal(root.SPXProxy.resolve('http://192.168.1.12:6161/matches?team=A%26B'), '/bspx-proxy/6161/matches?team=A%26B');
    }
});

test('URL objects, host case, trailing DNS dot and IPv6 aliases work', () => {
    const { root } = browser();
    assert.equal(root.SPXProxy.resolve(new URL('http://PISERVER.LOCAL.:6161/player-form/jl?limit=40')), '/bspx-proxy/6161/player-form/jl?limit=40');
    assert.equal(root.SPXProxy.resolve('http://[::1]:6262/odds/fixtures?sport=counter-strike'), '/bspx-proxy/6262/odds/fixtures?sport=counter-strike');
});

test('external destinations, unregistered ports, credentials and control URLs remain untouched', async () => {
    const { root, calls } = browser();
    for (const input of [
        '/gc/fetchItems?url=http%3A%2F%2F127.0.0.1%3A6161%2Fdropdown',
        '/api/v1/panic', '/socket.io/', '/bspx-proxy/6161/matches',
        'http://piserver.local:8080/api/v1/panic',
        'https://api.citoapi.com:6161/matches',
        'https://predictions.barstoolproduction.dk/api/broadcast',
        'http://piserver.local:9999/data',
        'http://name:password@piserver.local:6161/data', 'not a valid URL'
    ]) {
        assert.equal(root.SPXProxy.resolve(input), input);
        await root.fetch(input);
        assert.equal(calls.at(-1).input, input);
    }
    // Even a mistaken registry cannot route instance-local control requests.
    root.SPX_PROXY_CONFIG.ports.push(5656);
    assert.equal(root.SPXProxy.resolve('http://100.72.96.30:5656/api/v1/panic'), 'http://100.72.96.30:5656/api/v1/panic');
});

test('fetch preserves init, AbortSignal, headers and cache for read methods', async () => {
    const { root, calls } = browser();
    const abort = new AbortController();
    for (const method of ['GET', 'head', 'OPTIONS']) {
        const init = { method, headers: { Accept: 'application/json' }, signal: abort.signal, cache: 'no-store', credentials: 'omit' };
        const response = await root.fetch('http://piserver.local:6161/matches?fresh=1', init);
        assert.equal(response.status, 200);
        assert.equal(calls.at(-1).input, '/bspx-proxy/6161/matches?fresh=1');
        assert.equal(calls.at(-1).init, init);
    }
});

test('Request inputs retain request metadata and abort propagation', async () => {
    const { root, calls } = browser();
    const abort = new AbortController();
    const input = new Request('http://piserver.local:6161/matches?limit=60', {
        method: 'GET', headers: { Accept: 'application/json', 'X-Test': 'kept' },
        signal: abort.signal, cache: 'no-store', credentials: 'omit', redirect: 'manual'
    });
    await root.fetch(input);
    const forwarded = calls[0].input;
    assert.ok(forwarded instanceof Request);
    assert.equal(forwarded.url, 'http://100.72.96.30:5656/bspx-proxy/6161/matches?limit=60');
    assert.equal(forwarded.method, 'GET');
    assert.equal(forwarded.headers.get('X-Test'), 'kept');
    assert.equal(forwarded.cache, input.cache);
    assert.equal(forwarded.credentials, input.credentials);
    assert.equal(forwarded.redirect, input.redirect);
    assert.equal(input.bodyUsed, false);
    assert.equal(forwarded.signal.aborted, false);
    abort.abort();
    assert.equal(forwarded.signal.aborted, true);
});

test('explicit fetch init overrides Request metadata and method selection', async () => {
    const { root, calls } = browser();
    const request = new Request('http://piserver.local:6161/data', { headers: { 'X-Original': 'yes' } });
    const init = { method: 'HEAD', headers: { 'X-Replaced': 'yes' }, cache: 'reload' };
    await root.fetch(request, init);
    assert.equal(calls[0].input.method, 'GET', 'native fetch receives the preserved Request plus its explicit overrides');
    assert.equal(calls[0].init, init);
    const effective = new Request(calls[0].input, calls[0].init);
    assert.equal(effective.method, 'HEAD');
    assert.equal(effective.headers.get('X-Replaced'), 'yes');
    assert.equal(effective.headers.has('X-Original'), false);
    assert.equal(effective.cache, 'reload');
});

test('POST, DELETE and overridden write methods never route to data gateway', async () => {
    const { root, calls } = browser();
    for (const method of ['POST', 'DELETE', 'PUT', 'PATCH']) {
        const init = { method, body: 'unchanged' };
        const url = 'http://piserver.local:6161/control';
        await root.fetch(url, init);
        assert.equal(calls.at(-1).input, url);
        assert.equal(calls.at(-1).init, init);
    }
    const request = new Request('http://piserver.local:6161/control', { method: 'POST', body: 'do not consume' });
    await root.fetch(request);
    assert.equal(calls.at(-1).input, request);
    assert.equal(await request.text(), 'do not consume');
    const readRequest = new Request('http://piserver.local:6161/control');
    await root.fetch(readRequest, { method: 'POST' });
    assert.equal(calls.at(-1).input, readRequest);
});

test('XHR read rewrite keeps receiver and optional arguments; writes and credentials pass through', () => {
    const { root, opened } = browser();
    const xhr = new root.XMLHttpRequest();
    assert.equal(xhr.open('GET', 'http://127.0.0.1:6262/odds/view?fixture=a%2Fb', false), 'opened');
    assert.equal(opened[0].receiver, xhr);
    assert.deepEqual(opened[0].args, ['GET', '/bspx-proxy/6262/odds/view?fixture=a%2Fb', false]);
    xhr.open('POST', 'http://127.0.0.1:6262/control', true);
    assert.equal(opened[1].args[1], 'http://127.0.0.1:6262/control');
    xhr.open('GET', 'http://127.0.0.1:6262/private', true, 'user', 'password');
    assert.deepEqual(opened[2].args, ['GET', 'http://127.0.0.1:6262/private', true, 'user', 'password']);
    xhr.open('GET', 'https://example.com:6262/external');
    assert.equal(opened[3].args[1], 'https://example.com:6262/external');
});

test('repeat installation does not stack fetch/XHR hooks, and registry may update', async () => {
    const { root, calls, load } = browser();
    const fetch = root.fetch, open = root.XMLHttpRequest.prototype.open;
    load();
    assert.equal(root.fetch, fetch);
    assert.equal(root.XMLHttpRequest.prototype.open, open);
    root.SPX_PROXY_CONFIG = { ports: [5055], hosts: ['other.local'] };
    await root.fetch('http://other.local:5055/api/matches');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input, '/bspx-proxy/5055/api/matches');
    assert.equal(root.SPXProxy.resolve('http://piserver.local:6161/matches'), 'http://piserver.local:6161/matches');
});

test('offline/file previews retain their existing direct/manual behavior', async () => {
    const { root, calls } = browser();
    root.location = new URL('file:///graphics/PGL/player.html');
    const input = 'http://piserver.local:6161/players';
    assert.equal(root.SPXProxy.resolve(input), input);
    await root.fetch(input);
    assert.equal(calls[0].input, input);
});
