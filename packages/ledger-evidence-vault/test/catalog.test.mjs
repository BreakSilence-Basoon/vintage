import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backup, DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createEvidenceVault } from '../src/index.mjs';
import { initializeEvidenceCatalog, inspectEvidenceCatalog, registerEvidenceReference } from '../src/catalog.mjs';

test('failed registration leaves the synthetic file for later inspection and retry', () => {
  const prefix = join(tmpdir(), 'vintage-evidence-catalog-'), temp = mkdtempSync(prefix);
  let db;
  try {
    const directory = join(temp, 'vault'); mkdirSync(directory);
    const vault = createEvidenceVault({ directory, acknowledgeSyntheticOnly: true });
    db = new DatabaseSync(join(temp, 'catalog.sqlite')); initializeEvidenceCatalog(db);
    assert.throws(() => initializeEvidenceCatalog(db));
    const ref = vault.put(Buffer.from('synthetic receipt'));
    db.exec("CREATE TRIGGER reject_entry BEFORE INSERT ON evidence_entries BEGIN SELECT RAISE(ABORT, 'example'); END");
    assert.throws(() => registerEvidenceReference(db, vault, 'operation-a', ref));
    assert.deepEqual(inspectEvidenceCatalog(db, vault), { verified: 0, missing: 0, unreadableOrChanged: 0, unregistered: 1, unexpected: 0 });
    assert.deepEqual(vault.read(ref), Buffer.from('synthetic receipt'));
    db.exec('DROP TRIGGER reject_entry');
    assert.deepEqual(registerEvidenceReference(db, vault, 'operation-a', ref), { replayed: false });
    assert.deepEqual(registerEvidenceReference(db, vault, 'operation-a', ref), { replayed: true });
    const other = vault.put(Buffer.from('another synthetic receipt'));
    assert.throws(() => registerEvidenceReference(db, vault, 'operation-a', other));
    assert.throws(() => registerEvidenceReference(db, vault, 'operation-b', ref));
    const report = inspectEvidenceCatalog(db, vault);
    assert.deepEqual(report, { verified: 1, missing: 0, unreadableOrChanged: 0, unregistered: 1, unexpected: 0 });
    assert.doesNotMatch(JSON.stringify(report), /operation-a|synthetic|[a-f0-9]{64}/);
  } finally { if (db?.isOpen) db.close(); if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path'); rmSync(temp, { recursive: true, force: true }); }
});

test('inspection distinguishes missing, unreadable and unregistered synthetic files without deletion', () => {
  const prefix = join(tmpdir(), 'vintage-evidence-inspect-'), temp = mkdtempSync(prefix);
  let db;
  try {
    const directory = join(temp, 'vault'); mkdirSync(directory);
    const vault = createEvidenceVault({ directory, acknowledgeSyntheticOnly: true });
    db = new DatabaseSync(join(temp, 'catalog.sqlite')); initializeEvidenceCatalog(db);
    const missing = vault.put(Buffer.from('synthetic one')), changed = vault.put(Buffer.from('synthetic two'));
    registerEvidenceReference(db, vault, 'operation-a', missing); registerEvidenceReference(db, vault, 'operation-b', changed);
    unlinkSync(join(directory, missing.id));
    writeFileSync(join(directory, changed.id), 'synthetic alteration');
    vault.put(Buffer.from('synthetic orphan'));
    writeFileSync(join(directory, 'unexpected-name'), 'synthetic extra');
    assert.deepEqual(inspectEvidenceCatalog(db, vault), { verified: 0, missing: 1, unreadableOrChanged: 1, unregistered: 1, unexpected: 1 });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM evidence_entries').get().n, 2);
  } finally { if (db?.isOpen) db.close(); if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path'); rmSync(temp, { recursive: true, force: true }); }
});

test('invalid catalog references and changed files do not register', () => {
  const prefix = join(tmpdir(), 'vintage-evidence-catalog-invalid-'), temp = mkdtempSync(prefix);
  let db;
  try {
    const directory = join(temp, 'vault'); mkdirSync(directory);
    const vault = createEvidenceVault({ directory, acknowledgeSyntheticOnly: true });
    db = new DatabaseSync(':memory:'); initializeEvidenceCatalog(db);
    const ref = vault.put(Buffer.from('synthetic content'));
    assert.throws(() => registerEvidenceReference(db, vault, '../invalid', ref));
    assert.throws(() => registerEvidenceReference(db, vault, 'operation-a', { ...ref, sha256: '0'.repeat(64) }));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM evidence_entries').get().n, 0);
    assert.equal(inspectEvidenceCatalog(db, vault).unregistered, 1);
    assert.throws(() => vault.inspect([ref, ref]));
  } finally { if (db?.isOpen) db.close(); if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path'); rmSync(temp, { recursive: true, force: true }); }
});

test('restoring only the catalog reports missing files and preserves the original', async () => {
  const prefix = join(tmpdir(), 'vintage-evidence-catalog-restore-'), temp = mkdtempSync(prefix);
  let db, restored;
  try {
    const original = join(temp, 'original'), empty = join(temp, 'empty'); mkdirSync(original); mkdirSync(empty);
    const originalVault = createEvidenceVault({ directory: original, acknowledgeSyntheticOnly: true });
    const emptyVault = createEvidenceVault({ directory: empty, acknowledgeSyntheticOnly: true });
    db = new DatabaseSync(join(temp, 'catalog.sqlite')); initializeEvidenceCatalog(db);
    const ref = originalVault.put(Buffer.from('synthetic content'));
    registerEvidenceReference(db, originalVault, 'operation-a', ref);
    const snapshot = join(temp, 'snapshot.sqlite'); await backup(db, snapshot);
    restored = new DatabaseSync(snapshot, { readOnly: true });
    assert.equal(inspectEvidenceCatalog(restored, emptyVault).missing, 1);
    assert.equal(inspectEvidenceCatalog(db, originalVault).verified, 1);
    assert.deepEqual(originalVault.read(ref), Buffer.from('synthetic content'));
  } finally {
    if (restored?.isOpen) restored.close(); if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path'); rmSync(temp, { recursive: true, force: true });
  }
});

test('a competing catalog writer leaves the synthetic file intact for a later retry', () => {
  const prefix = join(tmpdir(), 'vintage-evidence-catalog-lock-'), temp = mkdtempSync(prefix);
  let db, holder;
  try {
    const directory = join(temp, 'vault'), path = join(temp, 'catalog.sqlite'); mkdirSync(directory);
    const vault = createEvidenceVault({ directory, acknowledgeSyntheticOnly: true });
    db = new DatabaseSync(path); initializeEvidenceCatalog(db); holder = new DatabaseSync(path);
    const ref = vault.put(Buffer.from('synthetic content'));
    holder.exec('BEGIN IMMEDIATE');
    assert.throws(() => registerEvidenceReference(db, vault, 'operation-a', ref));
    holder.exec('ROLLBACK');
    assert.equal(inspectEvidenceCatalog(db, vault).unregistered, 1);
    assert.equal(registerEvidenceReference(db, vault, 'operation-a', ref).replayed, false);
    assert.equal(inspectEvidenceCatalog(db, vault).verified, 1);
  } finally {
    if (holder?.isTransaction) holder.exec('ROLLBACK');
    if (holder?.isOpen) holder.close(); if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path'); rmSync(temp, { recursive: true, force: true });
  }
});
