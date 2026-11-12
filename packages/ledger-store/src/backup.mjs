import { closeSync, linkSync, lstatSync, mkdtempSync, openSync, rmdirSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

export function verifyStructure(db) {
  const integrity = db.prepare('PRAGMA integrity_check').all();
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' ||
      db.prepare('PRAGMA foreign_key_check').all().length || ![1, 2].includes(version)) throw new Error('Invalid database');
  for (const name of ['ledger_facts', 'ledger_operations']) {
    if (db.prepare("SELECT type FROM sqlite_schema WHERE name=?").get(name)?.type !== 'table') throw new Error('Invalid schema');
  }
  db.prepare('SELECT id,revision,fact_json FROM ledger_facts LIMIT 0');
  db.prepare('SELECT operation_id,actor_id,fingerprint,fact_id,revision,before_json,after_json,recorded_at FROM ledger_operations LIMIT 0');
  if (version === 2) {
    for (const name of ['ledger_recovery_guard', 'ledger_recovery_events']) {
      if (db.prepare('SELECT type FROM sqlite_schema WHERE name=?').get(name)?.type !== 'table') throw new Error('Invalid schema');
    }
    const guard = db.prepare('SELECT status,generation FROM ledger_recovery_guard WHERE id=1').get();
    if (!guard || !['pending', 'unlocked'].includes(guard.status) || !Number.isSafeInteger(guard.generation) || guard.generation < 1) throw new Error('Invalid guard');
    db.prepare('SELECT generation,operation,operator_id,reason,recorded_at FROM ledger_recovery_events LIMIT 0');
  }
}

// Copies only to a new path. The caller must protect source, destination and any staging files.
export async function copyLedgerDatabase(source, destination) {
  let original, staged;
  try {
    if (!isAbsolute(source ?? '') || !isAbsolute(destination ?? '') || resolve(source) === resolve(destination) || !lstatSync(source).isFile()) throw new Error('Invalid paths');
    try { lstatSync(destination); throw new Error('Destination exists'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    original = new DatabaseSync(source, { readOnly: true });
    verifyStructure(original);
    const directory = mkdtempSync(join(dirname(destination), '.ledger-copy-'));
    const temporary = join(directory, 'snapshot.sqlite');
    const fd = openSync(temporary, 'wx', 0o600);
    closeSync(fd);
    await backup(original, temporary);
    staged = new DatabaseSync(temporary);
    if (staged.prepare('PRAGMA journal_mode = DELETE').get().journal_mode.toLowerCase() !== 'delete') throw new Error('Snapshot not standalone');
    verifyStructure(staged);
    staged.close(); staged = undefined;
    linkSync(temporary, destination); // Atomic no-overwrite publication; requires hard-link support.
    unlinkSync(temporary);
    rmdirSync(directory);
  } catch { throw new Error('Ledger copy failed'); }
  finally {
    if (staged?.isOpen) staged.close();
    if (original?.isOpen) original.close();
  }
}
