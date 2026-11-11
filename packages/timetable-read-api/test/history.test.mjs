import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT } from 'jose';
import { createAccessTokenVerifier } from '@vintage/access-token';
import { createHistoryHandler } from '../src/index.mjs';

const issuer = 'https://identity.example.invalid';
const audience = 'https://api.example.invalid';
const keys = await generateKeyPair('RS256');
const otherKeys = await generateKeyPair('RS256');
const verifier = createAccessTokenVerifier({
  issuer, audience, clientIds: ['example-client'], requiredScopes: ['timetable:access'],
  keyResolver: async () => keys.publicKey,
});
async function token(subject, key = keys.privateKey) {
  return new SignJWT({ iss: issuer, aud: audience, sub: subject, jti: 'example-token',
    client_id: 'example-client', scope: 'timetable:access' })
    .setIssuedAt().setExpirationTime('5m').setProtectedHeader({ alg: 'RS256', typ: 'at+jwt' }).sign(key);
}
const memberships = {
  'example-person-a': { businessId: 'shop-a', staffId: 'staff-a', role: 'VIEWER', active: true },
  'example-manager': { businessId: 'shop-a', staffId: 'staff-b', role: 'ADMIN', active: true },
  'example-inactive': { businessId: 'shop-a', staffId: 'staff-a', role: 'VIEWER', active: false },
};
const records = {
  'record-a': { id: 'record-a', businessId: 'shop-a', staffId: 'staff-a', startsAt: '2026-01-01T09:00:00.000Z', endsAt: null, internalField: 'not-returned' },
  'record-b': { id: 'record-b', businessId: 'shop-a', staffId: 'staff-b', startsAt: '2026-01-01T09:00:00.000Z', endsAt: null },
  'record-other': { id: 'record-other', businessId: 'shop-b', staffId: 'staff-a', startsAt: '2026-01-01T09:00:00.000Z', endsAt: null },
};
const adapters = {
  verifyAuthorization: verifier,
  // Deliberately returns a cross-business record to test the policy as a second boundary.
  findAccessAndHistory: async (iss, sub, recordId) => ({
    actor: iss === issuer ? memberships[sub] : undefined, record: records[recordId],
  }),
};
const handler = createHistoryHandler(adapters);
const call = async (subject, path, extra = {}, key) => handler(new Request(`https://api.example.invalid${path}`, {
  headers: { authorization: `Bearer ${await token(subject, key)}`, ...extra },
}));

test('verified employee reads only their own record, with no private extra fields', async () => {
  const response = await call('example-person-a', '/v1/history/record-a');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { id: 'record-a', startsAt: '2026-01-01T09:00:00.000Z', endsAt: null });
  assert.equal((await call('example-person-a', '/v1/history/record-b', { 'x-role': 'ADMIN' })).status, 404);
});

test('manager can read same-business records; cross-business record is denied', async () => {
  assert.equal((await call('example-manager', '/v1/history/record-a')).status, 200);
  assert.equal((await call('example-manager', '/v1/history/record-other')).status, 404);
  assert.equal((await call('example-manager', '/v1/history/missing')).status, 404);
});

test('rejects unsigned, forged, missing, and inactive identities', async () => {
  assert.equal((await handler(new Request('https://api.example.invalid/v1/history/record-a'))).status, 401);
  assert.equal((await call('example-person-a', '/v1/history/record-a', {}, otherKeys.privateKey)).status, 401);
  assert.equal((await call('example-inactive', '/v1/history/record-a')).status, 404);
  assert.equal((await call('example-unknown', '/v1/history/record-a')).status, 404);
});

test('fails closed when trusted adapters fail or required adapters are missing', async () => {
  assert.throws(() => createHistoryHandler({}));
  const unavailable = createHistoryHandler({ ...adapters, findAccessAndHistory: async () => { throw new Error('internal detail'); } });
  const response = await unavailable(new Request('https://api.example.invalid/v1/history/record-a', {
    headers: { authorization: `Bearer ${await token('example-person-a')}` },
  }));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'unavailable' });
});
