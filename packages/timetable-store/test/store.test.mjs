import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTimetableStore, initializeTimetableStore } from '../src/index.mjs';
import { createHistoryHandler } from '@vintage/timetable-read-api';
import { createAccessTokenVerifier } from '@vintage/access-token';
import { generateKeyPair, SignJWT } from 'jose';

const fixture = (db) => {
  db.prepare('INSERT INTO businesses (id) VALUES (?)').run('shop-a');
  db.prepare('INSERT INTO businesses (id) VALUES (?)').run('shop-b');
  for (const business of ['shop-a', 'shop-b']) {
    db.prepare('INSERT INTO staff (business_id,id) VALUES (?,?)').run(business, 'staff-a');
    db.prepare('INSERT INTO history (business_id,id,staff_id,starts_at,ends_at) VALUES (?,?,?,?,?)')
      .run(business, 'record-a', 'staff-a', business === 'shop-a' ? '2026-01-01T09:00:00.000Z' : '2026-01-02T09:00:00.000Z', null);
  }
  db.prepare('INSERT INTO memberships (issuer,subject,business_id,staff_id,role,active) VALUES (?,?,?,?,?,?)')
    .run('https://identity.example.invalid', 'example-person', 'shop-a', 'staff-a', 'VIEWER', 1);
  db.prepare('INSERT INTO memberships (issuer,subject,business_id,staff_id,role,active) VALUES (?,?,?,?,?,?)')
    .run('https://identity.example.invalid', 'example-other', 'shop-b', 'staff-a', 'VIEWER', 1);
  db.prepare('INSERT INTO staff (business_id,id) VALUES (?,?)').run('shop-a', 'staff-b');
  db.prepare('INSERT INTO memberships (issuer,subject,business_id,staff_id,role,active) VALUES (?,?,?,?,?,?)')
    .run('https://identity.example.invalid', 'example-manager', 'shop-a', 'staff-b', 'ADMIN', 1);
};

test('persists isolated records across database reopen and applies server authorization', async () => {
  const prefix = join(tmpdir(), 'vintage-store-');
  const temp = mkdtempSync(prefix);
  let db;
  try {
    const path = join(temp, 'fixture.sqlite');
    db = new DatabaseSync(path);
    initializeTimetableStore(db);
    fixture(db);
    db.close();
    db = new DatabaseSync(path);
    const store = createTimetableStore(db);
    const first = await store.findAccessAndHistory('https://identity.example.invalid', 'example-person', 'record-a');
    const second = await store.findAccessAndHistory('https://identity.example.invalid', 'example-other', 'record-a');
    assert.equal(first.actor.businessId, 'shop-a');
    assert.equal(first.record.businessId, 'shop-a');
    assert.equal(second.record.businessId, 'shop-b');
    assert.equal(second.record.startsAt, '2026-01-02T09:00:00.000Z');
    assert.equal(await store.findAccessAndHistory('https://identity.example.invalid', 'example-person', 'missing'), null);
    const handler = createHistoryHandler({
      ...store, verifyAuthorization: async () => ({ issuer: 'https://identity.example.invalid', subject: 'example-person' }),
    });
    const response = await handler(new Request('https://api.example.invalid/v1/history/record-a'));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id: 'record-a', startsAt: '2026-01-01T09:00:00.000Z', endsAt: null });
    db.prepare('UPDATE memberships SET active = 0 WHERE subject = ?').run('example-person');
    assert.equal((await handler(new Request('https://api.example.invalid/v1/history/record-a'))).status, 404);
  } finally {
    if (db?.isOpen) db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path');
    rmSync(temp, { recursive: true, force: true });
  }
});

test('refuses uninitialized and previously initialized databases without resetting data', () => {
  const db = new DatabaseSync(':memory:');
  try {
    assert.throws(() => createTimetableStore(db));
    initializeTimetableStore(db);
    fixture(db);
    assert.throws(() => initializeTimetableStore(db), /not empty/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM history').get().count, 2);
    assert.throws(() => db.prepare('INSERT INTO history (business_id,id,staff_id,starts_at) VALUES (?,?,?,?)')
      .run('shop-a', 'record-invalid', 'missing-staff', '2026-01-01T09:00:00.000Z'));
  } finally { db.close(); }
});

test('signed token, current membership, and stored record are checked together', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    initializeTimetableStore(db);
    fixture(db);
    const issuer = 'https://identity.example.invalid';
    const keys = await generateKeyPair('RS256');
    const signed = await new SignJWT({ iss: issuer, aud: 'example-api', sub: 'example-person',
      client_id: 'example-client', jti: 'example-token', scope: 'timetable:access' })
      .setIssuedAt().setExpirationTime('5m').setProtectedHeader({ alg: 'RS256', typ: 'at+jwt' }).sign(keys.privateKey);
    const verifyAuthorization = createAccessTokenVerifier({ issuer, audience: 'example-api',
      clientIds: ['example-client'], requiredScopes: ['timetable:access'], keyResolver: async () => keys.publicKey });
    const handler = createHistoryHandler({ ...createTimetableStore(db), verifyAuthorization });
    const request = () => new Request('https://api.example.invalid/v1/history/record-a', { headers: { authorization: `Bearer ${signed}` } });
    assert.equal((await handler(request())).status, 200);
    db.prepare('UPDATE memberships SET active = 0 WHERE subject = ?').run('example-person');
    assert.equal((await handler(request())).status, 404);
    const managerToken = await new SignJWT({ iss: issuer, aud: 'example-api', sub: 'example-manager',
      client_id: 'example-client', jti: 'example-token-2', scope: 'timetable:access' })
      .setIssuedAt().setExpirationTime('5m').setProtectedHeader({ alg: 'RS256', typ: 'at+jwt' }).sign(keys.privateKey);
    const managerRequest = () => new Request('https://api.example.invalid/v1/history/record-a', { headers: { authorization: `Bearer ${managerToken}` } });
    assert.equal((await handler(managerRequest())).status, 200);
    db.prepare('UPDATE memberships SET role = ? WHERE subject = ?').run('VIEWER', 'example-manager');
    assert.equal((await handler(managerRequest())).status, 404);
  } finally { db.close(); }
});
