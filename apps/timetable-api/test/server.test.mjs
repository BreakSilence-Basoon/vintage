import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { initializeTimetableStore } from '@vintage/timetable-store';
import { prepareService } from '../src/main.mjs';
import { initializeNewDatabase } from '../src/init-db.mjs';

test('fails to start without the required explicit configuration', () => {
  assert.throws(() => prepareService({}), /Configuration incomplete/);
});

test('initial setup creates one administrator and refuses to overwrite it', () => {
  const prefix = join(tmpdir(), 'vintage-init-');
  const temp = mkdtempSync(prefix);
  let db;
  try {
    const path = join(temp, 'new.sqlite');
    const fixture = { issuer: 'https://identity.example.invalid', subject: 'example-person', businessId: 'shop-a', staffId: 'staff-a' };
    assert.throws(() => initializeNewDatabase(path, { ...fixture, issuer: 'http://identity.example.invalid' }));
    initializeNewDatabase(path, fixture);
    assert.throws(() => initializeNewDatabase(path, fixture));
    db = new DatabaseSync(path, { readOnly: true });
    assert.deepEqual({ ...db.prepare('SELECT role,active FROM memberships').get() }, { role: 'ADMIN', active: 1 });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM memberships').get().count, 1);
  } finally {
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});

test('initialization command accepts UTF-8 input without printing identifiers', () => {
  const prefix = join(tmpdir(), 'vintage-init-cli-');
  const temp = mkdtempSync(prefix);
  try {
    const path = join(temp, 'new.sqlite');
    const input = { issuer: 'https://identity.example.invalid', subject: 'example-person', businessId: 'shop-a', staffId: 'staff-a' };
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/init-db.mjs', import.meta.url))], {
      input: '\uFEFF' + JSON.stringify(input), encoding: 'utf8', env: { ...process.env, VINTAGE_DATABASE_FILE: path },
    });
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout + result.stderr, /example-person|shop-a|staff-a/);
    const retry = spawnSync(process.execPath, [fileURLToPath(new URL('../src/init-db.mjs', import.meta.url))], {
      input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, VINTAGE_DATABASE_FILE: path },
    });
    assert.notEqual(retry.status, 0);
  } finally {
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});

test('loopback HTTP verifies signed token and current stored employee access', async () => {
  const prefix = join(tmpdir(), 'vintage-api-');
  const temp = mkdtempSync(prefix);
  let writer, service;
  try {
    const database = join(temp, 'fixture.sqlite');
    writer = new DatabaseSync(database);
    initializeTimetableStore(writer);
    writer.prepare('INSERT INTO businesses (id) VALUES (?)').run('shop-a');
    writer.prepare('INSERT INTO staff (business_id,id) VALUES (?,?)').run('shop-a', 'staff-a');
    writer.prepare('INSERT INTO memberships (issuer,subject,business_id,staff_id,role,active) VALUES (?,?,?,?,?,?)')
      .run('https://identity.example.invalid', 'example-person', 'shop-a', 'staff-a', 'VIEWER', 1);
    writer.prepare('INSERT INTO history (business_id,id,staff_id,starts_at,ends_at) VALUES (?,?,?,?,?)')
      .run('shop-a', 'record-a', 'staff-a', '2026-01-01T09:00:00.000Z', null);

    const keys = await generateKeyPair('RS256', { extractable: true });
    const publicKey = { ...await exportJWK(keys.publicKey), kid: 'fixture-key', alg: 'RS256', use: 'sig' };
    const keyFile = join(temp, 'fixture-public-keys.json');
    const config = { VINTAGE_ISSUER: 'https://identity.example.invalid', VINTAGE_AUDIENCE: 'example-api',
      VINTAGE_CLIENT_ID: 'example-client', VINTAGE_REQUIRED_SCOPE: 'timetable:access',
      VINTAGE_JWKS_FILE: keyFile, VINTAGE_DATABASE_FILE: database, VINTAGE_PORT: '3004' };
    writeFileSync(keyFile, JSON.stringify({ keys: [{ ...publicKey, d: 'synthetic-private-field' }] }));
    assert.throws(() => prepareService(config), /Invalid public verification key/);
    writeFileSync(keyFile, JSON.stringify({ keys: [publicKey] }));
    const missing = join(temp, 'missing.sqlite');
    assert.throws(() => prepareService({ ...config, VINTAGE_DATABASE_FILE: missing }));
    assert.equal(existsSync(missing), false);
    service = prepareService(config);
    service.server.listen(0, '127.0.0.1');
    await once(service.server, 'listening');
    const address = service.server.address();
    const url = `http://127.0.0.1:${address.port}/v1/history/record-a`;
    const signed = await new SignJWT({ iss: 'https://identity.example.invalid', aud: 'example-api', sub: 'example-person',
      client_id: 'example-client', jti: 'example-token', scope: 'timetable:access' })
      .setIssuedAt().setExpirationTime('5m').setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'fixture-key' }).sign(keys.privateKey);
    assert.equal((await fetch(url)).status, 401);
    const headers = { authorization: `Bearer ${signed}` };
    const allowed = await fetch(url, { headers });
    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), { id: 'record-a', startsAt: '2026-01-01T09:00:00.000Z', endsAt: null });
    assert.equal((await fetch(url, { method: 'POST', headers, body: 'unexpected' })).status, 400);
    const duplicateStatus = await new Promise((resolveStatus, reject) => {
      const request = httpRequest(url, { headers: ['Authorization', `Bearer ${signed}`, 'Authorization', `Bearer ${signed}`] }, (response) => {
        response.resume();
        resolveStatus(response.statusCode);
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(duplicateStatus, 400);
    writer.prepare('UPDATE memberships SET active = 0 WHERE subject = ?').run('example-person');
    assert.equal((await fetch(url, { headers })).status, 404);
  } finally {
    if (service?.server.listening) await new Promise((resolveClose) => service.server.close(resolveClose));
    if (service?.db.isOpen) service.db.close();
    if (writer?.isOpen) writer.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});
