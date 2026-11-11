import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOwnHistoryHandler } from '../src/index.mjs';

const identity = { issuer: 'https://identity.example.invalid', subject: 'example-user' };
const url = 'https://app.example.invalid/v1/me/history';
const record = { id: 'example-record', startsAt: '2026-01-01T09:00:00.000Z', endsAt: null };

test('only returns approved record fields and passes the verified identity to the store', async () => {
  const handler = createOwnHistoryHandler({ verifyAuthorization: async () => identity,
    findOwnHistory: async (issuer, subject, cursor, limit) => {
      assert.equal(issuer, identity.issuer); assert.equal(subject, identity.subject);
      assert.equal(cursor, null); assert.equal(limit, 51);
      return [{ ...record, privateExtra: 'synthetic-extra' }];
    } });
  const response = await handler(new Request(url));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { records: [record], nextCursor: null });
});

test('fails closed for missing identities, missing memberships and invalid stored data', async () => {
  for (const [verifyAuthorization, findOwnHistory, expected] of [
    [async () => null, async () => [record], 401],
    [async () => identity, async () => null, 404],
    [async () => identity, async () => [{ ...record, startsAt: 'invalid' }], 503],
    [async () => identity, async () => { throw new Error('synthetic detail'); }, 503],
  ]) {
    const handler = createOwnHistoryHandler({ verifyAuthorization, findOwnHistory });
    const response = await handler(new Request(url));
    assert.equal(response.status, expected);
    assert.doesNotMatch(await response.text(), /synthetic detail/);
  }
});
