import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initializeTimetableStore, createTimetableStore } from '../src/index.mjs';
import { migrateWithBackup } from '../src/operations.mjs';
import { prepareRestoredDatabase } from '../src/prepare-restore.mjs';
import { registerKiosk, issueKioskChallenge, consumeKioskChallenge } from '../src/kiosk.mjs';

async function setup(path, dir) {
  const db = new DatabaseSync(path);
  initializeTimetableStore(db);
  db.prepare('INSERT INTO businesses (id) VALUES (?)').run('shop-a');
  db.prepare('INSERT INTO staff (business_id,id) VALUES (?,?)').run('shop-a', 'admin-a');
  db.prepare('INSERT INTO memberships (issuer,subject,business_id,staff_id,role,active) VALUES (?,?,?,?,?,1)')
    .run('https://identity.example.invalid', 'example-admin', 'shop-a', 'admin-a', 'ADMIN');
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
    assert.equal(prepared.prepare('PRAGMA user_version').get().user_version, 12);
    assert.equal(prepared.prepare('SELECT active FROM kiosk_devices').get().active, 0);
    assert.notEqual(prepared.prepare('SELECT used_at FROM kiosk_challenges').get().used_at, null);
    const cutoff = prepared.prepare('SELECT token_valid_after FROM memberships').get().token_valid_after;
    assert.ok(cutoff > identity.issuedAt);
    assert.equal(await createTimetableStore(prepared).findOwnHistory(identity.issuer, identity.subject, null, 10, identity.issuedAt), null);
    assert.throws(() => issueKioskChallenge(prepared, credential, 'clock-in', 60), /Kiosk operation failed/);
    assert.throws(() => consumeKioskChallenge(prepared, { ...identity, issuedAt: cutoff }, challenge, 'clock-in', () => {}), /Kiosk operation failed/);
    const event = prepared.prepare('SELECT disabled_devices,invalidated_challenges,actor_kind FROM restore_preparation_events').get();
    assert.deepEqual({ ...event }, { disabled_devices: 1, invalidated_challenges: 1, actor_kind: 'local-operator' });
    const newCredential = registerKiosk(prepared, { ...identity, issuedAt: cutoff }, { deviceId: 'device-b', locationId: 'location-a' });
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
  } finally {
    if (source?.isOpen) source.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});
