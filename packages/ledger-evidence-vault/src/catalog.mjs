const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const hex = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const validRef = (ref) => ref && typeof ref === 'object' && !Array.isArray(ref) && Object.keys(ref).length === 3 &&
  ['id','sha256','size'].every((key) => Object.hasOwn(ref, key)) && hex(ref.id) && hex(ref.sha256) && Number.isSafeInteger(ref.size) && ref.size >= 1 && ref.size <= 8 * 1024 * 1024;

// Separate synthetic catalog; not a Ledger record, identity or authorization store.
export function initializeEvidenceCatalog(db) {
  let begun = false;
  try {
    db.exec('BEGIN IMMEDIATE'); begun = true;
    if (db.prepare('PRAGMA user_version').get().user_version !== 0 ||
        db.prepare("SELECT 1 FROM sqlite_schema WHERE type IN ('table','view','trigger') AND name NOT LIKE 'sqlite_%' LIMIT 1").get()) throw new Error('Not empty');
    db.exec('CREATE TABLE evidence_entries (operation_id TEXT PRIMARY KEY NOT NULL, file_id TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, size INTEGER NOT NULL); PRAGMA user_version=1; COMMIT'); begun = false;
  } catch {
    if (begun) { try { db.exec('ROLLBACK'); } catch { if (db.isTransaction) { try { db.close(); } catch {} } } }
    throw new Error('Evidence catalog initialization failed');
  }
}

// Caller must already be trusted. The file and DB are not one atomic transaction.
export function registerEvidenceReference(db, vault, operationId, reference) {
  let begun = false;
  try {
    if (!id(operationId) || !validRef(reference) || typeof vault?.read !== 'function') throw new Error('Invalid input');
    db.exec('BEGIN IMMEDIATE'); begun = true;
    if (db.prepare('PRAGMA user_version').get().user_version !== 1) throw new Error('Invalid catalog');
    const existing = db.prepare('SELECT file_id,sha256,size FROM evidence_entries WHERE operation_id=?').get(operationId);
    if (existing && (existing.file_id !== reference.id || existing.sha256 !== reference.sha256 || existing.size !== reference.size)) throw new Error('Conflict');
    vault.read(reference);
    if (!existing) db.prepare('INSERT INTO evidence_entries VALUES (?,?,?,?)').run(operationId, reference.id, reference.sha256, reference.size);
    db.exec('COMMIT'); begun = false;
    return { replayed: !!existing };
  } catch {
    if (begun) { try { db.exec('ROLLBACK'); } catch { if (db.isTransaction) { try { db.close(); } catch {} } } }
    throw new Error('Evidence registration failed');
  }
}

// Offline inspection is advisory; files and DB cannot be snapshotted atomically here.
export function inspectEvidenceCatalog(db, vault) {
  let begun = false;
  try {
    if (typeof vault?.inspect !== 'function') throw new Error('Invalid vault');
    db.exec('BEGIN'); begun = true;
    if (db.prepare('PRAGMA user_version').get().user_version !== 1) throw new Error('Invalid catalog');
    const rows = db.prepare('SELECT file_id AS id,sha256,size FROM evidence_entries LIMIT 10001').all();
    if (rows.length > 10000) throw new Error('Too many records');
    const result = vault.inspect(rows.map((row) => ({ id: row.id, sha256: row.sha256, size: row.size })));
    db.exec('COMMIT'); begun = false;
    return result;
  } catch {
    if (begun) { try { db.exec('ROLLBACK'); } catch { if (db.isTransaction) { try { db.close(); } catch {} } } }
    throw new Error('Evidence catalog inspection failed');
  }
}
