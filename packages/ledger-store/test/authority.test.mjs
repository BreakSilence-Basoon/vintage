import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPair, SignJWT } from 'jose';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initializeLedgerStore, writeLedgerFact, readLedgerFact, createLedgerAuthorizedStore } from '../src/index.mjs';
import { initializeLedgerAuthority, setLedgerGrant, setLedgerGrantWithBackup } from '../src/authority.mjs';
import { prepareLedgerRecovery, unlockLedgerRecovery } from '../src/recovery.mjs';

const issuer = 'https://identity.example.invalid', audience = 'https://api.example.invalid';
const keys = await generateKeyPair('RS256'), otherKeys = await generateKeyPair('RS256');
const now = Math.floor(Date.now() / 1000);
const config = { issuer, audience, clientIds: ['example-client'], businessId: 'example-shop', readScope: 'ledger:read', writeScope: 'ledger:write', keyResolver: async () => keys.publicKey };
const grant = { issuer, subject: 'example-user', actorId: 'example-actor', active: true, read: true, write: true, tokenValidAfter: 0, operatorId: 'example-operator', reason: 'Example review' };
const fact = { id: 'example-a', type: 'invoice-issued', date: '2026-01-01', currency: 'XXX', amountMinor: '100' };
const request = { operationId: 'operation-a', expectedRevision: 0, fact };

test('local grant changes require a verified pre-change backup and hold the writer lock', async () => {
  const prefix = join(tmpdir(), 'vintage-grant-backup-'), temp = mkdtempSync(prefix), path = join(temp, 'ledger.sqlite');
  let db, copy;
  try {
    db = new DatabaseSync(path); initializeLedgerStore(db); initializeLedgerAuthority(db, 'example-shop'); setLedgerGrant(db, grant);
    const destination = join(temp, 'before.sqlite'), change = { ...grant, active: false };
    const pending = setLedgerGrantWithBackup(path, destination, change);
    change.active = true; // The asynchronous operation must use its validated snapshot.
    assert.throws(() => db.exec('BEGIN IMMEDIATE'));
    await pending;
    copy = new DatabaseSync(destination, { readOnly: true });
    assert.equal(copy.prepare('SELECT active FROM ledger_authority_grants').get().active, 1);
    assert.equal(db.prepare('SELECT active FROM ledger_authority_grants').get().active, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger_authority_events').get().n, 2);
    copy.close(); copy = undefined;
    const collision = join(temp, 'existing'); writeFileSync(collision, 'preserve');
    await assert.rejects(setLedgerGrantWithBackup(path, collision, grant));
    assert.equal(readFileSync(collision, 'utf8'), 'preserve');
    assert.equal(db.prepare('SELECT active FROM ledger_authority_grants').get().active, 0);
    db.exec('BEGIN IMMEDIATE');
    const locked = join(temp, 'locked.sqlite');
    await assert.rejects(setLedgerGrantWithBackup(path, locked, grant));
    db.exec('ROLLBACK');
    assert.equal(existsSync(locked), false);
    db.exec("CREATE TRIGGER reject_backup_audit BEFORE INSERT ON ledger_authority_events BEGIN SELECT RAISE(ABORT, 'example'); END");
    const failed = join(temp, 'failed.sqlite');
    await assert.rejects(setLedgerGrantWithBackup(path, failed, { ...grant, active: false }));
    assert.equal(existsSync(failed), true);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger_authority_events').get().n, 2);
    const recovery = join(temp, 'recovery.sqlite'), rejected = join(temp, 'recovery-before.sqlite');
    await prepareLedgerRecovery(path, recovery);
    await assert.rejects(setLedgerGrantWithBackup(recovery, rejected, { ...grant, active: false }));
    assert.equal(existsSync(rejected), false);
  } finally {
    if (copy?.isOpen) copy.close();
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});
async function token(overrides = {}, key = keys.privateKey) {
  const jwt = await new SignJWT({ iss: issuer, sub: 'example-user', aud: audience, iat: now, exp: now + 300, jti: 'example-token', client_id: 'example-client', scope: 'ledger:read ledger:write', ...overrides })
    .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt' }).sign(key);
  return `Bearer ${jwt}`;
}

test('real signature and current same-database grant are required on every operation', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    initializeLedgerStore(db);
    writeLedgerFact(db, { ...request, actorId: grant.actorId });
    initializeLedgerAuthority(db, 'example-shop');
    assert.throws(() => initializeLedgerAuthority(db, 'example-shop'));
    const store = createLedgerAuthorizedStore(db, config), header = await token();
    await assert.rejects(store.read(header, fact.id)); // No default grant.
    db.exec("CREATE TRIGGER reject_grant_audit BEFORE INSERT ON ledger_authority_events BEGIN SELECT RAISE(ABORT, 'example'); END");
    assert.throws(() => setLedgerGrant(db, grant));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger_authority_grants').get().n, 0);
    db.exec('DROP TRIGGER reject_grant_audit');
    setLedgerGrant(db, grant);
    assert.equal((await store.read(header, fact.id)).fact.amountMinor, '100');
    assert.equal((await store.write(header, request)).replayed, true);
    await assert.rejects(store.write(await token({}, otherKeys.privateKey), request));
    await assert.rejects(store.write(await token({ scope: 'ledger:read' }), request));
    await assert.rejects(store.read(await token({ sub: 'other-user' }), fact.id));
    await assert.rejects(createLedgerAuthorizedStore(db, { ...config, businessId: 'other-shop' }).read(header, fact.id));
    await assert.rejects(store.write(header, { ...request, actorId: 'forged' }));
    assert.throws(() => writeLedgerFact(db, { ...request, actorId: grant.actorId }));
    assert.throws(() => readLedgerFact(db, fact.id));
    setLedgerGrant(db, { ...grant, write: false });
    assert.ok(await store.read(header, fact.id));
    await assert.rejects(store.write(header, request));
    setLedgerGrant(db, { ...grant, active: false, write: false });
    await assert.rejects(store.read(header, fact.id));
    await assert.rejects(store.write(header, request)); // Retry must still recheck current grant.
    assert.throws(() => setLedgerGrant(db, grant)); // Reactivation cannot reuse an old token cutoff.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger_operations').get().n, 1);
  } finally { db.close(); }
});

test('revocation before the write transaction prevents the write; a writer holding the lock orders first', async (t) => {
  const prefix = join(tmpdir(), 'vintage-ledger-grant-race-'), temp = mkdtempSync(prefix), path = join(temp, 'fixture.sqlite');
  let db, revoker;
  try {
    t.mock.timers.enable({ apis: ['Date'] });
    db = new DatabaseSync(path); initializeLedgerStore(db); initializeLedgerAuthority(db, 'example-shop'); setLedgerGrant(db, grant);
    revoker = new DatabaseSync(path);
    const store = createLedgerAuthorizedStore(db, config), header = await token(), exec = db.exec.bind(db);
    let inject = true;
    db.exec = (sql) => { if (sql === 'BEGIN IMMEDIATE' && inject) { inject = false; setLedgerGrant(revoker, { ...grant, active: false }); } return exec(sql); };
    await assert.rejects(store.write(header, request));
    db.exec = exec;
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger_facts').get().n, 0);
    const cutoff = Math.floor(Date.now() / 1000) + 1;
    setLedgerGrant(db, { ...grant, tokenValidAfter: cutoff });
    t.mock.timers.tick(2000);
    const laterHeader = await token({ iat: cutoff, exp: cutoff + 300 });
    let attempted = false;
    db.exec = (sql) => { if (sql === 'COMMIT' && !attempted) { attempted = true; assert.throws(() => setLedgerGrant(revoker, { ...grant, active: false, tokenValidAfter: cutoff })); } return exec(sql); };
    try { assert.equal((await store.write(laterHeader, request)).revision, 1); } finally { db.exec = exec; }
    assert.equal(attempted, true);
    setLedgerGrant(revoker, { ...grant, active: false, tokenValidAfter: cutoff });
    await assert.rejects(store.write(laterHeader, request));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger_operations').get().n, 1);
  } finally {
    if (revoker?.isOpen) revoker.close();
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});

test('prepared recovery disables restored grants and refuses changes until reviewed', async () => {
  const prefix = join(tmpdir(), 'vintage-ledger-authority-restore-'), temp = mkdtempSync(prefix);
  let source, restored;
  try {
    const path = join(temp, 'source.sqlite'), target = join(temp, 'prepared.sqlite');
    source = new DatabaseSync(path); initializeLedgerStore(source); initializeLedgerAuthority(source, 'example-shop'); setLedgerGrant(source, grant);
    await prepareLedgerRecovery(path, target);
    restored = new DatabaseSync(target);
    assert.equal(source.prepare('SELECT active FROM ledger_authority_grants').get().active, 1);
    const restoredGrant = restored.prepare('SELECT active,token_valid_after FROM ledger_authority_grants').get();
    assert.equal(restoredGrant.active, 0);
    assert.ok(restoredGrant.token_valid_after > now);
    assert.throws(() => setLedgerGrant(restored, { ...grant, tokenValidAfter: restoredGrant.token_valid_after + 1 }));
    unlockLedgerRecovery(restored, { operatorId: 'example-operator', reason: 'Example review', reconciled: true });
    await assert.rejects(createLedgerAuthorizedStore(restored, config).read(await token(), fact.id));
    assert.equal(restored.prepare('SELECT active FROM ledger_authority_grants').get().active, 0);
  } finally {
    if (restored?.isOpen) restored.close();
    if (source?.isOpen) source.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});

test('a revoked read grant is rechecked in the read transaction', async () => {
  const prefix = join(tmpdir(), 'vintage-ledger-read-revoke-'), temp = mkdtempSync(prefix), path = join(temp, 'fixture.sqlite');
  let db, revoker;
  try {
    db = new DatabaseSync(path); initializeLedgerStore(db); writeLedgerFact(db, { ...request, actorId: grant.actorId });
    initializeLedgerAuthority(db, 'example-shop'); setLedgerGrant(db, grant);
    revoker = new DatabaseSync(path);
    const store = createLedgerAuthorizedStore(db, config), exec = db.exec.bind(db);
    let injected = false;
    db.exec = (sql) => { if (sql === 'BEGIN' && !injected) { injected = true; setLedgerGrant(revoker, { ...grant, active: false }); } return exec(sql); };
    try { await assert.rejects(store.read(await token(), fact.id)); } finally { db.exec = exec; }
    assert.equal(injected, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger_facts').get().n, 1);
  } finally {
    if (revoker?.isOpen) revoker.close();
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});

test('history requires its own scope and rechecks a revoked grant in the read transaction', async () => {
  const prefix = join(tmpdir(), 'vintage-ledger-history-revoke-'), temp = mkdtempSync(prefix), path = join(temp, 'fixture.sqlite');
  let db, revoker;
  try {
    db = new DatabaseSync(path); initializeLedgerStore(db); writeLedgerFact(db, { ...request, actorId: grant.actorId });
    initializeLedgerAuthority(db, 'example-shop'); setLedgerGrant(db, grant); revoker = new DatabaseSync(path);
    const store = createLedgerAuthorizedStore(db, { ...config, historyScope: 'ledger:history' }), exec = db.exec.bind(db);
    await assert.rejects(store.history(await token(), { id: fact.id }));
    assert.throws(() => createLedgerAuthorizedStore(db, { ...config, historyScope: config.readScope }));
    assert.throws(() => createLedgerAuthorizedStore(db, { ...config, historyScope: config.writeScope }));
    let injected = false;
    db.exec = (sql) => { if (sql === 'BEGIN' && !injected) { injected = true; setLedgerGrant(revoker, { ...grant, active: false }); } return exec(sql); };
    try { await assert.rejects(store.history(await token({ scope: 'ledger:read ledger:history' }), { id: fact.id })); } finally { db.exec = exec; }
    assert.equal(injected, true);
  } finally {
    if (revoker?.isOpen) revoker.close();
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});

test('a revoked grant is rechecked before listing records', async () => {
  const prefix = join(tmpdir(), 'vintage-ledger-list-revoke-'), temp = mkdtempSync(prefix), path = join(temp, 'fixture.sqlite');
  let db, revoker;
  try {
    db = new DatabaseSync(path); initializeLedgerStore(db); writeLedgerFact(db, { ...request, actorId: grant.actorId });
    initializeLedgerAuthority(db, 'example-shop'); setLedgerGrant(db, grant); revoker = new DatabaseSync(path);
    const store = createLedgerAuthorizedStore(db, config), exec = db.exec.bind(db);
    let injected = false;
    db.exec = (sql) => { if (sql === 'BEGIN' && !injected) { injected = true; setLedgerGrant(revoker, { ...grant, active: false }); } return exec(sql); };
    try { await assert.rejects(store.list(await token(), {})); } finally { db.exec = exec; }
    assert.equal(injected, true);
  } finally {
    if (revoker?.isOpen) revoker.close();
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});
