import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT } from 'jose';
import { createLedgerAccessCheck } from '../src/index.mjs';

const issuer = 'https://identity.example.invalid', audience = 'https://api.example.invalid';
const keys = await generateKeyPair('RS256'), otherKeys = await generateKeyPair('RS256');
const now = Math.floor(Date.now() / 1000);
const baseMember = { issuer, subject: 'example-user', businessId: 'example-shop', actorId: 'example-actor', active: true, read: true, write: true, tokenValidAfter: 0 };
const baseConfig = { issuer, audience, clientIds: ['example-client'], businessId: 'example-shop', readScope: 'ledger:read', writeScope: 'ledger:write',
  keyResolver: async () => keys.publicKey, lookupMembership: async () => ({ ...baseMember }) };
async function token(overrides = {}, key = keys.privateKey) {
  return new SignJWT({ iss: issuer, sub: 'example-user', aud: audience, iat: now, exp: now + 300, jti: 'example-token',
    client_id: 'example-client', scope: 'ledger:read ledger:write', ...overrides }).setProtectedHeader({ alg: 'RS256', typ: 'at+jwt' }).sign(key);
}

test('requires a signed token and current explicit permissions for each action', async () => {
  let member = { ...baseMember }, calls = 0;
  const check = createLedgerAccessCheck({ ...baseConfig, lookupMembership: async (identity) => {
    calls++; assert.deepEqual(identity, { issuer, subject: 'example-user' }); return { ...member };
  } });
  const header = `Bearer ${await token()}`;
  assert.equal((await check(header, 'read')).actorId, 'example-actor');
  assert.equal((await check(header, 'write')).businessId, 'example-shop');
  member.write = false;
  assert.ok(await check(header, 'read'));
  assert.equal(await check(header, 'write'), null);
  member.active = false;
  assert.equal(await check(header, 'read'), null);
  assert.equal(calls, 5);
  assert.equal(await check(header, 'delete'), null);
  assert.equal(calls, 5);
});

test('rejects wrong signature, claims, scopes and stale or unrelated membership', async () => {
  const check = createLedgerAccessCheck(baseConfig);
  for (const signed of [await token({}, otherKeys.privateKey), await token({ aud: 'other-audience' }),
    await token({ iss: 'https://other.example.invalid' }), await token({ exp: now - 1 }),
    await token({ client_id: 'other-client' }), await token({ scope: 'ledger:read' })]) {
    assert.equal(await check(`Bearer ${signed}`, 'write'), null);
  }
  const header = `Bearer ${await token()}`;
  for (const change of [{ businessId: 'other-shop' }, { subject: 'other-user' }, { issuer: 'https://other.example.invalid' },
    { actorId: '' }, { active: false }, { read: false }, { write: false }, { tokenValidAfter: now + 1 }, { tokenValidAfter: null }]) {
    const scoped = createLedgerAccessCheck({ ...baseConfig, lookupMembership: async () => ({ ...baseMember, ...change }) });
    assert.equal(await scoped(header, 'write'), null);
  }
  assert.equal(await check(`Bearer ${await token({ scope: 'ledger:read' })}`, 'read') !== null, true);
});

test('lookup failures and a token expiring during lookup fail closed without echoing credentials', async (t) => {
  const header = `Bearer ${await token()}`;
  const broken = createLedgerAccessCheck({ ...baseConfig, lookupMembership: async () => { throw new Error('example-secret'); } });
  assert.equal(await broken(header, 'read'), null);
  assert.equal(await broken('invalid', 'read'), null);
  t.mock.timers.enable({ apis: ['Date'] });
  const expiring = createLedgerAccessCheck({ ...baseConfig, lookupMembership: async () => {
    t.mock.timers.tick(301000); return { ...baseMember };
  } });
  assert.equal(await expiring(header, 'read'), null);
});

test('requires distinct configured read and write scopes and an authoritative lookup', () => {
  for (const change of [{ readScope: 'same', writeScope: 'same' }, { readScope: '' }, { writeScope: 'two scopes' },
    { businessId: '' }, { lookupMembership: undefined }, { issuer: 'http://identity.example.invalid' }, { keyResolver: undefined }]) {
    assert.throws(() => createLedgerAccessCheck({ ...baseConfig, ...change }));
  }
});
