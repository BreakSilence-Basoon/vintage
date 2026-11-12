import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { initializeTimetableStore } from '../src/index.mjs';
import { migrateWithBackup } from '../src/operations.mjs';
import { applyAuthenticatedOperation } from '../src/admin.mjs';
import { registerKiosk, issueKioskChallenge } from '../src/kiosk.mjs';
import { confirmScheduledAttendance, getScheduledAttendanceReceipt } from '../src/scheduled-clock.mjs';
import { prepareRestoredDatabase } from '../src/prepare-restore.mjs';
import { unlockRecoveredAdmin } from '../src/recover-admin.mjs';

const issuer = 'https://identity.example.invalid';
const identity = (subject) => ({ issuer, subject, issuedAt: Math.floor(Date.now() / 1000) });
const policy = { earlyWindowMs: 3600000, lateWindowMs: 3600000 };

test('lost replies can be recovered by the same authorized staff without creating duplicate attendance', async (t) => {
  const prefix = join(tmpdir(), 'vintage-receipt-'), temp = mkdtempSync(prefix);
  let db;
  try {
    t.mock.timers.enable({ apis: ['Date'] });
    t.mock.timers.setTime(Date.parse('2026-01-01T09:00:00.000Z'));
    const fixture = await setup(join(temp, 'fixture.sqlite'), temp, '2026-01-01T09:00:00.000Z', '2026-01-01T17:00:00.000Z');
    db = fixture.db;
    const user = identity('example-user'), input = { shiftId: 'shift-a', expectedRevision: 1 };
    const challenge = issueKioskChallenge(db, fixture.first, 'clock-in', 60);
    const receipt = (who = user, value = challenge, action = 'clock-in', requested = input) => getScheduledAttendanceReceipt(db, who, value, action, requested);
    assert.equal(receipt(), null);
    const observer = new DatabaseSync(join(temp, 'fixture.sqlite'));
    const execute = db.exec.bind(db);
    db.exec = (sql) => {
      if (sql === 'COMMIT') assert.equal(getScheduledAttendanceReceipt(observer, user, challenge, 'clock-in', input), null);
      return execute(sql);
    };
    let original;
    try { original = confirmScheduledAttendance(db, user, challenge, 'clock-in', input, policy); } // Simulated lost reply.
    finally { db.exec = execute; observer.close(); }
    assert.throws(() => confirmScheduledAttendance(db, user, challenge, 'clock-in', input, policy));
    assert.deepEqual(receipt(), original);
    assert.equal(receipt(identity('example-other')), null);
    assert.equal(receipt(identity('example-foreign')), null);
    assert.equal(receipt(user, challenge, 'clock-out'), null);
    assert.equal(receipt(user, challenge, 'clock-in', { ...input, expectedRevision: 2 }), null);
    db.prepare('UPDATE memberships SET active=0 WHERE subject=?').run('example-user');
    assert.equal(receipt(), null);
    db.prepare('UPDATE memberships SET active=1, token_valid_after=? WHERE subject=?').run(user.issuedAt + 1, 'example-user');
    assert.equal(receipt(), null);
    t.mock.timers.tick(3600000);
    const freshUser = identity('example-user');
    assert.deepEqual(receipt(freshUser), original); // Receipt survives challenge expiry.
    const checkout = issueKioskChallenge(db, fixture.first, 'clock-out', 60);
    const closed = confirmScheduledAttendance(db, freshUser, checkout, 'clock-out', input, policy); // Simulated lost reply.
    assert.deepEqual(receipt(freshUser, checkout, 'clock-out'), closed);
    assert.deepEqual(receipt(freshUser), original); // A later checkout does not change the earlier receipt.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM history').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scheduled_attendance_events').get().n, 2);
    db.exec("INSERT INTO restore_preparation_events VALUES (1,'2026-01-01T10:00:00.000Z',0,0,0,'local-operator'); INSERT INTO recovery_guard VALUES (1,1,'pending')");
    assert.equal(receipt(freshUser), null);
  } finally {
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});

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

test('concurrent confirmed clock-ins cannot create two records', async (t) => {
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
      const db = new DatabaseSync(process.argv[1]); if (process.argv[4] === 'wait') db.exec('PRAGMA busy_timeout=2000');
      if (db.prepare('PRAGMA busy_timeout').get().timeout !== (process.argv[4] === 'wait' ? 2000 : 0)) throw new Error('Unexpected test connection timeout');
      try { confirmScheduledAttendance(db, { issuer: 'https://identity.example.invalid', subject: process.argv[2], issuedAt: Math.floor(Date.now()/1000) }, challenge, 'clock-in',
        { shiftId: process.argv[3], expectedRevision: 1 }, { earlyWindowMs: 3600000, lateWindowMs: 3600000 }); process.stdout.write('ok'); }
      catch { process.stdout.write('denied'); } finally { db.close(); }`;
    const run = (challenge, subject, shift, wait) => new Promise((done, fail) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', program, path, subject, shift, wait ? 'wait' : 'zero'], { stdio: ['pipe', 'pipe', 'ignore'] });
      let text = '';
      child.stdout.on('data', (chunk) => { text += chunk; });
      child.on('error', fail); child.stdin.end(challenge);
      child.on('close', (code) => code === 0 ? done(text) : fail(new Error('Test worker failed')));
    });
    const outcomes = await Promise.all(challenges.map((challenge) => run(challenge, 'example-user', 'shift-a', true)));
    assert.deepEqual(outcomes.sort(), ['denied', 'ok']);
    db = new DatabaseSync(path);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM history').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scheduled_attendance_events').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM kiosk_challenges WHERE used_at IS NOT NULL').get().n, 1);
    applyAuthenticatedOperation(db, fixture.admin, 'add-shift', { shiftId: 'shift-b', staffId: 'staff-b', locationId: 'location-a',
      startsAt: new Date(now - 60000).toISOString(), endsAt: new Date(now + 3600000).toISOString(), graceMinutes: 0 });
    const zeroChallenges = [issueKioskChallenge(db, fixture.first, 'clock-in', 60), issueKioskChallenge(db, fixture.first, 'clock-in', 60)];
    db.close();
    const zeroOutcomes = await Promise.all(zeroChallenges.map((challenge) => run(challenge, 'example-other', 'shift-b', false)));
    assert.ok(zeroOutcomes.every((value) => ['denied', 'ok'].includes(value)));
    assert.ok(zeroOutcomes.filter((value) => value === 'ok').length <= 1);
    t.diagnostic(`Zero-timeout concurrent successes: ${zeroOutcomes.filter((value) => value === 'ok').length} of 2`);
    db = new DatabaseSync(path);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM history').get().n, 1 + zeroOutcomes.filter((value) => value === 'ok').length);
    if (!zeroOutcomes.includes('ok')) confirmScheduledAttendance(db, identity('example-other'), zeroChallenges[0], 'clock-in', { shiftId: 'shift-b', expectedRevision: 1 }, policy);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM history').get().n, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scheduled_attendance_events').get().n, 2);
    applyAuthenticatedOperation(db, fixture.admin, 'add-viewer', { staffId: 'staff-c', subject: 'example-third' });
    applyAuthenticatedOperation(db, fixture.admin, 'add-shift', { shiftId: 'shift-c', staffId: 'staff-c', locationId: 'location-a',
      startsAt: new Date(now - 60000).toISOString(), endsAt: new Date(now + 3600000).toISOString(), graceMinutes: 0 });
    const repeated = issueKioskChallenge(db, fixture.first, 'clock-in', 60);
    db.close();
    const repeatedOutcomes = await Promise.all([run(repeated, 'example-third', 'shift-c', false), run(repeated, 'example-third', 'shift-c', false)]);
    assert.ok(repeatedOutcomes.filter((value) => value === 'ok').length <= 1);
    db = new DatabaseSync(path);
    const third = identity('example-third'), thirdInput = { shiftId: 'shift-c', expectedRevision: 1 };
    if (!repeatedOutcomes.includes('ok')) confirmScheduledAttendance(db, third, repeated, 'clock-in', thirdInput, policy);
    const recovered = getScheduledAttendanceReceipt(db, third, repeated, 'clock-in', thirdInput);
    assert.ok(recovered?.recordId);
    assert.throws(() => confirmScheduledAttendance(db, third, repeated, 'clock-in', thirdInput, policy));
    assert.deepEqual(getScheduledAttendanceReceipt(db, third, repeated, 'clock-in', thirdInput), recovered);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM history').get().n, 3);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scheduled_attendance_events').get().n, 3);
  } finally {
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});

test('default zero-timeout lock failure leaves challenge and attendance unchanged for a later attempt', async () => {
  const prefix = join(tmpdir(), 'vintage-clock-locked-');
  const temp = mkdtempSync(prefix);
  let db, holder, probe;
  try {
    const path = join(temp, 'fixture.sqlite'), now = Date.now();
    const fixture = await setup(path, temp, new Date(now - 60000).toISOString(), new Date(now + 3600000).toISOString());
    db = fixture.db;
    assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 0);
    const challenge = issueKioskChallenge(db, fixture.first, 'clock-in', 60);
    const digest = createHash('sha256').update(challenge).digest('hex');
    holder = new DatabaseSync(path);
    holder.exec('BEGIN IMMEDIATE');
    try {
      probe = new DatabaseSync(path);
      assert.throws(() => probe.exec('BEGIN IMMEDIATE'), (error) => error.errcode === 5);
      probe.close();
      assert.throws(() => confirmScheduledAttendance(db, identity('example-user'), challenge, 'clock-in',
        { shiftId: 'shift-a', expectedRevision: 1 }, policy), (error) => error.message === 'Scheduled attendance failed' && error.cause === undefined);
      assert.equal(holder.prepare('SELECT used_at FROM kiosk_challenges WHERE digest=?').get(digest).used_at, null);
      assert.equal(holder.prepare('SELECT COUNT(*) AS n FROM history').get().n, 0);
    } finally { holder.exec('ROLLBACK'); }
    const result = confirmScheduledAttendance(db, identity('example-user'), challenge, 'clock-in', { shiftId: 'shift-a', expectedRevision: 1 }, policy);
    assert.ok(result.recordId);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM history').get().n, 1);
    assert.notEqual(db.prepare('SELECT used_at FROM kiosk_challenges WHERE digest=?').get(digest).used_at, null);
  } finally {
    if (probe?.isOpen) probe.close();
    if (holder?.isOpen) holder.close();
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});

test('a reader blocking COMMIT causes an atomic rollback before a later attempt', async () => {
  const prefix = join(tmpdir(), 'vintage-clock-commit-lock-');
  const temp = mkdtempSync(prefix);
  let db, reader;
  try {
    const path = join(temp, 'fixture.sqlite'), now = Date.now();
    const fixture = await setup(path, temp, new Date(now - 60000).toISOString(), new Date(now + 3600000).toISOString());
    db = fixture.db;
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
    assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 0);
    const challenge = issueKioskChallenge(db, fixture.first, 'clock-in', 60);
    const digest = createHash('sha256').update(challenge).digest('hex');
    reader = new DatabaseSync(path);
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) AS n FROM history').get();
    let commitErrorCode = null;
    const originalExec = db.exec.bind(db);
    db.exec = (statement) => {
      try { return originalExec(statement); }
      catch (error) { if (statement === 'COMMIT') commitErrorCode = error.errcode; throw error; }
    };
    try {
      assert.throws(() => confirmScheduledAttendance(db, identity('example-user'), challenge, 'clock-in',
        { shiftId: 'shift-a', expectedRevision: 1 }, policy), (error) => error.message === 'Scheduled attendance failed');
      assert.equal(commitErrorCode, 5);
      assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM history').get().n, 0);
      assert.equal(reader.prepare('SELECT used_at FROM kiosk_challenges WHERE digest=?').get(digest).used_at, null);
    } finally { reader.exec('ROLLBACK'); }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM history').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scheduled_attendance_events').get().n, 0);
    assert.equal(db.prepare('SELECT used_at FROM kiosk_challenges WHERE digest=?').get(digest).used_at, null);
    assert.ok(confirmScheduledAttendance(db, identity('example-user'), challenge, 'clock-in', { shiftId: 'shift-a', expectedRevision: 1 }, policy).recordId);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM history').get().n, 1);
  } finally {
    if (reader?.isOpen) reader.close();
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
