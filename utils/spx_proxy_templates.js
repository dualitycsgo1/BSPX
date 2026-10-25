'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const CLIENT_SCRIPT = '<script src="/bspx-proxy/client.js"></script>';
const MAX_TEMPLATE_BYTES = 1024 * 1024;
const EXISTING_CLIENT = /<script\b[^>]*\bsrc\s*=\s*(?:"\/bspx-proxy\/client\.js(?:\?[^"<>]*)?"|'\/bspx-proxy\/client\.js(?:\?[^'<>]*)?'|\/bspx-proxy\/client\.js(?:\?[^\s<>]*)?)(?=\s|>)[^>]*>/i;

function isWithin(base, file) {
    const relative = path.relative(base, file);
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

// Mount before express.static at /templates. The HTML response gains only this
// same-origin client; template source files, CSP and asset paths stay untouched.
function createTemplateProxyMiddleware({ root = process.cwd() } = {}) {
    const templates = path.resolve(root, 'ASSETS', 'templates');
    return async function templateProxyClient(req, res, next) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        let pathname;
        try {
            pathname = decodeURIComponent(String(req.path || req.url || '').split('?')[0]);
        } catch (_) {
            res.statusCode = 400;
            return res.end('Invalid template path');
        }
        if (!pathname.startsWith('/') || pathname.includes('\0') || pathname.includes('\\')) {
            res.statusCode = 400;
            return res.end('Invalid template path');
        }
        if (pathname.split('/').includes('..')) {
            res.statusCode = 403;
            return res.end('Template path is outside the template folder');
        }
        // Leave extensionless directory redirects to express.static, preserving
        // relative asset resolution. A trailing slash may serve its index.html.
        if (pathname.endsWith('/')) pathname += 'index.html';
        else if (!/\.html$/i.test(pathname)) return next();
        const requested = path.resolve(templates, '.' + pathname);
        if (!isWithin(templates, requested)) {
            res.statusCode = 403;
            return res.end('Template path is outside the template folder');
        }
        let handle;
        try {
            const [base, file] = await Promise.all([fs.realpath(templates), fs.realpath(requested)]);
            if (!isWithin(base, file)) {
                res.statusCode = 403;
                return res.end('Template path is outside the template folder');
            }
            handle = await fs.open(file, 'r');
            const stat = await handle.stat();
            if (!stat.isFile()) return next();
            if (stat.size > MAX_TEMPLATE_BYTES) {
                res.statusCode = 413;
                return res.end('Template is too large');
            }
            // Bound the actual read too: a file can grow after the stat call.
            const buffer = Buffer.allocUnsafe(MAX_TEMPLATE_BYTES + 1);
            let length = 0;
            while (length < buffer.length) {
                const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
                if (!bytesRead) break;
                length += bytesRead;
            }
            if (length > MAX_TEMPLATE_BYTES) {
                res.statusCode = 413;
                return res.end('Template is too large');
            }
            let html = buffer.subarray(0, length).toString('utf8');
            if (!EXISTING_CLIENT.test(html)) {
                const head = /<head\b[^>]*>/i;
                html = head.test(html) ? html.replace(head, '$&' + CLIENT_SCRIPT) : CLIENT_SCRIPT + html;
            }
            const body = Buffer.from(html, 'utf8');
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Content-Length', String(body.length));
            return res.end(req.method === 'HEAD' ? undefined : body);
        } catch (error) {
            if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return next();
            return next(error);
        } finally {
            if (handle) await handle.close().catch(() => {});
        }
    };
}

module.exports = { createTemplateProxyMiddleware };
