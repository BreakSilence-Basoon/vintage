import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const maxBytes = 8 * 1024 * 1024;
const hex = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Synthetic-only trusted local experiment. It does not authenticate users or establish filesystem privacy.
export function createEvidenceVault({ directory, acknowledgeSyntheticOnly } = {}) {
  let root;
  try {
    if (acknowledgeSyntheticOnly !== true || !isAbsolute(directory ?? '')) throw new Error('Invalid configuration');
    root = lstatSync(directory);
    if (!root.isDirectory()) throw new Error('Invalid directory');
  } catch { throw new Error('Invalid evidence vault'); }
  function checkRoot() {
    const current = lstatSync(directory);
    if (!current.isDirectory() || current.dev !== root.dev || current.ino !== root.ino) throw new Error('Invalid vault');
  }
  function readVerified(reference) {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference) || Object.keys(reference).length !== 3 ||
        !['id','sha256','size'].every((key) => Object.hasOwn(reference, key)) || !hex(reference.id) || !hex(reference.sha256) ||
        !Number.isSafeInteger(reference.size) || reference.size < 1 || reference.size > maxBytes) throw new Error('Invalid reference');
    checkRoot();
    const path = join(directory, reference.id);
    const before = lstatSync(path);
    if (!before.isFile() || before.size !== reference.size) throw new Error('Invalid file');
    let fd;
    try {
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== reference.size) throw new Error('Changed file');
      const bytes = readFileSync(fd);
      const after = fstatSync(fd), entry = lstatSync(path);
      if (!entry.isFile() || entry.dev !== opened.dev || entry.ino !== opened.ino || after.size !== reference.size || bytes.length !== reference.size ||
          !timingSafeEqual(Buffer.from(digest(bytes), 'hex'), Buffer.from(reference.sha256, 'hex'))) throw new Error('Changed file');
      return bytes;
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  return Object.freeze({
    put(input) {
      try {
        if (!(input instanceof Uint8Array) || input.byteLength < 1 || input.byteLength > maxBytes) throw new Error('Invalid input');
        const bytes = Buffer.from(input), reference = Object.freeze({ id: randomBytes(32).toString('hex'), sha256: digest(bytes), size: bytes.length });
        checkRoot();
        const path = join(directory, reference.id);
        let fd;
        try {
          fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
          writeFileSync(fd, bytes); fsyncSync(fd);
        } finally { if (fd !== undefined) closeSync(fd); }
        readVerified(reference);
        return reference;
      } catch { throw new Error('Evidence operation failed'); }
    },
    read(reference) {
      try { return readVerified(reference); } catch { throw new Error('Evidence operation failed'); }
    },
    inspect(references) {
      try {
        if (!Array.isArray(references) || references.length > 10000) throw new Error('Invalid references');
        const ids = new Set();
        for (const ref of references) {
          if (!ref || typeof ref !== 'object' || Array.isArray(ref) || Object.keys(ref).length !== 3 ||
              !['id','sha256','size'].every((key) => Object.hasOwn(ref, key)) || !hex(ref.id) || !hex(ref.sha256) ||
              !Number.isSafeInteger(ref.size) || ref.size < 1 || ref.size > maxBytes || ids.has(ref.id)) throw new Error('Invalid reference');
          ids.add(ref.id);
        }
        checkRoot();
        const entries = readdirSync(directory, { withFileTypes: true });
        if (entries.length > 10000) throw new Error('Too many entries');
        const names = new Map(entries.map((entry) => [entry.name, entry]));
        const result = { verified: 0, missing: 0, unreadableOrChanged: 0, unregistered: 0, unexpected: 0 };
        for (const ref of references) {
          if (!names.has(ref.id)) result.missing++;
          else { try { readVerified(ref); result.verified++; } catch { result.unreadableOrChanged++; } }
        }
        for (const entry of entries) {
          if (ids.has(entry.name)) continue;
          if (hex(entry.name) && entry.isFile()) result.unregistered++; else result.unexpected++;
        }
        checkRoot();
        return result;
      } catch { throw new Error('Evidence inspection failed'); }
    },
  });
}
