import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initializeTimetableStore, createTimetableStore } from '../src/index.mjs';
import { migrateWithBackup } from '../src/operations.mjs';

test('version 5 migration backs up before adding the owner and time index', async () => {
  const prefix = join(tmpdir(), 'vintage-history-index-');
  const temp = mkdtempSync(prefix);
  let db, snapshot;
  try {
    const path = join(temp, 'fixture.sqlite');
    db = new DatabaseSync(path);
    initializeTimetableStore(db);
    db.prepare('INSERT INTO businesses (id) VALUES (?)').run('shop-a');
    db.prepare('INSERT INTO staff (business_id,id) VALUES (?,?)').run('shop-a', 'staff-a');
    db.prepare('INSERT INTO memberships (issuer,subject,business_id,staff_id,role,active) VALUES (?,?,?,?,?,?)')
      .run('https://identity.example.invalid', 'example-user', 'shop-a', 'staff-a', 'VIEWER', 1);
    db.prepare('INSERT INTO history (business_id,id,staff_id,starts_at,ends_at) VALUES (?,?,?,?,?)')
      .run('shop-a', 'record-a', 'staff-a', '2026-01-01T09:00:00.000Z', null);
    db.close();
    for (const version of [1, 2, 3, 4]) await migrateWithBackup(path, join(temp, `backup-v${version}.sqlite`));
    snapshot = new DatabaseSync(join(temp, 'backup-v4.sqlite'), { readOnly: true });
    assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version, 4);
    assert.equal(snapshot.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='index' AND name='history_owner_started_id'").get().n, 0);
    db = new DatabaseSync(path);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5);
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT h.id, h.starts_at, h.ends_at FROM memberships m
      LEFT JOIN history h ON h.business_id = m.business_id AND h.staff_id = m.staff_id AND (h.starts_at, h.id) < (?, ?)
      WHERE m.issuer = ? AND m.subject = ? AND m.active = 1 AND m.role IN ('VIEWER', 'ADMIN')
      ORDER BY h.starts_at DESC, h.id DESC LIMIT ?`)
      .all('2027-01-01T00:00:00.000Z', 'example', 'https://identity.example.invalid', 'example-user', 10);
    assert.ok(plan.some((row) => row.detail.includes('history_owner_started_id')));
    const rows = await createTimetableStore(db).findOwnHistory('https://identity.example.invalid', 'example-user', null, 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'record-a');
    db.close();
    await migrateWithBackup(path, join(temp, 'backup-v5.sqlite'));
    await migrateWithBackup(path, join(temp, 'backup-v6.sqlite'));
    await assert.rejects(migrateWithBackup(path, join(temp, 'backup-v7.sqlite')));
  } finally {
    if (snapshot?.isOpen) snapshot.close();
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});

test('index migration failure preserves the old database and backup', async () => {
  const prefix = join(tmpdir(), 'vintage-history-index-failure-');
  const temp = mkdtempSync(prefix);
  let db, snapshot;
  try {
    const path = join(temp, 'fixture.sqlite');
    db = new DatabaseSync(path);
    initializeTimetableStore(db);
    db.close();
    for (const version of [1, 2, 3]) await migrateWithBackup(path, join(temp, `backup-v${version}.sqlite`));
    db = new DatabaseSync(path);
    db.exec('CREATE INDEX history_owner_started_id ON staff (id)');
    db.close();
    const backup = join(temp, 'backup-v4.sqlite');
    await assert.rejects(migrateWithBackup(path, backup));
    db = new DatabaseSync(path, { readOnly: true });
    snapshot = new DatabaseSync(backup, { readOnly: true });
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4);
    assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version, 4);
    assert.equal(db.prepare("SELECT tbl_name FROM sqlite_schema WHERE name = 'history_owner_started_id'").get().tbl_name, 'staff');
  } finally {
    if (snapshot?.isOpen) snapshot.close();
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});
