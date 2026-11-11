import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { initializeTimetableStore } from '@vintage/timetable-store';
import { migrateWithBackup } from '@vintage/timetable-store/operations';
import { prepareService } from '../src/main.mjs';

test('restore preparation CLI creates a new protected-state copy without printing identities', async () => {
  const prefix = join(tmpdir(), 'vintage-restore-cli-');
  const temp = mkdtempSync(prefix);
  let db, service;
  try {
    const source = join(temp, 'source.sqlite'), output = join(temp, 'prepared.sqlite');
    db = new DatabaseSync(source);
    initializeTimetableStore(db);
    db.prepare('INSERT INTO businesses (id) VALUES (?)').run('shop-a');
    db.prepare('INSERT INTO staff (business_id,id) VALUES (?,?)').run('shop-a', 'staff-a');
    db.prepare('INSERT INTO staff (business_id,id) VALUES (?,?)').run('shop-a', 'staff-b');
    db.prepare('INSERT INTO memberships (issuer,subject,business_id,staff_id,role,active) VALUES (?,?,?,?,?,1)')
      .run('https://identity.example.invalid', 'example-user', 'shop-a', 'staff-a', 'ADMIN');
    db.prepare('INSERT INTO memberships (issuer,subject,business_id,staff_id,role,active) VALUES (?,?,?,?,?,1)')
      .run('https://identity.example.invalid', 'example-viewer', 'shop-a', 'staff-b', 'VIEWER');
    db.prepare('INSERT INTO history (business_id,id,staff_id,starts_at,ends_at) VALUES (?,?,?,?,?)')
      .run('shop-a', 'record-b', 'staff-b', '2026-01-01T09:00:00.000Z', null);
    db.close();
    for (const version of [1,2,3,4,5,6,7,8,9,10]) await migrateWithBackup(source, join(temp, `backup-v${version}.sqlite`));
    const keys = await generateKeyPair('RS256', { extractable: true });
    const publicKey = { ...await exportJWK(keys.publicKey), kid: 'fixture-key', alg: 'RS256', use: 'sig' };
    const keyFile = join(temp, 'keys.json');
    writeFileSync(keyFile, JSON.stringify({ keys: [publicKey] }));
    const signed = (subject = 'example-user') => new SignJWT({ iss: 'https://identity.example.invalid', sub: subject, aud: 'example-api',
      jti: 'example-token', client_id: 'example-client', scope: 'timetable:access timetable:write' })
      .setIssuedAt().setExpirationTime('5m').setProtectedHeader({ alg: 'RS256', kid: 'fixture-key', typ: 'at+jwt' }).sign(keys.privateKey);
    const oldToken = await signed();
    const oldViewer = await signed('example-viewer');
    const cli = fileURLToPath(new URL('../src/prepare-restore.mjs', import.meta.url));
    const run = () => spawnSync(process.execPath, [cli], { encoding: 'utf8',
      env: { ...process.env, VINTAGE_BACKUP_FILE: source, VINTAGE_PREPARED_RESTORE_FILE: output } });
    const result = run();
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout + result.stderr, /example-user|example-viewer|shop-a|staff-a|staff-b/);
    assert.ok(existsSync(output));
    db = new DatabaseSync(output, { readOnly: true });
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 13);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE active=1').get().n, 0);
    const cutoff = db.prepare('SELECT token_valid_after FROM memberships WHERE subject=?').get('example-user').token_valid_after;
    assert.ok(cutoff > 0);
    db.close();
    assert.notEqual(run().status, 0);
    const config = { VINTAGE_ISSUER: 'https://identity.example.invalid', VINTAGE_AUDIENCE: 'example-api',
      VINTAGE_CLIENT_ID: 'example-client', VINTAGE_REQUIRED_SCOPE: 'timetable:access', VINTAGE_WRITE_SCOPE: 'timetable:write',
      VINTAGE_ENABLE_WRITES: 'true', VINTAGE_JWKS_FILE: keyFile, VINTAGE_DATABASE_FILE: output, VINTAGE_PORT: '3004' };
    assert.throws(() => prepareService(config), /Recovery authority review required/);
    db = new DatabaseSync(output);
    db.prepare('UPDATE memberships SET active=1 WHERE subject=?').run('example-user');
    db.close();
    assert.throws(() => prepareService(config), /Recovery authority review required/);
    const unlockCli = fileURLToPath(new URL('../src/recover-admin.mjs', import.meta.url));
    const unlock = (subject) => spawnSync(process.execPath, [unlockCli], { encoding: 'utf8',
      input: JSON.stringify({ issuer: 'https://identity.example.invalid', subject, reason: 'Example verification' }),
      env: { ...process.env, VINTAGE_PREPARED_RESTORE_FILE: output } });
    assert.notEqual(unlock('example-other').status, 0);
    assert.notEqual(unlock('example-user').status, 0);
    db = new DatabaseSync(output);
    db.prepare('UPDATE memberships SET active=0 WHERE subject=?').run('example-user');
    db.close();
    assert.throws(() => prepareService(config), /Recovery authority review required/);
    const unlocked = unlock('example-user');
    assert.equal(unlocked.status, 0);
    assert.doesNotMatch(unlocked.stdout + unlocked.stderr, /example-user|shop-a|staff-a/);
    assert.notEqual(unlock('example-user').status, 0);
    db = new DatabaseSync(output, { readOnly: true });
    const recoveredCutoff = db.prepare('SELECT token_valid_after FROM memberships WHERE subject=?').get('example-user').token_valid_after;
    assert.equal(db.prepare('SELECT active FROM memberships WHERE subject=?').get('example-viewer').active, 0);
    db.close();
    service = prepareService(config);
    service.server.listen(0, '127.0.0.1');
    await once(service.server, 'listening');
    const staffUrl = `http://127.0.0.1:${service.server.address().port}/v1/admin/staff`;
    assert.equal((await fetch(staffUrl, { headers: { authorization: `Bearer ${oldToken}` } })).status, 404);
    const deadline = Date.now() + 3000;
    while (Math.floor(Date.now() / 1000) < recoveredCutoff && Date.now() < deadline) await new Promise((done) => setTimeout(done, 30));
    assert.ok(Math.floor(Date.now() / 1000) >= recoveredCutoff);
    const freshToken = await signed();
    assert.equal((await fetch(staffUrl, { headers: { authorization: `Bearer ${freshToken}` } })).status, 200);
    const reactivate = await fetch(`http://127.0.0.1:${service.server.address().port}/v1/admin/viewers/reactivate`, { method: 'POST',
      headers: { authorization: `Bearer ${freshToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ staffId: 'staff-b', reason: 'Example verification' }) });
    assert.equal(reactivate.status, 200);
    const recordUrl = `http://127.0.0.1:${service.server.address().port}/v1/history/record-b`;
    assert.equal((await fetch(recordUrl, { headers: { authorization: `Bearer ${oldViewer}` } })).status, 404);
    const viewerCutoff = service.db.prepare('SELECT token_valid_after FROM memberships WHERE subject=?').get('example-viewer').token_valid_after;
    const viewerDeadline = Date.now() + 3000;
    while (Math.floor(Date.now() / 1000) < viewerCutoff && Date.now() < viewerDeadline) await new Promise((done) => setTimeout(done, 30));
    assert.ok(Math.floor(Date.now() / 1000) >= viewerCutoff);
    assert.equal((await fetch(recordUrl, { headers: { authorization: `Bearer ${await signed('example-viewer')}` } })).status, 200);
    db = new DatabaseSync(source, { readOnly: true });
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 11);
  } finally {
    if (service?.server.listening) await new Promise((done) => service.server.close(done));
    if (service?.db.isOpen) service.db.close();
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});
