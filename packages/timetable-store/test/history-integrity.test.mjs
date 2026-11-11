import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initializeTimetableStore } from '../src/index.mjs';
import { migrateWithBackup } from '../src/operations.mjs';
import { AdminConflictError, applyAuthenticatedOperation } from '../src/admin.mjs';
import { copyTimetableDatabase } from '../src/backup.mjs';

const issuer = 'https://identity.example.invalid';
const admin = { issuer, subject: 'example-admin' };
async function setup(path, dir) {
  const db = new DatabaseSync(path);
  try {
    initializeTimetableStore(db);
    db.prepare('INSERT INTO businesses (id) VALUES (?)').run('shop-a');
    db.prepare('INSERT INTO staff (business_id,id) VALUES (?,?)').run('shop-a', 'admin-a');
    db.prepare('INSERT INTO memberships (issuer,subject,business_id,staff_id,role,active) VALUES (?,?,?,?,?,?)')
      .run(issuer, admin.subject, 'shop-a', 'admin-a', 'ADMIN', 1);
  } finally { db.close(); }
  await migrateWithBackup(path, join(dir, 'v1.sqlite'));
  await migrateWithBackup(path, join(dir, 'v2.sqlite'));
}

test('retries are idempotent and only non-overlapping intervals are accepted', async () => {
  const prefix = join(tmpdir(), 'vintage-interval-');
  const temp = mkdtempSync(prefix);
  let db;
  try {
    const path = join(temp, 'fixture.sqlite');
    await setup(path, temp);
    db = new DatabaseSync(path);
    const first = { staffId: 'admin-a', recordId: 'record-a', startsAt: '2026-01-01T09:00:00.000Z', endsAt: '2026-01-01T10:00:00.000Z' };
    assert.deepEqual(applyAuthenticatedOperation(db, admin, 'add-history', first), { replayed: false });
    assert.deepEqual(applyAuthenticatedOperation(db, admin, 'add-history', first), { replayed: true });
    assert.throws(() => applyAuthenticatedOperation(db, admin, 'add-history', { ...first, startsAt: '2026-01-01T09:30:00.000Z' }), AdminConflictError);
    assert.throws(() => applyAuthenticatedOperation(db, admin, 'add-history', { ...first, recordId: 'record-b', startsAt: '2026-01-01T09:30:00.000Z', endsAt: '2026-01-01T10:30:00.000Z' }), AdminConflictError);
    assert.throws(() => applyAuthenticatedOperation(db, admin, 'add-history', { ...first, recordId: 'record-c', endsAt: first.startsAt }));
    applyAuthenticatedOperation(db, admin, 'add-history', { ...first, recordId: 'record-d', startsAt: first.endsAt, endsAt: null });
    assert.throws(() => applyAuthenticatedOperation(db, admin, 'add-history', { ...first, recordId: 'record-e', startsAt: '2026-01-02T09:00:00.000Z', endsAt: null }), AdminConflictError);
    applyAuthenticatedOperation(db, admin, 'add-viewer', { staffId: 'staff-b', subject: 'example-viewer' });
    applyAuthenticatedOperation(db, admin, 'add-history', { ...first, staffId: 'staff-b', recordId: 'record-f' });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM history').get().count, 3);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM authenticated_audit_events').get().count, 4);
  } finally {
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});

test('concurrent overlapping writes cannot both commit', async () => {
  const prefix = join(tmpdir(), 'vintage-interval-race-');
  const temp = mkdtempSync(prefix);
  let db;
  try {
    const path = join(temp, 'fixture.sqlite');
    await setup(path, temp);
    const moduleUrl = new URL('../src/admin.mjs', import.meta.url).href;
    const program = `import { DatabaseSync } from 'node:sqlite'; import { applyAuthenticatedOperation } from ${JSON.stringify(moduleUrl)};
      const db = new DatabaseSync(process.argv[1]);
      try { applyAuthenticatedOperation(db, { issuer: 'https://identity.example.invalid', subject: 'example-admin' }, 'add-history',
        { staffId: 'admin-a', recordId: process.argv[2], startsAt: '2026-01-01T09:00:00.000Z', endsAt: null }); process.stdout.write('ok'); }
      catch { process.stdout.write('denied'); } finally { db.close(); }`;
    const run = (recordId) => new Promise((finish, fail) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', program, path, recordId], { stdio: ['ignore', 'pipe', 'ignore'] });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.on('error', fail);
      child.on('close', (code) => code === 0 ? finish(output) : fail(new Error('Test worker failed')));
    });
    const outcomes = await Promise.all([run('record-a'), run('record-b')]);
    assert.deepEqual(outcomes.sort(), ['denied', 'ok']);
    db = new DatabaseSync(path, { readOnly: true });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM history').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM authenticated_audit_events').get().count, 1);
  } finally {
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});

test('closing an open record is audited, repeatable, and permits an adjacent record', async () => {
  const prefix = join(tmpdir(), 'vintage-close-');
  const temp = mkdtempSync(prefix);
  let db, backup;
  try {
    const path = join(temp, 'fixture.sqlite');
    await setup(path, temp);
    await migrateWithBackup(path, join(temp, 'v3.sqlite'));
    db = new DatabaseSync(path);
    const first = { staffId: 'admin-a', recordId: 'record-a', startsAt: '2026-01-01T09:00:00.000Z', endsAt: null };
    applyAuthenticatedOperation(db, admin, 'add-history', first);
    assert.throws(() => applyAuthenticatedOperation(db, admin, 'close-history', { recordId: 'record-a', endsAt: first.startsAt }), AdminConflictError);
    const close = { recordId: 'record-a', endsAt: '2026-01-01T10:00:00.000Z' };
    assert.deepEqual(applyAuthenticatedOperation(db, admin, 'close-history', close), { replayed: false });
    assert.deepEqual(applyAuthenticatedOperation(db, admin, 'close-history', close), { replayed: true });
    assert.throws(() => applyAuthenticatedOperation(db, admin, 'close-history', { ...close, endsAt: '2026-01-01T11:00:00.000Z' }), AdminConflictError);
    assert.throws(() => applyAuthenticatedOperation(db, admin, 'add-history', first), AdminConflictError);
    const bounded = { ...first, recordId: 'record-c', startsAt: close.endsAt, endsAt: '2026-01-01T11:00:00.000Z' };
    applyAuthenticatedOperation(db, admin, 'add-history', bounded);
    assert.throws(() => applyAuthenticatedOperation(db, admin, 'close-history', { recordId: bounded.recordId, endsAt: bounded.endsAt }), AdminConflictError);
    applyAuthenticatedOperation(db, admin, 'add-history', { ...first, recordId: 'record-b', startsAt: bounded.endsAt });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM history_close_events').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM history').get().count, 3);
    await copyTimetableDatabase(path, join(temp, 'v4-backup.sqlite'));
    backup = new DatabaseSync(join(temp, 'v4-backup.sqlite'), { readOnly: true });
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 4);
    assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM history_close_events').get().count, 1);
  } finally {
    if (backup?.isOpen) backup.close();
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});

test('failed version 4 migration keeps version 3 and its backup', async () => {
  const prefix = join(tmpdir(), 'vintage-close-migration-');
  const temp = mkdtempSync(prefix);
  let db, backup;
  try {
    const path = join(temp, 'fixture.sqlite');
    const backupPath = join(temp, 'v3.sqlite');
    await setup(path, temp);
    db = new DatabaseSync(path);
    db.exec('CREATE TABLE history_close_events (existing TEXT)');
    db.close();
    await assert.rejects(migrateWithBackup(path, backupPath));
    db = new DatabaseSync(path, { readOnly: true });
    backup = new DatabaseSync(backupPath, { readOnly: true });
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 3);
    assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    if (backup?.isOpen) backup.close();
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});
