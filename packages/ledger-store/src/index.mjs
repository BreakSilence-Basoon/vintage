import { createHash } from 'node:crypto';
import { validateLedgerFact } from '@vintage/ledger-facts';
import { createLedgerAccessCheck } from '@vintage/ledger-access';
import { authorityInstalled, lookupLedgerGrant } from './authority.mjs';
import { listLedgerFactsInTransaction } from './list-query.mjs';

const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const version = (db) => db.prepare('PRAGMA user_version').get().user_version;
function requireSupported(db, writable) {
  const current = version(db);
  if (current === 1) return;
  if (current !== 2) throw new Error('Invalid version');
  const guard = db.prepare('SELECT status,generation FROM ledger_recovery_guard WHERE id=1').get();
  if (!guard || !['pending', 'unlocked'].includes(guard.status) || !Number.isSafeInteger(guard.generation) || guard.generation < 1 ||
      (writable && guard.status !== 'unlocked')) throw new Error('Recovery review required');
}

// One independently controlled database. Authentication, authorization and file protection are caller responsibilities.
export function initializeLedgerStore(db) {
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (version(db) !== 0 || db.prepare("SELECT 1 FROM sqlite_schema WHERE type IN ('table','view','trigger') AND name NOT LIKE 'sqlite_%' LIMIT 1").get()) throw new Error('Not empty');
    db.exec(`CREATE TABLE ledger_facts (
      id TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL CHECK (revision >= 1), fact_json TEXT NOT NULL
    ); CREATE TABLE ledger_operations (
      operation_id TEXT PRIMARY KEY NOT NULL, actor_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      fact_id TEXT NOT NULL, revision INTEGER NOT NULL, before_json TEXT, after_json TEXT NOT NULL, recorded_at TEXT NOT NULL,
      UNIQUE (fact_id, revision), FOREIGN KEY (fact_id) REFERENCES ledger_facts(id)
    ); PRAGMA user_version = 1;`);
    db.exec('COMMIT');
  } catch {
    try { db.exec('ROLLBACK'); }
    catch { if (db.isTransaction) { try { db.close(); } catch {} } }
    throw new Error('Ledger initialization failed');
  }
}

// Trusted local/server code only. Validate actor and current authorization before every call, including retries.
function writeLedgerFactInternal(db, input, authorize) {
  let begun = false;
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 4 ||
        !['operationId', 'actorId', 'expectedRevision', 'fact'].every((key) => Object.hasOwn(input, key)) ||
        !validId(input.operationId) || !validId(input.actorId) || !Number.isSafeInteger(input.expectedRevision) ||
        input.expectedRevision < 0 || input.expectedRevision >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid input');
    const fact = validateLedgerFact(input.fact), factJson = JSON.stringify(fact);
    const fingerprint = createHash('sha256').update(JSON.stringify([input.actorId, input.expectedRevision, fact])).digest('hex');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('BEGIN IMMEDIATE'); begun = true;
    requireSupported(db, true);
    if (authorize) authorize();
    else if (authorityInstalled(db)) throw new Error('Authenticated access required');
    const previousOperation = db.prepare('SELECT fingerprint,fact_id,revision FROM ledger_operations WHERE operation_id=?').get(input.operationId);
    if (previousOperation) {
      if (previousOperation.fingerprint !== fingerprint) throw new Error('Operation conflict');
      db.exec('COMMIT'); begun = false;
      return { id: previousOperation.fact_id, revision: previousOperation.revision, replayed: true };
    }
    const current = db.prepare('SELECT revision,fact_json FROM ledger_facts WHERE id=?').get(fact.id);
    if ((current?.revision ?? 0) !== input.expectedRevision) throw new Error('Revision conflict');
    const next = input.expectedRevision + 1;
    if (!current) db.prepare('INSERT INTO ledger_facts (id,revision,fact_json) VALUES (?,?,?)').run(fact.id, next, factJson);
    else db.prepare('UPDATE ledger_facts SET revision=?,fact_json=? WHERE id=? AND revision=?').run(next, factJson, fact.id, input.expectedRevision);
    db.prepare('INSERT INTO ledger_operations (operation_id,actor_id,fingerprint,fact_id,revision,before_json,after_json,recorded_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(input.operationId, input.actorId, fingerprint, fact.id, next, current?.fact_json ?? null, factJson, new Date().toISOString());
    db.exec('COMMIT'); begun = false;
    return { id: fact.id, revision: next, replayed: false };
  } catch {
    if (begun) {
      try { db.exec('ROLLBACK'); }
      catch { if (db.isTransaction) { try { db.close(); } catch {} } }
    }
    throw new Error('Ledger write failed');
  }
}

export function writeLedgerFact(db, input) { return writeLedgerFactInternal(db, input, null); }

// Do not expose this unauthenticated; the caller must first authorize access to the record.
export function readLedgerFact(db, id) {
  try {
    if (!validId(id)) throw new Error('Invalid input');
    requireSupported(db, false);
    if (authorityInstalled(db)) throw new Error('Authenticated access required');
    const row = db.prepare('SELECT revision,fact_json FROM ledger_facts WHERE id=?').get(id);
    return row ? { revision: row.revision, fact: validateLedgerFact(JSON.parse(row.fact_json)) } : null;
  } catch { throw new Error('Ledger read failed'); }
}

// Server configuration and key resolver are trusted. The database is the grant source.
export function createLedgerAuthorizedStore(db, options) {
  const check = createLedgerAccessCheck({ ...options, lookupMembership: async (identity) => lookupLedgerGrant(db, identity) });
  if (options.historyScope !== undefined && (options.historyScope === options.readScope || options.historyScope === options.writeScope)) throw new Error('Invalid Ledger access configuration');
  const checkHistory = options.historyScope === undefined ? null : createLedgerAccessCheck({ ...options, readScope: options.historyScope,
    writeScope: options.readScope, lookupMembership: async (identity) => lookupLedgerGrant(db, identity) });
  function recheck(identity, action) {
    const member = lookupLedgerGrant(db, identity);
    if (!member || member.actorId !== identity.actorId || member.businessId !== identity.businessId || !member.active || !member.read ||
        (action === 'write' && !member.write) || identity.issuedAt < member.tokenValidAfter || Date.now() >= identity.expiresAt) throw new Error('Access denied');
  }
  return Object.freeze({
    async write(authorization, input) {
      const identity = await check(authorization, 'write');
      if (!identity || !input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 3 ||
          !['operationId', 'expectedRevision', 'fact'].every((key) => Object.hasOwn(input, key))) throw new Error('Ledger access failed');
      return writeLedgerFactInternal(db, { ...input, actorId: identity.actorId }, () => recheck(identity, 'write'));
    },
    async read(authorization, id) {
      const identity = await check(authorization, 'read');
      if (!identity || !validId(id)) throw new Error('Ledger access failed');
      let begun = false;
      try {
        db.exec('BEGIN'); begun = true;
        requireSupported(db, true);
        recheck(identity, 'read');
        const row = db.prepare('SELECT revision,fact_json FROM ledger_facts WHERE id=?').get(id);
        const result = row ? { revision: row.revision, fact: validateLedgerFact(JSON.parse(row.fact_json)) } : null;
        db.exec('COMMIT'); begun = false;
        return result;
      } catch {
        if (begun) { try { db.exec('ROLLBACK'); } catch { if (db.isTransaction) { try { db.close(); } catch {} } } }
        throw new Error('Ledger access failed');
      }
    },
    async list(authorization, query) {
      const identity = await check(authorization, 'read');
      if (!identity) throw new Error('Ledger access failed');
      let begun = false;
      try {
        db.exec('BEGIN'); begun = true;
        requireSupported(db, true);
        recheck(identity, 'read');
        const result = listLedgerFactsInTransaction(db, query);
        db.exec('COMMIT'); begun = false;
        return result;
      } catch {
        if (begun) { try { db.exec('ROLLBACK'); } catch { if (db.isTransaction) { try { db.close(); } catch {} } } }
        throw new Error('Ledger access failed');
      }
    },
    async history(authorization, query) {
      if (!checkHistory) throw new Error('Ledger access failed');
      const identity = await check(authorization, 'read');
      const historyIdentity = await checkHistory(authorization, 'read');
      if (!identity || !historyIdentity || identity.issuer !== historyIdentity.issuer || identity.subject !== historyIdentity.subject ||
          identity.actorId !== historyIdentity.actorId || !query || typeof query !== 'object' || Array.isArray(query) ||
          Object.keys(query).some((key) => !['id','afterRevision','limit'].includes(key)) || !validId(query.id)) throw new Error('Ledger access failed');
      const after = query.afterRevision ?? 0, limit = query.limit ?? 20;
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Ledger access failed');
      let begun = false;
      try {
        db.exec('BEGIN'); begun = true;
        requireSupported(db, true); recheck(identity, 'read'); recheck(historyIdentity, 'read');
        const rows = db.prepare('SELECT revision,after_json,recorded_at FROM ledger_operations WHERE fact_id=? AND revision>? ORDER BY revision LIMIT ?').all(query.id, after, limit + 1);
        const items = rows.slice(0, limit).map((row) => {
          const fact = validateLedgerFact(JSON.parse(row.after_json));
          if (fact.id !== query.id || !Number.isSafeInteger(row.revision) || row.revision < 1 || typeof row.recorded_at !== 'string') throw new Error('Invalid history');
          return { revision: row.revision, fact, recordedAt: row.recorded_at };
        });
        const result = { items, nextAfterRevision: rows.length > limit ? items.at(-1).revision : null };
        db.exec('COMMIT'); begun = false;
        return result;
      } catch {
        if (begun) { try { db.exec('ROLLBACK'); } catch { if (db.isTransaction) { try { db.close(); } catch {} } } }
        throw new Error('Ledger access failed');
      }
    },
  });
}
