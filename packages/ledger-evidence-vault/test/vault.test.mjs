import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createEvidenceVault } from '../src/index.mjs';

test('synthetic bytes get independent names, byte hashes and verified reads', () => {
  const prefix = join(tmpdir(), 'vintage-evidence-'), temp = mkdtempSync(prefix);
  try {
    const vault = createEvidenceVault({ directory: temp, acknowledgeSyntheticOnly: true });
    const input = Buffer.from('synthetic document');
    const first = vault.put(input), second = vault.put(input);
    assert.notEqual(first.id, second.id);
    assert.equal(first.sha256, second.sha256); // Byte equality does not establish transaction identity.
    assert.equal(first.size, input.length);
    assert.deepEqual(vault.read(first), input);
    assert.deepEqual(readFileSync(join(temp, first.id)), input);
    if (process.platform !== 'win32') assert.equal(statSync(join(temp, first.id)).mode & 0o077, 0);
  } finally { if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path'); rmSync(temp, { recursive: true, force: true }); }
});

test('tampering, invalid references and unsupported inputs fail without leaking content', () => {
  const prefix = join(tmpdir(), 'vintage-evidence-invalid-'), temp = mkdtempSync(prefix);
  try {
    assert.throws(() => createEvidenceVault({ directory: temp }));
    assert.throws(() => createEvidenceVault({ directory: join(temp, 'example-private'), acknowledgeSyntheticOnly: true }),
      (error) => error.message === 'Invalid evidence vault');
    const vault = createEvidenceVault({ directory: temp, acknowledgeSyntheticOnly: true });
    for (const input of ['', Buffer.alloc(0), Buffer.alloc(8 * 1024 * 1024 + 1)]) assert.throws(() => vault.put(input), /Evidence operation failed/);
    const ref = vault.put(Buffer.from('synthetic document'));
    assert.throws(() => vault.read({ ...ref, id: '../example' }), /Evidence operation failed/);
    assert.throws(() => vault.read({ ...ref, sha256: '0'.repeat(64) }), /Evidence operation failed/);
    assert.throws(() => vault.read({ ...ref, extra: 'example' }), /Evidence operation failed/);
    writeFileSync(join(temp, ref.id), 'synthetic alteration');
    assert.throws(() => vault.read(ref), (error) => error.message === 'Evidence operation failed');
    if (process.platform !== 'win32') {
      const other = vault.put(Buffer.from('synthetic content'));
      const alias = 'a'.repeat(64);
      symlinkSync(join(temp, other.id), join(temp, alias));
      assert.throws(() => vault.read({ ...other, id: alias }), /Evidence operation failed/);
    }
  } finally { if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path'); rmSync(temp, { recursive: true, force: true }); }
});

test('replacement of the vault directory is detected', () => {
  const prefix = join(tmpdir(), 'vintage-evidence-root-'), temp = mkdtempSync(prefix);
  try {
    const root = join(temp, 'vault'), original = join(temp, 'original'); mkdirSync(root);
    const vault = createEvidenceVault({ directory: root, acknowledgeSyntheticOnly: true });
    const ref = vault.put(Buffer.from('synthetic document'));
    renameSync(root, original); mkdirSync(root);
    assert.throws(() => vault.read(ref), /Evidence operation failed/);
    assert.throws(() => vault.put(Buffer.from('synthetic document')), /Evidence operation failed/);
  } finally { if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path'); rmSync(temp, { recursive: true, force: true }); }
});
