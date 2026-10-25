/* Shared read access to project proxies through the current BSPX instance. */
(function (root) {
    'use strict';

    if (!root || (root.SPXProxy && root.SPXProxy.__sharedProxyClient === 1)) return;

    function host(value) {
        return String(value || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    }

    function readMethod(method) {
        return /^(GET|HEAD|OPTIONS)$/.test(String(method || 'GET').toUpperCase());
    }

    function isRequest(input) {
        return Boolean(root.Request && input && (
            input instanceof root.Request || Object.prototype.toString.call(input) === '[object Request]'
        ));
    }

    function resolve(input) {
        var config = root.SPX_PROXY_CONFIG || {};
        var location = root.location;
        if (!location || !/^https?:$/.test(location.protocol) || typeof root.URL !== 'function') return input;
        var target;
        try {
            target = new root.URL(isRequest(input) ? input.url : input, location.href);
        } catch (_) { return input; }
        if (!/^https?:$/.test(target.protocol) || target.username || target.password) return input;
        // Ordinary controller requests must stay ordinary controller requests.
        if (target.origin === location.origin) return input;
        var ports = Array.isArray(config.ports) ? config.ports : [];
        var port = Number(target.port);
        if (!port || ports.every(function (item) { return Number(item) !== port; })) return input;
        var targetHost = host(target.hostname);
        var aliases = Array.isArray(config.hosts) ? config.hosts : [];
        if (targetHost !== host(location.hostname) && aliases.every(function (item) { return host(item) !== targetHost; })) return input;
        return '/bspx-proxy/' + port + target.pathname + target.search;
    }

    root.SPXProxy = { resolve: resolve, __sharedProxyClient: 1 };

    if (typeof root.fetch === 'function') {
        var originalFetch = root.fetch;
        root.fetch = function (input, init) {
            var method = init && init.method !== undefined ? init.method : (isRequest(input) ? input.method : 'GET');
            if (!readMethod(method)) return originalFetch.call(root, input, init);
            var resolved = resolve(input);
            if (resolved === input) return originalFetch.call(root, input, init);
            // Constructing from a Request copies its headers, cache policy,
            // credentials and abort signal. Explicit init overrides still win.
            if (isRequest(input)) resolved = new root.Request(new root.URL(resolved, root.location.href).href, input);
            return originalFetch.call(root, resolved, init);
        };
    }

    if (root.XMLHttpRequest && root.XMLHttpRequest.prototype && typeof root.XMLHttpRequest.prototype.open === 'function') {
        var originalOpen = root.XMLHttpRequest.prototype.open;
        root.XMLHttpRequest.prototype.open = function (method, url) {
            // Explicit HTTP credentials retain their original destination and
            // authentication semantics instead of being sent to the gateway.
            if (!readMethod(method) || (arguments.length > 3 && (arguments[3] != null || arguments[4] != null))) {
                return originalOpen.apply(this, arguments);
            }
            var resolved = resolve(url);
            if (resolved === url) return originalOpen.apply(this, arguments);
            var args = Array.prototype.slice.call(arguments);
            args[1] = resolved;
            return originalOpen.apply(this, args);
        };
    }
})(typeof window !== 'undefined' ? window : this);
