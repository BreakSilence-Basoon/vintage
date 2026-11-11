import { createHash, randomBytes } from 'node:crypto';

const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const token = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const part = (value) => typeof value === 'string' && value.length > 0 && value.length <= 2048 && value === value.trim();
const hash = (value) => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const validIdentity = (identity) => identity && part(identity.issuer) && part(identity.subject) && Number.isSafeInteger(identity.issuedAt) && identity.issuedAt >= 0;

function transaction(db, operation) {
  let begun = false;
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('BEGIN IMMEDIATE');
    begun = true;
    if (db.prepare('PRAGMA user_version').get().user_version !== 11) throw new Error('Invalid version');
    const result = operation();
    if (result && typeof result.then === 'function') throw new Error('Asynchronous operation');
    db.exec('COMMIT');
    begun = false;
    return result;
  } catch {
    if (begun) { try { db.exec('ROLLBACK'); } catch {} }
    throw new Error('Kiosk operation failed');
  }
}

// Identity and action are trusted server inputs. No HTTP route uses these primitives yet.
function admin(db, identity) {
  if (!validIdentity(identity)) throw new Error('Invalid identity');
  const actor = db.prepare("SELECT business_id,staff_id FROM memberships WHERE issuer=? AND subject=? AND role='ADMIN' AND active=1 AND token_valid_after <= ?")
    .get(identity.issuer, identity.subject, identity.issuedAt);
  if (!actor || !id(actor.business_id) || !id(actor.staff_id)) throw new Error('Not authorized');
  return actor;
}

export function registerKiosk(db, identity, { deviceId, locationId } = {}) {
  return transaction(db, () => {
    if (!id(deviceId) || !id(locationId)) throw new Error('Invalid input');
    const actor = admin(db, identity);
    if (!db.prepare('SELECT 1 FROM schedule_locations WHERE business_id=? AND id=?').get(actor.business_id, locationId)) throw new Error('Invalid location');
    const credential = random();
    db.prepare('INSERT INTO kiosk_devices (business_id,id,location_id,credential_digest,active) VALUES (?,?,?,?,1)')
      .run(actor.business_id, deviceId, locationId, hash(credential));
    db.prepare("INSERT INTO kiosk_device_events (business_id,actor_staff_id,device_id,operation,created_at) VALUES (?,?,?,'register',?)")
      .run(actor.business_id, actor.staff_id, deviceId, new Date().toISOString());
    return credential;
  });
}

export function revokeKiosk(db, identity, deviceId) {
  return transaction(db, () => {
    if (!id(deviceId)) throw new Error('Invalid input');
    const actor = admin(db, identity);
    const changed = db.prepare('UPDATE kiosk_devices SET active=0 WHERE business_id=? AND id=? AND active=1').run(actor.business_id, deviceId);
    if (changed.changes !== 1) throw new Error('Invalid device');
    db.prepare("INSERT INTO kiosk_device_events (business_id,actor_staff_id,device_id,operation,created_at) VALUES (?,?,?,'revoke',?)")
      .run(actor.business_id, actor.staff_id, deviceId, new Date().toISOString());
  });
}

export function issueKioskChallenge(db, credential, purpose, ttlSeconds) {
  return transaction(db, () => {
    if (!token(credential) || !['clock-in', 'clock-out'].includes(purpose) || !Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 300) throw new Error('Invalid input');
    const device = db.prepare('SELECT business_id,id FROM kiosk_devices WHERE credential_digest=? AND active=1').get(hash(credential));
    if (!device) throw new Error('Invalid device');
    const now = Date.now();
    const outstanding = db.prepare('SELECT COUNT(*) AS n FROM kiosk_challenges WHERE business_id=? AND device_id=? AND used_at IS NULL AND expires_at > ?')
      .get(device.business_id, device.id, now).n;
    if (outstanding >= 64) throw new Error('Capacity reached');
    const challenge = random();
    db.prepare('INSERT INTO kiosk_challenges (digest,business_id,device_id,purpose,expires_at) VALUES (?,?,?,?,?)')
      .run(hash(challenge), device.business_id, device.id, purpose, now + ttlSeconds * 1000);
    return challenge;
  });
}

// `action` is trusted synchronous server code; it must not commit, roll back, or perform external effects.
// This primitive does not itself create an attendance record or prove physical presence.
export function consumeKioskChallenge(db, identity, challenge, purpose, action) {
  return transaction(db, () => {
    if (!validIdentity(identity) || !token(challenge) || !['clock-in', 'clock-out'].includes(purpose) ||
        typeof action !== 'function' || action.constructor?.name === 'AsyncFunction') throw new Error('Invalid input');
    const actor = db.prepare("SELECT business_id,staff_id FROM memberships WHERE issuer=? AND subject=? AND active=1 AND role IN ('VIEWER','ADMIN') AND token_valid_after <= ?")
      .get(identity.issuer, identity.subject, identity.issuedAt);
    if (!actor || !id(actor.business_id) || !id(actor.staff_id)) throw new Error('Not authorized');
    const now = Date.now();
    const found = db.prepare(`SELECT c.device_id, d.location_id FROM kiosk_challenges c JOIN kiosk_devices d
      ON d.business_id=c.business_id AND d.id=c.device_id AND d.active=1
      WHERE c.digest=? AND c.business_id=? AND c.purpose=? AND c.used_at IS NULL AND c.expires_at > ?`)
      .get(hash(challenge), actor.business_id, purpose, now);
    if (!found) throw new Error('Invalid challenge');
    const result = action({ businessId: actor.business_id, staffId: actor.staff_id, deviceId: found.device_id, locationId: found.location_id });
    if (result && typeof result.then === 'function') throw new Error('Asynchronous operation');
    const finishedAt = Date.now();
    const changed = db.prepare('UPDATE kiosk_challenges SET used_at=?, actor_staff_id=? WHERE digest=? AND used_at IS NULL AND expires_at > ?')
      .run(finishedAt, actor.staff_id, hash(challenge), finishedAt);
    if (changed.changes !== 1) throw new Error('Invalid challenge');
    return result;
  });
}
