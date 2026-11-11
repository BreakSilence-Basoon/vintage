import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT, generateKeyPair } from 'jose';
import { createAccessTokenVerifier } from '../src/index.mjs';

const issuer = 'https://identity.example.invalid';
const audience = 'https://api.example.invalid';
const keyPair = await generateKeyPair('RS256');
const wrongKey = await generateKeyPair('RS256');
const config = {
  issuer, audience, clientIds: ['example-client'], requiredScopes: ['timetable:access'],
  keyResolver: async () => keyPair.publicKey,
};
const verify = createAccessTokenVerifier(config);
const now = Math.floor(Date.now() / 1000);

async function token(overrides = {}, header = {}, key = keyPair.privateKey) {
  const claims = {
    iss: issuer, sub: 'example-subject', aud: audience, iat: now, exp: now + 300,
    jti: 'example-token', client_id: 'example-client', scope: 'timetable:access', ...overrides,
  };
  return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', ...header }).sign(key);
}

test('accepts a signed, scoped access token for the configured issuer and client', async () => {
  assert.deepEqual(await verify(`Bearer ${await token()}`), {
    issuer, subject: 'example-subject', clientId: 'example-client',
  });
  assert.ok(await verify(`bearer ${await token({}, { typ: 'application/at+jwt' })}`));
});

test('rejects invalid signatures, issuer, audience, age, type, client, and scope', async () => {
  const invalid = [
    await token({}, {}, wrongKey.privateKey), await token({ iss: 'https://other.example.invalid' }),
    await token({ aud: 'other-audience' }), await token({ exp: now - 1 }),
    await token({ iat: now - 901, exp: now + 300 }), await token({}, { typ: 'JWT' }),
    await token({ client_id: 'other-client' }), await token({ scope: 'unrelated' }),
    await token({ sub: '' }), await token({ jti: '' }), await token({ client_id: '' }),
    await token({ scope: undefined }),
  ];
  for (const value of invalid) assert.equal(await verify(`Bearer ${value}`), null);
});

test('rejects malformed headers without returning token or error details', async () => {
  for (const value of [undefined, null, '', 'Basic abc', 'Bearer abc', 'Bearer x.y.z extra', `Bearer ${'x'.repeat(9000)}`]) {
    assert.equal(await verify(value), null);
  }
});

test('requires complete trusted HTTPS configuration', () => {
  for (const change of [
    { issuer: 'http://identity.example.invalid' }, { issuer: 'https://user@localhost' },
    { issuer: 'https://identity.example.invalid?query=1' }, { audience: '' },
    { clientIds: [] }, { requiredScopes: [] }, { requiredScopes: ['two scopes'] }, { keyResolver: null },
  ]) assert.throws(() => createAccessTokenVerifier({ ...config, ...change }));
});
