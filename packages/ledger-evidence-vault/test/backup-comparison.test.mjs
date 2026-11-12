import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backup, DatabaseSync } from 'node:sqlite';
import { constants, copyFileSync, linkSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createEvidenceVault } from '../src/index.mjs';
import { compareEvidenceBackups, initializeEvidenceCatalog, registerEvidenceReference } from '../src/catalog.mjs';

test('compares synthetic catalog and file copies and identifies shared hard-linked content', async () => {
  const prefix = join(tmpdir(), 'vintage-evidence-backup-pair-'), temp = mkdtempSync(prefix);
  let db, copied;
  try {
    const originalDir = join(temp, 'source-files'), copyDir = join(temp, 'backup-files'); mkdirSync(originalDir); mkdirSync(copyDir);
    const sourceVault = createEvidenceVault({ directory: originalDir, acknowledgeSyntheticOnly: true });
    const backupVault = createEvidenceVault({ directory: copyDir, acknowledgeSyntheticOnly: true });
    db = new DatabaseSync(join(temp, 'source.sqlite')); initializeEvidenceCatalog(db);
    const ref = sourceVault.put(Buffer.from('synthetic evidence'));
    registerEvidenceReference(db, sourceVault, 'operation-a', ref);
    const backupPath = join(temp, 'backup.sqlite'); await backup(db, backupPath);
    copyFileSync(join(originalDir, ref.id), join(copyDir, ref.id), constants.COPYFILE_EXCL);
    copied = new DatabaseSync(backupPath, { readOnly: true });
    const result = compareEvidenceBackups(db, sourceVault, copied, backupVault);
    assert.equal(result.source.verified, 1); assert.equal(result.backup.verified, 1);
    assert.deepEqual(result.catalog, { onlySource: 0, onlyBackup: 0, changed: 0, equal: 1 });
    assert.deepEqual(result.storage, { sameFileIdentity: 0, differentFileIdentity: 1, unknownIdentity: 0 });
    assert.doesNotMatch(JSON.stringify(result), /operation-a|synthetic|[a-f0-9]{64}/);
    writeFileSync(join(copyDir, ref.id), 'synthetic altered');
    assert.equal(compareEvidenceBackups(db, sourceVault, copied, backupVault).backup.unreadableOrChanged, 1);
    unlinkSync(join(copyDir, ref.id)); linkSync(join(originalDir, ref.id), join(copyDir, ref.id));
    const linked = compareEvidenceBackups(db, sourceVault, copied, backupVault);
    assert.equal(linked.backup.verified, 1);
    assert.equal(linked.storage.sameFileIdentity, 1);
    const later = sourceVault.put(Buffer.from('synthetic later'));
    registerEvidenceReference(db, sourceVault, 'operation-b', later);
    assert.equal(compareEvidenceBackups(db, sourceVault, copied, backupVault).catalog.onlySource, 1);
    assert.deepEqual(sourceVault.read(ref), Buffer.from('synthetic evidence'));
  } finally {
    if (copied?.isOpen) copied.close(); if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path'); rmSync(temp, { recursive: true, force: true });
  }
});

test('rejects the same database or the same vault even through separate handles', async () => {
  const prefix = join(tmpdir(), 'vintage-evidence-backup-alias-'), temp = mkdtempSync(prefix);
  let db, alias, copied, memory;
  try {
    const firstDir = join(temp, 'first'), secondDir = join(temp, 'second'); mkdirSync(firstDir); mkdirSync(secondDir);
    const a = createEvidenceVault({ directory: firstDir, acknowledgeSyntheticOnly: true });
    const same = createEvidenceVault({ directory: firstDir, acknowledgeSyntheticOnly: true });
    const b = createEvidenceVault({ directory: secondDir, acknowledgeSyntheticOnly: true });
    const path = join(temp, 'source.sqlite'), backupPath = join(temp, 'backup.sqlite'), aliasPath = join(temp, 'alias.sqlite');
    db = new DatabaseSync(path); initializeEvidenceCatalog(db); await backup(db, backupPath);
    copied = new DatabaseSync(backupPath, { readOnly: true });
    linkSync(path, aliasPath); alias = new DatabaseSync(aliasPath, { readOnly: true });
    assert.throws(() => compareEvidenceBackups(db, a, copied, same));
    assert.throws(() => compareEvidenceBackups(db, a, alias, b));
    memory = new DatabaseSync(':memory:'); initializeEvidenceCatalog(memory);
    assert.throws(() => compareEvidenceBackups(db, a, memory, b));
  } finally {
    for (const item of [memory, alias, copied, db]) if (item?.isOpen) item.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path'); rmSync(temp, { recursive: true, force: true });
  }
});

test('separately changed catalog entries are reported without exposing identifiers', () => {
  const prefix = join(tmpdir(), 'vintage-evidence-backup-changed-'), temp = mkdtempSync(prefix);
  let a, b;
  try {
    const first = join(temp, 'first'), second = join(temp, 'second'); mkdirSync(first); mkdirSync(second);
    const av = createEvidenceVault({ directory: first, acknowledgeSyntheticOnly: true });
    const bv = createEvidenceVault({ directory: second, acknowledgeSyntheticOnly: true });
    a = new DatabaseSync(join(temp, 'first.sqlite')); b = new DatabaseSync(join(temp, 'second.sqlite'));
    initializeEvidenceCatalog(a); initializeEvidenceCatalog(b);
    registerEvidenceReference(a, av, 'operation-a', av.put(Buffer.from('synthetic one')));
    registerEvidenceReference(b, bv, 'operation-a', bv.put(Buffer.from('synthetic two')));
    const report = compareEvidenceBackups(a, av, b, bv);
    assert.equal(report.catalog.changed, 1);
    assert.equal(report.source.verified, 1); assert.equal(report.backup.verified, 1);
    assert.doesNotMatch(JSON.stringify(report), /operation-a|synthetic|[a-f0-9]{64}/);
    b.exec('DROP TABLE evidence_entries');
    assert.throws(() => compareEvidenceBackups(a, av, b, bv));
    assert.equal(a.isTransaction, false); assert.equal(b.isTransaction, false);
  } finally {
    if (a?.isOpen) a.close(); if (b?.isOpen) b.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path'); rmSync(temp, { recursive: true, force: true });
  }
});
