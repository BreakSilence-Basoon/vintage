import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initializeTimetableStore } from '../src/index.mjs';
import { copyTimetableDatabase } from '../src/backup.mjs';

test('backs up and restores into new files without overwriting existing files', async () => {
  const prefix = join(tmpdir(), 'vintage-backup-');
  const temp = mkdtempSync(prefix);
  let source, restored;
  try {
    const original = join(temp, 'original.sqlite');
    const snapshot = join(temp, 'backup.sqlite');
    const recovered = join(temp, 'restored.sqlite');
    const existing = join(temp, 'existing.sqlite');
    source = new DatabaseSync(original);
    initializeTimetableStore(source);
    source.prepare('INSERT INTO businesses (id) VALUES (?)').run('shop-a');
    source.prepare('INSERT INTO staff (business_id,id) VALUES (?,?)').run('shop-a', 'staff-a');
    source.prepare('INSERT INTO history (business_id,id,staff_id,starts_at) VALUES (?,?,?,?)')
      .run('shop-a', 'record-a', 'staff-a', '2026-01-01T09:00:00.000Z');
    writeFileSync(existing, 'existing-file');
    await assert.rejects(copyTimetableDatabase(original, existing));
    assert.equal(readFileSync(existing, 'utf8'), 'existing-file');
    assert.equal(readdirSync(temp).some((name) => name.startsWith('.vintage-copy-')), false);
    await assert.rejects(copyTimetableDatabase(original, original));
    await copyTimetableDatabase(original, snapshot);
    await copyTimetableDatabase(snapshot, recovered);
    assert.equal(readdirSync(temp).some((name) => name.startsWith('.vintage-copy-')), false);
    if (process.platform !== 'win32') assert.equal(statSync(snapshot).mode & 0o077, 0);
    restored = new DatabaseSync(recovered, { readOnly: true });
    assert.equal(restored.prepare('SELECT COUNT(*) AS count FROM history').get().count, 1);
    assert.equal(restored.prepare('PRAGMA user_version').get().user_version, 1);
  } finally {
    if (restored?.isOpen) restored.close();
    if (source?.isOpen) source.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});

test('backs up a live WAL database into a standalone copy without staging sidecars', async () => {
  const prefix = join(tmpdir(), 'vintage-backup-wal-');
  const temp = mkdtempSync(prefix);
  let source, snapshot;
  try {
    const original = join(temp, 'original.sqlite'), output = join(temp, 'backup.sqlite');
    source = new DatabaseSync(original);
    initializeTimetableStore(source);
    source.exec('PRAGMA journal_mode = WAL');
    source.prepare('INSERT INTO businesses (id) VALUES (?)').run('shop-a');
    source.prepare('INSERT INTO staff (business_id,id) VALUES (?,?)').run('shop-a', 'staff-a');
    source.prepare('INSERT INTO history (business_id,id,staff_id,starts_at) VALUES (?,?,?,?)')
      .run('shop-a', 'record-a', 'staff-a', '2026-01-01T09:00:00.000Z');
    assert.ok(statSync(`${original}-wal`).size > 0);
    await copyTimetableDatabase(original, output);
    assert.equal(readdirSync(temp).some((name) => name.startsWith('.vintage-copy-')), false);
    assert.equal(existsSync(`${output}-wal`), false);
    assert.equal(existsSync(`${output}-shm`), false);
    snapshot = new DatabaseSync(output, { readOnly: true });
    assert.equal(snapshot.prepare('SELECT COUNT(*) AS n FROM history').get().n, 1);
    assert.equal(snapshot.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
  } finally {
    if (snapshot?.isOpen) snapshot.close();
    if (source?.isOpen) source.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});

test('rejects missing or incompatible sources without creating a destination', async () => {
  const prefix = join(tmpdir(), 'vintage-backup-invalid-');
  const temp = mkdtempSync(prefix);
  let db;
  try {
    const destination = join(temp, 'result.sqlite');
    await assert.rejects(copyTimetableDatabase(join(temp, 'missing.sqlite'), destination));
    assert.equal(existsSync(destination), false);
    const incompatible = join(temp, 'incompatible.sqlite');
    db = new DatabaseSync(incompatible);
    db.exec('CREATE TABLE other (id TEXT)');
    db.close();
    await assert.rejects(copyTimetableDatabase(incompatible, destination));
    assert.equal(existsSync(destination), false);
    const incomplete = join(temp, 'incomplete.sqlite');
    db = new DatabaseSync(incomplete);
    initializeTimetableStore(db);
    db.exec('PRAGMA user_version = 2');
    db.close();
    await assert.rejects(copyTimetableDatabase(incomplete, destination));
    assert.equal(existsSync(destination), false);
  } finally {
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});
