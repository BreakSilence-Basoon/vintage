import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initializeTimetableStore, createTimetableStore } from '../src/index.mjs';
import { migrateWithBackup } from '../src/operations.mjs';
import { applyAuthenticatedOperation } from '../src/admin.mjs';
import { copyTimetableDatabase } from '../src/backup.mjs';

test('only current admin may change own business, with actor-bound atomic audit', async () => {
  const prefix = join(tmpdir(), 'vintage-admin-');
  const temp = mkdtempSync(prefix);
  let db;
  try {
    const path = join(temp, 'fixture.sqlite');
    const issuer = 'https://identity.example.invalid';
    db = new DatabaseSync(path);
    initializeTimetableStore(db);
    db.prepare('INSERT INTO businesses (id) VALUES (?)').run('shop-a');
    db.prepare('INSERT INTO businesses (id) VALUES (?)').run('shop-b');
    db.prepare('INSERT INTO staff (business_id,id) VALUES (?,?)').run('shop-a', 'admin-a');
    db.prepare('INSERT INTO staff (business_id,id) VALUES (?,?)').run('shop-b', 'other-b');
    db.prepare('INSERT INTO memberships (issuer,subject,business_id,staff_id,role,active) VALUES (?,?,?,?,?,?)')
      .run(issuer, 'example-admin', 'shop-a', 'admin-a', 'ADMIN', 1);
    db.close();
    await migrateWithBackup(path, join(temp, 'v1-backup.sqlite'));
    await migrateWithBackup(path, join(temp, 'v2-backup.sqlite'));
    db = new DatabaseSync(path);
    const admin = { issuer, subject: 'example-admin' };
    const viewer = { issuer, subject: 'example-viewer' };
    applyAuthenticatedOperation(db, admin, 'add-viewer', { staffId: 'staff-a', subject: viewer.subject });
    applyAuthenticatedOperation(db, admin, 'add-history', { staffId: 'staff-a', recordId: 'record-a', startsAt: '2026-01-01T09:00:00.000Z', endsAt: null });
    assert.throws(() => applyAuthenticatedOperation(db, viewer, 'add-history', { staffId: 'staff-a', recordId: 'record-b', startsAt: '2026-01-01T09:00:00.000Z', endsAt: null }));
    assert.throws(() => applyAuthenticatedOperation(db, admin, 'add-viewer', { staffId: 'staff-b', subject: 'example-other', businessId: 'shop-b' }));
    assert.throws(() => applyAuthenticatedOperation(db, admin, 'add-viewer', { staffId: 'staff-b', subject: viewer.subject }));
    assert.throws(() => applyAuthenticatedOperation(db, admin, 'deactivate-viewer', { staffId: 'admin-a' }));
    applyAuthenticatedOperation(db, admin, 'deactivate-viewer', { staffId: 'staff-a' });
    assert.equal(await createTimetableStore(db).findAccessAndHistory(issuer, viewer.subject, 'record-a'), null);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM authenticated_audit_events').get().count, 3);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM staff WHERE business_id = ?').get('shop-a').count, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM authenticated_audit_events WHERE actor_staff_id = ?').get('admin-a').count, 3);
    const backup = join(temp, 'v3-backup.sqlite');
    await copyTimetableDatabase(path, backup);
    const restored = new DatabaseSync(backup, { readOnly: true });
    try {
      createTimetableStore(restored);
      assert.equal(restored.prepare('SELECT COUNT(*) AS count FROM authenticated_audit_events').get().count, 3);
    } finally { restored.close(); }
    db.prepare('UPDATE memberships SET active = 0 WHERE subject = ?').run('example-admin');
    assert.throws(() => applyAuthenticatedOperation(db, admin, 'add-viewer', { staffId: 'staff-c', subject: 'example-new' }));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM authenticated_audit_events').get().count, 3);
  } finally {
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});

test('version 3 migration preserves version 2 data and backup on schema failure', async () => {
  const prefix = join(tmpdir(), 'vintage-admin-migration-');
  const temp = mkdtempSync(prefix);
  let db, backup;
  try {
    const path = join(temp, 'fixture.sqlite');
    const secondBackup = join(temp, 'v2-backup.sqlite');
    db = new DatabaseSync(path);
    initializeTimetableStore(db);
    db.close();
    await migrateWithBackup(path, join(temp, 'v1-backup.sqlite'));
    db = new DatabaseSync(path);
    db.exec('CREATE TABLE authenticated_audit_events (existing TEXT)');
    db.close();
    await assert.rejects(migrateWithBackup(path, secondBackup));
    db = new DatabaseSync(path, { readOnly: true });
    backup = new DatabaseSync(secondBackup, { readOnly: true });
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 2);
    assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    if (backup?.isOpen) backup.close();
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});
