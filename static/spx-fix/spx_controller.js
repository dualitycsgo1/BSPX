// Controller-specific layout and editor mounting for SPX Graphics.
// Keeps the left rundown as compact rows and hosts the active editor
// in #controllerEditorMount on the right. Does not auto-playout.

(function (global) {
    'use strict';

    function isControllerView() {
        var id = document.getElementById('identifier');
        return !!(id && id.value === 'controller');
    }

    function getMount() {
        return document.getElementById('controllerEditorMount');
    }

    function getEmpty() {
        return document.getElementById('controllerEditorEmpty');
    }

    function getExpanded(itemrow) {
        if (!itemrow) return null;
        var local = itemrow.querySelector('.controller-expanded') || itemrow.querySelector('#Expanded');
        if (local) return local;
        var epoch = itemrow.getAttribute('data-spx-epoch') || '';
        var mount = getMount();
        if (!mount) return null;
        var nodes = mount.querySelectorAll('.controller-expanded, #Expanded');
        for (var i = 0; i < nodes.length; i++) {
            if (String(nodes[i].getAttribute('data-spx-owner-epoch') || '') === String(epoch)) {
                return nodes[i];
            }
        }
        return null;
    }

    function findRowByEpoch(epoch) {
        if (epoch == null || epoch === '') return null;
        var rows = document.querySelectorAll('.itemrow');
        for (var i = 0; i < rows.length; i++) {
            if (String(rows[i].getAttribute('data-spx-epoch') || '') === String(epoch)) {
                return rows[i];
            }
        }
        return null;
    }

    function collectMountedEditors(mount) {
        var seen = [];
        if (!mount) return seen;
        Array.prototype.forEach.call(mount.querySelectorAll('.controller-expanded, #Expanded'), function (node) {
            if (seen.indexOf(node) === -1) seen.push(node);
        });
        Array.prototype.forEach.call(mount.children, function (node) {
            if (node.id === 'controllerEditorEmpty') return;
            if (seen.indexOf(node) === -1 && node.classList && (node.classList.contains('controller-expanded') || node.id === 'Expanded')) {
                seen.push(node);
            }
        });
        return seen;
    }

    function parkEditorNode(expanded, fallbackEpoch) {
        if (!expanded) return;
        expanded.classList.remove('is-open');
        expanded.style.setProperty('display', 'none', 'important');
        var epoch = expanded.getAttribute('data-spx-owner-epoch') || fallbackEpoch || '';
        var row = findRowByEpoch(epoch);
        if (row) {
            getHome(row).appendChild(expanded);
        }
    }

    function getHome(itemrow) {
        if (!itemrow) return null;
        var home = itemrow.querySelector('.controller-editor-home');
        if (home) return home;
        var handle = itemrow.querySelector('.handle') || itemrow;
        home = document.createElement('div');
        home.className = 'controller-editor-home';
        handle.appendChild(home);
        return home;
    }

    function bindEditorToForm(expanded, itemrow) {
        if (!expanded || !itemrow) return;
        var form = itemrow.querySelector('form');
        if (!form || !form.id) return;
        expanded.querySelectorAll('input, select, textarea, button').forEach(function (el) {
            if (!el.getAttribute('form')) {
                el.setAttribute('form', form.id);
            }
        });
        expanded.setAttribute('data-spx-owner-epoch', itemrow.getAttribute('data-spx-epoch') || '');
    }

    function parkControllerEditor() {
        var mount = getMount();
        if (!mount) return;
        var fallbackEpoch = mount.getAttribute('data-spx-owner-epoch') || '';
        collectMountedEditors(mount).forEach(function (expanded) {
            parkEditorNode(expanded, fallbackEpoch);
        });
        // Anything still sitting in the mount is an orphan — hide it.
        collectMountedEditors(mount).forEach(function (expanded) {
            expanded.classList.remove('is-open');
            expanded.style.setProperty('display', 'none', 'important');
        });
        mount.removeAttribute('data-spx-owner-epoch');
        document.querySelectorAll('.itemrow.controller-editor-active').forEach(function (r) {
            r.classList.remove('controller-editor-active');
        });
        var empty = getEmpty();
        if (empty) empty.hidden = false;
    }

    function layoutControllerFields(expanded) {
        var host = expanded && expanded.querySelector('.controller-fields');
        if (!host) return;

        host.querySelectorAll('.kamp-heading').forEach(function (el) { el.remove(); });
        host.querySelectorAll('.kamp-block, .kamp-row').forEach(function (wrap) {
            while (wrap.firstChild) {
                wrap.parentNode.insertBefore(wrap.firstChild, wrap);
            }
            wrap.remove();
        });

        var fields = Array.prototype.slice.call(host.querySelectorAll(':scope > .controller-field'));
        if (!fields.length) return;

        fields.forEach(function (field) {
            var ftype = field.getAttribute('data-ftype') || '';
            var name = field.getAttribute('data-field') || '';
            var title = (field.getAttribute('data-title') || '').toLowerCase();
            field.classList.remove('controller-field-wide');
            if (ftype === 'instruction' || ftype === 'caption' || ftype === 'textarea' || ftype === 'divider' || ftype === 'hidden' || name === 'f0') {
                field.classList.add('controller-field-wide');
            }
            if ((title === 'board title' || title === 'title' || title.indexOf('titel') !== -1) && !/kamp\s+\d/i.test(title)) {
                field.classList.add('controller-field-wide');
            }
        });

        var kampNums = [];
        fields.forEach(function (field) {
            var title = field.getAttribute('data-title') || '';
            var name = field.getAttribute('data-field') || '';
            var match = title.match(/Kamp\s+(\d+)/i) || name.match(/^[hats](\d+)$/i);
            if (match && kampNums.indexOf(match[1]) === -1) {
                kampNums.push(match[1]);
            }
        });
        if (!kampNums.length) return;

        function findKamp(n, kind) {
            var re;
            if (kind === 'home') re = new RegExp('Kamp\\s+' + n + '.*(hjemme|hold 1|team a)', 'i');
            if (kind === 'away') re = new RegExp('Kamp\\s+' + n + '.*(ude|hold 2|team b)', 'i');
            if (kind === 'time') re = new RegExp('Kamp\\s+' + n + '.*(tid|score|time)', 'i');
            if (kind === 'status') re = new RegExp('Kamp\\s+' + n + '.*status', 'i');
            var byTitle = fields.find(function (f) { return re && re.test(f.getAttribute('data-title') || ''); });
            if (byTitle) return byTitle;
            var prefix = { home: 'h', away: 'a', time: 't', status: 's' }[kind];
            return fields.find(function (f) { return (f.getAttribute('data-field') || '') === (prefix + n); });
        }

        var grouped = new Set();
        var inserted = new Set();
        var queue = [];

        fields.forEach(function (field) {
            var title = field.getAttribute('data-title') || '';
            var name = field.getAttribute('data-field') || '';
            var match = title.match(/Kamp\s+(\d+)/i) || name.match(/^[hats](\d+)$/i);
            var n = match && match[1];
            if (!n) {
                queue.push(field);
                return;
            }
            if (inserted.has(n)) {
                grouped.add(field);
                return;
            }
            inserted.add(n);
            var block = document.createElement('div');
            block.className = 'kamp-block';
            var heading = document.createElement('div');
            heading.className = 'kamp-heading';
            heading.textContent = 'Kamp ' + n;
            block.appendChild(heading);

            var teams = document.createElement('div');
            teams.className = 'kamp-row';
            var home = findKamp(n, 'home');
            var away = findKamp(n, 'away');
            if (home) { teams.appendChild(home); grouped.add(home); }
            if (away) { teams.appendChild(away); grouped.add(away); }
            block.appendChild(teams);

            var meta = document.createElement('div');
            meta.className = 'kamp-row';
            var time = findKamp(n, 'time');
            var status = findKamp(n, 'status');
            if (time) { meta.appendChild(time); grouped.add(time); }
            if (status) { meta.appendChild(status); grouped.add(status); }
            block.appendChild(meta);
            queue.push(block);
        });

        queue.forEach(function (node) { host.appendChild(node); });
    }

    function openControllerEditor(itemrow) {
        if (!isControllerView() || !itemrow) return;
        var mount = getMount();
        if (!mount) return;
        var epoch = itemrow.getAttribute('data-spx-epoch') || '';
        var existing = getExpanded(itemrow);
        var already = existing && existing.parentNode === mount && String(existing.getAttribute('data-spx-owner-epoch') || '') === String(epoch);
        if (already) {
            collectMountedEditors(mount).forEach(function (node) {
                if (node !== existing) parkEditorNode(node, mount.getAttribute('data-spx-owner-epoch'));
            });
            existing.classList.add('is-open');
            existing.style.setProperty('display', 'block', 'important');
            itemrow.classList.add('controller-editor-active');
            mount.setAttribute('data-spx-owner-epoch', epoch);
            var emptyOpen = getEmpty();
            if (emptyOpen) emptyOpen.hidden = true;
            return;
        }

        parkControllerEditor();
        var expanded = getExpanded(itemrow);
        if (!expanded) return;
        bindEditorToForm(expanded, itemrow);
        mount.appendChild(expanded);
        mount.setAttribute('data-spx-owner-epoch', epoch);
        expanded.classList.add('is-open');
        expanded.style.setProperty('display', 'block', 'important');
        itemrow.classList.add('controller-editor-active');
        var empty = getEmpty();
        if (empty) empty.hidden = true;
        layoutControllerFields(expanded);
        if (typeof AppState === 'function') AppState('EDITING');
    }

    function closeControllerEditor() {
        parkControllerEditor();
        if (typeof AppState === 'function') AppState('DEFAULT');
    }

    function selectControllerItem(item, evt) {
        if (!item) return;
        if (evt) {
            var target = evt.target;
            if (target && target.closest && target.closest('input, select, textarea, button, a, label, .gcinput, .deleteItem, .utilityOverlay, .controller-expanded, .controller-drag-handle, .controller-divider')) {
                return;
            }
            evt.stopPropagation();
        }
        if (typeof focusRow === 'function') {
            focusRow(item, { skipPreview: true, skipScrollIfSame: true });
        }
        openControllerEditor(item);
    }

    function addControllerDivider() {
        var order = [];
        document.querySelectorAll('#itemList > .itemrow, #itemList > .controller-divider').forEach(function (element) {
            if (element.classList.contains('itemrow')) {
                order.push({ type: 'graphic', id: element.getAttribute('data-spx-epoch') });
            } else {
                order.push({ type: 'divider', id: element.getAttribute('data-divider-id') });
            }
        });
        post('', {
            command: 'addControllerDivider',
            title: '',
            position: document.querySelectorAll('#itemList > .itemrow').length,
            dividerID: String(Date.now()),
            visualIndex: order.length,
            datafile: document.getElementById('datafile').value,
            foldername: document.getElementById('foldername').value,
            listname: document.getElementById('filebasename').value
        }, 'post');
    }

    function removeControllerDivider(dividerID) {
        post('', {
            command: 'removeControllerDivider',
            dividerID: dividerID,
            datafile: document.getElementById('datafile').value,
            foldername: document.getElementById('foldername').value,
            listname: document.getElementById('filebasename').value
        }, 'post');
    }

    global.isControllerView = isControllerView;
    global.parkControllerEditor = parkControllerEditor;
    global.openControllerEditor = openControllerEditor;
    global.closeControllerEditor = closeControllerEditor;
    global.layoutControllerFields = layoutControllerFields;
    global.selectControllerItem = selectControllerItem;
    global.addControllerDivider = addControllerDivider;
    global.removeControllerDivider = removeControllerDivider;
})(window);
