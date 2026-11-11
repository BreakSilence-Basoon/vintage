import { lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createTimetableStore } from './index.mjs';

const text = (value, max) => typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= max && !/[\p{Cc}]/u.test(value);

// This trusts an offline operator to verify the selected identity against current authority.
export function unlockRecoveredAdmin(path, input) {
  if (!isAbsolute(path ?? '') || !lstatSync(path).isFile() || !input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => !['issuer', 'subject', 'reason'].includes(key)) ||
      !text(input.issuer, 2048) || !text(input.subject, 512) || !text(input.reason, 500)) throw new Error('Invalid input');
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('BEGIN IMMEDIATE');
    try {
      if (db.prepare('PRAGMA user_version').get().user_version !== 13) throw new Error('Invalid version');
      createTimetableStore(db);
      const guard = db.prepare('SELECT preparation_id,status FROM recovery_guard WHERE id = 1').get();
      if (!guard || guard.status !== 'pending' || db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE active <> 0').get().n) throw new Error('Invalid recovery state');
      const candidate = db.prepare(`SELECT c.business_id,c.staff_id FROM recovery_admin_candidates c JOIN memberships m
        ON m.issuer=c.issuer AND m.subject=c.subject AND m.business_id=c.business_id AND m.staff_id=c.staff_id
        WHERE c.preparation_id=? AND c.issuer=? AND c.subject=? AND m.role='ADMIN' AND m.active=0`)
        .get(guard.preparation_id, input.issuer, input.subject);
      if (!candidate) throw new Error('Invalid candidate');
      const cutoff = Math.floor(Date.now() / 1000) + 1;
      const changed = db.prepare("UPDATE memberships SET active=1,token_valid_after=MAX(token_valid_after,?) WHERE issuer=? AND subject=? AND role='ADMIN' AND active=0")
        .run(cutoff, input.issuer, input.subject);
      if (changed.changes !== 1) throw new Error('Invalid candidate');
      db.prepare("INSERT INTO recovery_admin_unlock_events (preparation_id,business_id,staff_id,reason,created_at,actor_kind) VALUES (?,?,?,?,?,'local-operator')")
        .run(guard.preparation_id, candidate.business_id, candidate.staff_id, input.reason, new Date().toISOString());
      const updated = db.prepare("UPDATE recovery_guard SET status='unlocked' WHERE id=1 AND status='pending' AND preparation_id=?").run(guard.preparation_id);
      if (updated.changes !== 1) throw new Error('Invalid recovery state');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}
