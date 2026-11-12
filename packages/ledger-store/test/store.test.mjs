import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { initializeLedgerStore, writeLedgerFact, readLedgerFact } from '../src/index.mjs';

const fact = { id: 'example-a', type: 'invoice-issued', date: '2026-01-01', currency: 'XXX', amountMinor: '100' };
const request = { operationId: 'operation-a', actorId: 'operator-a', expectedRevision: 0, fact };

test('initialization refuses an existing database without replacing its contents', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE example (value TEXT); INSERT INTO example VALUES ('keep')");
    assert.throws(() => initializeLedgerStore(db));
    assert.equal(db.prepare('SELECT value FROM example').get().value, 'keep');
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0);
  } finally { db.close(); }
});

test('create, retry and correction retain distinct revisions and an atomic change history', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initializeLedgerStore(db);
    assert.throws(() => initializeLedgerStore(db));
    assert.deepEqual(writeLedgerFact(db, request), { id: fact.id, revision: 1, replayed: false });
    assert.deepEqual(writeLedgerFact(db, request), { id: fact.id, revision: 1, replayed: true });
    assert.throws(() => writeLedgerFact(db, { ...request, actorId: 'operator-b' }));
    assert.throws(() => writeLedgerFact(db, { ...request, fact: { ...fact, amountMinor: '200' } }));
    assert.throws(() => writeLedgerFact(db, { ...request, operationId: 'operation-b' }));
    const corrected = { ...fact, amountMinor: '200' };
    const correction = { operationId: 'operation-c', actorId: 'operator-a', expectedRevision: 1, fact: corrected };
    assert.deepEqual(writeLedgerFact(db, correction), { id: fact.id, revision: 2, replayed: false });
    assert.deepEqual(writeLedgerFact(db, request), { id: fact.id, revision: 1, replayed: true });
    assert.deepEqual(readLedgerFact(db, fact.id), { revision: 2, fact: corrected });
    assert.equal(readLedgerFact(db, 'missing'), null);
    const events = db.prepare('SELECT actor_id,before_json,after_json FROM ledger_operations ORDER BY revision').all();
    assert.equal(events.length, 2);
    assert.equal(events[0].before_json, null);
    assert.deepEqual(JSON.parse(events[1].before_json), fact);
    assert.deepEqual(JSON.parse(events[1].after_json), corrected);
    assert.equal(events[1].actor_id, 'operator-a');
  } finally { db.close(); }
});

test('audit failure rolls back the record and a lost post-commit result can be retried', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initializeLedgerStore(db);
    db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON ledger_operations BEGIN SELECT RAISE(ABORT, 'example'); END");
    assert.throws(() => writeLedgerFact(db, request), /Ledger write failed/);
    assert.equal(readLedgerFact(db, fact.id), null);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger_operations').get().n, 0);
    db.exec('DROP TRIGGER reject_audit');
    const exec = db.exec.bind(db);
    db.exec = (sql) => { const result = exec(sql); if (sql === 'COMMIT') throw new Error('Simulated lost result'); return result; };
    try { assert.throws(() => writeLedgerFact(db, request), /Ledger write failed/); } finally { db.exec = exec; }
    assert.deepEqual(writeLedgerFact(db, request), { id: fact.id, revision: 1, replayed: true });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger_operations').get().n, 1);
  } finally { db.close(); }
});

test('a failed rollback closes the connection instead of leaving a pending write available', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initializeLedgerStore(db);
    db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON ledger_operations BEGIN SELECT RAISE(ABORT, 'example'); END");
    const exec = db.exec.bind(db);
    db.exec = (sql) => { if (sql === 'ROLLBACK') throw new Error('Simulated rollback failure'); return exec(sql); };
    assert.throws(() => writeLedgerFact(db, request), /Ledger write failed/);
    assert.equal(db.isOpen, false);
  } finally { if (db.isOpen) db.close(); }
});

test('simultaneous corrections cannot both replace the same revision', async () => {
  const prefix = join(tmpdir(), 'vintage-ledger-race-'), temp = mkdtempSync(prefix), path = join(temp, 'fixture.sqlite');
  let db;
  try {
    db = new DatabaseSync(path); initializeLedgerStore(db); writeLedgerFact(db, request); db.close();
    const moduleUrl = new URL('../src/index.mjs', import.meta.url).href;
    const program = `import { DatabaseSync } from 'node:sqlite'; import { writeLedgerFact } from ${JSON.stringify(moduleUrl)};
      let input=''; for await (const part of process.stdin) input+=part;
      const db=new DatabaseSync(process.argv[1]);
      try { writeLedgerFact(db,JSON.parse(input)); process.stdout.write('ok'); } catch { process.stdout.write('denied'); } finally { db.close(); }`;
    const run = (value, operationId) => new Promise((done, fail) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', program, path], { stdio: ['pipe','pipe','ignore'] });
      let output = ''; child.stdout.on('data', (chunk) => { output += chunk; });
      child.on('error', fail); child.stdin.end(JSON.stringify({ operationId, actorId: 'operator-a', expectedRevision: 1, fact: { ...fact, amountMinor: value } }));
      child.on('close', (code) => code === 0 ? done(output) : fail(new Error('Test worker failed')));
    });
    const outcomes = await Promise.all([run('200', 'operation-b'), run('300', 'operation-c')]);
    assert.ok(outcomes.filter((value) => value === 'ok').length <= 1);
    db = new DatabaseSync(path);
    const recorded = readLedgerFact(db, fact.id);
    assert.equal(recorded.revision, 1 + outcomes.filter((value) => value === 'ok').length);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger_operations').get().n, recorded.revision);
  } finally {
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});
