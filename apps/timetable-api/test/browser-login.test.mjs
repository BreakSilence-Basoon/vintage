import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { initializeTimetableStore } from '@vintage/timetable-store';
import { migrateWithBackup } from '@vintage/timetable-store/operations';
import { prepareBrowserService } from '../src/main.mjs';
import { createLoopbackServer } from '../src/server.mjs';

const issuer = 'https://identity.example.invalid/';
const publicOrigin = 'https://app.example.invalid';
const audience = 'https://api.example.invalid';
const credential = ['synthetic', 'credential'].join('-');

test('read-only browser mode permits empty logout without permitting other POST requests', async () => {
  const server = createLoopbackServer(async () => Response.json({ ok: true }), { browserLogin: true });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${base}/auth/logout`, { method: 'POST' })).status, 200);
    assert.equal((await fetch(`${base}/auth/logout`, { method: 'POST', body: 'x' })).status, 400);
    assert.equal((await fetch(`${base}/v1/admin/viewers`, { method: 'POST', body: '{}' })).status, 400);
  } finally {
    if (server.listening) await new Promise((done) => server.close(done));
  }
});

test('fake OIDC login reaches HTTP authorization, honors current membership and logs out', async () => {
  const prefix = join(tmpdir(), 'vintage-browser-test-');
  const temp = mkdtempSync(prefix);
  let writer, service;
  try {
    const database = join(temp, 'fixture.sqlite');
    writer = new DatabaseSync(database);
    initializeTimetableStore(writer);
    writer.prepare('INSERT INTO businesses (id) VALUES (?)').run('shop-a');
    writer.prepare('INSERT INTO staff (business_id,id) VALUES (?,?)').run('shop-a', 'staff-a');
    writer.prepare('INSERT INTO memberships (issuer,subject,business_id,staff_id,role,active) VALUES (?,?,?,?,?,?)').run(issuer, 'example-user', 'shop-a', 'staff-a', 'VIEWER', 1);
    writer.prepare('INSERT INTO history (business_id,id,staff_id,starts_at,ends_at) VALUES (?,?,?,?,?)').run('shop-a', 'record-a', 'staff-a', '2026-01-01T09:00:00.000Z', null);
    writer.close();
    await migrateWithBackup(database, join(temp, 'backup-v1.sqlite'));
    await migrateWithBackup(database, join(temp, 'backup-v2.sqlite'));
    await migrateWithBackup(database, join(temp, 'backup-v3.sqlite'));
    await migrateWithBackup(database, join(temp, 'backup-v4.sqlite'));
    await migrateWithBackup(database, join(temp, 'backup-v5.sqlite'));
    await migrateWithBackup(database, join(temp, 'backup-v6.sqlite'));
    await migrateWithBackup(database, join(temp, 'backup-v7.sqlite'));
    await migrateWithBackup(database, join(temp, 'backup-v8.sqlite'));
    await migrateWithBackup(database, join(temp, 'backup-v9.sqlite'));
    await migrateWithBackup(database, join(temp, 'backup-v10.sqlite'));
    writer = new DatabaseSync(database);
    const keys = await generateKeyPair('RS256', { extractable: true });
    const publicKey = { ...await exportJWK(keys.publicKey), kid: 'fixture-key', alg: 'RS256', use: 'sig' };
    const keyFile = join(temp, 'keys.json');
    const secretFile = join(temp, 'secret.txt');
    writeFileSync(keyFile, JSON.stringify({ keys: [publicKey] }));
    writeFileSync(secretFile, credential);
    let nonce, challenge, scope;
    const provider = async (url, options = {}) => {
      const target = String(url);
      if (target === `${issuer}.well-known/openid-configuration`) return Response.json({ issuer,
        authorization_endpoint: `${issuer}authorize`, token_endpoint: `${issuer}token`, jwks_uri: `${issuer}jwks`,
        response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'], code_challenge_methods_supported: ['S256'] });
      if (target === `${issuer}jwks`) return Response.json({ keys: [publicKey] });
      if (target === `${issuer}token`) {
        const body = new URLSearchParams(options.body.toString());
        assert.equal(body.get('code'), 'example-code');
        assert.equal(body.get('client_secret'), credential);
        assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), challenge);
        const now = Math.floor(Date.now() / 1000);
        const idToken = await new SignJWT({ iss: issuer, sub: 'example-user', aud: 'example-client', iat: now, exp: now + 300, nonce })
          .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key', typ: 'JWT' }).sign(keys.privateKey);
        const accessToken = await new SignJWT({ iss: issuer, sub: 'example-user', aud: audience, iat: now, exp: now + 300,
          jti: 'example-token', client_id: 'example-client', scope })
          .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key', typ: 'at+jwt' }).sign(keys.privateKey);
        return Response.json({ token_type: 'Bearer', expires_in: 300, access_token: accessToken, id_token: idToken });
      }
      throw new Error('Unexpected provider endpoint');
    };
    const config = { VINTAGE_ISSUER: issuer, VINTAGE_AUDIENCE: audience, VINTAGE_CLIENT_ID: 'example-client',
      VINTAGE_REQUIRED_SCOPE: 'timetable:access', VINTAGE_JWKS_FILE: keyFile, VINTAGE_DATABASE_FILE: database,
      VINTAGE_PORT: '3004', VINTAGE_PUBLIC_ORIGIN: publicOrigin, VINTAGE_CLIENT_SECRET_FILE: secretFile,
      VINTAGE_ENABLE_WRITES: 'true', VINTAGE_WRITE_SCOPE: 'timetable:write' };
    service = await prepareBrowserService(config, { fetchImplementation: provider });
    service.server.listen(0, '127.0.0.1');
    await once(service.server, 'listening');
    const base = `http://127.0.0.1:${service.server.address().port}`;
    const start = await fetch(`${base}/auth/start`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    const authorization = new URL(start.headers.get('location'));
    nonce = authorization.searchParams.get('nonce');
    challenge = authorization.searchParams.get('code_challenge');
    scope = authorization.searchParams.get('scope');
    const binding = start.headers.getSetCookie()[0].split(';')[0];
    const callbackUrl = `${base}/auth/callback?code=example-code&state=${encodeURIComponent(authorization.searchParams.get('state'))}`;
    const callback = await fetch(callbackUrl, { headers: { cookie: binding } });
    assert.equal(callback.status, 200);
    const cookies = callback.headers.getSetCookie();
    assert.equal(cookies.length, 2);
    const session = cookies.find((value) => value.startsWith('__Host-vintage-session=')).split(';')[0];
    assert.equal((await fetch(callbackUrl, { headers: { cookie: binding } })).status, 401);
    const headers = { cookie: session };
    assert.equal((await fetch(`${base}/v1/history/record-a`, { headers })).status, 200);
    const own = await (await fetch(`${base}/v1/me/history`, { headers })).json();
    assert.deepEqual(own.records.map((item) => item.id), ['record-a']);
    const adminPost = (cookieValue, origin) => fetch(`${base}/v1/admin/viewers`, { method: 'POST',
      headers: { cookie: cookieValue, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ staffId: 'staff-b', subject: 'example-other' }) });
    assert.equal((await adminPost(session, publicOrigin)).status, 401);
    const writeStart = await fetch(`${base}/auth/start-write`, { redirect: 'manual' });
    const writeAuthorization = new URL(writeStart.headers.get('location'));
    nonce = writeAuthorization.searchParams.get('nonce');
    challenge = writeAuthorization.searchParams.get('code_challenge');
    scope = writeAuthorization.searchParams.get('scope');
    const writeBinding = writeStart.headers.getSetCookie()[0].split(';')[0];
    const writeCallback = await fetch(`${base}/auth/callback?code=example-code&state=${encodeURIComponent(writeAuthorization.searchParams.get('state'))}`,
      { headers: { cookie: `${writeBinding}; ${session}` } });
    assert.equal(writeCallback.status, 200);
    const writeSession = writeCallback.headers.getSetCookie().find((value) => value.startsWith('__Host-vintage-session=')).split(';')[0];
    assert.equal((await fetch(`${base}/v1/history/record-a`, { headers })).status, 401);
    assert.equal((await adminPost(writeSession, 'https://other.example.invalid')).status, 403);
    assert.equal((await adminPost(writeSession, publicOrigin)).status, 403);
    writer.prepare('UPDATE memberships SET role = ? WHERE subject = ?').run('ADMIN', 'example-user');
    assert.equal((await adminPost(writeSession, publicOrigin)).status, 200);
    const close = await fetch(`${base}/v1/admin/history/close`, { method: 'POST',
      headers: { cookie: writeSession, origin: publicOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ recordId: 'record-a', endsAt: '2026-01-01T10:00:00.000Z' }) });
    assert.equal(close.status, 200);
    const schedulePost = (route, data) => fetch(`${base}${route}`, { method: 'POST',
      headers: { cookie: writeSession, origin: publicOrigin, 'content-type': 'application/json' }, body: JSON.stringify(data) });
    assert.equal((await schedulePost('/v1/admin/locations', { locationId: 'location-a', label: 'Example location' })).status, 200);
    assert.equal((await schedulePost('/v1/admin/shifts', { shiftId: 'shift-a', staffId: 'staff-a', locationId: 'location-a', startsAt: '2026-01-01T09:00:00.000Z', endsAt: '2026-01-01T17:00:00.000Z', graceMinutes: 0 })).status, 200);
    assert.equal((await schedulePost('/v1/admin/shifts/cancel', { shiftId: 'shift-a', expectedRevision: 1, reason: 'Example cancellation' })).status, 200);
    assert.equal((await schedulePost('/v1/admin/shifts/restore', { shiftId: 'shift-a', expectedRevision: 2, reason: 'Example restore' })).status, 200);
    assert.equal((await schedulePost('/v1/admin/shifts/copy', { sourceShiftId: 'shift-a', sourceRevision: 3, shiftId: 'shift-copy', startsAt: '2026-01-02T09:00:00.000Z', endsAt: '2026-01-02T17:00:00.000Z' })).status, 200);
    const adminScheduleQuery = new URLSearchParams({ from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z' });
    assert.deepEqual((await (await fetch(`${base}/v1/admin/shifts?${adminScheduleQuery}`, { headers: { cookie: writeSession } })).json()).shifts.map((item) => item.id), ['shift-a']);
    writer.prepare('UPDATE memberships SET role = ? WHERE subject = ?').run('VIEWER', 'example-user');
    assert.equal((await adminPost(writeSession, publicOrigin)).status, 403);
    const writeHeaders = { cookie: writeSession };
    const scheduleQuery = new URLSearchParams({ from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z' });
    assert.deepEqual((await (await fetch(`${base}/v1/me/shifts?${scheduleQuery}`, { headers: writeHeaders })).json()).shifts.map((item) => item.id), ['shift-a']);
    assert.equal((await fetch(`${base}/v1/admin/shifts?${scheduleQuery}`, { headers: writeHeaders })).status, 404);
    assert.equal((await fetch(`${base}/auth/logout`, { method: 'POST', headers: { ...writeHeaders, origin: 'https://other.example.invalid' } })).status, 403);
    writer.prepare('UPDATE memberships SET active = 0 WHERE subject = ?').run('example-user');
    assert.equal((await fetch(`${base}/v1/history/record-a`, { headers: writeHeaders })).status, 404);
    assert.equal((await fetch(`${base}/v1/me/history`, { headers: writeHeaders })).status, 404);
    assert.equal((await fetch(`${base}/v1/me/shifts?${scheduleQuery}`, { headers: writeHeaders })).status, 404);
    writer.prepare('UPDATE memberships SET active = 1, token_valid_after = ? WHERE subject = ?')
      .run(Math.floor(Date.now() / 1000) + 1, 'example-user');
    assert.equal((await fetch(`${base}/v1/me/history`, { headers: writeHeaders })).status, 404);
    const logout = await fetch(`${base}/auth/logout`, { method: 'POST', headers: { ...writeHeaders, origin: publicOrigin } });
    assert.equal(logout.status, 200);
    assert.equal((await fetch(`${base}/v1/history/record-a`, { headers: writeHeaders })).status, 401);
  } finally {
    if (service?.server.listening) await new Promise((done) => service.server.close(done));
    if (service?.db.isOpen) service.db.close();
    if (writer?.isOpen) writer.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});
