import { lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { copyTimetableDatabase } from './backup.mjs';
import { createTimetableStore } from './index.mjs';

const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const subject = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512 && value === value.trim();
const timestamp = (value) => {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) && date.toISOString() === value;
};
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
      if (db.prepare('PRAGMA user_version').get().user_version !== 1) throw new Error('Expected version 1');
      createTimetableStore(db);
      await copyTimetableDatabase(path, backupPath);
      db.exec(`CREATE TABLE audit_events (
        id INTEGER PRIMARY KEY, business_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('add-viewer', 'add-history', 'deactivate-viewer')),
        staff_id TEXT NOT NULL, record_id TEXT, created_at TEXT NOT NULL,
        actor_kind TEXT NOT NULL CHECK (actor_kind = 'local-operator'),
        FOREIGN KEY (business_id, staff_id) REFERENCES staff(business_id, id),
        FOREIGN KEY (business_id, record_id) REFERENCES history(business_id, id)
      ); PRAGMA user_version = 2;`);
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
        !id(input.recordId) || !timestamp(input.startsAt) ||
        (input.endsAt !== null && !timestamp(input.endsAt)) ||
        (input.endsAt !== null && input.endsAt < input.startsAt)) throw new Error('Invalid input');
  } else if (operation === 'deactivate-viewer') {
    if (Object.keys(input).some((key) => !['businessId', 'staffId'].includes(key))) throw new Error('Invalid input');
  } else throw new Error('Invalid operation');

  const db = openExisting(path);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    if (db.prepare('PRAGMA user_version').get().user_version !== 2) throw new Error('Migration required');
    db.exec('BEGIN IMMEDIATE');
    try {
      if (operation === 'add-viewer') {
        db.prepare('INSERT INTO staff (business_id,id) VALUES (?,?)').run(input.businessId, input.staffId);
        db.prepare('INSERT INTO memberships (issuer,subject,business_id,staff_id,role,active) VALUES (?,?,?,?,?,?)')
          .run(input.issuer, input.subject, input.businessId, input.staffId, 'VIEWER', 1);
      } else if (operation === 'add-history') {
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
