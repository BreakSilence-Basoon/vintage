import { historyOverlaps, validTimestamp } from './history-rules.mjs';

const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const subject = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512 && value === value.trim();
const only = (value, keys) => Object.keys(value).every((key) => keys.includes(key));
export class AdminRequestError extends Error {}
export class AdminAccessError extends Error {}
export class AdminConflictError extends Error {}

// Identity must come from the server's verified token, never a request body.
export function applyAuthenticatedOperation(db, identity, operation, input) {
  if (!identity || !subject(identity.issuer) || !subject(identity.subject) || !input ||
      typeof input !== 'object' || Array.isArray(input)) throw new AdminRequestError('Invalid request');
  if (operation === 'add-viewer') {
    if (!only(input, ['staffId', 'subject']) || !id(input.staffId) || !subject(input.subject)) throw new AdminRequestError('Invalid request');
  } else if (operation === 'add-history') {
    if (!only(input, ['staffId', 'recordId', 'startsAt', 'endsAt']) || !id(input.staffId) || !id(input.recordId) || !validTimestamp(input.startsAt) ||
        (input.endsAt !== null && !validTimestamp(input.endsAt)) ||
        (input.endsAt !== null && input.endsAt <= input.startsAt)) throw new AdminRequestError('Invalid request');
  } else if (operation === 'deactivate-viewer') {
    if (!only(input, ['staffId']) || !id(input.staffId)) throw new AdminRequestError('Invalid request');
  } else if (operation === 'close-history') {
    if (!only(input, ['recordId', 'endsAt']) || !id(input.recordId) || !validTimestamp(input.endsAt)) throw new AdminRequestError('Invalid request');
  } else throw new AdminRequestError('Invalid request');
  db.exec('PRAGMA foreign_keys = ON');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (![3, 4, 5].includes(version) || (operation === 'close-history' && version < 4)) throw new Error('Migration required');
  db.exec('BEGIN IMMEDIATE');
  try {
    const actor = db.prepare("SELECT business_id, staff_id FROM memberships WHERE issuer = ? AND subject = ? AND role = 'ADMIN' AND active = 1")
      .get(identity.issuer, identity.subject);
    if (!actor || !id(actor.business_id) || !id(actor.staff_id)) throw new AdminAccessError('Not authorized');
    const business = actor.business_id;
    if (operation === 'close-history') {
      const record = db.prepare('SELECT staff_id, starts_at, ends_at FROM history WHERE business_id = ? AND id = ?').get(business, input.recordId);
      if (!record || !id(record.staff_id) || !validTimestamp(record.starts_at) || input.endsAt <= record.starts_at) {
        throw new AdminConflictError('Record conflicts');
      }
      if (record.ends_at !== null) {
        const event = db.prepare('SELECT ends_at FROM history_close_events WHERE business_id = ? AND record_id = ?')
          .get(business, input.recordId);
        if (record.ends_at !== input.endsAt || !event || event.ends_at !== input.endsAt) throw new AdminConflictError('Record conflicts');
        db.exec('COMMIT');
        return { replayed: true };
      }
      if (historyOverlaps(db, business, record.staff_id, record.starts_at, input.endsAt, input.recordId)) {
        throw new AdminConflictError('Record conflicts');
      }
      const updated = db.prepare('UPDATE history SET ends_at = ? WHERE business_id = ? AND id = ? AND ends_at IS NULL')
        .run(input.endsAt, business, input.recordId);
      if (updated.changes !== 1) throw new AdminConflictError('Record conflicts');
      db.prepare('INSERT INTO history_close_events (business_id,actor_staff_id,staff_id,record_id,ends_at,created_at) VALUES (?,?,?,?,?,?)')
        .run(business, actor.staff_id, record.staff_id, input.recordId, input.endsAt, new Date().toISOString());
      db.exec('COMMIT');
      return { replayed: false };
    } else if (operation === 'add-viewer') {
      db.prepare('INSERT INTO staff (business_id,id) VALUES (?,?)').run(business, input.staffId);
      db.prepare('INSERT INTO memberships (issuer,subject,business_id,staff_id,role,active) VALUES (?,?,?,?,?,?)')
        .run(identity.issuer, input.subject, business, input.staffId, 'VIEWER', 1);
    } else if (operation === 'add-history') {
      const existing = db.prepare('SELECT staff_id, starts_at, ends_at FROM history WHERE business_id = ? AND id = ?')
        .get(business, input.recordId);
      if (existing) {
        if (existing.staff_id !== input.staffId || existing.starts_at !== input.startsAt || existing.ends_at !== input.endsAt) {
          throw new AdminConflictError('Record conflicts');
        }
        db.exec('COMMIT');
        return { replayed: true };
      }
      if (historyOverlaps(db, business, input.staffId, input.startsAt, input.endsAt)) throw new AdminConflictError('Record conflicts');
      db.prepare('INSERT INTO history (business_id,id,staff_id,starts_at,ends_at) VALUES (?,?,?,?,?)')
        .run(business, input.recordId, input.staffId, input.startsAt, input.endsAt);
    } else {
      const result = db.prepare("UPDATE memberships SET active = 0 WHERE business_id = ? AND staff_id = ? AND role = 'VIEWER' AND active = 1")
        .run(business, input.staffId);
      if (result.changes !== 1) throw new AdminRequestError('Invalid target');
    }
    db.prepare('INSERT INTO authenticated_audit_events (business_id,actor_staff_id,operation,staff_id,record_id,created_at) VALUES (?,?,?,?,?,?)')
      .run(business, actor.staff_id, operation, input.staffId, operation === 'add-history' ? input.recordId : null, new Date().toISOString());
    db.exec('COMMIT');
    return { replayed: false };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
