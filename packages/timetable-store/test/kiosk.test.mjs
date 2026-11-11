import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { initializeTimetableStore, createTimetableStore } from '../src/index.mjs';
import { migrateWithBackup } from '../src/operations.mjs';
import { registerKiosk, revokeKiosk, issueKioskChallenge, consumeKioskChallenge } from '../src/kiosk.mjs';

const issuer = 'https://identity.example.invalid';
const identity = (subject) => ({ issuer, subject, issuedAt: Math.floor(Date.now() / 1000) });
async function setup(path, dir) {
  const db = new DatabaseSync(path);
  initializeTimetableStore(db);
  for (const business of ['shop-a', 'shop-b']) db.prepare('INSERT INTO businesses (id) VALUES (?)').run(business);
  for (const [business, staff] of [['shop-a', 'admin-a'], ['shop-a', 'staff-a'], ['shop-b', 'staff-b']])
    db.prepare('INSERT INTO staff (business_id,id) VALUES (?,?)').run(business, staff);
  const add = db.prepare('INSERT INTO memberships (issuer,subject,business_id,staff_id,role,active) VALUES (?,?,?,?,?,1)');
  add.run(issuer, 'example-admin', 'shop-a', 'admin-a', 'ADMIN');
  add.run(issuer, 'example-user', 'shop-a', 'staff-a', 'VIEWER');
  add.run(issuer, 'example-foreign', 'shop-b', 'staff-b', 'VIEWER');
  db.close();
  for (const version of [1,2,3,4,5,6,7,8,9,10]) await migrateWithBackup(path, join(dir, `backup-v${version}.sqlite`));
  const ready = new DatabaseSync(path);
  ready.prepare('INSERT INTO schedule_locations (business_id,id,label) VALUES (?,?,?)').run('shop-a', 'location-a', 'Example location');
  ready.exec('CREATE TABLE test_effects (staff_id TEXT NOT NULL)');
  return ready;
}

test('one-use challenge is scoped, atomic and invalid after device revocation', async () => {
  const prefix = join(tmpdir(), 'vintage-kiosk-');
  const temp = mkdtempSync(prefix);
  let db, backup;
  try {
    const path = join(temp, 'fixture.sqlite');
    db = await setup(path, temp);
    backup = new DatabaseSync(join(temp, 'backup-v10.sqlite'), { readOnly: true });
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 10);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 11);
    createTimetableStore(db);
    assert.throws(() => registerKiosk(db, identity('example-user'), { deviceId: 'device-a', locationId: 'location-a' }), /Kiosk operation failed/);
    db.exec("CREATE TRIGGER reject_kiosk_audit BEFORE INSERT ON kiosk_device_events BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    assert.throws(() => registerKiosk(db, identity('example-admin'), { deviceId: 'device-a', locationId: 'location-a' }), /Kiosk operation failed/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM kiosk_devices').get().n, 0);
    db.exec('DROP TRIGGER reject_kiosk_audit');
    const credential = registerKiosk(db, identity('example-admin'), { deviceId: 'device-a', locationId: 'location-a' });
    const challenge = issueKioskChallenge(db, credential, 'clock-in', 60);
    assert.notEqual(db.prepare('SELECT credential_digest FROM kiosk_devices').get().credential_digest, credential);
    assert.notEqual(db.prepare('SELECT digest FROM kiosk_challenges').get().digest, challenge);
    assert.throws(() => consumeKioskChallenge(db, identity('example-foreign'), challenge, 'clock-in', () => {}), /Kiosk operation failed/);
    assert.throws(() => consumeKioskChallenge(db, identity('example-user'), challenge, 'clock-out', () => {}), /Kiosk operation failed/);
    assert.throws(() => consumeKioskChallenge(db, identity('example-user'), challenge, 'clock-in', async () => {}), /Kiosk operation failed/);
    assert.throws(() => consumeKioskChallenge(db, identity('example-user'), challenge, 'clock-in', () => Promise.resolve()), /Kiosk operation failed/);
    db.prepare('UPDATE memberships SET token_valid_after=? WHERE subject=?').run(Math.floor(Date.now() / 1000) + 10, 'example-user');
    assert.throws(() => consumeKioskChallenge(db, identity('example-user'), challenge, 'clock-in', () => {}), /Kiosk operation failed/);
    db.prepare('UPDATE memberships SET token_valid_after=0 WHERE subject=?').run('example-user');
    assert.throws(() => consumeKioskChallenge(db, identity('example-user'), challenge, 'clock-in', ({ staffId }) => {
      db.prepare('INSERT INTO test_effects (staff_id) VALUES (?)').run(staffId); throw new Error('synthetic private detail');
    }), (error) => error.message === 'Kiosk operation failed' && error.cause === undefined);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM test_effects').get().n, 0);
    const result = consumeKioskChallenge(db, identity('example-user'), challenge, 'clock-in', ({ businessId, staffId, deviceId, locationId }) => {
      assert.deepEqual([businessId, staffId, deviceId, locationId], ['shop-a', 'staff-a', 'device-a', 'location-a']);
      db.prepare('INSERT INTO test_effects (staff_id) VALUES (?)').run(staffId);
      return 'ok';
    });
    assert.equal(result, 'ok');
    assert.throws(() => consumeKioskChallenge(db, identity('example-user'), challenge, 'clock-in', () => {}), /Kiosk operation failed/);
    assert.throws(() => issueKioskChallenge(db, credential, 'clock-in', 0), /Kiosk operation failed/);
    const pending = issueKioskChallenge(db, credential, 'clock-out', 60);
    for (let i = 0; i < 63; i++) issueKioskChallenge(db, credential, 'clock-in', 60);
    assert.throws(() => issueKioskChallenge(db, credential, 'clock-in', 60), /Kiosk operation failed/);
    db.exec("CREATE TRIGGER reject_kiosk_audit BEFORE INSERT ON kiosk_device_events BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    assert.throws(() => revokeKiosk(db, identity('example-admin'), 'device-a'), /Kiosk operation failed/);
    assert.equal(db.prepare('SELECT active FROM kiosk_devices').get().active, 1);
    db.exec('DROP TRIGGER reject_kiosk_audit');
    revokeKiosk(db, identity('example-admin'), 'device-a');
    assert.throws(() => issueKioskChallenge(db, credential, 'clock-in', 60), /Kiosk operation failed/);
    assert.throws(() => consumeKioskChallenge(db, identity('example-user'), pending, 'clock-out', () => {}), /Kiosk operation failed/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM kiosk_device_events').get().n, 2);
  } finally {
    if (backup?.isOpen) backup.close();
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});

test('expired, revoked and concurrently consumed challenges fail closed', async (t) => {
  const prefix = join(tmpdir(), 'vintage-kiosk-race-');
  const temp = mkdtempSync(prefix);
  let db;
  try {
    const path = join(temp, 'fixture.sqlite');
    db = await setup(path, temp);
    const credential = registerKiosk(db, identity('example-admin'), { deviceId: 'device-a', locationId: 'location-a' });
    t.mock.timers.enable({ apis: ['Date'] });
    const expired = issueKioskChallenge(db, credential, 'clock-in', 1);
    t.mock.timers.tick(1001);
    assert.throws(() => consumeKioskChallenge(db, identity('example-user'), expired, 'clock-in', () => {}), /Kiosk operation failed/);
    const expiresDuringAction = issueKioskChallenge(db, credential, 'clock-in', 1);
    assert.throws(() => consumeKioskChallenge(db, identity('example-user'), expiresDuringAction, 'clock-in', ({ staffId }) => {
      db.prepare('INSERT INTO test_effects (staff_id) VALUES (?)').run(staffId); t.mock.timers.tick(1001);
    }), /Kiosk operation failed/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM test_effects').get().n, 0);
    t.mock.timers.reset();
    const challenge = issueKioskChallenge(db, credential, 'clock-in', 60);
    db.close();
    const moduleUrl = new URL('../src/kiosk.mjs', import.meta.url).href;
    const program = `import { DatabaseSync } from 'node:sqlite'; import { consumeKioskChallenge } from ${JSON.stringify(moduleUrl)};
      let challenge = ''; for await (const chunk of process.stdin) challenge += chunk;
      const db = new DatabaseSync(process.argv[1]);
      try { consumeKioskChallenge(db, { issuer: 'https://identity.example.invalid', subject: 'example-user', issuedAt: Math.floor(Date.now()/1000) }, challenge, 'clock-in',
        ({ staffId }) => { db.prepare('INSERT INTO test_effects (staff_id) VALUES (?)').run(staffId); }); process.stdout.write('ok'); }
      catch { process.stdout.write('denied'); } finally { db.close(); }`;
    const run = () => new Promise((done, fail) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', program, path], { stdio: ['pipe', 'pipe', 'ignore'] });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.on('error', fail);
      child.stdin.end(challenge);
      child.on('close', (code) => code === 0 ? done(output) : fail(new Error('Test worker failed')));
    });
    assert.deepEqual((await Promise.all([run(), run()])).sort(), ['denied', 'ok']);
    db = new DatabaseSync(path, { readOnly: true });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM test_effects').get().n, 1);
  } finally {
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});

test('failed kiosk migration leaves version 10 and its backup intact', async () => {
  const prefix = join(tmpdir(), 'vintage-kiosk-migration-');
  const temp = mkdtempSync(prefix);
  let db, backup;
  try {
    const path = join(temp, 'fixture.sqlite');
    db = new DatabaseSync(path);
    initializeTimetableStore(db);
    db.close();
    for (const version of [1,2,3,4,5,6,7,8,9]) await migrateWithBackup(path, join(temp, `backup-v${version}.sqlite`));
    db = new DatabaseSync(path);
    db.exec('CREATE TABLE kiosk_challenges (example TEXT)');
    db.close();
    const backupPath = join(temp, 'backup-v10.sqlite');
    await assert.rejects(migrateWithBackup(path, backupPath));
    db = new DatabaseSync(path, { readOnly: true });
    backup = new DatabaseSync(backupPath, { readOnly: true });
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 10);
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 10);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='kiosk_devices'").get().n, 0);
  } finally {
    if (backup?.isOpen) backup.close();
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});
