import { createHash, randomBytes } from 'node:crypto';
import { consumeKioskChallenge } from './kiosk.mjs';
import { historyOverlaps, validTimestamp } from './history-rules.mjs';

const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const revision = (value) => Number.isSafeInteger(value) && value > 0;
const duration = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 7 * 86400000;

// Identity, policy and caller authorization are trusted server inputs; this is not an HTTP endpoint.
export function confirmScheduledAttendance(db, identity, challenge, purpose, input, policy) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => !['shiftId', 'expectedRevision'].includes(key)) || !id(input.shiftId) || !revision(input.expectedRevision) ||
      !policy || typeof policy !== 'object' || Array.isArray(policy) ||
      Object.keys(policy).some((key) => !['earlyWindowMs', 'lateWindowMs'].includes(key)) ||
      !duration(policy.earlyWindowMs) || !duration(policy.lateWindowMs)) throw new Error('Scheduled attendance failed');
  try {
    return consumeKioskChallenge(db, identity, challenge, purpose, ({ businessId, staffId, deviceId, locationId }) => {
      if (db.prepare('PRAGMA user_version').get().user_version !== 14) throw new Error('Migration required');
      const shift = db.prepare(`SELECT staff_id,location_id,starts_at,ends_at,revision,active FROM scheduled_shifts
        WHERE business_id=? AND id=?`).get(businessId, input.shiftId);
      if (!shift || shift.staff_id !== staffId || shift.location_id !== locationId || shift.active !== 1 || shift.revision !== input.expectedRevision ||
          !validTimestamp(shift.starts_at) || !validTimestamp(shift.ends_at) || shift.ends_at <= shift.starts_at) throw new Error('Invalid shift');
      const now = Date.now(), starts = Date.parse(shift.starts_at), ends = Date.parse(shift.ends_at);
      if (!Number.isSafeInteger(now) || now < starts - policy.earlyWindowMs || now > ends + policy.lateWindowMs) throw new Error('Outside allowed window');
      const recordedAt = new Date(now).toISOString();
      const existing = db.prepare(`SELECT a.record_id,a.staff_id,a.checkin_device_id,a.checkout_device_id,h.staff_id AS history_staff_id,h.starts_at,h.ends_at
        FROM scheduled_attendance a JOIN history h ON h.business_id=a.business_id AND h.id=a.record_id
        WHERE a.business_id=? AND a.shift_id=?`).get(businessId, input.shiftId);
      if (purpose === 'clock-in') {
        if (existing || historyOverlaps(db, businessId, staffId, recordedAt, null)) throw new Error('Attendance conflict');
        const recordId = `clock-${randomBytes(16).toString('hex')}`;
        db.prepare('INSERT INTO history (business_id,id,staff_id,starts_at,ends_at) VALUES (?,?,?,?,NULL)')
          .run(businessId, recordId, staffId, recordedAt);
        db.prepare('INSERT INTO scheduled_attendance (business_id,shift_id,record_id,staff_id,checkin_device_id) VALUES (?,?,?,?,?)')
          .run(businessId, input.shiftId, recordId, staffId, deviceId);
        db.prepare("INSERT INTO scheduled_attendance_events (business_id,shift_id,staff_id,device_id,challenge_digest,purpose,created_at) VALUES (?,?,?,?,?,'clock-in',?)")
          .run(businessId, input.shiftId, staffId, deviceId, createHash('sha256').update(challenge).digest('hex'), recordedAt);
        return { recordId, startsAt: recordedAt, endsAt: null };
      }
      if (purpose !== 'clock-out' || !existing || existing.staff_id !== staffId || existing.history_staff_id !== staffId || existing.checkin_device_id !== deviceId ||
          existing.checkout_device_id !== null || existing.ends_at !== null || !validTimestamp(existing.starts_at) || recordedAt <= existing.starts_at ||
          historyOverlaps(db, businessId, staffId, existing.starts_at, recordedAt, existing.record_id)) throw new Error('Attendance conflict');
      const closed = db.prepare('UPDATE history SET ends_at=? WHERE business_id=? AND id=? AND ends_at IS NULL')
        .run(recordedAt, businessId, existing.record_id);
      if (closed.changes !== 1) throw new Error('Attendance conflict');
      const linked = db.prepare('UPDATE scheduled_attendance SET checkout_device_id=? WHERE business_id=? AND shift_id=? AND checkout_device_id IS NULL')
        .run(deviceId, businessId, input.shiftId);
      if (linked.changes !== 1) throw new Error('Attendance conflict');
      db.prepare("INSERT INTO scheduled_attendance_events (business_id,shift_id,staff_id,device_id,challenge_digest,purpose,created_at) VALUES (?,?,?,?,?,'clock-out',?)")
        .run(businessId, input.shiftId, staffId, deviceId, createHash('sha256').update(challenge).digest('hex'), recordedAt);
      return { recordId: existing.record_id, startsAt: existing.starts_at, endsAt: recordedAt };
    });
  } catch { throw new Error('Scheduled attendance failed'); }
}
