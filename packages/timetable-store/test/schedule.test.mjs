import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { initializeTimetableStore, createTimetableStore } from '../src/index.mjs';
import { migrateWithBackup } from '../src/operations.mjs';
import { applyAuthenticatedOperation, AdminAccessError, AdminConflictError, AdminRequestError } from '../src/admin.mjs';

test('schedule creation isolates tenants, rejects conflicts and records the actor atomically', async () => {
  const prefix = join(tmpdir(), 'vintage-schedule-');
  const temp = mkdtempSync(prefix);
  let db, backup;
  try {
    const path = join(temp, 'fixture.sqlite');
    db = new DatabaseSync(path);
    initializeTimetableStore(db);
    for (const business of ['shop-a', 'shop-b']) db.prepare('INSERT INTO businesses (id) VALUES (?)').run(business);
    for (const [business, staff] of [['shop-a', 'admin-a'], ['shop-a', 'staff-a'], ['shop-b', 'staff-b']])
      db.prepare('INSERT INTO staff (business_id,id) VALUES (?,?)').run(business, staff);
    const issuer = 'https://identity.example.invalid';
    for (const [sub, business, staff, role] of [['example-admin', 'shop-a', 'admin-a', 'ADMIN'], ['example-user', 'shop-a', 'staff-a', 'VIEWER'], ['example-foreign', 'shop-b', 'staff-b', 'VIEWER']])
      db.prepare('INSERT INTO memberships (issuer,subject,business_id,staff_id,role,active) VALUES (?,?,?,?,?,1)').run(issuer, sub, business, staff, role);
    db.close();
    for (const version of [1, 2, 3, 4, 5]) await migrateWithBackup(path, join(temp, `backup-v${version}.sqlite`));
    backup = new DatabaseSync(join(temp, 'backup-v5.sqlite'), { readOnly: true });
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 5);
    db = new DatabaseSync(path);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 6);
    createTimetableStore(db);
    const admin = { issuer, subject: 'example-admin' };
    const viewer = { issuer, subject: 'example-user' };
    const location = { locationId: 'location-a', label: 'Example location' };
    const shift = { shiftId: 'shift-a', staffId: 'staff-a', locationId: 'location-a', startsAt: '2026-01-01T09:00:00.000Z', endsAt: '2026-01-01T17:00:00.000Z', graceMinutes: 5 };
    const apply = (identity, operation, input) => applyAuthenticatedOperation(db, identity, operation, input);
    assert.throws(() => apply(viewer, 'add-location', location), AdminAccessError);
    assert.deepEqual(apply(admin, 'add-location', location), { replayed: false });
    assert.deepEqual(apply(admin, 'add-location', location), { replayed: true });
    assert.throws(() => apply(admin, 'add-location', { ...location, label: 'Different location' }), AdminConflictError);
    assert.throws(() => apply(admin, 'add-shift', { ...shift, staffId: 'staff-b' }), AdminRequestError);
    assert.throws(() => apply(admin, 'add-shift', { ...shift, locationId: 'missing' }), AdminRequestError);
    assert.deepEqual(apply(admin, 'add-shift', shift), { replayed: false });
    assert.deepEqual(apply(admin, 'add-shift', shift), { replayed: true });
    assert.throws(() => apply(admin, 'add-shift', { ...shift, shiftId: 'shift-b', startsAt: '2026-01-01T16:00:00.000Z', endsAt: '2026-01-01T18:00:00.000Z' }), AdminConflictError);
    assert.deepEqual(apply(admin, 'add-shift', { ...shift, shiftId: 'shift-b', startsAt: shift.endsAt, endsAt: '2026-01-01T18:00:00.000Z' }), { replayed: false });
    assert.throws(() => apply(admin, 'add-shift', { ...shift, shiftId: 'shift-c', graceMinutes: 181 }), AdminRequestError);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schedule_create_events WHERE actor_staff_id = ?').get('admin-a').n, 3);
    db.prepare('UPDATE memberships SET active = 0 WHERE subject = ?').run('example-user');
    assert.throws(() => apply(admin, 'add-shift', { ...shift, shiftId: 'shift-d', startsAt: '2026-01-02T09:00:00.000Z', endsAt: '2026-01-02T17:00:00.000Z' }), AdminRequestError);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scheduled_shifts').get().n, 2);
    db.exec("CREATE TRIGGER reject_schedule_audit BEFORE INSERT ON schedule_create_events BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    assert.throws(() => apply(admin, 'add-shift', { ...shift, shiftId: 'shift-e', staffId: 'admin-a', startsAt: '2026-01-03T09:00:00.000Z', endsAt: '2026-01-03T17:00:00.000Z' }));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scheduled_shifts').get().n, 2);
    db.exec('DROP TRIGGER reject_schedule_audit');
    db.close();
    const moduleUrl = new URL('../src/admin.mjs', import.meta.url).href;
    const program = `import { DatabaseSync } from 'node:sqlite'; import { applyAuthenticatedOperation } from ${JSON.stringify(moduleUrl)};
      const db = new DatabaseSync(process.argv[1]);
      try { applyAuthenticatedOperation(db, { issuer: 'https://identity.example.invalid', subject: 'example-admin' }, 'add-shift',
        { shiftId: process.argv[2], staffId: 'admin-a', locationId: 'location-a', startsAt: '2026-01-04T09:00:00.000Z', endsAt: '2026-01-04T17:00:00.000Z', graceMinutes: 0 }); process.stdout.write('ok'); }
      catch { process.stdout.write('denied'); } finally { db.close(); }`;
    const run = (id) => new Promise((done, fail) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', program, path, id], { stdio: ['ignore', 'pipe', 'ignore'] });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.on('error', fail);
      child.on('close', (code) => code === 0 ? done(output) : fail(new Error('Test worker failed')));
    });
    assert.deepEqual((await Promise.all([run('race-a'), run('race-b')])).sort(), ['denied', 'ok']);
    db = new DatabaseSync(path, { readOnly: true });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scheduled_shifts').get().n, 3);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schedule_create_events').get().n, 4);
  } finally {
    if (backup?.isOpen) backup.close();
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});

test('schedule migration failure preserves the version 5 database and backup', async () => {
  const prefix = join(tmpdir(), 'vintage-schedule-failure-');
  const temp = mkdtempSync(prefix);
  let db, backup;
  try {
    const path = join(temp, 'fixture.sqlite');
    db = new DatabaseSync(path);
    initializeTimetableStore(db);
    db.close();
    for (const version of [1, 2, 3, 4]) await migrateWithBackup(path, join(temp, `backup-v${version}.sqlite`));
    db = new DatabaseSync(path);
    db.exec('CREATE TABLE scheduled_shifts (example TEXT)');
    db.close();
    const backupPath = join(temp, 'backup-v5.sqlite');
    await assert.rejects(migrateWithBackup(path, backupPath));
    db = new DatabaseSync(path, { readOnly: true });
    backup = new DatabaseSync(backupPath, { readOnly: true });
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5);
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 5);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name = 'schedule_locations'").get().n, 0);
  } finally {
    if (backup?.isOpen) backup.close();
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});
