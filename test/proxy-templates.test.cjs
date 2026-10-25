'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createTemplateProxyMiddleware } = require('../utils/spx_proxy_templates');
const SCRIPT = '<script src="/bspx-proxy/client.js"></script>';

async function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bspx-proxy-template-'));
    const templates = path.join(root, 'ASSETS', 'templates');
    fs.mkdirSync(templates, { recursive: true });
    const write = (name, text) => {
        const file = path.join(templates, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
        return file;
    };
    const middleware = createTemplateProxyMiddleware({ root });
    const sockets = new Set();
    const server = http.createServer((req, res) => {
        req.url = req.url.replace(/^\/templates(?=\/|\?|$)/, '') || '/';
        middleware(req, res, error => {
            res.statusCode = error ? 500 : 404;
            res.end(error ? 'unexpected middleware error' : 'next');
        });
    });
    server.on('connection', socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
        assert.equal(path.dirname(root), os.tmpdir());
        assert.ok(path.basename(root).startsWith('bspx-proxy-template-'));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const get = (url, method = 'GET') => new Promise((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port: server.address().port, path: '/templates' + url, method }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
        });
        request.on('error', reject); request.end();
    });
    return { root, templates, write, get };
}

test('nested UTF-8 template gains only one early client and source/assets stay unchanged', async t => {
    const item = await fixture(t);
    const source = '<!doctype html><html><head data-test="x"><meta charset="utf-8"><script>window.before=1</script></head><body>Æøå<img src="assets/photo.png"></body></html>';
    const file = item.write('PGL/nested/graphic.html', source);
    const response = await item.get('/PGL/nested/graphic.html?cache=123');
    assert.equal(response.status, 200);
    assert.equal(response.body, source.replace('<head data-test="x">', '<head data-test="x">' + SCRIPT));
    assert.equal(fs.readFileSync(file, 'utf8'), source);
    assert.match(response.headers['content-type'], /^text\/html; charset=utf-8$/);
    assert.match(response.headers['cache-control'], /no-cache/);
    assert.equal(Number(response.headers['content-length']), Buffer.byteLength(response.body));
    assert.equal((await item.get('/PGL/nested/graphic.html')).body, response.body);
});

test('HEAD reports the injected content length without a response body', async t => {
    const item = await fixture(t); item.write('graphic.html', '<head></head><body>test</body>');
    const get = await item.get('/graphic.html'), head = await item.get('/graphic.html', 'HEAD');
    assert.equal(head.status, 200); assert.equal(head.body, '');
    assert.equal(head.headers['content-length'], get.headers['content-length']);
});

test('missing HTML, non-HTML, extensionless directory and non-read requests pass through', async t => {
    const item = await fixture(t); item.write('PGL/index.html', '<head></head>'); item.write('image.svg', '<svg/>');
    for (const [url, method] of [['/missing.html','GET'],['/image.svg','GET'],['/PGL','GET'],['/PGL/index.html','POST']]) {
        const response = await item.get(url, method); assert.equal(response.status, 404); assert.equal(response.body, 'next');
    }
});

test('directory index keeps the existing trailing-slash URL and relative asset paths', async t => {
    const item = await fixture(t); item.write('PGL/index.html', '<head></head><script src="gfx.js"></script>');
    const response = await item.get('/PGL/?v=2');
    assert.equal(response.status, 200); assert.equal(response.body, '<head>' + SCRIPT + '</head><script src="gfx.js"></script>');
    assert.equal(response.headers.location, undefined);
});

test('malformed encodings, nulls, backslashes and encoded traversal never reach files', async t => {
    const item = await fixture(t); fs.writeFileSync(path.join(item.root, 'outside.html'), 'PRIVATE');
    for (const url of ['/%ZZ.html', '/%00.html', '/PGL%5c..%5coutside.html']) {
        assert.equal((await item.get(url)).status, 400);
    }
    for (const url of ['/../outside.html', '/PGL/%2e%2e/%2e%2e/outside.html', '/PGL%2f..%2f..%2foutside.html']) {
        const response = await item.get(url); assert.equal(response.status, 403); assert.ok(!response.body.includes('PRIVATE'));
    }
});

test('existing client is idempotent and CSP is preserved exactly', async t => {
    const item = await fixture(t);
    const source = '<head><meta http-equiv="Content-Security-Policy" content="script-src \'self\'"><script src=\'/bspx-proxy/client.js?v=1\'></script></head><body>unchanged</body>';
    item.write('ready.html', source);
    assert.equal((await item.get('/ready.html')).body, source);
});

test('headless HTML only gains a prefix and oversized HTML is rejected', async t => {
    const item = await fixture(t); item.write('bare.html', '<div>Keep me</div>');
    assert.equal((await item.get('/bare.html')).body, SCRIPT + '<div>Keep me</div>');
    item.write('large.html', 'x'.repeat(1024 * 1024 + 1));
    assert.equal((await item.get('/large.html')).status, 413);
});

test('realpath confines symlinked directories to templates', async t => {
    const item = await fixture(t);
    const outside = path.join(item.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'secret.html'), 'PRIVATE');
    try {
        fs.symlinkSync(outside, path.join(item.templates, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
        if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('Symlink creation is unavailable for this account');
        throw error;
    }
    const escaped = await item.get('/escape/secret.html');
    assert.equal(escaped.status, 403); assert.ok(!escaped.body.includes('PRIVATE'));
});

test('realpath permits a symlink to an HTML file inside templates when supported', async t => {
    const item = await fixture(t); item.write('safe.html', '<head></head>');
    try {
        fs.symlinkSync(path.join(item.templates, 'safe.html'), path.join(item.templates, 'safe-link.html'), 'file');
    } catch (error) {
        if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('File symlinks are unavailable for this account');
        throw error;
    }
    assert.equal((await item.get('/safe-link.html')).status, 200);
});
