import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { compareVaultStorage } from './index.mjs';

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
function catalogFile(db) {
  const main = db.prepare('PRAGMA database_list').all().find((row) => row.name === 'main');
  if (!main || !isAbsolute(main.file ?? '')) throw new Error('A file-backed catalog is required');
  const stat = lstatSync(main.file, { bigint: true });
  if (!stat.isFile() || !stat.ino) throw new Error('Unknown catalog identity');
  return { path: realpathSync(main.file), dev: stat.dev, ino: stat.ino };
}
function catalogRows(db) {
  if (db.prepare('PRAGMA user_version').get().user_version !== 1) throw new Error('Invalid catalog');
  const rows = db.prepare('SELECT operation_id,file_id AS id,sha256,size FROM evidence_entries LIMIT 10001').all();
  if (rows.length > 10000) throw new Error('Too many records');
  const operations = new Set(), files = new Set();
  for (const row of rows) {
    if (!id(row.operation_id) || !validRef({ id: row.id, sha256: row.sha256, size: row.size }) || operations.has(row.operation_id) || files.has(row.id)) throw new Error('Invalid record');
    operations.add(row.operation_id); files.add(row.id);
  }
  return rows;
}

// Read-only, offline advisory check; it neither creates a backup nor proves independent storage.
export function compareEvidenceBackups(sourceDb, sourceVault, backupDb, backupVault) {
  let sourceBegun = false, backupBegun = false;
  try {
    if (!sourceDb || !backupDb || sourceDb === backupDb || sourceDb.isTransaction || backupDb.isTransaction ||
        compareVaultStorage(sourceVault, backupVault) !== 'different') throw new Error('Distinct inputs required');
    const sourceFile = catalogFile(sourceDb), backupFile = catalogFile(backupDb);
    if (sourceFile.path === backupFile.path || (sourceFile.dev === backupFile.dev && sourceFile.ino === backupFile.ino)) throw new Error('Same catalog');
    sourceDb.exec('BEGIN'); sourceBegun = true;
    backupDb.exec('BEGIN'); backupBegun = true;
    const sourceRows = catalogRows(sourceDb), backupRows = catalogRows(backupDb);
    const refs = (rows) => rows.map((row) => ({ id: row.id, sha256: row.sha256, size: row.size }));
    const source = sourceVault.inspect(refs(sourceRows)), backup = backupVault.inspect(refs(backupRows));
    const sourceMap = new Map(sourceRows.map((row) => [row.operation_id, row]));
    const backupMap = new Map(backupRows.map((row) => [row.operation_id, row]));
    const catalog = { onlySource: 0, onlyBackup: 0, changed: 0, equal: 0 };
    const storage = { sameFileIdentity: 0, differentFileIdentity: 0, unknownIdentity: 0 };
    for (const [operation, row] of sourceMap) {
      const other = backupMap.get(operation);
      if (!other) { catalog.onlySource++; continue; }
      if (row.id !== other.id || row.sha256 !== other.sha256 || row.size !== other.size) { catalog.changed++; continue; }
      catalog.equal++;
      const identity = compareVaultStorage(sourceVault, backupVault, row.id);
      if (identity === 'same') storage.sameFileIdentity++;
      else if (identity === 'different') storage.differentFileIdentity++;
      else storage.unknownIdentity++;
    }
    for (const operation of backupMap.keys()) if (!sourceMap.has(operation)) catalog.onlyBackup++;
    sourceDb.exec('COMMIT'); sourceBegun = false;
    backupDb.exec('COMMIT'); backupBegun = false;
    return { source, backup, catalog, storage };
  } catch { throw new Error('Evidence backup comparison failed'); }
  finally {
    if (backupBegun && backupDb?.isTransaction) { try { backupDb.exec('ROLLBACK'); } catch { try { backupDb.close(); } catch {} } }
    if (sourceBegun && sourceDb?.isTransaction) { try { sourceDb.exec('ROLLBACK'); } catch { try { sourceDb.close(); } catch {} } }
  }
}
