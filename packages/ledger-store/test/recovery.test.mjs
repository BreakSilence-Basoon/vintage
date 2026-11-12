import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { initializeLedgerStore, readLedgerFact, writeLedgerFact } from '../src/index.mjs';
import { copyLedgerDatabase } from '../src/backup.mjs';
import { prepareLedgerRecovery, unlockLedgerRecovery } from '../src/recovery.mjs';

const fact = { id: 'example-a', type: 'invoice-issued', date: '2026-01-01', currency: 'XXX', amountMinor: '100' };
const request = { operationId: 'operation-a', actorId: 'operator-a', expectedRevision: 0, fact };
const review = { operatorId: 'operator-a', reason: 'Example review', reconciled: true };

test('offline recovery preserves originals and blocks writes until explicit review', async () => {
  const prefix = join(tmpdir(), 'vintage-ledger-recovery-'), temp = mkdtempSync(prefix);
  let source, restored, pendingCopy, second, raw;
  try {
    const original = join(temp, 'original.sqlite'), backup = join(temp, 'backup.sqlite'), prepared = join(temp, 'prepared.sqlite');
    source = new DatabaseSync(original); initializeLedgerStore(source); writeLedgerFact(source, request);
    await copyLedgerDatabase(original, backup);
    const rawPath = join(temp, 'raw-copy.sqlite');
    await copyLedgerDatabase(backup, rawPath);
    raw = new DatabaseSync(rawPath);
    assert.equal(writeLedgerFact(raw, request).replayed, true); // Ordinary v1 copying does not create a guard.
    const newer = { ...request, operationId: 'operation-b', expectedRevision: 1, fact: { ...fact, amountMinor: '200' } };
    writeLedgerFact(source, newer);
    await prepareLedgerRecovery(backup, prepared);
    restored = new DatabaseSync(prepared);
    assert.equal(readLedgerFact(source, fact.id).fact.amountMinor, '200');
    assert.equal(readLedgerFact(restored, fact.id).fact.amountMinor, '100');
    assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM ledger_operations WHERE operation_id=?').get('operation-b').n, 0);
    assert.throws(() => writeLedgerFact(restored, request)); // A replay is also blocked pending review.
    assert.throws(() => writeLedgerFact(restored, newer));
    assert.throws(() => unlockLedgerRecovery(restored, { ...review, reconciled: false }));
    restored.exec("CREATE TRIGGER reject_unlock BEFORE INSERT ON ledger_recovery_events WHEN NEW.operation='unlock' BEGIN SELECT RAISE(ABORT, 'example'); END");
    assert.throws(() => unlockLedgerRecovery(restored, review));
    assert.equal(restored.prepare('SELECT status FROM ledger_recovery_guard').get().status, 'pending');
    restored.exec('DROP TRIGGER reject_unlock');
    const pending = join(temp, 'pending.sqlite');
    await copyLedgerDatabase(prepared, pending);
    pendingCopy = new DatabaseSync(pending);
    assert.throws(() => writeLedgerFact(pendingCopy, newer));
    await assert.rejects(prepareLedgerRecovery(pending, join(temp, 'pending-again.sqlite')));
    unlockLedgerRecovery(restored, review);
    assert.throws(() => unlockLedgerRecovery(restored, review));
    assert.deepEqual(writeLedgerFact(restored, request), { id: fact.id, revision: 1, replayed: true });
    assert.deepEqual(writeLedgerFact(restored, newer), { id: fact.id, revision: 2, replayed: false });
    assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM ledger_recovery_events WHERE operation='unlock'").get().n, 1);
    const again = join(temp, 'again.sqlite');
    await prepareLedgerRecovery(prepared, again);
    second = new DatabaseSync(again);
    assert.deepEqual({ ...second.prepare('SELECT status,generation FROM ledger_recovery_guard').get() }, { status: 'pending', generation: 2 });
    assert.equal(second.prepare('SELECT COUNT(*) AS n FROM ledger_recovery_events').get().n, 3);
    assert.throws(() => writeLedgerFact(second, newer));
    assert.equal(restored.prepare('SELECT status FROM ledger_recovery_guard').get().status, 'unlocked');
  } finally {
    for (const db of [raw, second, pendingCopy, restored, source]) if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});

test('a missing guard, invalid source or existing target fails closed', async () => {
  const prefix = join(tmpdir(), 'vintage-ledger-recovery-invalid-'), temp = mkdtempSync(prefix);
  let db;
  try {
    const source = join(temp, 'source.sqlite'), prepared = join(temp, 'prepared.sqlite'), existing = join(temp, 'existing.sqlite');
    db = new DatabaseSync(source); initializeLedgerStore(db); writeLedgerFact(db, request); db.close();
    writeFileSync(existing, 'existing synthetic file');
    await assert.rejects(prepareLedgerRecovery(source, existing));
    assert.equal(readFileSync(existing, 'utf8'), 'existing synthetic file');
    await assert.rejects(prepareLedgerRecovery(join(temp, 'missing.sqlite'), prepared));
    assert.equal(existsSync(prepared), false);
    await prepareLedgerRecovery(source, prepared);
    db = new DatabaseSync(prepared); db.exec('DELETE FROM ledger_recovery_guard');
    assert.throws(() => writeLedgerFact(db, request));
    assert.throws(() => readLedgerFact(db, fact.id));
    assert.throws(() => unlockLedgerRecovery(db, review));
    await assert.rejects(copyLedgerDatabase(prepared, join(temp, 'invalid-copy.sqlite')));
  } finally {
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});

test('concurrent review attempts create at most one unlock event', async () => {
  const prefix = join(tmpdir(), 'vintage-ledger-recovery-race-'), temp = mkdtempSync(prefix);
  let db;
  try {
    const source = join(temp, 'source.sqlite'), prepared = join(temp, 'prepared.sqlite');
    db = new DatabaseSync(source); initializeLedgerStore(db); db.close();
    const sameTarget = join(temp, 'same-target.sqlite');
    const preparations = await Promise.allSettled([prepareLedgerRecovery(source, sameTarget), prepareLedgerRecovery(source, sameTarget)]);
    assert.equal(preparations.filter((result) => result.status === 'fulfilled').length, 1);
    await prepareLedgerRecovery(source, prepared);
    const moduleUrl = new URL('../src/recovery.mjs', import.meta.url).href;
    const program = `import { DatabaseSync } from 'node:sqlite'; import { unlockLedgerRecovery } from ${JSON.stringify(moduleUrl)};
      let input=''; for await (const part of process.stdin) input+=part; const db=new DatabaseSync(process.argv[1]);
      try { unlockLedgerRecovery(db,JSON.parse(input)); process.stdout.write('ok'); } catch { process.stdout.write('denied'); } finally { db.close(); }`;
    const run = () => new Promise((done, fail) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', program, prepared], { stdio: ['pipe','pipe','ignore'] });
      let output = ''; child.stdout.on('data', (part) => { output += part; }); child.on('error', fail); child.stdin.end(JSON.stringify(review));
      child.on('close', (code) => code === 0 ? done(output) : fail(new Error('Test worker failed')));
    });
    const outcomes = await Promise.all([run(), run()]);
    assert.ok(outcomes.filter((value) => value === 'ok').length <= 1);
    db = new DatabaseSync(prepared);
    if (!outcomes.includes('ok')) unlockLedgerRecovery(db, review);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger_recovery_events WHERE operation='unlock'").get().n, 1);
    assert.equal(db.prepare('SELECT status FROM ledger_recovery_guard').get().status, 'unlocked');
  } finally {
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});
