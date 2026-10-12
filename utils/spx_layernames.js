// Optional display names for web playout layers 1-10, shown in the project settings dropdown.

const fs = require('fs');
const path = require('path');

const MAX_LAYER = 10;
const MAX_NAME = 60;

function appRoot() {
    if (process.pkg) return path.resolve(process.execPath + '/..');
    return process.cwd();
}

function namesFile() {
    return path.join(appRoot(), 'layer-names.json');
}

function load() {
    try {
        const data = JSON.parse(fs.readFileSync(namesFile(), 'utf8'));
        return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch (error) {
        return {};
    }
}

function list() {
    const names = load();
    const rows = [];
    for (let i = 1; i <= MAX_LAYER; i++) {
        rows.push({ layer: i, name: typeof names[i] === 'string' ? names[i] : '' });
    }
    return rows;
}

function save(input) {
    const names = {};
    for (let i = 1; i <= MAX_LAYER; i++) {
        const value = String((input && input['layer' + i]) || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, MAX_NAME);
        if (value) names[i] = value;
    }
    fs.writeFileSync(namesFile(), JSON.stringify(names, null, 2));
    return Object.keys(names).length;
}

function label(layer) {
    const name = load()[layer];
    return name ? 'Layer ' + layer + ' - ' + name : String(layer);
}

module.exports = {
    list: list,
    save: save,
    label: label
};
