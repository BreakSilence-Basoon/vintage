import { lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { copyTimetableDatabase } from './backup.mjs';
import { createTimetableStore } from './index.mjs';
import { historyOverlaps, validTimestamp } from './history-rules.mjs';
import { restorePreparationSchema } from './restore-schema.mjs';
import { recoveryGuardSchema } from './recovery-schema.mjs';

const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const subject = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512 && value === value.trim();
function trustedIssuer(value) {
  try {
    const url = new URL(value);
    return typeof value === 'string' && value.trim() === value && url.protocol === 'https:' &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
function openExisting(path) {
  if (!isAbsolute(path ?? '') || !lstatSync(path).isFile()) throw new Error('Existing regular database required');
  return new DatabaseSync(path);
}

// A backup is created while a write lock prevents changes between copy and migration.
export async function migrateWithBackup(path, backupPath) {
  const db = openExisting(path);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('BEGIN IMMEDIATE');
    try {
      const version = db.prepare('PRAGMA user_version').get().user_version;
      if (![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].includes(version)) throw new Error('Unsupported migration');
      createTimetableStore(db);
      await copyTimetableDatabase(path, backupPath);
      if (version === 1) db.exec(`CREATE TABLE audit_events (
        id INTEGER PRIMARY KEY, business_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('add-viewer', 'add-history', 'deactivate-viewer')),
        staff_id TEXT NOT NULL, record_id TEXT, created_at TEXT NOT NULL,
        actor_kind TEXT NOT NULL CHECK (actor_kind = 'local-operator'),
        FOREIGN KEY (business_id, staff_id) REFERENCES staff(business_id, id),
        FOREIGN KEY (business_id, record_id) REFERENCES history(business_id, id)
      ); PRAGMA user_version = 2;`);
      else if (version === 2) db.exec(`CREATE TABLE authenticated_audit_events (
        id INTEGER PRIMARY KEY, business_id TEXT NOT NULL, actor_staff_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('add-viewer', 'add-history', 'deactivate-viewer')),
        staff_id TEXT NOT NULL, record_id TEXT, created_at TEXT NOT NULL,
        FOREIGN KEY (business_id, actor_staff_id) REFERENCES staff(business_id, id),
        FOREIGN KEY (business_id, staff_id) REFERENCES staff(business_id, id),
        FOREIGN KEY (business_id, record_id) REFERENCES history(business_id, id)
      ); PRAGMA user_version = 3;`);
      else if (version === 3) db.exec(`CREATE TABLE history_close_events (
        id INTEGER PRIMARY KEY, business_id TEXT NOT NULL, actor_staff_id TEXT NOT NULL,
        staff_id TEXT NOT NULL, record_id TEXT NOT NULL, ends_at TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE (business_id, record_id),
        FOREIGN KEY (business_id, actor_staff_id) REFERENCES staff(business_id, id),
        FOREIGN KEY (business_id, staff_id) REFERENCES staff(business_id, id),
        FOREIGN KEY (business_id, record_id) REFERENCES history(business_id, id)
      ); PRAGMA user_version = 4;`);
      else if (version === 4) db.exec('CREATE INDEX history_owner_started_id ON history (business_id, staff_id, starts_at DESC, id DESC); PRAGMA user_version = 5;');
      else if (version === 5) db.exec(`CREATE TABLE schedule_locations (
        business_id TEXT NOT NULL, id TEXT NOT NULL, label TEXT NOT NULL,
        PRIMARY KEY (business_id, id), FOREIGN KEY (business_id) REFERENCES businesses(id)
      ); CREATE TABLE scheduled_shifts (
        business_id TEXT NOT NULL, id TEXT NOT NULL, staff_id TEXT NOT NULL, location_id TEXT NOT NULL,
        starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, grace_minutes INTEGER NOT NULL CHECK (grace_minutes BETWEEN 0 AND 180),
        PRIMARY KEY (business_id, id), FOREIGN KEY (business_id, staff_id) REFERENCES staff(business_id, id),
        FOREIGN KEY (business_id, location_id) REFERENCES schedule_locations(business_id, id)
      ); CREATE INDEX scheduled_shifts_owner_time ON scheduled_shifts (business_id, staff_id, starts_at, id);
      CREATE TABLE schedule_create_events (
        id INTEGER PRIMARY KEY, business_id TEXT NOT NULL, actor_staff_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('add-location', 'add-shift')),
        target_id TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY (business_id, actor_staff_id) REFERENCES staff(business_id, id)
      ); PRAGMA user_version = 6;`);
      else if (version === 6) db.exec(`ALTER TABLE scheduled_shifts ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);
        ALTER TABLE scheduled_shifts ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1));
        CREATE TABLE schedule_change_events (
          id INTEGER PRIMARY KEY, business_id TEXT NOT NULL, actor_staff_id TEXT NOT NULL, shift_id TEXT NOT NULL,
          operation TEXT NOT NULL CHECK (operation IN ('update-shift', 'cancel-shift', 'restore-shift')),
          reason TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL, created_at TEXT NOT NULL,
          FOREIGN KEY (business_id, actor_staff_id) REFERENCES staff(business_id, id),
          FOREIGN KEY (business_id, shift_id) REFERENCES scheduled_shifts(business_id, id)
        ); PRAGMA user_version = 7;`);
      else if (version === 7) db.exec('CREATE INDEX scheduled_shifts_business_time ON scheduled_shifts (business_id, starts_at DESC, id DESC); PRAGMA user_version = 8;');
      else if (version === 8) db.exec(`CREATE TABLE schedule_copy_events (
        id INTEGER PRIMARY KEY, business_id TEXT NOT NULL, actor_staff_id TEXT NOT NULL,
        source_shift_id TEXT NOT NULL, source_revision INTEGER NOT NULL, target_shift_id TEXT NOT NULL,
        target_starts_at TEXT NOT NULL, target_ends_at TEXT NOT NULL, source_snapshot TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE (business_id, target_shift_id),
        FOREIGN KEY (business_id, actor_staff_id) REFERENCES staff(business_id, id),
        FOREIGN KEY (business_id, source_shift_id) REFERENCES scheduled_shifts(business_id, id),
        FOREIGN KEY (business_id, target_shift_id) REFERENCES scheduled_shifts(business_id, id)
      ); PRAGMA user_version = 9;`);
      else if (version === 9) db.exec(`ALTER TABLE memberships ADD COLUMN token_valid_after INTEGER NOT NULL DEFAULT 0 CHECK (token_valid_after >= 0);
      CREATE TABLE membership_reactivation_events (
        id INTEGER PRIMARY KEY, business_id TEXT NOT NULL, actor_staff_id TEXT NOT NULL,
        staff_id TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY (business_id, actor_staff_id) REFERENCES staff(business_id, id),
        FOREIGN KEY (business_id, staff_id) REFERENCES staff(business_id, id)
      ); PRAGMA user_version = 10;`);
      else if (version === 10) db.exec(`CREATE TABLE kiosk_devices (
        business_id TEXT NOT NULL, id TEXT NOT NULL, location_id TEXT NOT NULL,
        credential_digest TEXT NOT NULL UNIQUE, active INTEGER NOT NULL CHECK (active IN (0, 1)),
        PRIMARY KEY (business_id, id), FOREIGN KEY (business_id, location_id) REFERENCES schedule_locations(business_id, id)
      ); CREATE TABLE kiosk_device_events (
        id INTEGER PRIMARY KEY, business_id TEXT NOT NULL, actor_staff_id TEXT NOT NULL, device_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('register', 'revoke')), created_at TEXT NOT NULL,
        FOREIGN KEY (business_id, actor_staff_id) REFERENCES staff(business_id, id),
        FOREIGN KEY (business_id, device_id) REFERENCES kiosk_devices(business_id, id)
      ); CREATE TABLE kiosk_challenges (
        digest TEXT NOT NULL PRIMARY KEY, business_id TEXT NOT NULL, device_id TEXT NOT NULL,
        purpose TEXT NOT NULL CHECK (purpose IN ('clock-in', 'clock-out')), expires_at INTEGER NOT NULL,
        used_at INTEGER, actor_staff_id TEXT,
        FOREIGN KEY (business_id, device_id) REFERENCES kiosk_devices(business_id, id),
        FOREIGN KEY (business_id, actor_staff_id) REFERENCES staff(business_id, id)
      ); CREATE INDEX kiosk_challenges_device_expiry ON kiosk_challenges (business_id,device_id,expires_at);
      PRAGMA user_version = 11;`);
      else if (version === 11) db.exec(restorePreparationSchema);
      else if (version === 12) db.exec(recoveryGuardSchema);
      else db.exec(`CREATE TABLE scheduled_attendance (
        business_id TEXT NOT NULL, shift_id TEXT NOT NULL, record_id TEXT NOT NULL, staff_id TEXT NOT NULL,
        checkin_device_id TEXT NOT NULL, checkout_device_id TEXT,
        PRIMARY KEY (business_id, shift_id), UNIQUE (business_id, record_id),
        FOREIGN KEY (business_id, shift_id) REFERENCES scheduled_shifts(business_id, id),
        FOREIGN KEY (business_id, record_id) REFERENCES history(business_id, id),
        FOREIGN KEY (business_id, staff_id) REFERENCES staff(business_id, id),
        FOREIGN KEY (business_id, checkin_device_id) REFERENCES kiosk_devices(business_id, id),
        FOREIGN KEY (business_id, checkout_device_id) REFERENCES kiosk_devices(business_id, id)
      ); CREATE TABLE scheduled_attendance_events (
        id INTEGER PRIMARY KEY, business_id TEXT NOT NULL, shift_id TEXT NOT NULL,
        staff_id TEXT NOT NULL, device_id TEXT NOT NULL, challenge_digest TEXT NOT NULL UNIQUE,
        purpose TEXT NOT NULL CHECK (purpose IN ('clock-in', 'clock-out')), created_at TEXT NOT NULL,
        UNIQUE (business_id, shift_id, purpose),
        FOREIGN KEY (business_id, shift_id) REFERENCES scheduled_shifts(business_id, id),
        FOREIGN KEY (business_id, staff_id) REFERENCES staff(business_id, id),
        FOREIGN KEY (business_id, device_id) REFERENCES kiosk_devices(business_id, id),
        FOREIGN KEY (challenge_digest) REFERENCES kiosk_challenges(digest)
      ); PRAGMA user_version = 14;`);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}

export function applyLocalOperation(path, operation, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !id(input.businessId) || !id(input.staffId)) throw new Error('Invalid input');
  if (operation === 'add-viewer') {
    if (Object.keys(input).some((key) => !['businessId', 'staffId', 'issuer', 'subject'].includes(key)) ||
        !trustedIssuer(input.issuer) || !subject(input.subject)) throw new Error('Invalid input');
  } else if (operation === 'add-history') {
    if (Object.keys(input).some((key) => !['businessId', 'staffId', 'recordId', 'startsAt', 'endsAt'].includes(key)) ||
        !id(input.recordId) || !validTimestamp(input.startsAt) ||
        (input.endsAt !== null && !validTimestamp(input.endsAt)) ||
        (input.endsAt !== null && input.endsAt <= input.startsAt)) throw new Error('Invalid input');
  } else if (operation === 'deactivate-viewer') {
    if (Object.keys(input).some((key) => !['businessId', 'staffId'].includes(key))) throw new Error('Invalid input');
  } else throw new Error('Invalid operation');

  const db = openExisting(path);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    if (![2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].includes(db.prepare('PRAGMA user_version').get().user_version)) throw new Error('Migration required');
    db.exec('BEGIN IMMEDIATE');
    try {
      if (db.prepare('PRAGMA user_version').get().user_version >= 13 && db.prepare('SELECT status FROM recovery_guard WHERE id = 1').get()?.status === 'pending') throw new Error('Recovery authority review required');
      if (operation === 'add-viewer') {
        db.prepare('INSERT INTO staff (business_id,id) VALUES (?,?)').run(input.businessId, input.staffId);
        db.prepare('INSERT INTO memberships (issuer,subject,business_id,staff_id,role,active) VALUES (?,?,?,?,?,?)')
          .run(input.issuer, input.subject, input.businessId, input.staffId, 'VIEWER', 1);
      } else if (operation === 'add-history') {
        if (historyOverlaps(db, input.businessId, input.staffId, input.startsAt, input.endsAt)) throw new Error('Record conflicts');
        db.prepare('INSERT INTO history (business_id,id,staff_id,starts_at,ends_at) VALUES (?,?,?,?,?)')
          .run(input.businessId, input.recordId, input.staffId, input.startsAt, input.endsAt);
      } else {
        const result = db.prepare("UPDATE memberships SET active = 0 WHERE business_id = ? AND staff_id = ? AND role = 'VIEWER' AND active = 1")
          .run(input.businessId, input.staffId);
        if (result.changes !== 1) throw new Error('Expected one active viewer');
      }
      db.prepare('INSERT INTO audit_events (business_id,operation,staff_id,record_id,created_at,actor_kind) VALUES (?,?,?,?,?,?)')
        .run(input.businessId, operation, input.staffId, operation === 'add-history' ? input.recordId : null,
          new Date().toISOString(), 'local-operator');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}
