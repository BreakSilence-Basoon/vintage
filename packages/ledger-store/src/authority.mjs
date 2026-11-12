import { lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const subject = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512 && value === value.trim();
const reason = (value) => typeof value === 'string' && value.length > 0 && value.length <= 500 && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);
function issuer(value) {
  try { const url = new URL(value); return typeof value === 'string' && value === value.trim() && url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash; }
  catch { return false; }
}
export function authorityInstalled(db) {
  return !!db.prepare("SELECT 1 FROM sqlite_schema WHERE name IN ('ledger_authority_config','ledger_authority_grants','ledger_authority_events') LIMIT 1").get();
}
function requireWritable(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version === 1) return;
  if (version !== 2 || db.prepare('SELECT status FROM ledger_recovery_guard WHERE id=1').get()?.status !== 'unlocked') throw new Error('Recovery review required');
}
function transaction(db, operation) {
  let begun = false;
  try {
    db.exec('BEGIN IMMEDIATE'); begun = true;
    requireWritable(db);
    const result = operation();
    db.exec('COMMIT'); begun = false;
    return result;
  } catch {
    if (begun) { try { db.exec('ROLLBACK'); } catch { if (db.isTransaction) { try { db.close(); } catch {} } } }
    throw new Error('Ledger authority operation failed');
  }
}

// Trusted local setup; no default account or permissions are created.
export function initializeLedgerAuthority(db, businessId) {
  if (!id(businessId)) throw new Error('Ledger authority operation failed');
  return transaction(db, () => {
    if (authorityInstalled(db)) throw new Error('Already configured');
    db.prepare('SELECT id,revision,fact_json FROM ledger_facts LIMIT 0');
    db.prepare('SELECT operation_id,actor_id,fingerprint,fact_id,revision,before_json,after_json,recorded_at FROM ledger_operations LIMIT 0');
    db.exec(`CREATE TABLE ledger_authority_config (id INTEGER PRIMARY KEY CHECK (id=1), business_id TEXT NOT NULL);
      CREATE TABLE ledger_authority_grants (issuer TEXT NOT NULL, subject TEXT NOT NULL, actor_id TEXT NOT NULL UNIQUE,
        active INTEGER NOT NULL CHECK (active IN (0,1)), can_read INTEGER NOT NULL CHECK (can_read IN (0,1)),
        can_write INTEGER NOT NULL CHECK (can_write IN (0,1)), token_valid_after INTEGER NOT NULL CHECK (token_valid_after>=0), PRIMARY KEY (issuer,subject));
      CREATE TABLE ledger_authority_events (id INTEGER PRIMARY KEY, operator_id TEXT NOT NULL, reason TEXT NOT NULL, before_json TEXT, after_json TEXT NOT NULL, recorded_at TEXT NOT NULL);`);
    db.prepare('INSERT INTO ledger_authority_config VALUES (1,?)').run(businessId);
  });
}

// Trusted local operator only; it does not authenticate or decide which person deserves a grant.
function validateGrant(input) {
  const keys = ['issuer','subject','actorId','active','read','write','tokenValidAfter','operatorId','reason'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 9 || !keys.every((key) => Object.hasOwn(input, key))) throw new Error('Ledger authority operation failed');
  input = Object.fromEntries(keys.map((key) => [key, input[key]]));
  if (
      !issuer(input.issuer) || !subject(input.subject) || !id(input.actorId) || !id(input.operatorId) || !reason(input.reason) ||
      typeof input.active !== 'boolean' || typeof input.read !== 'boolean' || typeof input.write !== 'boolean' || (input.write && !input.read) ||
      !Number.isSafeInteger(input.tokenValidAfter) || input.tokenValidAfter < 0) throw new Error('Ledger authority operation failed');
  return Object.freeze(input);
}
function applyGrant(db, input) {
    if (!db.prepare('SELECT business_id FROM ledger_authority_config WHERE id=1').get()) throw new Error('Not configured');
    const old = db.prepare('SELECT issuer,subject,actor_id,active,can_read,can_write,token_valid_after FROM ledger_authority_grants WHERE issuer=? AND subject=?').get(input.issuer, input.subject);
    if (old && (old.actor_id !== input.actorId || input.tokenValidAfter < old.token_valid_after ||
        ((!old.active && input.active) || (!old.can_read && input.read) || (!old.can_write && input.write)) && input.tokenValidAfter <= Math.floor(Date.now() / 1000))) throw new Error('Invalid authority transition');
    db.prepare(`INSERT INTO ledger_authority_grants VALUES (?,?,?,?,?,?,?) ON CONFLICT(issuer,subject) DO UPDATE SET
      active=excluded.active,can_read=excluded.can_read,can_write=excluded.can_write,token_valid_after=excluded.token_valid_after`)
      .run(input.issuer, input.subject, input.actorId, Number(input.active), Number(input.read), Number(input.write), input.tokenValidAfter);
    const after = db.prepare('SELECT issuer,subject,actor_id,active,can_read,can_write,token_valid_after FROM ledger_authority_grants WHERE issuer=? AND subject=?').get(input.issuer, input.subject);
    db.prepare('INSERT INTO ledger_authority_events (operator_id,reason,before_json,after_json,recorded_at) VALUES (?,?,?,?,?)')
      .run(input.operatorId, input.reason, old ? JSON.stringify(old) : null, JSON.stringify(after), new Date().toISOString());
}
export function setLedgerGrant(db, input) {
  const grant = validateGrant(input);
  return transaction(db, () => applyGrant(db, grant));
}

// Trusted local operator: lock the same DB through a verified pre-change backup and grant mutation.
export async function setLedgerGrantWithBackup(path, backupPath, input) {
  let db, begun = false;
  try {
    const grant = validateGrant(input);
    if (!isAbsolute(path ?? '') || !lstatSync(path).isFile()) throw new Error('Existing database required');
    db = new DatabaseSync(path);
    db.exec('BEGIN IMMEDIATE'); begun = true;
    requireWritable(db);
    const { copyLedgerDatabase } = await import('./backup.mjs');
    await copyLedgerDatabase(path, backupPath);
    applyGrant(db, grant);
    db.exec('COMMIT'); begun = false;
  } catch { throw new Error('Ledger authority operation failed'); }
  finally {
    if (begun && db?.isOpen) { try { db.exec('ROLLBACK'); } catch {} }
    if (db?.isOpen) db.close();
  }
}

export function lookupLedgerGrant(db, identity) {
  const config = db.prepare('SELECT business_id FROM ledger_authority_config WHERE id=1').get();
  const row = db.prepare('SELECT issuer,subject,actor_id,active,can_read,can_write,token_valid_after FROM ledger_authority_grants WHERE issuer=? AND subject=?').get(identity.issuer, identity.subject);
  return row && config ? { issuer: row.issuer, subject: row.subject, actorId: row.actor_id, businessId: config.business_id,
    active: row.active === 1, read: row.can_read === 1, write: row.can_write === 1, tokenValidAfter: row.token_valid_after } : null;
}
