'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pending = new Map();

async function renameReadyFile(temporary, filepath) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fs.promises.rename(temporary, filepath);
    } catch (error) {
      // Windows readers/virus scanners may briefly hold a file open without
      // delete sharing. Keep serving the old file while waiting for that lock.
      if (process.platform !== 'win32' || attempt >= 20 ||
          !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(10 * (attempt + 1), 100)));
    }
  }
}

// Readers keep seeing the previous complete file until the replacement is ready.
// Never fall back to truncating or deleting the destination on rename failure.
async function replaceFile(filepath, contents) {
  const temporary = path.join(path.dirname(filepath),
    '.' + path.basename(filepath) + '.' + process.pid + '.' + crypto.randomBytes(12).toString('hex') + '.tmp');
  let handle;
  let created = false;
  try {
    let mode;
    try {
      mode = (await fs.promises.stat(filepath)).mode & 0o777;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    handle = await fs.promises.open(temporary, 'wx', mode === undefined ? 0o666 : mode);
    created = true;
    if (mode !== undefined) await handle.chmod(mode);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameReadyFile(temporary, filepath);
    created = false;
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (created) await fs.promises.unlink(temporary).catch(() => {});
  }
}

module.exports = function writeAtomicJson(filepath, contents) {
  const target = path.resolve(filepath);
  // Serialize saves of the same file, including after a failed previous save.
  const previous = pending.get(target) || Promise.resolve();
  const operation = previous.then(() => replaceFile(target, contents));
  const settled = operation.then(() => {}, () => {});
  pending.set(target, settled);
  settled.then(() => {
    if (pending.get(target) === settled) pending.delete(target);
  });
  return operation;
};
