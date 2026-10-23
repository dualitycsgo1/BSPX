'use strict';

const path = require('path');
const pending = new Map();

function buildControllerEntries(data) {
  const templates = Array.isArray(data?.templates) ? data.templates : [];
  const dividers = (Array.isArray(data?.dividers) ? data.dividers : []).slice().sort((a, b) => {
    const difference = Number(a.position) - Number(b.position);
    return difference || String(a.id).localeCompare(String(b.id));
  });
  const entries = [];
  let nextDivider = 0;
  function appendDivider(divider) {
    const entry = { ...divider, type: 'divider' };
    delete entry.templateIndex;
    entries.push(entry);
  }
  templates.forEach((template, index) => {
    while (nextDivider < dividers.length && Number(dividers[nextDivider].position) <= index) {
      appendDivider(dividers[nextDivider++]);
    }
    // These two values describe this render, never a previously saved render.
    entries.push({ ...template, type: 'graphic', templateIndex: index });
  });
  while (nextDivider < dividers.length) appendDivider(dividers[nextDivider++]);
  return entries;
}

function changedRundown() {
  const error = new Error('Rundown changed. Reload before reordering.');
  error.status = 409;
  error.statusCode = 409;
  return error;
}

function indexed(items, key) {
  const result = new Map();
  items.forEach(item => {
    if (!item || item[key] == null || String(item[key]) === '') throw changedRundown();
    const id = String(item[key]);
    if (result.has(id)) throw changedRundown();
    result.set(id, item);
  });
  return result;
}

function take(index, id) {
  if (id == null || !index.has(String(id))) throw changedRundown();
  const item = index.get(String(id));
  index.delete(String(id));
  return item;
}

function sortedRundown(data, order = {}) {
  const originals = Array.isArray(data?.templates) ? data.templates : [];
  const originalDividers = Array.isArray(data?.dividers) ? data.dividers : [];
  const graphics = indexed(originals, 'itemID');
  const separators = indexed(originalDividers, 'id');
  const templates = [];
  let dividers;

  if (Array.isArray(order.controllerOrder)) {
    dividers = [];
    order.controllerOrder.forEach(entry => {
      if (entry?.type === 'graphic') {
        templates.push(take(graphics, entry.id));
      } else if (entry?.type === 'divider') {
        dividers.push({ ...take(separators, entry.id), position: templates.length });
      } else {
        throw changedRundown();
      }
    });
    if (graphics.size || separators.size) throw changedRundown();
  } else if (Array.isArray(order.newTemplateOrderArr)) {
    order.newTemplateOrderArr.forEach(id => templates.push(take(graphics, id)));
    if (graphics.size) throw changedRundown();
    // Older controllers sort only graphics. Their request must not discard or
    // reposition dividers introduced by a newer controller.
    dividers = originalDividers.slice();
  } else {
    throw changedRundown();
  }

  const result = { ...data, templates };
  if (Array.isArray(data.dividers) || Array.isArray(order.controllerOrder)) result.dividers = dividers;
  delete result.controllerEntries;
  return result;
}

function serializeRundown(file, task) {
  if (!file || (typeof file === 'string' && !file.trim())) return Promise.resolve().then(task);
  const target = path.resolve(file);
  const previous = pending.get(target) || Promise.resolve();
  const operation = previous.then(task);
  const settled = operation.then(() => {}, () => {});
  pending.set(target, settled);
  settled.then(() => {
    if (pending.get(target) === settled) pending.delete(target);
  });
  return operation;
}

function wrapRundown(resolveFile, handler) {
  return (req, res, next) => Promise.resolve()
    .then(() => serializeRundown(resolveFile(req), () => handler(req, res, next)))
    .catch(next);
}

function createItemIdAllocator(templates, seed = Date.now()) {
  const allocated = new Set((Array.isArray(templates) ? templates : [])
    .filter(item => item?.itemID != null).map(item => String(item.itemID)));
  let next = BigInt(seed);
  return () => {
    while (allocated.has(String(next))) next += 1n;
    const id = String(next);
    allocated.add(id);
    next += 1n;
    return id;
  };
}

module.exports = { buildControllerEntries, sortedRundown, serializeRundown, wrapRundown, createItemIdAllocator };
