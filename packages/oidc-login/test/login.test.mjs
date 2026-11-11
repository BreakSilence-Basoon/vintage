import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccessTokenVerifier } from '@vintage/access-token';
import { createLoginFlow } from '../src/index.mjs';

const issuer = 'https://identity.example.invalid/';
const redirectUri = 'https://app.example.invalid/auth/callback';
const audience = 'https://api.example.invalid';
const fakeCredential = ['example', 'credential'].join('-');
const keys = await generateKeyPair('RS256', { extractable: true });
const otherKeys = await generateKeyPair('RS256');
const publicKey = { ...await exportJWK(keys.publicKey), kid: 'fixture-key', use: 'sig', alg: 'RS256' };
const verifyAccessToken = createAccessTokenVerifier({ issuer, audience, clientIds: ['example-client'],
  requiredScopes: ['timetable:access'], keyResolver: createLocalJWKSet({ keys: [publicKey] }) });
const verifyWriteAccessToken = createAccessTokenVerifier({ issuer, audience, clientIds: ['example-client'],
  requiredScopes: ['timetable:access', 'timetable:write'], keyResolver: createLocalJWKSet({ keys: [publicKey] }) });

function fakeProvider({ badNonce = false, mismatchedSubject = false, badSignature = false, noPkce = false, noWriteScope = false, badTokenType = false, shortAccess = false } = {}) {
  let nonce, challenge, tokenRequests = 0;
  const json = (body, status = 200) => Response.json(body, { status });
  const fetchImplementation = async (url, options = {}) => {
    const target = String(url);
    if (target === `${issuer}.well-known/openid-configuration`) return json({
      issuer, authorization_endpoint: `${issuer}authorize`, token_endpoint: `${issuer}token`, jwks_uri: `${issuer}jwks`,
      response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: ['client_secret_post'], code_challenge_methods_supported: noPkce ? [] : ['S256'],
    });
    if (target === `${issuer}jwks`) return json({ keys: [publicKey] });
    if (target === `${issuer}token`) {
      tokenRequests++;
      const body = new URLSearchParams(options.body.toString());
      const expected = createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url');
      if (body.get('code') !== 'example-code' || expected !== challenge || body.get('client_id') !== 'example-client' ||
          body.get('client_secret') !== fakeCredential) return json({ error: 'invalid_grant' }, 400);
      const now = Math.floor(Date.now() / 1000);
      const idToken = await new SignJWT({ iss: issuer, sub: 'example-user', aud: 'example-client',
        iat: now, exp: now + 300, nonce: badNonce ? 'wrong-nonce' : nonce })
        .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key', typ: 'JWT' }).sign(badSignature ? otherKeys.privateKey : keys.privateKey);
      const accessToken = await new SignJWT({ iss: issuer, sub: mismatchedSubject ? 'example-other' : 'example-user', aud: audience,
        iat: now, exp: now + (shortAccess ? 10 : 300), jti: 'example-token', client_id: 'example-client', scope: noWriteScope ? 'timetable:access' : 'timetable:access timetable:write' })
        .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key', typ: 'at+jwt' }).sign(keys.privateKey);
      return json({ token_type: badTokenType ? 'DPoP' : 'Bearer', expires_in: 300, access_token: accessToken, id_token: idToken });
    }
    throw new Error('Unexpected provider endpoint');
  };
  return {
    fetchImplementation,
    observe(url) { const parsed = new URL(url); nonce = parsed.searchParams.get('nonce'); challenge = parsed.searchParams.get('code_challenge'); },
    tokenRequests() { return tokenRequests; },
  };
}

async function flow(provider) {
  return createLoginFlow({ issuer, clientId: 'example-client', clientSecret: fakeCredential, redirectUri, audience,
    readScope: 'timetable:access', writeScope: 'timetable:write', verifyAccessToken, verifyWriteAccessToken, fetchImplementation: provider.fetchImplementation });
}
const callback = (url) => `${redirectUri}?code=example-code&state=${encodeURIComponent(new URL(url).searchParams.get('state'))}`;

test('PKCE login binds browser, verifies both tokens, and consumes the state once', async () => {
  const provider = fakeProvider();
  const login = await flow(provider);
  const started = await login.begin();
  provider.observe(started.authorizationUrl);
  const authorization = new URL(started.authorizationUrl);
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorization.searchParams.get('scope'), 'openid timetable:access');
  assert.equal(authorization.searchParams.has('client_secret'), false);
  assert.match(started.browserBinding, /^[A-Za-z0-9_-]{43}$/);
  await assert.rejects(login.finish(callback(started.authorizationUrl), 'x'.repeat(43)), /Login failed/);
  await assert.rejects(login.finish(callback(started.authorizationUrl).replace('app.example.invalid', 'other.example.invalid'), started.browserBinding), /Login failed/);
  assert.equal(provider.tokenRequests(), 0);
  const result = await login.finish(callback(started.authorizationUrl), started.browserBinding);
  assert.equal(result.identity.subject, 'example-user');
  assert.ok(result.expiresAt > Date.now() && result.expiresAt <= Date.now() + 300000);
  await assert.rejects(login.finish(callback(started.authorizationUrl), started.browserBinding), /Login failed/);
  assert.equal(provider.tokenRequests(), 1);
});

test('rejects wrong nonce, mismatched identities, and forged ID token', async () => {
  for (const option of [{ badNonce: true }, { mismatchedSubject: true }, { badSignature: true }, { noWriteScope: true }, { badTokenType: true }]) {
    const provider = fakeProvider(option);
    const login = await flow(provider);
    const started = await login.begin({ write: true });
    provider.observe(started.authorizationUrl);
    assert.equal(new URL(started.authorizationUrl).searchParams.get('scope'), 'openid timetable:access timetable:write');
    await assert.rejects(login.finish(callback(started.authorizationUrl), started.browserBinding), /Login failed/);
    await assert.rejects(login.finish(callback(started.authorizationUrl), started.browserBinding), /Login failed/);
    assert.equal(provider.tokenRequests(), 1);
  }
});

test('rejects duplicate callback parameters and consumes concurrent successful callbacks once', async () => {
  const provider = fakeProvider();
  const login = await flow(provider);
  const started = await login.begin();
  provider.observe(started.authorizationUrl);
  await assert.rejects(login.finish(`${callback(started.authorizationUrl)}&state=other`, started.browserBinding), /Login failed/);
  const outcomes = await Promise.allSettled([login.finish(callback(started.authorizationUrl), started.browserBinding), login.finish(callback(started.authorizationUrl), started.browserBinding)]);
  assert.deepEqual(outcomes.map((item) => item.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(provider.tokenRequests(), 1);
});

test('requires HTTPS configuration and a provider advertising PKCE S256', async () => {
  const provider = fakeProvider({ noPkce: true });
  await assert.rejects(flow(provider));
  await assert.rejects(createLoginFlow({ issuer: 'http://identity.example.invalid' }));
  await assert.rejects(createLoginFlow({ issuer, clientId: 'example-client', clientSecret: fakeCredential, redirectUri: 'http://app.example.invalid/callback',
    audience, readScope: 'timetable:access', verifyAccessToken, fetchImplementation: provider.fetchImplementation }));
  await assert.rejects(createLoginFlow({ issuer, clientId: 'example-client', clientSecret: fakeCredential, redirectUri,
    audience, readScope: 'timetable:access', writeScope: 'timetable:write', verifyAccessToken, fetchImplementation: provider.fetchImplementation }));
  await assert.rejects(createLoginFlow({ issuer, clientId: 'example-client', clientSecret: fakeCredential, redirectUri,
    audience: 'urn:example:api', readScope: 'timetable:access', verifyAccessToken, fetchImplementation: provider.fetchImplementation }));
  await assert.rejects(createLoginFlow({ issuer, clientId: 'example-client', clientSecret: fakeCredential, redirectUri,
    audience, readScope: 'openid', verifyAccessToken, fetchImplementation: provider.fetchImplementation }));
  await assert.rejects(createLoginFlow({ issuer, clientId: 'example-client', clientSecret: fakeCredential, redirectUri,
    audience, readScope: 'timetable:access', verifyAccessToken,
    fetchImplementation: async () => { throw new Error('sensitive-example-detail'); } }),
  (error) => error.message === 'Provider discovery failed' && error.cause === undefined);
});

test('does not accept a verifier result for a different client', async () => {
  const provider = fakeProvider();
  const login = await createLoginFlow({ issuer, clientId: 'example-client', clientSecret: fakeCredential, redirectUri, audience,
    readScope: 'timetable:access', fetchImplementation: provider.fetchImplementation,
    verifyAccessToken: async () => ({ issuer, subject: 'example-user', clientId: 'example-other', expiresAt: Date.now() + 300000 }) });
  const started = await login.begin();
  provider.observe(started.authorizationUrl);
  await assert.rejects(login.finish(callback(started.authorizationUrl), started.browserBinding), /Login failed/);
});

test('expires an unused login before exchanging a code', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const provider = fakeProvider();
  const login = await flow(provider);
  const started = await login.begin();
  provider.observe(started.authorizationUrl);
  t.mock.timers.tick(300001);
  await assert.rejects(login.finish(callback(started.authorizationUrl), started.browserBinding), /Login failed/);
  assert.equal(provider.tokenRequests(), 0);
});

test('does not extend a shorter signed access token lifetime', async () => {
  const provider = fakeProvider({ shortAccess: true });
  const login = await flow(provider);
  const started = await login.begin();
  provider.observe(started.authorizationUrl);
  const result = await login.finish(callback(started.authorizationUrl), started.browserBinding);
  assert.ok(result.expiresAt > Date.now() && result.expiresAt <= Date.now() + 10000);
});
