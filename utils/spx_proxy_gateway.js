'use strict';

const http = require('node:http');
const os = require('node:os');

function validPort(port) {
    const number = Number(port);
    return Number.isInteger(number) && number > 0 && number <= 65535;
}

function serverAliases(request) {
    const hostname = os.hostname();
    const aliases = ['localhost', '127.0.0.1', '::1', hostname, hostname + '.local'];
    for (const addresses of Object.values(os.networkInterfaces())) {
        for (const entry of addresses || []) aliases.push(entry.address);
    }
    // The address used to reach this instance can be a reverse-proxy name.
    const incoming = request && request.hostname;
    if (typeof incoming === 'string' && /^[a-z0-9.:[\]_-]+$/i.test(incoming)) aliases.push(incoming);
    return aliases;
}

function normalizeHost(host) {
    return String(host).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function localProxyTarget(value, options = {}) {
    const target = new URL(String(value));
    const ports = options.ports || [];
    const hosts = options.hosts || serverAliases();
    if ((target.protocol === 'http:' || target.protocol === 'https:') && !target.username && !target.password &&
        [...ports].some(port => validPort(port) && Number(port) === Number(target.port)) &&
        [...hosts].some(host => normalizeHost(host) === normalizeHost(target.hostname))) {
        target.protocol = 'http:';
        target.hostname = '127.0.0.1';
    }
    return target;
}

function bounded(value, fallback, maximum) {
    return Number.isFinite(value) && value > 0 && value <= maximum ? value : fallback;
}

// Mount on every BSPX process. This module only reads an existing local proxy;
// starting, stopping and supervising that proxy remain the main server's job.
function createProxyGateway(options = {}) {
    const getPorts = options.getPorts || (() => []);
    const getAliases = options.getAliases || serverAliases;
    const timeoutMs = bounded(options.timeoutMs, 10000, 30000);
    const maxBytes = bounded(options.maxBytes, 10 * 1024 * 1024, 50 * 1024 * 1024);

    function ports() {
        const values = getPorts();
        return [...new Set((Array.isArray(values) || values instanceof Set ? [...values] : [])
            .filter(validPort).map(Number))].sort((a, b) => a - b);
    }

    function headers(response) {
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type');
        response.setHeader('Access-Control-Allow-Private-Network', 'true');
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
    }

    function fail(response, status, message, head) {
        response.statusCode = status;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        const body = Buffer.from(JSON.stringify({ error: message }));
        response.setHeader('Content-Length', body.length);
        response.end(head ? undefined : body);
    }

    return function proxyGateway(request, response) {
        headers(response);
        const head = request.method === 'HEAD';
        if (request.method === 'OPTIONS') {
            response.statusCode = 204;
            response.end();
            return;
        }
        if (request.method !== 'GET' && !head) {
            response.setHeader('Allow', 'GET, HEAD, OPTIONS');
            fail(response, 405, 'Only proxy data reads are allowed', head);
            return;
        }

        let registered;
        try { registered = ports(); }
        catch (_) { fail(response, 503, 'Proxy registry is unavailable', head); return; }
        const url = String(request.url || '');
        if (/^\/client\.js(?:\?[^#]*)?$/.test(url)) {
            try {
                const aliases = getAliases(request);
                const hosts = [...new Set((Array.isArray(aliases) ? aliases : [])
                    .filter(host => typeof host === 'string' && host.length > 0)
                    .map(normalizeHost))];
                const source = typeof options.clientSource === 'function' ? options.clientSource() : (options.clientSource || '');
                const config = JSON.stringify({ ports: registered, hosts }).replace(/</g, '\\u003c');
                const body = Buffer.from('window.SPX_PROXY_CONFIG=' + config + ';\n' + source + '\n');
                response.statusCode = 200;
                response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
                response.setHeader('Content-Length', body.length);
                response.end(head ? undefined : body);
            } catch (_) { fail(response, 503, 'Proxy client configuration is unavailable', head); }
            return;
        }

        // Read the original request target without decoding or normalizing its
        // query. The upstream host is never accepted from request input.
        const match = url.match(/^\/(\d{1,5})(\/[^?#]*)?(\?[^#]*)?$/);
        if (!match) { fail(response, 404, 'Unknown shared proxy route', head); return; }
        const port = Number(match[1]);
        if (!registered.includes(port)) { fail(response, 403, 'Proxy port is not registered', head); return; }
        const target = (match[2] || '/') + (match[3] || '');

        let upstream, incoming, settled = false, timer;
        const cleanup = () => {
            clearTimeout(timer);
            request.removeListener('aborted', abort);
        };
        const destroyUpstream = () => {
            if (incoming) incoming.destroy();
            if (upstream) upstream.destroy();
        };
        const abort = () => {
            if (settled) return;
            settled = true;
            cleanup();
            destroyUpstream();
        };
        const error = (status, message) => {
            if (settled) return;
            settled = true;
            cleanup();
            destroyUpstream();
            if (!response.destroyed) fail(response, status, message, head);
        };
        request.once('aborted', abort);
        response.once('close', () => { if (!response.writableEnded) abort(); });
        timer = setTimeout(() => error(504, 'Shared proxy did not respond in time'), timeoutMs);

        try {
            // Cookies, authorization, Origin and arbitrary client headers are
            // deliberately not forwarded into a local service.
            upstream = http.request({ hostname: '127.0.0.1', port, path: target,
                method: head ? 'HEAD' : 'GET', agent: false,
                headers: { Accept: 'application/json', Connection: 'close' }
            }, source => {
                incoming = source;
                source.on('error', () => error(502, 'Shared proxy response failed'));
                source.on('aborted', () => error(502, 'Shared proxy response was incomplete'));
                const length = Number(source.headers['content-length']);
                if (Number.isFinite(length) && length > maxBytes) {
                    error(502, 'Shared proxy response is too large');
                    return;
                }
                let size = 0;
                const chunks = [];
                source.on('data', chunk => {
                    if (settled) return;
                    size += chunk.length;
                    if (size > maxBytes) { error(502, 'Shared proxy response is too large'); return; }
                    chunks.push(chunk);
                });
                source.on('end', () => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    response.statusCode = source.statusCode || 502;
                    response.setHeader('Content-Type', source.headers['content-type'] || 'application/octet-stream');
                    if (source.headers['content-encoding']) response.setHeader('Content-Encoding', source.headers['content-encoding']);
                    // Do not forward Location: browser fetch must not turn a
                    // local data gateway into a redirect to an arbitrary host.
                    const body = Buffer.concat(chunks, size);
                    if (![204, 304].includes(response.statusCode)) {
                        if (head && Number.isFinite(length)) response.setHeader('Content-Length', length);
                        else response.setHeader('Content-Length', body.length);
                    }
                    response.end(head ? undefined : body);
                });
            });
            upstream.on('error', () => error(502, 'Shared proxy is unavailable'));
            upstream.end();
        } catch (_) { error(502, 'Shared proxy is unavailable'); }
    };
}

module.exports = { createProxyGateway, serverAliases, serverHosts: serverAliases, localProxyTarget };
