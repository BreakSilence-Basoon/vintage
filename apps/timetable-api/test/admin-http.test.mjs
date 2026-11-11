import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { migrateWithBackup } from '@vintage/timetable-store/operations';
import { initializeNewDatabase } from '../src/init-db.mjs';
import { prepareService } from '../src/main.mjs';

test('opt-in write HTTP enforces scope, current admin role, tenant and audit', async () => {
  const prefix = join(tmpdir(), 'vintage-admin-http-');
  const temp = mkdtempSync(prefix);
  let writer, service;
  try {
    const database = join(temp, 'fixture.sqlite');
    const issuer = 'https://identity.example.invalid';
    initializeNewDatabase(database, { issuer, subject: 'example-admin', businessId: 'shop-a', staffId: 'admin-a' });
    await migrateWithBackup(database, join(temp, 'v1-backup.sqlite'));
    await migrateWithBackup(database, join(temp, 'v2-backup.sqlite'));
    writer = new DatabaseSync(database);
    writer.prepare('INSERT INTO businesses (id) VALUES (?)').run('shop-b');
    writer.prepare('INSERT INTO staff (business_id,id) VALUES (?,?)').run('shop-b', 'foreign-staff');
    const keys = await generateKeyPair('RS256', { extractable: true });
    const publicKey = { ...await exportJWK(keys.publicKey), kid: 'fixture-key', alg: 'RS256', use: 'sig' };
    const keyFile = join(temp, 'fixture-public-keys.json');
    writeFileSync(keyFile, JSON.stringify({ keys: [publicKey] }));
    const config = { VINTAGE_ISSUER: issuer, VINTAGE_AUDIENCE: 'example-api', VINTAGE_CLIENT_ID: 'example-client',
      VINTAGE_REQUIRED_SCOPE: 'timetable:access', VINTAGE_WRITE_SCOPE: 'timetable:write', VINTAGE_ENABLE_WRITES: 'true',
      VINTAGE_JWKS_FILE: keyFile, VINTAGE_DATABASE_FILE: database, VINTAGE_PORT: '3004' };
    assert.throws(() => prepareService({ ...config, VINTAGE_WRITE_SCOPE: 'timetable:access' }));
    assert.throws(() => prepareService({ ...config, VINTAGE_ENABLE_WRITES: 'yes' }));
    writer.exec('PRAGMA user_version = 2');
    assert.throws(() => prepareService(config), /Migration required/);
    writer.exec('PRAGMA user_version = 3');
    service = prepareService(config);
    service.server.listen(0, '127.0.0.1');
    await once(service.server, 'listening');
    const base = `http://127.0.0.1:${service.server.address().port}`;
    const signed = async (sub, scope) => new SignJWT({ iss: issuer, aud: 'example-api', sub, jti: 'example-token',
      client_id: 'example-client', scope }).setIssuedAt().setExpirationTime('5m')
      .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'fixture-key' }).sign(keys.privateKey);
    const admin = await signed('example-admin', 'timetable:access timetable:write');
    const readOnlyAdmin = await signed('example-admin', 'timetable:access');
    const viewer = await signed('example-viewer', 'timetable:access timetable:write');
    const post = (path, bearer, body, extra = {}) => fetch(base + path, { method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json; charset=utf-8', ...extra }, body: JSON.stringify(body) });
    assert.equal((await post('/v1/admin/viewers', readOnlyAdmin, { staffId: 'staff-a', subject: 'example-viewer' })).status, 401);
    const created = await post('/v1/admin/viewers', admin, { staffId: 'staff-a', subject: 'example-viewer' });
    assert.equal(created.status, 200);
    assert.equal(created.headers.get('cache-control'), 'no-store');
    assert.equal(created.headers.get('access-control-allow-origin'), null);
    const record = { staffId: 'staff-a', recordId: 'record-a', startsAt: '2026-01-01T09:00:00.000Z', endsAt: null };
    assert.equal((await post('/v1/admin/history', viewer, record, { 'x-role': 'ADMIN' })).status, 403);
    assert.equal((await post('/v1/admin/history', admin, { ...record, businessId: 'shop-b' })).status, 400);
    const foreign = await post('/v1/admin/history', admin, { ...record, staffId: 'foreign-staff' });
    assert.equal(foreign.status, 503);
    assert.deepEqual(await foreign.json(), { error: 'unavailable' });
    assert.equal((await post('/v1/admin/history', admin, record, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await post('/v1/admin/history', admin, record)).status, 200);
    assert.equal((await fetch(base + '/v1/history/record-a', { headers: { authorization: `Bearer ${viewer}` } })).status, 200);
    assert.equal((await post('/v1/admin/viewers/deactivate', admin, { staffId: 'staff-a' })).status, 200);
    assert.equal((await fetch(base + '/v1/history/record-a', { headers: { authorization: `Bearer ${viewer}` } })).status, 404);
    assert.equal(writer.prepare('SELECT COUNT(*) AS count FROM authenticated_audit_events').get().count, 3);
    assert.equal(writer.prepare('SELECT COUNT(*) AS count FROM authenticated_audit_events WHERE actor_staff_id = ?').get('admin-a').count, 3);
    writer.prepare('UPDATE memberships SET role = ? WHERE subject = ?').run('VIEWER', 'example-admin');
    assert.equal((await post('/v1/admin/viewers', admin, { staffId: 'staff-b', subject: 'example-other' })).status, 403);
    assert.equal(writer.prepare('SELECT COUNT(*) AS count FROM authenticated_audit_events').get().count, 3);
  } finally {
    if (service?.server.listening) await new Promise((close) => service.server.close(close));
    if (service?.db.isOpen) service.db.close();
    if (writer?.isOpen) writer.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});
