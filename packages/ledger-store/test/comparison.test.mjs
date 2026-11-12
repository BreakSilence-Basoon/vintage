import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { linkSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initializeLedgerStore, writeLedgerFact } from '../src/index.mjs';
import { copyLedgerDatabase } from '../src/backup.mjs';
import { compareLedgerRecovery, prepareLedgerRecovery, unlockLedgerRecovery } from '../src/recovery.mjs';

const fact = { id: 'example-a', type: 'invoice-issued', date: '2026-01-01', currency: 'XXX', amountMinor: '100' };
const request = { operationId: 'operation-a', actorId: 'operator-a', expectedRevision: 0, fact };

test('comparison counts missing and changed records without exposing their contents or unlocking', async () => {
  const prefix = join(tmpdir(), 'vintage-ledger-compare-'), temp = mkdtempSync(prefix);
  let reference, recovery, empty;
  try {
    const source = join(temp, 'reference.sqlite'), snapshot = join(temp, 'snapshot.sqlite'), prepared = join(temp, 'prepared.sqlite');
    reference = new DatabaseSync(source); initializeLedgerStore(reference); writeLedgerFact(reference, request);
    await copyLedgerDatabase(source, snapshot);
    await prepareLedgerRecovery(snapshot, prepared);
    const same = compareLedgerRecovery(prepared, snapshot);
    assert.deepEqual(same.facts, { onlyRecovery: 0, onlyReference: 0, changed: 0, equal: 1 });
    assert.deepEqual(same.operations, { onlyRecovery: 0, onlyReference: 0, changed: 0, equal: 1 });
    writeLedgerFact(reference, { ...request, operationId: 'operation-b', expectedRevision: 1, fact: { ...fact, amountMinor: '200' } });
    writeLedgerFact(reference, { ...request, operationId: 'operation-c', fact: { ...fact, id: 'example-b' } });
    const result = compareLedgerRecovery(prepared, source);
    assert.deepEqual(result.facts, { onlyRecovery: 0, onlyReference: 1, changed: 1, equal: 0 });
    assert.deepEqual(result.operations, { onlyRecovery: 0, onlyReference: 2, changed: 0, equal: 1 });
    assert.doesNotMatch(JSON.stringify(result), /example-a|operator-a|operation-a|100|200/);
    reference.prepare('UPDATE ledger_operations SET actor_id=? WHERE operation_id=?').run('operator-b', 'operation-a');
    assert.equal(compareLedgerRecovery(prepared, source).operations.changed, 1);
    recovery = new DatabaseSync(prepared);
    assert.equal(recovery.prepare('SELECT status FROM ledger_recovery_guard').get().status, 'pending');
    assert.throws(() => writeLedgerFact(recovery, request));
    const emptyPath = join(temp, 'empty.sqlite');
    empty = new DatabaseSync(emptyPath); initializeLedgerStore(empty); empty.close();
    const reverse = compareLedgerRecovery(prepared, emptyPath);
    assert.equal(reverse.facts.onlyRecovery, 1);
    assert.equal(reverse.operations.onlyRecovery, 1);
  } finally {
    for (const db of [empty, recovery, reference]) if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});

test('comparison rejects missing, identical and not-pending inputs', async () => {
  const prefix = join(tmpdir(), 'vintage-ledger-compare-invalid-'), temp = mkdtempSync(prefix);
  let db;
  try {
    const source = join(temp, 'source.sqlite'), prepared = join(temp, 'prepared.sqlite'), alias = join(temp, 'alias.sqlite');
    db = new DatabaseSync(source); initializeLedgerStore(db); db.close();
    await prepareLedgerRecovery(source, prepared);
    linkSync(prepared, alias);
    assert.throws(() => compareLedgerRecovery(prepared, alias), /Ledger recovery comparison failed/);
    assert.throws(() => compareLedgerRecovery(prepared, join(temp, 'missing.sqlite')));
    assert.throws(() => compareLedgerRecovery(source, prepared));
    db = new DatabaseSync(prepared);
    unlockLedgerRecovery(db, { operatorId: 'operator-a', reason: 'Example review', reconciled: true });
    db.close();
    assert.throws(() => compareLedgerRecovery(prepared, source));
  } finally {
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});

test('a WAL reference comparison does not include an uncommitted change', async () => {
  const prefix = join(tmpdir(), 'vintage-ledger-compare-wal-'), temp = mkdtempSync(prefix);
  let reference;
  try {
    const source = join(temp, 'source.sqlite'), prepared = join(temp, 'prepared.sqlite');
    reference = new DatabaseSync(source); initializeLedgerStore(reference); reference.exec('PRAGMA journal_mode=WAL');
    writeLedgerFact(reference, request);
    await prepareLedgerRecovery(source, prepared);
    reference.exec('BEGIN IMMEDIATE');
    reference.prepare('UPDATE ledger_facts SET fact_json=? WHERE id=?').run(JSON.stringify({ ...fact, amountMinor: '300' }), fact.id);
    assert.equal(compareLedgerRecovery(prepared, source).facts.equal, 1);
    reference.exec('COMMIT');
    assert.equal(compareLedgerRecovery(prepared, source).facts.changed, 1);
  } finally {
    if (reference?.isTransaction) reference.exec('ROLLBACK');
    if (reference?.isOpen) reference.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});
