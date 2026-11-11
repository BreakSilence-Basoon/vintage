import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { initializeTimetableStore, createTimetableStore } from '../src/index.mjs';
import { applyLocalOperation, migrateWithBackup } from '../src/operations.mjs';
import { prepareRestoredDatabase } from '../src/prepare-restore.mjs';
import { registerKiosk, issueKioskChallenge, consumeKioskChallenge } from '../src/kiosk.mjs';
import { unlockRecoveredAdmin } from '../src/recover-admin.mjs';

async function setup(path, dir) {
  const db = new DatabaseSync(path);
  initializeTimetableStore(db);
  db.prepare('INSERT INTO businesses (id) VALUES (?)').run('shop-a');
  db.prepare('INSERT INTO staff (business_id,id) VALUES (?,?)').run('shop-a', 'admin-a');
  db.prepare('INSERT INTO staff (business_id,id) VALUES (?,?)').run('shop-a', 'staff-a');
  db.prepare('INSERT INTO memberships (issuer,subject,business_id,staff_id,role,active) VALUES (?,?,?,?,?,1)')
    .run('https://identity.example.invalid', 'example-admin', 'shop-a', 'admin-a', 'ADMIN');
  db.prepare('INSERT INTO memberships (issuer,subject,business_id,staff_id,role,active) VALUES (?,?,?,?,?,1)')
    .run('https://identity.example.invalid', 'example-user', 'shop-a', 'staff-a', 'VIEWER');
  db.close();
  for (const version of [1,2,3,4,5,6,7,8,9,10]) await migrateWithBackup(path, join(dir, `backup-v${version}.sqlite`));
  return new DatabaseSync(path);
}

test('offline preparation preserves source while invalidating old access and device challenges', async () => {
  const prefix = join(tmpdir(), 'vintage-prepare-restore-');
  const temp = mkdtempSync(prefix);
  let source, prepared, repeated;
  try {
    const original = join(temp, 'source.sqlite');
    const output = join(temp, 'prepared.sqlite');
    source = await setup(original, temp);
    source.exec('PRAGMA journal_mode = WAL');
    source.prepare('INSERT INTO schedule_locations (business_id,id,label) VALUES (?,?,?)').run('shop-a', 'location-a', 'Example location');
    const identity = { issuer: 'https://identity.example.invalid', subject: 'example-admin', issuedAt: Math.floor(Date.now() / 1000) };
    const credential = registerKiosk(source, identity, { deviceId: 'device-a', locationId: 'location-a' });
    const challenge = issueKioskChallenge(source, credential, 'clock-in', 60);
    source.close();
    assert.deepEqual(await prepareRestoredDatabase(original, output), { cleanupIncomplete: false });
    source = new DatabaseSync(original, { readOnly: true });
    prepared = new DatabaseSync(output);
    assert.equal(source.prepare('PRAGMA user_version').get().user_version, 11);
    assert.equal(source.prepare('SELECT active FROM kiosk_devices').get().active, 1);
    assert.equal(source.prepare('SELECT used_at FROM kiosk_challenges').get().used_at, null);
    assert.equal(prepared.prepare('PRAGMA user_version').get().user_version, 13);
    assert.equal(prepared.prepare('SELECT COUNT(*) AS n FROM memberships WHERE active=1').get().n, 0);
    assert.equal(prepared.prepare('SELECT status FROM recovery_guard').get().status, 'pending');
    assert.throws(() => applyLocalOperation(output, 'add-viewer', { businessId: 'shop-a', staffId: 'staff-b', issuer: 'https://identity.example.invalid', subject: 'example-new' }));
    assert.equal(prepared.prepare('SELECT active FROM kiosk_devices').get().active, 0);
    assert.notEqual(prepared.prepare('SELECT used_at FROM kiosk_challenges').get().used_at, null);
    const cutoff = prepared.prepare('SELECT token_valid_after FROM memberships WHERE subject = ?').get('example-admin').token_valid_after;
    assert.ok(cutoff > identity.issuedAt);
    assert.equal(await createTimetableStore(prepared).findOwnHistory(identity.issuer, identity.subject, null, 10, identity.issuedAt), null);
    assert.throws(() => issueKioskChallenge(prepared, credential, 'clock-in', 60), /Kiosk operation failed/);
    assert.throws(() => consumeKioskChallenge(prepared, { ...identity, issuedAt: cutoff }, challenge, 'clock-in', () => {}), /Kiosk operation failed/);
    const event = prepared.prepare('SELECT disabled_devices,invalidated_challenges,actor_kind FROM restore_preparation_events').get();
    assert.deepEqual({ ...event }, { disabled_devices: 1, invalidated_challenges: 1, actor_kind: 'local-operator' });
    assert.equal(source.prepare('SELECT COUNT(*) AS n FROM memberships WHERE active=1').get().n, 2);
    prepared.close();
    const premature = join(temp, 'premature.sqlite');
    await assert.rejects(prepareRestoredDatabase(output, premature));
    assert.equal(existsSync(premature), false);
    assert.throws(() => unlockRecoveredAdmin(output, { issuer: identity.issuer, subject: 'example-user', reason: 'Example verification' }));
    prepared = new DatabaseSync(output);
    prepared.exec("CREATE TRIGGER reject_unlock_audit BEFORE INSERT ON recovery_admin_unlock_events BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    prepared.close();
    assert.throws(() => unlockRecoveredAdmin(output, { issuer: identity.issuer, subject: identity.subject, reason: 'Example verification' }));
    prepared = new DatabaseSync(output);
    assert.equal(prepared.prepare('SELECT COUNT(*) AS n FROM memberships WHERE active=1').get().n, 0);
    assert.equal(prepared.prepare('SELECT status FROM recovery_guard').get().status, 'pending');
    prepared.exec('DROP TRIGGER reject_unlock_audit');
    prepared.close();
    unlockRecoveredAdmin(output, { issuer: identity.issuer, subject: identity.subject, reason: 'Example verification' });
    assert.throws(() => unlockRecoveredAdmin(output, { issuer: identity.issuer, subject: identity.subject, reason: 'Example verification' }));
    prepared = new DatabaseSync(output);
    assert.equal(prepared.prepare('SELECT status FROM recovery_guard').get().status, 'unlocked');
    assert.equal(prepared.prepare('SELECT COUNT(*) AS n FROM memberships WHERE active=1').get().n, 1);
    assert.equal(prepared.prepare('SELECT active FROM memberships WHERE subject=?').get('example-user').active, 0);
    const recoveredCutoff = prepared.prepare('SELECT token_valid_after FROM memberships WHERE subject=?').get('example-admin').token_valid_after;
    const newCredential = registerKiosk(prepared, { ...identity, issuedAt: recoveredCutoff }, { deviceId: 'device-b', locationId: 'location-a' });
    assert.ok(issueKioskChallenge(prepared, newCredential, 'clock-out', 60));
    prepared.close();
    const second = join(temp, 'prepared-again.sqlite');
    assert.deepEqual(await prepareRestoredDatabase(output, second), { cleanupIncomplete: false });
    repeated = new DatabaseSync(second, { readOnly: true });
    assert.equal(repeated.prepare('SELECT COUNT(*) AS n FROM kiosk_devices WHERE active=1').get().n, 0);
    assert.equal(repeated.prepare('SELECT COUNT(*) AS n FROM kiosk_challenges WHERE used_at IS NULL').get().n, 0);
    assert.equal(repeated.prepare('SELECT COUNT(*) AS n FROM restore_preparation_events').get().n, 2);
  } finally {
    if (repeated?.isOpen) repeated.close();
    if (prepared?.isOpen) prepared.close();
    if (source?.isOpen) source.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});

test('existing targets and failed sanitization never publish an output', async () => {
  const prefix = join(tmpdir(), 'vintage-prepare-failure-');
  const temp = mkdtempSync(prefix);
  let source;
  try {
    const original = join(temp, 'source.sqlite');
    source = await setup(original, temp);
    source.prepare('INSERT INTO schedule_locations (business_id,id,label) VALUES (?,?,?)').run('shop-a', 'location-a', 'Example location');
    const identity = { issuer: 'https://identity.example.invalid', subject: 'example-admin', issuedAt: Math.floor(Date.now() / 1000) };
    registerKiosk(source, identity, { deviceId: 'device-a', locationId: 'location-a' });
    source.exec("CREATE TRIGGER reject_restore BEFORE UPDATE ON kiosk_devices BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    source.close();
    const occupied = join(temp, 'occupied.sqlite');
    writeFileSync(occupied, 'synthetic-existing-data');
    await assert.rejects(prepareRestoredDatabase(original, occupied));
    assert.equal(readFileSync(occupied, 'utf8'), 'synthetic-existing-data');
    const failed = join(temp, 'must-not-exist.sqlite');
    await assert.rejects(prepareRestoredDatabase(original, failed));
    assert.equal(existsSync(failed), false);
    source = new DatabaseSync(original, { readOnly: true });
    assert.equal(source.prepare('SELECT active FROM kiosk_devices').get().active, 1);
    assert.equal(source.prepare('PRAGMA user_version').get().user_version, 11);
    source.close();
    source = new DatabaseSync(original);
    source.exec('DROP TRIGGER reject_restore');
    source.prepare('UPDATE memberships SET active=0').run();
    source.close();
    const noCandidate = join(temp, 'no-candidate.sqlite');
    await assert.rejects(prepareRestoredDatabase(original, noCandidate));
    assert.equal(existsSync(noCandidate), false);
  } finally {
    if (source?.isOpen) source.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});

test('concurrent recovery unlocks enable only one administrator and one audit event', async () => {
  const prefix = join(tmpdir(), 'vintage-recover-race-');
  const temp = mkdtempSync(prefix);
  let db;
  try {
    const original = join(temp, 'source.sqlite'), output = join(temp, 'prepared.sqlite');
    db = await setup(original, temp);
    db.close();
    await prepareRestoredDatabase(original, output);
    const moduleUrl = new URL('../src/recover-admin.mjs', import.meta.url).href;
    const program = `import { unlockRecoveredAdmin } from ${JSON.stringify(moduleUrl)};
      try { unlockRecoveredAdmin(process.argv[1], { issuer: 'https://identity.example.invalid', subject: 'example-admin', reason: 'Example verification' }); process.stdout.write('ok'); }
      catch { process.stdout.write('denied'); }`;
    const run = () => new Promise((done, fail) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', program, output], { stdio: ['ignore', 'pipe', 'ignore'] });
      let text = '';
      child.stdout.on('data', (chunk) => { text += chunk; });
      child.on('error', fail);
      child.on('close', (code) => code === 0 ? done(text) : fail(new Error('Test worker failed')));
    });
    const outcomes = await Promise.all([run(), run()]);
    assert.ok(outcomes.every((value) => ['denied', 'ok'].includes(value)));
    assert.ok(outcomes.filter((value) => value === 'ok').length <= 1);
    if (!outcomes.includes('ok')) unlockRecoveredAdmin(output, { issuer: 'https://identity.example.invalid', subject: 'example-admin', reason: 'Example verification' });
    db = new DatabaseSync(output, { readOnly: true });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE active=1').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recovery_admin_unlock_events').get().n, 1);
    assert.equal(db.prepare('SELECT status FROM recovery_guard').get().status, 'unlocked');
  } finally {
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});

test('recovery guard migration failure preserves the version 12 source and backup', async () => {
  const prefix = join(tmpdir(), 'vintage-recover-schema-');
  const temp = mkdtempSync(prefix);
  let db, backup;
  try {
    const path = join(temp, 'source.sqlite');
    db = await setup(path, temp);
    db.close();
    await migrateWithBackup(path, join(temp, 'backup-v11.sqlite'));
    db = new DatabaseSync(path);
    db.exec('CREATE TABLE recovery_guard (example TEXT)');
    db.close();
    const backupPath = join(temp, 'backup-v12.sqlite');
    await assert.rejects(migrateWithBackup(path, backupPath));
    db = new DatabaseSync(path, { readOnly: true });
    backup = new DatabaseSync(backupPath, { readOnly: true });
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 12);
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 12);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='recovery_admin_candidates'").get().n, 0);
  } finally {
    if (backup?.isOpen) backup.close();
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});
