import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initializeLedgerStore, readLedgerFact, writeLedgerFact } from '../src/index.mjs';
import { copyLedgerDatabase } from '../src/backup.mjs';

const fact = { id: 'example-a', type: 'invoice-issued', date: '2026-01-01', currency: 'XXX', amountMinor: '100' };
const request = { operationId: 'operation-a', actorId: 'operator-a', expectedRevision: 0, fact };

test('a standalone snapshot restores into a new file without replacing newer records', async () => {
  const prefix = join(tmpdir(), 'vintage-ledger-backup-'), temp = mkdtempSync(prefix);
  let db, restored;
  try {
    const source = join(temp, 'source.sqlite'), snapshot = join(temp, 'snapshot.sqlite'), target = join(temp, 'restored.sqlite');
    db = new DatabaseSync(source); initializeLedgerStore(db);
    db.exec('PRAGMA journal_mode=WAL');
    writeLedgerFact(db, request);
    assert.ok(statSync(`${source}-wal`).size > 0);
    await copyLedgerDatabase(source, snapshot);
    writeLedgerFact(db, { ...request, operationId: 'operation-b', expectedRevision: 1, fact: { ...fact, amountMinor: '200' } });
    await assert.rejects(copyLedgerDatabase(snapshot, source), /Ledger copy failed/);
    assert.equal(readLedgerFact(db, fact.id).fact.amountMinor, '200');
    await copyLedgerDatabase(snapshot, target);
    restored = new DatabaseSync(target, { readOnly: true });
    assert.equal(readLedgerFact(restored, fact.id).fact.amountMinor, '100');
    assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM ledger_operations').get().n, 1);
    assert.equal(restored.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
    assert.equal(existsSync(`${snapshot}-wal`), false);
    assert.equal(existsSync(`${snapshot}-shm`), false);
    assert.equal(readdirSync(temp).some((name) => name.startsWith('.ledger-copy-')), false);
    if (process.platform !== 'win32') assert.equal(statSync(snapshot).mode & 0o077, 0);
  } finally {
    if (restored?.isOpen) restored.close();
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});

test('rejects missing, incompatible or foreign-key-invalid sources and preserves existing targets', async () => {
  const prefix = join(tmpdir(), 'vintage-ledger-backup-invalid-'), temp = mkdtempSync(prefix);
  let db;
  try {
    const source = join(temp, 'source.sqlite'), output = join(temp, 'output.sqlite');
    await assert.rejects(copyLedgerDatabase(source, output));
    assert.equal(existsSync(source), false);
    db = new DatabaseSync(source); db.exec('CREATE TABLE example (id TEXT)'); db.close();
    await assert.rejects(copyLedgerDatabase(source, output));
    assert.equal(existsSync(output), false);
    const invalid = join(temp, 'invalid.sqlite');
    db = new DatabaseSync(invalid); initializeLedgerStore(db);
    db.exec('PRAGMA foreign_keys=OFF');
    db.prepare('INSERT INTO ledger_operations VALUES (?,?,?,?,?,?,?,?)').run('operation-a', 'operator-a', 'example', 'missing', 1, null, '{}', '2026-01-01T00:00:00.000Z');
    db.close();
    await assert.rejects(copyLedgerDatabase(invalid, output));
    assert.equal(existsSync(output), false);
    writeFileSync(output, 'existing synthetic file');
    await assert.rejects(copyLedgerDatabase(invalid, output));
    assert.equal(readFileSync(output, 'utf8'), 'existing synthetic file');
  } finally {
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});

test('concurrent copies to the same destination never overwrite each other', async () => {
  const prefix = join(tmpdir(), 'vintage-ledger-backup-race-'), temp = mkdtempSync(prefix);
  let db, output;
  try {
    const source = join(temp, 'source.sqlite'), destination = join(temp, 'snapshot.sqlite');
    db = new DatabaseSync(source); initializeLedgerStore(db); writeLedgerFact(db, request); db.close();
    const results = await Promise.allSettled([copyLedgerDatabase(source, destination), copyLedgerDatabase(source, destination)]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    output = new DatabaseSync(destination, { readOnly: true });
    assert.equal(readLedgerFact(output, fact.id).fact.amountMinor, '100');
    assert.equal(output.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    if (output?.isOpen) output.close();
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});

test('a WAL snapshot excludes a concurrent uncommitted correction', async () => {
  const prefix = join(tmpdir(), 'vintage-ledger-backup-write-'), temp = mkdtempSync(prefix);
  let writer, snapshot;
  try {
    const source = join(temp, 'source.sqlite'), destination = join(temp, 'snapshot.sqlite');
    writer = new DatabaseSync(source); initializeLedgerStore(writer); writer.exec('PRAGMA journal_mode=WAL');
    writeLedgerFact(writer, request);
    writer.exec('BEGIN IMMEDIATE');
    writer.prepare('UPDATE ledger_facts SET fact_json=? WHERE id=?').run(JSON.stringify({ ...fact, amountMinor: '300' }), fact.id);
    await copyLedgerDatabase(source, destination);
    snapshot = new DatabaseSync(destination, { readOnly: true });
    assert.equal(readLedgerFact(snapshot, fact.id).fact.amountMinor, '100');
    writer.exec('ROLLBACK');
    assert.equal(readLedgerFact(writer, fact.id).fact.amountMinor, '100');
  } finally {
    if (snapshot?.isOpen) snapshot.close();
    if (writer?.isTransaction) writer.exec('ROLLBACK');
    if (writer?.isOpen) writer.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});
