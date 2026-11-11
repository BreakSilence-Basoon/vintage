import { historyOverlaps, validTimestamp } from './history-rules.mjs';

const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const subject = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512 && value === value.trim();
const only = (value, keys) => Object.keys(value).every((key) => keys.includes(key));
const label = (value) => typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= 100 && !/[\p{Cc}]/u.test(value);
const reason = (value) => typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= 500 && !/[\p{Cc}]/u.test(value);
const revision = (value) => Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER;
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
  } else if (operation === 'reactivate-viewer') {
    if (!only(input, ['staffId', 'reason']) || !id(input.staffId) || !reason(input.reason)) throw new AdminRequestError('Invalid request');
  } else if (operation === 'close-history') {
    if (!only(input, ['recordId', 'endsAt']) || !id(input.recordId) || !validTimestamp(input.endsAt)) throw new AdminRequestError('Invalid request');
  } else if (operation === 'add-location') {
    if (!only(input, ['locationId', 'label']) || !id(input.locationId) || !label(input.label)) throw new AdminRequestError('Invalid request');
  } else if (operation === 'add-shift') {
    if (!only(input, ['shiftId', 'staffId', 'locationId', 'startsAt', 'endsAt', 'graceMinutes']) || !id(input.shiftId) ||
        !id(input.staffId) || !id(input.locationId) || !validTimestamp(input.startsAt) || !validTimestamp(input.endsAt) ||
        input.endsAt <= input.startsAt || !Number.isInteger(input.graceMinutes) || input.graceMinutes < 0 || input.graceMinutes > 180) throw new AdminRequestError('Invalid request');
  } else if (operation === 'update-shift') {
    if (!only(input, ['shiftId', 'staffId', 'locationId', 'startsAt', 'endsAt', 'graceMinutes', 'expectedRevision', 'reason']) ||
        !id(input.shiftId) || !id(input.staffId) || !id(input.locationId) || !validTimestamp(input.startsAt) || !validTimestamp(input.endsAt) ||
        input.endsAt <= input.startsAt || !Number.isInteger(input.graceMinutes) || input.graceMinutes < 0 || input.graceMinutes > 180 ||
        !revision(input.expectedRevision) || !reason(input.reason)) throw new AdminRequestError('Invalid request');
  } else if (operation === 'cancel-shift' || operation === 'restore-shift') {
    if (!only(input, ['shiftId', 'expectedRevision', 'reason']) || !id(input.shiftId) || !revision(input.expectedRevision) || !reason(input.reason)) throw new AdminRequestError('Invalid request');
  } else if (operation === 'copy-shift') {
    if (!only(input, ['sourceShiftId', 'sourceRevision', 'shiftId', 'startsAt', 'endsAt']) || !id(input.sourceShiftId) ||
        !revision(input.sourceRevision) || !id(input.shiftId) || !validTimestamp(input.startsAt) || !validTimestamp(input.endsAt) ||
        input.endsAt <= input.startsAt) throw new AdminRequestError('Invalid request');
  } else throw new AdminRequestError('Invalid request');
  db.exec('PRAGMA foreign_keys = ON');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (![3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].includes(version) || (operation === 'close-history' && version < 4) ||
      (['add-location', 'add-shift'].includes(operation) && version < 6) ||
      (['update-shift', 'cancel-shift', 'restore-shift'].includes(operation) && version < 7) ||
      (operation === 'copy-shift' && version < 9) || (operation === 'reactivate-viewer' && version < 10)) throw new Error('Migration required');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (version >= 13 && db.prepare('SELECT status FROM recovery_guard WHERE id = 1').get()?.status === 'pending') throw new Error('Recovery authority review required');
    const actor = db.prepare(`SELECT business_id, staff_id FROM memberships WHERE issuer = ? AND subject = ? AND role = 'ADMIN' AND active = 1 ${version >= 10 ? 'AND token_valid_after <= ?' : ''}`)
      .get(identity.issuer, identity.subject, ...(version >= 10 ? [Number.isSafeInteger(identity.issuedAt) && identity.issuedAt >= 0 ? identity.issuedAt : -1] : []));
    if (!actor || !id(actor.business_id) || !id(actor.staff_id)) throw new AdminAccessError('Not authorized');
    const business = actor.business_id;
    if (operation === 'reactivate-viewer') {
      const targets = db.prepare('SELECT role,active,token_valid_after FROM memberships WHERE business_id = ? AND staff_id = ?').all(business, input.staffId);
      if (targets.length !== 1 || targets[0].role !== 'VIEWER' || targets[0].active !== 0) throw new AdminConflictError('Invalid target');
      const validAfter = Math.max(targets[0].token_valid_after, Math.floor(Date.now() / 1000) + 1);
      const changed = db.prepare("UPDATE memberships SET active = 1, token_valid_after = ? WHERE business_id = ? AND staff_id = ? AND role = 'VIEWER' AND active = 0")
        .run(validAfter, business, input.staffId);
      if (changed.changes !== 1) throw new AdminConflictError('Invalid target');
      db.prepare('INSERT INTO membership_reactivation_events (business_id,actor_staff_id,staff_id,reason,created_at) VALUES (?,?,?,?,?)')
        .run(business, actor.staff_id, input.staffId, input.reason, new Date().toISOString());
      db.exec('COMMIT'); return { replayed: false };
    }
    if (operation === 'copy-shift') {
      const existing = db.prepare('SELECT staff_id,location_id,starts_at,ends_at,grace_minutes,revision,active FROM scheduled_shifts WHERE business_id = ? AND id = ?').get(business, input.shiftId);
      if (existing) {
        const event = db.prepare('SELECT source_shift_id,source_revision,target_starts_at,target_ends_at,source_snapshot FROM schedule_copy_events WHERE business_id = ? AND target_shift_id = ?').get(business, input.shiftId);
        if (!event || event.source_shift_id !== input.sourceShiftId || event.source_revision !== input.sourceRevision ||
            event.target_starts_at !== input.startsAt || event.target_ends_at !== input.endsAt || existing.starts_at !== input.startsAt ||
            existing.ends_at !== input.endsAt || existing.revision !== 1 || existing.active !== 1) throw new AdminConflictError('Shift conflicts');
        const snapshot = JSON.parse(event.source_snapshot);
        if (snapshot.staff_id !== existing.staff_id || snapshot.location_id !== existing.location_id || snapshot.grace_minutes !== existing.grace_minutes) throw new AdminConflictError('Shift conflicts');
        db.exec('COMMIT'); return { replayed: true };
      }
      const source = db.prepare('SELECT staff_id,location_id,starts_at,ends_at,grace_minutes,revision,active FROM scheduled_shifts WHERE business_id = ? AND id = ?').get(business, input.sourceShiftId);
      if (!source || source.active !== 1 || source.revision !== input.sourceRevision) throw new AdminConflictError('Shift conflicts');
      if (!db.prepare('SELECT 1 FROM memberships WHERE business_id = ? AND staff_id = ? AND active = 1').get(business, source.staff_id) ||
          !db.prepare('SELECT 1 FROM schedule_locations WHERE business_id = ? AND id = ?').get(business, source.location_id)) throw new AdminRequestError('Invalid target');
      if (db.prepare('SELECT 1 FROM scheduled_shifts WHERE business_id = ? AND staff_id = ? AND active = 1 AND starts_at < ? AND ends_at > ? LIMIT 1')
        .get(business, source.staff_id, input.endsAt, input.startsAt)) throw new AdminConflictError('Shift conflicts');
      db.prepare('INSERT INTO scheduled_shifts (business_id,id,staff_id,location_id,starts_at,ends_at,grace_minutes) VALUES (?,?,?,?,?,?,?)')
        .run(business, input.shiftId, source.staff_id, source.location_id, input.startsAt, input.endsAt, source.grace_minutes);
      db.prepare('INSERT INTO schedule_copy_events (business_id,actor_staff_id,source_shift_id,source_revision,target_shift_id,target_starts_at,target_ends_at,source_snapshot,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(business, actor.staff_id, input.sourceShiftId, input.sourceRevision, input.shiftId, input.startsAt, input.endsAt, JSON.stringify(source), new Date().toISOString());
      db.exec('COMMIT'); return { replayed: false };
    }
    if (['update-shift', 'cancel-shift', 'restore-shift'].includes(operation)) {
      const old = db.prepare('SELECT staff_id,location_id,starts_at,ends_at,grace_minutes,revision,active FROM scheduled_shifts WHERE business_id = ? AND id = ?').get(business, input.shiftId);
      if (!old || old.revision !== input.expectedRevision || (operation === 'restore-shift' ? old.active !== 0 : old.active !== 1)) throw new AdminConflictError('Shift conflicts');
      const next = operation === 'update-shift' ? { staff_id: input.staffId, location_id: input.locationId, starts_at: input.startsAt,
        ends_at: input.endsAt, grace_minutes: input.graceMinutes, revision: old.revision + 1, active: 1 } :
        { ...old, revision: old.revision + 1, active: operation === 'restore-shift' ? 1 : 0 };
      if (next.active) {
        if (!db.prepare('SELECT 1 FROM schedule_locations WHERE business_id = ? AND id = ?').get(business, next.location_id) ||
            !db.prepare('SELECT 1 FROM memberships WHERE business_id = ? AND staff_id = ? AND active = 1').get(business, next.staff_id)) throw new AdminRequestError('Invalid target');
        if (db.prepare('SELECT 1 FROM scheduled_shifts WHERE business_id = ? AND staff_id = ? AND active = 1 AND id <> ? AND starts_at < ? AND ends_at > ? LIMIT 1')
          .get(business, next.staff_id, input.shiftId, next.ends_at, next.starts_at)) throw new AdminConflictError('Shift conflicts');
      }
      const updated = db.prepare('UPDATE scheduled_shifts SET staff_id = ?, location_id = ?, starts_at = ?, ends_at = ?, grace_minutes = ?, revision = ?, active = ? WHERE business_id = ? AND id = ? AND revision = ?')
        .run(next.staff_id, next.location_id, next.starts_at, next.ends_at, next.grace_minutes, next.revision, next.active, business, input.shiftId, old.revision);
      if (updated.changes !== 1) throw new AdminConflictError('Shift conflicts');
      db.prepare('INSERT INTO schedule_change_events (business_id,actor_staff_id,shift_id,operation,reason,before_json,after_json,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(business, actor.staff_id, input.shiftId, operation, input.reason, JSON.stringify(old), JSON.stringify(next), new Date().toISOString());
      db.exec('COMMIT'); return { replayed: false };
    }
    if (operation === 'add-location' || operation === 'add-shift') {
      const location = db.prepare('SELECT label FROM schedule_locations WHERE business_id = ? AND id = ?').get(business, input.locationId);
      if (operation === 'add-location') {
        if (location) {
          if (location.label !== input.label) throw new AdminConflictError('Location conflicts');
          db.exec('COMMIT'); return { replayed: true };
        }
        db.prepare('INSERT INTO schedule_locations (business_id,id,label) VALUES (?,?,?)').run(business, input.locationId, input.label);
      } else {
        const existing = db.prepare(`SELECT staff_id,location_id,starts_at,ends_at,grace_minutes${version >= 7 ? ',revision,active' : ''} FROM scheduled_shifts WHERE business_id = ? AND id = ?`).get(business, input.shiftId);
        if (existing) {
          if (existing.staff_id !== input.staffId || existing.location_id !== input.locationId || existing.starts_at !== input.startsAt ||
              existing.ends_at !== input.endsAt || existing.grace_minutes !== input.graceMinutes || (version >= 7 && (existing.revision !== 1 || existing.active !== 1))) throw new AdminConflictError('Shift conflicts');
          db.exec('COMMIT'); return { replayed: true };
        }
        if (!location || !db.prepare('SELECT 1 FROM memberships WHERE business_id = ? AND staff_id = ? AND active = 1').get(business, input.staffId)) throw new AdminRequestError('Invalid target');
        if (db.prepare(`SELECT 1 FROM scheduled_shifts WHERE business_id = ? AND staff_id = ? ${version >= 7 ? 'AND active = 1' : ''} AND starts_at < ? AND ends_at > ? LIMIT 1`)
          .get(business, input.staffId, input.endsAt, input.startsAt)) throw new AdminConflictError('Shift conflicts');
        db.prepare('INSERT INTO scheduled_shifts (business_id,id,staff_id,location_id,starts_at,ends_at,grace_minutes) VALUES (?,?,?,?,?,?,?)')
          .run(business, input.shiftId, input.staffId, input.locationId, input.startsAt, input.endsAt, input.graceMinutes);
      }
      db.prepare('INSERT INTO schedule_create_events (business_id,actor_staff_id,operation,target_id,created_at) VALUES (?,?,?,?,?)')
        .run(business, actor.staff_id, operation, operation === 'add-location' ? input.locationId : input.shiftId, new Date().toISOString());
      db.exec('COMMIT'); return { replayed: false };
    }
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
