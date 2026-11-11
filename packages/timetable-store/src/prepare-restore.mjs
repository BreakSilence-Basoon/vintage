import { linkSync, lstatSync, mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { copyTimetableDatabase } from './backup.mjs';
import { createTimetableStore } from './index.mjs';
import { restorePreparationSchema } from './restore-schema.mjs';

// Creates a new offline copy. It never changes the backup or applies the copy to a live service.
export async function prepareRestoredDatabase(source, destination) {
  if (!isAbsolute(source ?? '') || !isAbsolute(destination ?? '') || resolve(source) === resolve(destination)) throw new Error('Invalid paths');
  try { lstatSync(destination); throw new Error('Destination exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const staging = mkdtempSync(join(dirname(destination), '.vintage-restore-'));
  const staged = join(staging, 'prepared.sqlite');
  let db;
  let cutoff;
  try {
    await copyTimetableDatabase(source, staged);
    db = new DatabaseSync(staged);
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('BEGIN IMMEDIATE');
    try {
      const version = db.prepare('PRAGMA user_version').get().user_version;
      if (![11, 12].includes(version)) throw new Error('Unsupported backup version');
      createTimetableStore(db);
      if (version === 11) db.exec(restorePreparationSchema);
      cutoff = Math.floor(Date.now() / 1000) + 1;
      db.prepare('UPDATE memberships SET token_valid_after = MAX(token_valid_after, ?)').run(cutoff);
      const devices = db.prepare('UPDATE kiosk_devices SET active = 0 WHERE active = 1').run().changes;
      const challenges = db.prepare('UPDATE kiosk_challenges SET used_at = ? WHERE used_at IS NULL').run(Date.now()).changes;
      db.prepare("INSERT INTO restore_preparation_events (created_at,token_cutoff,disabled_devices,invalidated_challenges,actor_kind) VALUES (?,?,?,?,'local-operator')")
        .run(new Date().toISOString(), cutoff, devices, challenges);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    createTimetableStore(db);
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length ||
        db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE token_valid_after < ?').get(cutoff).n ||
        db.prepare('SELECT COUNT(*) AS n FROM kiosk_devices WHERE active = 1').get().n ||
        db.prepare('SELECT COUNT(*) AS n FROM kiosk_challenges WHERE used_at IS NULL').get().n) throw new Error('Prepared copy invalid');
    db.close();
    linkSync(staged, destination);
    let cleanupIncomplete = false;
    try { unlinkSync(staged); rmdirSync(staging); } catch { cleanupIncomplete = true; }
    return { cleanupIncomplete };
  } finally {
    if (db?.isOpen) db.close();
  }
}
