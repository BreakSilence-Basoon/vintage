const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const subject = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512 && value === value.trim();
const timestamp = (value) => {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) && date.toISOString() === value;
};
const only = (value, keys) => Object.keys(value).every((key) => keys.includes(key));
export class AdminRequestError extends Error {}
export class AdminAccessError extends Error {}

// Identity must come from the server's verified token, never a request body.
export function applyAuthenticatedOperation(db, identity, operation, input) {
  if (!identity || !subject(identity.issuer) || !subject(identity.subject) || !input ||
      typeof input !== 'object' || Array.isArray(input) || !id(input.staffId)) throw new AdminRequestError('Invalid request');
  if (operation === 'add-viewer') {
    if (!only(input, ['staffId', 'subject']) || !subject(input.subject)) throw new AdminRequestError('Invalid request');
  } else if (operation === 'add-history') {
    if (!only(input, ['staffId', 'recordId', 'startsAt', 'endsAt']) || !id(input.recordId) || !timestamp(input.startsAt) ||
        (input.endsAt !== null && !timestamp(input.endsAt)) ||
        (input.endsAt !== null && input.endsAt < input.startsAt)) throw new AdminRequestError('Invalid request');
  } else if (operation === 'deactivate-viewer') {
    if (!only(input, ['staffId'])) throw new AdminRequestError('Invalid request');
  } else throw new AdminRequestError('Invalid request');
  db.exec('PRAGMA foreign_keys = ON');
  if (db.prepare('PRAGMA user_version').get().user_version !== 3) throw new Error('Migration required');
  db.exec('BEGIN IMMEDIATE');
  try {
    const actor = db.prepare("SELECT business_id, staff_id FROM memberships WHERE issuer = ? AND subject = ? AND role = 'ADMIN' AND active = 1")
      .get(identity.issuer, identity.subject);
    if (!actor || !id(actor.business_id) || !id(actor.staff_id)) throw new AdminAccessError('Not authorized');
    const business = actor.business_id;
    if (operation === 'add-viewer') {
      db.prepare('INSERT INTO staff (business_id,id) VALUES (?,?)').run(business, input.staffId);
      db.prepare('INSERT INTO memberships (issuer,subject,business_id,staff_id,role,active) VALUES (?,?,?,?,?,?)')
        .run(identity.issuer, input.subject, business, input.staffId, 'VIEWER', 1);
    } else if (operation === 'add-history') {
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
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
