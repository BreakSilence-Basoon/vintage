import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccessTokenVerifier } from '@vintage/access-token';
import { createMemorySessionStore } from '../src/session.mjs';

const issuer = 'https://identity.example.invalid/';
const audience = 'https://api.example.invalid';
const keys = await generateKeyPair('RS256', { extractable: true });
const publicKey = { ...await exportJWK(keys.publicKey), kid: 'fixture-key', use: 'sig', alg: 'RS256' };
const verify = createAccessTokenVerifier({ issuer, audience, clientIds: ['example-client'],
  requiredScopes: ['timetable:access'], keyResolver: createLocalJWKSet({ keys: [publicKey] }) });

async function login() {
  const accessToken = await new SignJWT({ iss: issuer, sub: 'example-user', aud: audience,
    jti: 'example-token', client_id: 'example-client', scope: 'timetable:access' })
    .setIssuedAt().setExpirationTime('5m').setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'fixture-key' }).sign(keys.privateKey);
  const identity = await verify(`Bearer ${accessToken}`);
  return { accessToken, identity, expiresAt: identity.expiresAt };
}

test('issues an opaque bounded session and revokes it immediately', async () => {
  const store = createMemorySessionStore({ verifyAccessToken: verify, maxSessions: 1 });
  const result = await login();
  const session = await store.issue(result);
  assert.match(session, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await store.get(session)).identity.subject, 'example-user');
  await assert.rejects(store.issue(result), /capacity/);
  assert.equal(store.revoke(session), true);
  assert.equal(await store.get(session), null);
  assert.equal(store.revoke(session), false);
  const next = await store.issue(result);
  assert.notEqual(next, session);
  assert.equal(store.revoke(next), true);
});

test('rejects malformed, unverified, expired, or mismatched session input', async () => {
  const store = createMemorySessionStore({ verifyAccessToken: verify });
  const result = await login();
  await assert.rejects(store.issue({ ...result, accessToken: 'not-a-token' }), /Invalid session/);
  await assert.rejects(store.issue({ ...result, identity: { ...result.identity, subject: 'example-other' } }), /Invalid session/);
  await assert.rejects(store.issue({ ...result, expiresAt: Date.now() - 1 }), /Invalid session/);
  assert.equal(await store.get('invalid'), null);
  assert.equal(store.revoke('invalid'), false);
});

test('logout during an in-flight verification cannot restore a session', async () => {
  let waiting = false, release, ready;
  const reached = new Promise((resolve) => { ready = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const store = createMemorySessionStore({ verifyAccessToken: async (header) => {
    if (waiting) { ready(); await gate; }
    return verify(header);
  } });
  const session = await store.issue(await login());
  waiting = true;
  const lookup = store.get(session);
  await reached;
  assert.equal(store.revoke(session), true);
  release();
  assert.equal(await lookup, null);
});

test('session expiration cannot exceed the verified token lifetime', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const store = createMemorySessionStore({ verifyAccessToken: verify });
  const result = await login();
  const session = await store.issue({ ...result, expiresAt: Date.now() + 86400000 });
  assert.ok((await store.get(session)).expiresAt <= result.identity.expiresAt);
  t.mock.timers.tick(300001);
  assert.equal(await store.get(session), null);
});
