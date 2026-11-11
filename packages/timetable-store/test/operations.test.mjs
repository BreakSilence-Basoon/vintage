import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initializeTimetableStore, createTimetableStore } from '../src/index.mjs';
import { applyLocalOperation, migrateWithBackup } from '../src/operations.mjs';
import { copyTimetableDatabase } from '../src/backup.mjs';

const issuer = 'https://identity.example.invalid';
const person = { issuer, subject: 'example-viewer', businessId: 'shop-a', staffId: 'staff-a' };
const history = { businessId: 'shop-a', staffId: 'staff-a', recordId: 'record-a', startsAt: '2026-01-01T09:00:00.000Z', endsAt: null };

test('migration backs up old data before transactional operations and audit', async () => {
  const prefix = join(tmpdir(), 'vintage-operations-');
  const temp = mkdtempSync(prefix);
  let db, snapshot;
  try {
    const path = join(temp, 'fixture.sqlite');
    const backup = join(temp, 'backup.sqlite');
    db = new DatabaseSync(path);
    initializeTimetableStore(db);
    db.prepare('INSERT INTO businesses (id) VALUES (?)').run('shop-a');
    db.close();
    await migrateWithBackup(path, backup);
    snapshot = new DatabaseSync(backup, { readOnly: true });
    assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(snapshot.prepare('SELECT COUNT(*) AS count FROM businesses').get().count, 1);
    applyLocalOperation(path, 'add-viewer', person);
    applyLocalOperation(path, 'add-history', history);
    db = new DatabaseSync(path, { readOnly: true });
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 2);
    const result = await createTimetableStore(db).findAccessAndHistory(issuer, 'example-viewer', 'record-a');
    assert.equal(result.actor.role, 'VIEWER');
    assert.equal(result.record.startsAt, history.startsAt);
    db.close();
    const laterBackup = join(temp, 'version-two-backup.sqlite');
    await copyTimetableDatabase(path, laterBackup);
    const later = new DatabaseSync(laterBackup, { readOnly: true });
    try {
      assert.equal(later.prepare('PRAGMA user_version').get().user_version, 2);
      assert.equal(later.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 2);
    } finally { later.close(); }
    assert.throws(() => applyLocalOperation(path, 'add-viewer', person));
    assert.throws(() => applyLocalOperation(path, 'add-viewer', { ...person, staffId: 'staff-b' }));
    assert.throws(() => applyLocalOperation(path, 'add-viewer', { ...person, subject: 'example-new', staffId: 'staff-c', role: 'ADMIN' }));
    assert.throws(() => applyLocalOperation(path, 'add-history', { ...history, recordId: 'record-b', staffId: 'missing' }));
    assert.throws(() => applyLocalOperation(path, 'add-history', { ...history, recordId: 'record-c', endsAt: 'invalid' }));
    assert.throws(() => applyLocalOperation(path, 'add-history', { ...history, recordId: 'record-d', startsAt: '2026-01-02T09:00:00.000Z' }));
    applyLocalOperation(path, 'deactivate-viewer', { businessId: 'shop-a', staffId: 'staff-a' });
    assert.throws(() => applyLocalOperation(path, 'deactivate-viewer', { businessId: 'shop-a', staffId: 'staff-a' }));
    db = new DatabaseSync(path, { readOnly: true });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 3);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM history').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM staff').get().count, 1);
    assert.equal(await createTimetableStore(db).findAccessAndHistory(issuer, 'example-viewer', 'record-a'), null);
  } finally {
    if (snapshot?.isOpen) snapshot.close();
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});

test('migration keeps the verified backup and rolls back if the schema change fails', async () => {
  const prefix = join(tmpdir(), 'vintage-migration-failure-');
  const temp = mkdtempSync(prefix);
  let db, backupDb;
  try {
    const path = join(temp, 'fixture.sqlite');
    const backup = join(temp, 'backup.sqlite');
    db = new DatabaseSync(path);
    initializeTimetableStore(db);
    db.exec('CREATE TABLE audit_events (existing TEXT)');
    db.close();
    await assert.rejects(migrateWithBackup(path, backup));
    db = new DatabaseSync(path, { readOnly: true });
    backupDb = new DatabaseSync(backup, { readOnly: true });
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(backupDb.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(backupDb.prepare('PRAGMA user_version').get().user_version, 1);
  } finally {
    if (backupDb?.isOpen) backupDb.close();
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});

test('migration does not begin while another writer holds the database', async () => {
  const prefix = join(tmpdir(), 'vintage-migration-lock-');
  const temp = mkdtempSync(prefix);
  let db;
  try {
    const path = join(temp, 'fixture.sqlite');
    const backup = join(temp, 'backup.sqlite');
    db = new DatabaseSync(path);
    initializeTimetableStore(db);
    db.exec('BEGIN IMMEDIATE');
    await assert.rejects(migrateWithBackup(path, backup));
    db.exec('ROLLBACK');
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  } finally {
    if (db?.isTransaction) db.exec('ROLLBACK');
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});

test('migration holds a write lock while making the backup', async () => {
  const prefix = join(tmpdir(), 'vintage-migration-copy-lock-');
  const temp = mkdtempSync(prefix);
  let db;
  try {
    const path = join(temp, 'fixture.sqlite');
    db = new DatabaseSync(path);
    initializeTimetableStore(db);
    const migrating = migrateWithBackup(path, join(temp, 'backup.sqlite'));
    assert.throws(() => db.exec('BEGIN IMMEDIATE'));
    await migrating;
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  } finally {
    if (db?.isTransaction) db.exec('ROLLBACK');
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});

test('migration refuses an existing backup and leaves the database untouched', async () => {
  const prefix = join(tmpdir(), 'vintage-migration-');
  const temp = mkdtempSync(prefix);
  let db;
  try {
    const path = join(temp, 'fixture.sqlite');
    const existing = join(temp, 'existing.sqlite');
    db = new DatabaseSync(path);
    initializeTimetableStore(db);
    db.close();
    writeFileSync(existing, 'existing-file');
    await assert.rejects(migrateWithBackup(path, existing));
    assert.equal(readFileSync(existing, 'utf8'), 'existing-file');
    db = new DatabaseSync(path, { readOnly: true });
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  } finally {
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});
