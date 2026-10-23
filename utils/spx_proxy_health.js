'use strict';

const http = require('node:http');
const net = require('node:net');

function validPort(port) {
    return Number.isInteger(port) && port > 0 && port <= 65535;
}

function deadline(value, fallback) {
    return Number.isFinite(value) && value > 0 && value <= 2147483647 ? value : fallback;
}

// OPTIONS is handled locally by the project proxies, without fetching upstream data.
function probeHttp(port, { timeoutMs = 2500 } = {}) {
    if (!validPort(port)) return Promise.resolve(false);
    return new Promise(resolve => {
        let request;
        let response;
        let settled = false;
        const finish = responsive => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (response) response.destroy();
            if (request) request.destroy();
            resolve(responsive);
        };
        // A wall-clock deadline also catches peers that drip incomplete headers.
        const timer = setTimeout(() => finish(false), deadline(timeoutMs, 2500));
        try {
            request = http.request({
                host: '127.0.0.1', port, method: 'OPTIONS', path: '/', agent: false,
                headers: { Connection: 'close' }
            }, incoming => {
                response = incoming;
                response.on('error', () => {});
                if (settled) {
                    response.destroy();
                    return;
                }
                // Any HTTP response proves the local server is dispatching requests.
                finish(true);
            });
            request.on('error', () => finish(false));
            request.end();
        } catch (_) {
            finish(false);
        }
    });
}

function isPortBusy(port, { timeoutMs = 500 } = {}) {
    if (!validPort(port)) return Promise.resolve(false);
    return new Promise(resolve => {
        let socket;
        let settled = false;
        const finish = busy => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (socket) socket.destroy();
            resolve(busy);
        };
        const timer = setTimeout(() => finish(true), deadline(timeoutMs, 500));
        try {
            socket = net.createConnection({ host: '127.0.0.1', port });
            socket.on('connect', () => finish(true));
            // Uncertain failures are treated as busy to avoid competing processes.
            socket.on('error', error => finish(error.code !== 'ECONNREFUSED'));
        } catch (_) {
            finish(true);
        }
    });
}

module.exports = { probeHttp, isPortBusy };
