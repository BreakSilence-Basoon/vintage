import { linkSync, lstatSync, mkdtempSync, realpathSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { copyLedgerDatabase, verifyStructure } from './backup.mjs';
import { authorityInstalled } from './authority.mjs';

const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const validReason = (value) => typeof value === 'string' && value.length >= 1 && value.length <= 500 && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);

// Creates a new offline copy that blocks ordinary writes pending a trusted human review.
export async function prepareLedgerRecovery(source, destination) {
  let db, begun = false;
  try {
    if (!isAbsolute(source ?? '') || !isAbsolute(destination ?? '') || resolve(source) === resolve(destination)) throw new Error('Invalid paths');
    try { lstatSync(destination); throw new Error('Destination exists'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const directory = mkdtempSync(join(dirname(destination), '.ledger-recovery-'));
    const temporary = join(directory, 'prepared.sqlite');
    await copyLedgerDatabase(source, temporary);
    db = new DatabaseSync(temporary);
    db.exec('BEGIN IMMEDIATE'); begun = true;
    const version = db.prepare('PRAGMA user_version').get().user_version;
    let generation;
    if (version === 1) {
      db.exec(`CREATE TABLE ledger_recovery_guard (id INTEGER PRIMARY KEY CHECK (id=1), status TEXT NOT NULL CHECK (status IN ('pending','unlocked')), generation INTEGER NOT NULL CHECK (generation>=1));
        CREATE TABLE ledger_recovery_events (generation INTEGER NOT NULL, operation TEXT NOT NULL CHECK (operation IN ('prepare','unlock')), operator_id TEXT, reason TEXT, recorded_at TEXT NOT NULL, PRIMARY KEY (generation,operation));
        INSERT INTO ledger_recovery_guard VALUES (1,'pending',1); PRAGMA user_version=2;`);
      generation = 1;
    } else if (version === 2) {
      const guard = db.prepare('SELECT status,generation FROM ledger_recovery_guard WHERE id=1').get();
      if (!guard || guard.status !== 'unlocked' || !Number.isSafeInteger(guard.generation) || guard.generation >= Number.MAX_SAFE_INTEGER) throw new Error('Review already pending');
      generation = guard.generation + 1;
      const changed = db.prepare("UPDATE ledger_recovery_guard SET status='pending',generation=? WHERE id=1 AND status='unlocked' AND generation=?").run(generation, guard.generation);
      if (changed.changes !== 1) throw new Error('Recovery conflict');
    } else throw new Error('Invalid version');
    if (authorityInstalled(db)) {
      if (!db.prepare('SELECT business_id FROM ledger_authority_config WHERE id=1').get()) throw new Error('Invalid authority');
      db.prepare('UPDATE ledger_authority_grants SET active=0,token_valid_after=MAX(token_valid_after,?)').run(Math.floor(Date.now() / 1000) + 1);
    }
    db.prepare("INSERT INTO ledger_recovery_events VALUES (?,'prepare',NULL,NULL,?)").run(generation, new Date().toISOString());
    db.exec('COMMIT'); begun = false;
    db.close(); db = undefined;
    linkSync(temporary, destination);
    unlinkSync(temporary);
    rmdirSync(directory);
  } catch { throw new Error('Ledger recovery preparation failed'); }
  finally {
    if (begun && db?.isOpen) { try { db.exec('ROLLBACK'); } catch {} }
    if (db?.isOpen) db.close();
  }
}

// The caller is a trusted offline operator; this acknowledgement is not an automated reconciliation or authentication.
export function unlockLedgerRecovery(db, input) {
  let begun = false;
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 3 ||
        !['operatorId', 'reason', 'reconciled'].every((key) => Object.hasOwn(input, key)) ||
        !validId(input.operatorId) || !validReason(input.reason) || input.reconciled !== true) throw new Error('Invalid input');
    db.exec('BEGIN IMMEDIATE'); begun = true;
    if (db.prepare('PRAGMA user_version').get().user_version !== 2) throw new Error('Invalid version');
    const guard = db.prepare('SELECT status,generation FROM ledger_recovery_guard WHERE id=1').get();
    if (!guard || guard.status !== 'pending' || !Number.isSafeInteger(guard.generation) || guard.generation < 1) throw new Error('Invalid state');
    const changed = db.prepare("UPDATE ledger_recovery_guard SET status='unlocked' WHERE id=1 AND status='pending' AND generation=?").run(guard.generation);
    if (changed.changes !== 1) throw new Error('Recovery conflict');
    db.prepare("INSERT INTO ledger_recovery_events VALUES (?,'unlock',?,?,?)").run(guard.generation, input.operatorId, input.reason, new Date().toISOString());
    db.exec('COMMIT'); begun = false;
  } catch {
    if (begun) { try { db.exec('ROLLBACK'); } catch { if (db.isTransaction) { try { db.close(); } catch {} } } }
    throw new Error('Ledger recovery unlock failed');
  }
}

function compareRows(left, right, sql, key) {
  const a = left.prepare(sql).iterate()[Symbol.iterator](), b = right.prepare(sql).iterate()[Symbol.iterator]();
  const counts = { onlyRecovery: 0, onlyReference: 0, changed: 0, equal: 0 };
  let x = a.next(), y = b.next();
  while (!x.done || !y.done) {
    if ((!x.done && !validId(x.value[key])) || (!y.done && !validId(y.value[key]))) throw new Error('Invalid identifier');
    if (y.done || (!x.done && x.value[key] < y.value[key])) { counts.onlyRecovery++; x = a.next(); }
    else if (x.done || y.value[key] < x.value[key]) { counts.onlyReference++; y = b.next(); }
    else {
      if (JSON.stringify(x.value) === JSON.stringify(y.value)) counts.equal++; else counts.changed++;
      x = a.next(); y = b.next();
    }
    if (Object.values(counts).some((count) => !Number.isSafeInteger(count))) throw new Error('Too many records');
  }
  return counts;
}

// Offline, read-only aggregate comparison; it does not establish that the reference is current or complete.
export function compareLedgerRecovery(recoveryPath, referencePath) {
  let recovery, reference;
  try {
    if (!isAbsolute(recoveryPath ?? '') || !isAbsolute(referencePath ?? '') ||
        !lstatSync(recoveryPath).isFile() || !lstatSync(referencePath).isFile() ||
        realpathSync(recoveryPath) === realpathSync(referencePath)) throw new Error('Invalid paths');
    const a = statSync(recoveryPath), b = statSync(referencePath);
    if (a.ino && b.ino && a.dev === b.dev && a.ino === b.ino) throw new Error('Same file');
    recovery = new DatabaseSync(recoveryPath, { readOnly: true });
    reference = new DatabaseSync(referencePath, { readOnly: true });
    recovery.exec('BEGIN'); reference.exec('BEGIN');
    verifyStructure(recovery); verifyStructure(reference);
    if (recovery.prepare('PRAGMA user_version').get().user_version !== 2 ||
        recovery.prepare('SELECT status FROM ledger_recovery_guard WHERE id=1').get()?.status !== 'pending') throw new Error('Recovery review required');
    const facts = compareRows(recovery, reference, 'SELECT id,revision,fact_json FROM ledger_facts ORDER BY id', 'id');
    const operations = compareRows(recovery, reference,
      'SELECT operation_id,actor_id,fingerprint,fact_id,revision,before_json,after_json,recorded_at FROM ledger_operations ORDER BY operation_id', 'operation_id');
    return { facts, operations };
  } catch { throw new Error('Ledger recovery comparison failed'); }
  finally {
    if (reference?.isTransaction) { try { reference.exec('ROLLBACK'); } catch {} }
    if (recovery?.isTransaction) { try { recovery.exec('ROLLBACK'); } catch {} }
    if (reference?.isOpen) reference.close();
    if (recovery?.isOpen) recovery.close();
  }
}
