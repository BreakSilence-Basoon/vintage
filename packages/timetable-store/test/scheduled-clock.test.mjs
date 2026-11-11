import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { initializeTimetableStore } from '../src/index.mjs';
import { migrateWithBackup } from '../src/operations.mjs';
import { applyAuthenticatedOperation } from '../src/admin.mjs';
import { registerKiosk, issueKioskChallenge } from '../src/kiosk.mjs';
import { confirmScheduledAttendance } from '../src/scheduled-clock.mjs';
import { prepareRestoredDatabase } from '../src/prepare-restore.mjs';
import { unlockRecoveredAdmin } from '../src/recover-admin.mjs';

const issuer = 'https://identity.example.invalid';
const identity = (subject) => ({ issuer, subject, issuedAt: Math.floor(Date.now() / 1000) });
const policy = { earlyWindowMs: 3600000, lateWindowMs: 3600000 };

async function setup(path, dir, startsAt, endsAt) {
  let db = new DatabaseSync(path);
  initializeTimetableStore(db);
  for (const business of ['shop-a', 'shop-b']) db.prepare('INSERT INTO businesses (id) VALUES (?)').run(business);
  for (const [business, staff] of [['shop-a','admin-a'], ['shop-a','staff-a'], ['shop-a','staff-b'], ['shop-b','foreign']])
    db.prepare('INSERT INTO staff (business_id,id) VALUES (?,?)').run(business, staff);
  const member = db.prepare('INSERT INTO memberships (issuer,subject,business_id,staff_id,role,active) VALUES (?,?,?,?,?,1)');
  member.run(issuer, 'example-admin', 'shop-a', 'admin-a', 'ADMIN');
  member.run(issuer, 'example-user', 'shop-a', 'staff-a', 'VIEWER');
  member.run(issuer, 'example-other', 'shop-a', 'staff-b', 'VIEWER');
  member.run(issuer, 'example-foreign', 'shop-b', 'foreign', 'VIEWER');
  db.close();
  for (const version of [1,2,3,4,5,6,7,8,9,10,11,12,13]) await migrateWithBackup(path, join(dir, `backup-v${version}.sqlite`));
  db = new DatabaseSync(path);
  const admin = identity('example-admin');
  applyAuthenticatedOperation(db, admin, 'add-location', { locationId: 'location-a', label: 'Example location' });
  applyAuthenticatedOperation(db, admin, 'add-location', { locationId: 'location-b', label: 'Other example location' });
  applyAuthenticatedOperation(db, admin, 'add-shift', { shiftId: 'shift-a', staffId: 'staff-a', locationId: 'location-a', startsAt, endsAt, graceMinutes: 0 });
  const first = registerKiosk(db, admin, { deviceId: 'device-a', locationId: 'location-a' });
  const second = registerKiosk(db, admin, { deviceId: 'device-b', locationId: 'location-a' });
  const other = registerKiosk(db, admin, { deviceId: 'device-c', locationId: 'location-b' });
  return { db, admin, first, second, other };
}

test('scheduled clock uses same-device confirmation, current authority and atomic attendance audit', async (t) => {
  const prefix = join(tmpdir(), 'vintage-clock-');
  const temp = mkdtempSync(prefix);
  let db;
  try {
    t.mock.timers.enable({ apis: ['Date'] });
    t.mock.timers.setTime(Date.parse('2026-01-01T09:00:00.000Z'));
    const path = join(temp, 'fixture.sqlite');
    const fixture = await setup(path, temp, '2026-01-01T09:00:00.000Z', '2026-01-01T17:00:00.000Z');
    db = fixture.db;
    const user = identity('example-user'), input = { shiftId: 'shift-a', expectedRevision: 1 };
    const confirm = (who, challenge, purpose, requested = input) => confirmScheduledAttendance(db, who, challenge, purpose, requested, policy);
    t.mock.timers.setTime(Date.parse('2026-01-01T07:59:00.000Z'));
    const tooEarly = issueKioskChallenge(db, fixture.first, 'clock-in', 60);
    assert.throws(() => confirm(user, tooEarly, 'clock-in'));
    t.mock.timers.setTime(Date.parse('2026-01-01T09:00:00.000Z'));
    const challenge = issueKioskChallenge(db, fixture.first, 'clock-in', 60);
    assert.throws(() => confirm(identity('example-other'), challenge, 'clock-in'));
    assert.throws(() => confirm(identity('example-foreign'), challenge, 'clock-in'));
    assert.throws(() => confirm(user, challenge, 'clock-in', { ...input, expectedRevision: 2 }));
    db.prepare('UPDATE memberships SET active=0 WHERE subject=?').run('example-user');
    assert.throws(() => confirm(user, challenge, 'clock-in'));
    db.prepare('UPDATE memberships SET active=1 WHERE subject=?').run('example-user');
    const wrongPlace = issueKioskChallenge(db, fixture.other, 'clock-in', 60);
    assert.throws(() => confirm(user, wrongPlace, 'clock-in'));
    db.exec("CREATE TRIGGER reject_attendance_audit BEFORE INSERT ON scheduled_attendance_events BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    assert.throws(() => confirm(user, challenge, 'clock-in'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM history').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scheduled_attendance').get().n, 0);
    db.exec('DROP TRIGGER reject_attendance_audit');
    const started = confirm(user, challenge, 'clock-in');
    assert.equal(started.startsAt, '2026-01-01T09:00:00.000Z');
    assert.equal(started.endsAt, null);
    assert.throws(() => confirm(user, challenge, 'clock-in'));
    assert.throws(() => applyAuthenticatedOperation(db, fixture.admin, 'cancel-shift', { shiftId: 'shift-a', expectedRevision: 1, reason: 'Example cancellation' }));
    assert.throws(() => applyAuthenticatedOperation(db, fixture.admin, 'update-shift', { shiftId: 'shift-a', staffId: 'staff-a', locationId: 'location-a', startsAt: '2026-01-01T09:00:00.000Z', endsAt: '2026-01-01T18:00:00.000Z', graceMinutes: 0, expectedRevision: 1, reason: 'Example correction' }));
    assert.throws(() => applyAuthenticatedOperation(db, fixture.admin, 'close-history', { recordId: started.recordId, endsAt: '2026-01-01T10:00:00.000Z' }));
    t.mock.timers.tick(1000);
    db.prepare('UPDATE history SET staff_id=? WHERE id=?').run('staff-b', started.recordId);
    const mismatchedRecord = issueKioskChallenge(db, fixture.first, 'clock-out', 60);
    assert.throws(() => confirm(user, mismatchedRecord, 'clock-out'));
    db.prepare('UPDATE history SET staff_id=? WHERE id=?').run('staff-a', started.recordId);
    const restoredPath = join(temp, 'restored.sqlite');
    await prepareRestoredDatabase(path, restoredPath);
    unlockRecoveredAdmin(restoredPath, { issuer, subject: 'example-admin', reason: 'Example verification' });
    const restored = new DatabaseSync(restoredPath);
    try {
      const adminCutoff = restored.prepare('SELECT token_valid_after FROM memberships WHERE subject=?').get('example-admin').token_valid_after;
      const restoredAdmin = { issuer, subject: 'example-admin', issuedAt: adminCutoff };
      applyAuthenticatedOperation(restored, restoredAdmin, 'reactivate-viewer', { staffId: 'staff-a', reason: 'Example verification' });
      const viewerCutoff = restored.prepare('SELECT token_valid_after FROM memberships WHERE subject=?').get('example-user').token_valid_after;
      const replacement = registerKiosk(restored, restoredAdmin, { deviceId: 'replacement', locationId: 'location-a' });
      const replacementChallenge = issueKioskChallenge(restored, replacement, 'clock-out', 60);
      assert.throws(() => confirmScheduledAttendance(restored, { issuer, subject: 'example-user', issuedAt: viewerCutoff }, replacementChallenge, 'clock-out', input, policy));
      assert.equal(restored.prepare('SELECT ends_at FROM history WHERE id=?').get(started.recordId).ends_at, null);
    } finally { restored.close(); }
    const wrongDevice = issueKioskChallenge(db, fixture.second, 'clock-out', 60);
    assert.throws(() => confirm(user, wrongDevice, 'clock-out'));
    t.mock.timers.tick(3599000);
    const closeChallenge = issueKioskChallenge(db, fixture.first, 'clock-out', 60);
    const closed = confirm(user, closeChallenge, 'clock-out');
    assert.equal(closed.recordId, started.recordId);
    assert.equal(closed.endsAt, '2026-01-01T10:00:00.000Z');
    assert.throws(() => confirm(user, closeChallenge, 'clock-out'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scheduled_attendance_events').get().n, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scheduled_attendance_events e JOIN kiosk_challenges c ON c.digest=e.challenge_digest WHERE c.used_at IS NOT NULL').get().n, 2);
    assert.equal(db.prepare('SELECT ends_at FROM history WHERE id=?').get(started.recordId).ends_at, closed.endsAt);
  } finally {
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});

test('concurrent confirmed clock-ins cannot create two records', async () => {
  const prefix = join(tmpdir(), 'vintage-clock-race-');
  const temp = mkdtempSync(prefix);
  let db;
  try {
    const path = join(temp, 'fixture.sqlite'), now = Date.now();
    const fixture = await setup(path, temp, new Date(now - 60000).toISOString(), new Date(now + 3600000).toISOString());
    db = fixture.db;
    const challenges = [issueKioskChallenge(db, fixture.first, 'clock-in', 60), issueKioskChallenge(db, fixture.first, 'clock-in', 60)];
    db.close();
    const moduleUrl = new URL('../src/scheduled-clock.mjs', import.meta.url).href;
    const program = `import { DatabaseSync } from 'node:sqlite'; import { confirmScheduledAttendance } from ${JSON.stringify(moduleUrl)};
      let challenge = ''; for await (const chunk of process.stdin) challenge += chunk;
      const db = new DatabaseSync(process.argv[1]); db.exec('PRAGMA busy_timeout=2000');
      try { confirmScheduledAttendance(db, { issuer: 'https://identity.example.invalid', subject: 'example-user', issuedAt: Math.floor(Date.now()/1000) }, challenge, 'clock-in',
        { shiftId: 'shift-a', expectedRevision: 1 }, { earlyWindowMs: 3600000, lateWindowMs: 3600000 }); process.stdout.write('ok'); }
      catch { process.stdout.write('denied'); } finally { db.close(); }`;
    const run = (challenge) => new Promise((done, fail) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', program, path], { stdio: ['pipe', 'pipe', 'ignore'] });
      let text = '';
      child.stdout.on('data', (chunk) => { text += chunk; });
      child.on('error', fail); child.stdin.end(challenge);
      child.on('close', (code) => code === 0 ? done(text) : fail(new Error('Test worker failed')));
    });
    const outcomes = await Promise.all(challenges.map(run));
    assert.deepEqual(outcomes.sort(), ['denied', 'ok']);
    db = new DatabaseSync(path, { readOnly: true });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM history').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scheduled_attendance_events').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM kiosk_challenges WHERE used_at IS NOT NULL').get().n, 1);
  } finally {
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});

test('attendance migration failure preserves version 13 and its backup', async () => {
  const prefix = join(tmpdir(), 'vintage-clock-schema-failure-');
  const temp = mkdtempSync(prefix);
  let db, backup;
  try {
    const path = join(temp, 'fixture.sqlite');
    db = new DatabaseSync(path);
    initializeTimetableStore(db);
    db.close();
    for (const version of [1,2,3,4,5,6,7,8,9,10,11,12]) await migrateWithBackup(path, join(temp, `backup-v${version}.sqlite`));
    db = new DatabaseSync(path);
    db.exec('CREATE TABLE scheduled_attendance_events (example TEXT)');
    db.close();
    const backupPath = join(temp, 'backup-v13.sqlite');
    await assert.rejects(migrateWithBackup(path, backupPath));
    db = new DatabaseSync(path, { readOnly: true });
    backup = new DatabaseSync(backupPath, { readOnly: true });
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 13);
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 13);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='scheduled_attendance'").get().n, 0);
  } finally {
    if (backup?.isOpen) backup.close();
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});
