import { openSync, closeSync, linkSync, lstatSync, mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { createTimetableStore } from './index.mjs';

function verifyDatabase(db) {
  const results = db.prepare('PRAGMA integrity_check').all();
  if (results.length !== 1 || results[0].integrity_check !== 'ok' ||
      db.prepare('PRAGMA foreign_key_check').all().length !== 0) throw new Error('Invalid database');
  createTimetableStore(db);
}

// Build and verify a private staging copy, then atomically link a new destination.
export async function copyTimetableDatabase(source, destination) {
  if (!isAbsolute(source ?? '') || !isAbsolute(destination ?? '') || resolve(source) === resolve(destination)) {
    throw new Error('Two distinct absolute paths are required');
  }
  const src = new DatabaseSync(source, { readOnly: true });
  let dest;
  try {
    verifyDatabase(src);
    try {
      lstatSync(destination);
      throw new Error('Destination already exists');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const staging = mkdtempSync(join(dirname(destination), '.vintage-copy-'));
    const stagedFile = join(staging, 'snapshot.sqlite');
    const fd = openSync(stagedFile, 'wx', 0o600);
    closeSync(fd);
    await backup(src, stagedFile);
    // A standalone destination cannot depend on a staging-path WAL or shared-memory file.
    // Convert only the private copy, after SQLite's backup has finished.
    dest = new DatabaseSync(stagedFile);
    if (dest.prepare('PRAGMA journal_mode = DELETE').get().journal_mode.toLowerCase() !== 'delete') throw new Error('Could not finalize backup journal');
    verifyDatabase(dest);
    dest.close();
    linkSync(stagedFile, destination);
    unlinkSync(stagedFile);
    rmdirSync(staging);
  } finally {
    if (dest?.isOpen) dest.close();
    if (src.isOpen) src.close();
  }
}
