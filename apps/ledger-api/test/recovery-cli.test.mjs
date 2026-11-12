import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { initializeNewLedgerDatabase } from '../src/init-db.mjs';

const grant = { issuer: 'https://identity.example.invalid', subject: 'example-user', actorId: 'example-actor', active: true,
  read: true, write: true, tokenValidAfter: 0, operatorId: 'example-operator', reason: 'Example setup' };
const cli = fileURLToPath(new URL('../src/manage-recovery.mjs', import.meta.url));
function run(command, env, input = '') {
  return spawnSync(process.execPath, [cli, command], { input, encoding: 'utf8', env: { ...process.env, ...env } });
}

test('offline commands preserve the source, require explicit review and do not print identities', () => {
  const prefix = join(tmpdir(), 'vintage-ledger-recovery-cli-'), temp = mkdtempSync(prefix);
  let db;
  try {
    const source = join(temp, 'source.sqlite'), backup = join(temp, 'backup.sqlite'), recovered = join(temp, 'recovered.sqlite');
    initializeNewLedgerDatabase(source, { businessId: 'example-shop', grant });
    const env = { VINTAGE_LEDGER_DATABASE_FILE: source, VINTAGE_LEDGER_DESTINATION_FILE: backup };
    const copied = run('backup', env);
    assert.equal(copied.status, 0);
    assert.equal(run('backup', env).status, 1); // Existing backup is never overwritten.
    const prepared = run('prepare', { VINTAGE_LEDGER_DATABASE_FILE: backup, VINTAGE_LEDGER_DESTINATION_FILE: recovered });
    assert.equal(prepared.status, 0);
    const compare = run('compare', { VINTAGE_LEDGER_DATABASE_FILE: recovered, VINTAGE_LEDGER_REFERENCE_FILE: source });
    assert.equal(compare.status, 0);
    assert.deepEqual(JSON.parse(compare.stdout).facts, { onlyRecovery: 0, onlyReference: 0, changed: 0, equal: 0 });
    const reviewEnv = { VINTAGE_LEDGER_DATABASE_FILE: recovered };
    const invalid = run('unlock', reviewEnv, JSON.stringify({ operatorId: 'example-operator', reason: 'Example review', reconciled: false }));
    assert.equal(invalid.status, 1);
    db = new DatabaseSync(recovered, { readOnly: true });
    assert.equal(db.prepare('SELECT status FROM ledger_recovery_guard').get().status, 'pending');
    assert.equal(db.prepare('SELECT active FROM ledger_authority_grants').get().active, 0);
    db.close(); db = undefined;
    const unlocked = run('unlock', reviewEnv, JSON.stringify({ operatorId: 'example-operator', reason: 'Example review', reconciled: true }));
    assert.equal(unlocked.status, 0);
    db = new DatabaseSync(recovered, { readOnly: true });
    assert.equal(db.prepare('SELECT status FROM ledger_recovery_guard').get().status, 'unlocked');
    assert.equal(db.prepare('SELECT active FROM ledger_authority_grants').get().active, 0);
    db.close(); db = new DatabaseSync(source, { readOnly: true });
    assert.equal(db.prepare('SELECT active FROM ledger_authority_grants').get().active, 1);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    for (const result of [copied, prepared, compare, invalid, unlocked]) assert.doesNotMatch(result.stdout + result.stderr, /example-user|example-shop|example-actor|example-operator/);
    const missing = join(temp, 'missing.sqlite');
    assert.equal(run('unlock', { VINTAGE_LEDGER_DATABASE_FILE: missing }, '{}').status, 1);
    assert.equal(existsSync(missing), false);
  } finally {
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});
