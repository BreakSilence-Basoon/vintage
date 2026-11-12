import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareLedgerRecovery } from '@vintage/ledger-store/recovery';
import { initializeNewLedgerDatabase } from '../src/init-db.mjs';
import { prepareLedgerService } from '../src/main.mjs';

const issuer = 'https://identity.example.invalid', audience = 'https://api.example.invalid';
const keys = await generateKeyPair('RS256'), otherKeys = await generateKeyPair('RS256');
const grant = { issuer, subject: 'example-user', actorId: 'example-actor', active: true, read: true, write: true, tokenValidAfter: 0, operatorId: 'example-operator', reason: 'Example setup' };
const fact = { id: 'example-a', type: 'invoice-issued', date: '2026-01-01', currency: 'XXX', amountMinor: '100' };
async function signed(overrides = {}, key = keys.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: issuer, sub: 'example-user', aud: audience, iat: now, exp: now + 300, jti: 'example-token', client_id: 'example-client', scope: 'ledger:read ledger:write', ...overrides })
    .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'example-key' }).sign(key);
}
function config(path, keyFile, writes = 'false') {
  return { VINTAGE_LEDGER_DATABASE_FILE: path, VINTAGE_LEDGER_JWKS_FILE: keyFile, VINTAGE_LEDGER_PORT: '3001', VINTAGE_LEDGER_ISSUER: issuer,
    VINTAGE_LEDGER_AUDIENCE: audience, VINTAGE_LEDGER_CLIENT_ID: 'example-client', VINTAGE_LEDGER_BUSINESS_ID: 'example-shop',
    VINTAGE_LEDGER_READ_SCOPE: 'ledger:read', VINTAGE_LEDGER_WRITE_SCOPE: 'ledger:write', VINTAGE_LEDGER_ENABLE_WRITES: writes };
}
async function call(port, path, body, bearer, extra = {}) {
  const data = Buffer.from(JSON.stringify(body));
  return new Promise((done, fail) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path, headers: { 'content-type': 'application/json', 'content-length': data.length,
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...extra } }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('end', () => done({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', fail); req.end(data);
  });
}

test('local initialization creates only a new database and does not print identities', () => {
  const prefix = join(tmpdir(), 'vintage-ledger-init-'), temp = mkdtempSync(prefix);
  let db;
  try {
    const path = join(temp, 'fixture.sqlite'), cli = fileURLToPath(new URL('../src/init-db.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [cli], { input: JSON.stringify({ businessId: 'example-shop', grant }), encoding: 'utf8', env: { ...process.env, VINTAGE_LEDGER_DATABASE_FILE: path } });
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout + result.stderr, /example-user|example-shop|example-actor/);
    assert.throws(() => initializeNewLedgerDatabase(path, { businessId: 'example-shop', grant }));
    db = new DatabaseSync(path, { readOnly: true });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger_authority_grants').get().n, 1);
  } finally { if (db?.isOpen) db.close(); if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path'); rmSync(temp, { recursive: true, force: true }); }
});

test('loopback flow requires a signed token and current grant for create, read, correction and retry', async () => {
  const prefix = join(tmpdir(), 'vintage-ledger-api-'), temp = mkdtempSync(prefix);
  let service;
  try {
    const path = join(temp, 'fixture.sqlite'), keyFile = join(temp, 'keys.json');
    initializeNewLedgerDatabase(path, { businessId: 'example-shop', grant });
    writeFileSync(keyFile, JSON.stringify({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'example-key', alg: 'RS256', use: 'sig' }] }));
    service = prepareLedgerService({ ...config(path, keyFile, 'true'), VINTAGE_LEDGER_HISTORY_SCOPE: 'ledger:history' });
    service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
    const port = service.server.address().port, valid = await signed();
    const input = { operationId: 'operation-a', expectedRevision: 0, fact };
    const first = await call(port, '/v1/facts/write', input, valid);
    assert.equal(first.status, 200); assert.equal(first.body.replayed, false); assert.equal(first.headers['cache-control'], 'no-store');
    assert.equal((await call(port, '/v1/facts/write', input, valid)).body.replayed, true);
    assert.equal((await call(port, '/v1/facts/read', { id: fact.id }, valid)).body.fact.amountMinor, '100');
    const corrected = { operationId: 'operation-b', expectedRevision: 1, fact: { ...fact, amountMinor: '200', description: 'Example paper' } };
    assert.equal((await call(port, '/v1/facts/write', corrected, valid)).body.revision, 2);
    assert.equal((await call(port, '/v1/facts/write', corrected, valid)).body.replayed, true);
    assert.equal((await call(port, '/v1/facts/write', { ...corrected, fact: { ...corrected.fact, description: 'Other item' } }, valid)).status, 503);
    assert.equal((await call(port, '/v1/facts/read', { id: fact.id }, valid)).body.fact.description, 'Example paper');
    const historyToken = await signed({ scope: 'ledger:read ledger:history' });
    assert.equal((await call(port, '/v1/facts/history', { id: fact.id }, valid)).status, 503);
    assert.equal((await call(port, '/v1/facts/history', { id: fact.id }, await signed({ scope: 'ledger:history' }))).status, 503);
    const history = await call(port, '/v1/facts/history', { id: fact.id, limit: 1 }, historyToken);
    assert.equal(history.status, 200); assert.equal(history.headers['cache-control'], 'no-store');
    assert.equal(history.body.items[0].fact.amountMinor, '100'); assert.equal(history.body.nextAfterRevision, 1);
    assert.doesNotMatch(JSON.stringify(history.body), /example-actor|operation-a/);
    const nextHistory = await call(port, '/v1/facts/history', { id: fact.id, afterRevision: 1 }, historyToken);
    assert.equal(nextHistory.body.items[0].fact.amountMinor, '200'); assert.equal(nextHistory.body.nextAfterRevision, null);
    assert.equal(nextHistory.body.items[0].fact.description, 'Example paper');
    assert.equal((await call(port, '/v1/facts/history', { id: fact.id, limit: 101 }, historyToken)).status, 503);
    for (const [id, type, date] of [['example-b','invoice-issued','2026-01-31'], ['example-c','payment-made','2026-01-15'], ['example-d','invoice-issued','2026-02-01']]) {
      const created = { operationId: `create-${id}`, expectedRevision: 0, fact: { ...fact, id, type, date, description: `Example paper ${'界'.repeat(100)}` } };
      assert.equal((await call(port, '/v1/facts/write', created, valid)).status, 200);
    }
    const descriptionFilter = { descriptionContains: 'paper', limit: 1 };
    const descriptionPage = await call(port, '/v1/facts/list', descriptionFilter, valid);
    assert.deepEqual(descriptionPage.body.items.map((item) => item.fact.id), ['example-a']);
    const descriptionNext = await call(port, '/v1/facts/list', { ...descriptionFilter, cursor: descriptionPage.body.nextCursor }, valid);
    assert.deepEqual(descriptionNext.body.items.map((item) => item.fact.id), ['example-b']);
    assert.equal((await call(port, '/v1/facts/list', { ...descriptionFilter, descriptionContains: 'Example', cursor: descriptionPage.body.nextCursor }, valid)).status, 503);
    assert.deepEqual((await call(port, '/v1/facts/list', { descriptionContains: '%' }, valid)).body.items, []);
    assert.equal((await call(port, '/v1/facts/list', { descriptionContains: '' }, valid)).status, 503);
    assert.equal((await call(port, '/v1/facts/list', { descriptionContains: '\ud800' }, valid)).status, 503);
    const longFilter = { descriptionContains: '界'.repeat(100), currency: 'XXX', amountMinor: '100', limit: 1 };
    const longPage = await call(port, '/v1/facts/list', longFilter, valid);
    assert.deepEqual(longPage.body.items.map((item) => item.fact.id), ['example-b']);
    assert.deepEqual((await call(port, '/v1/facts/list', { ...longFilter, cursor: longPage.body.nextCursor }, valid)).body.items.map((item) => item.fact.id), ['example-c']);
    const huge = '9'.repeat(80);
    assert.equal((await call(port, '/v1/facts/write', { operationId: 'create-large', expectedRevision: 0,
      fact: { ...fact, id: 'example-large', date: '2026-03-01', currency: 'YYY', amountMinor: huge } }, valid)).status, 200);
    for (const [suffix, amountMinor] of [['negative', '-100'], ['zero', '0']]) {
      assert.equal((await call(port, '/v1/facts/write', { operationId: `create-${suffix}`, expectedRevision: 0,
        fact: { ...fact, id: `example-${suffix}`, date: '2026-03-01', currency: 'YYY', amountMinor } }, valid)).status, 200);
    }
    const amountFilter = { currency: 'XXX', amountMinor: '100', limit: 1 };
    const amountPage = await call(port, '/v1/facts/list', amountFilter, valid);
    assert.deepEqual(amountPage.body.items.map((item) => item.fact.id), ['example-b']);
    assert.ok(amountPage.body.nextCursor);
    const amountNext = await call(port, '/v1/facts/list', { ...amountFilter, cursor: amountPage.body.nextCursor }, valid);
    assert.deepEqual(amountNext.body.items.map((item) => item.fact.id), ['example-c']);
    assert.equal((await call(port, '/v1/facts/list', { ...amountFilter, amountMinor: '200', cursor: amountPage.body.nextCursor }, valid)).status, 503);
    assert.equal((await call(port, '/v1/facts/list', { ...amountFilter, currency: 'YYY', cursor: amountPage.body.nextCursor }, valid)).status, 503);
    assert.deepEqual((await call(port, '/v1/facts/list', { currency: 'YYY', amountMinor: huge }, valid)).body.items.map((item) => item.fact.id), ['example-large']);
    assert.deepEqual((await call(port, '/v1/facts/list', { currency: 'YYY', amountMinor: '-100' }, valid)).body.items.map((item) => item.fact.id), ['example-negative']);
    assert.deepEqual((await call(port, '/v1/facts/list', { currency: 'YYY', amountMinor: '0' }, valid)).body.items.map((item) => item.fact.id), ['example-zero']);
    assert.deepEqual((await call(port, '/v1/facts/list', { currency: 'XXX', amountMinor: huge }, valid)).body.items, []);
    assert.equal((await call(port, '/v1/facts/list', { amountMinor: '100' }, valid)).status, 503);
    assert.equal((await call(port, '/v1/facts/list', { currency: 'XXX', amountMinor: 100 }, valid)).status, 503);
    assert.equal((await call(port, '/v1/facts/list', { currency: 'XXX', amountMinor: '-0' }, valid)).status, 503);
    const filter = { type: 'invoice-issued', from: '2026-01-01', to: '2026-02-01', limit: 1 };
    const firstPage = await call(port, '/v1/facts/list', filter, valid);
    assert.equal(firstPage.status, 200);
    assert.deepEqual(firstPage.body.items.map((item) => item.fact.id), ['example-a']);
    assert.ok(firstPage.body.nextCursor);
    assert.equal((await call(port, '/v1/facts/list', { ...filter, currency: 'XXX', cursor: firstPage.body.nextCursor }, valid)).status, 503);
    assert.equal(firstPage.headers['cache-control'], 'no-store');
    const secondPage = await call(port, '/v1/facts/list', { ...filter, cursor: firstPage.body.nextCursor }, valid);
    assert.deepEqual(secondPage.body.items.map((item) => item.fact.id), ['example-b']);
    assert.equal(secondPage.body.nextCursor, null);
    assert.equal((await call(port, '/v1/facts/list', { ...filter, type: 'payment-made', cursor: firstPage.body.nextCursor }, valid)).status, 503);
    assert.equal((await call(port, '/v1/facts/list', { limit: 0 }, valid)).status, 503);
    assert.equal((await call(port, '/v1/facts/list', { from: '2026-02-30' }, valid)).status, 503);
    assert.deepEqual((await call(port, '/v1/facts/list', { type: 'example-sensitive-query' }, valid)).body, { error: 'unavailable' });
    assert.equal((await call(port, '/v1/facts/list', { cursor: 'not-valid' }, valid)).status, 503);
    assert.equal((await call(port, '/v1/facts/list', {}, await signed({ sub: 'other-user' }))).status, 503);
    assert.equal((await call(port, '/v1/facts/list', {}, await signed({ scope: 'ledger:read' }))).status, 200);
    for (const id of ['example-0', 'example-z']) {
      assert.equal((await call(port, '/v1/facts/write', { operationId: `create-${id}`, expectedRevision: 0, fact: { ...fact, id } }, valid)).status, 200);
    }
    assert.equal((await call(port, '/v1/facts/write', { operationId: 'move-b', expectedRevision: 1,
      fact: { ...fact, id: 'example-b', date: '2026-02-02' } }, valid)).status, 200);
    assert.equal(Object.hasOwn((await call(port, '/v1/facts/read', { id: 'example-b' }, valid)).body.fact, 'description'), false);
    const changedPage = await call(port, '/v1/facts/list', { ...filter, cursor: firstPage.body.nextCursor }, valid);
    assert.deepEqual(changedPage.body.items.map((item) => item.fact.id), ['example-z']); // Earlier insert is outside this page; changed record left the filter.
    assert.equal((await call(port, '/v1/facts/write', input, await signed({}, otherKeys.privateKey))).status, 503);
    assert.equal((await call(port, '/v1/facts/write', input, await signed({ scope: 'ledger:read' }))).status, 503);
    assert.equal((await call(port, '/v1/facts/read', { id: fact.id }, await signed({ sub: 'other-user' }))).status, 503);
    assert.equal((await call(port, '/v1/facts/read', { id: fact.id }, valid, { origin: 'https://example.invalid' })).status, 400);
    assert.equal((await call(port, '/v1/facts/read', { id: fact.id }, valid, { host: 'example.invalid' })).status, 400);
    assert.equal((await call(port, '/v1/facts/read?example=1', { id: fact.id }, valid)).status, 400);
    assert.equal((await call(port, '/v1/facts/read', { id: fact.id }, null)).status, 400);
    const cli = fileURLToPath(new URL('../src/manage-grant.mjs', import.meta.url)), backup = join(temp, 'before-change.sqlite');
    const result = spawnSync(process.execPath, [cli, 'change'], { input: JSON.stringify({ ...grant, active: false }), encoding: 'utf8',
      env: { ...process.env, VINTAGE_LEDGER_DATABASE_FILE: path, VINTAGE_LEDGER_BACKUP_FILE: backup } });
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout + result.stderr, /example-user|example-shop|example-actor/);
    const snapshot = new DatabaseSync(backup, { readOnly: true });
    try { assert.equal(snapshot.prepare('SELECT active FROM ledger_authority_grants').get().active, 1); } finally { snapshot.close(); }
    assert.equal((await call(port, '/v1/facts/read', { id: fact.id }, valid)).status, 503);
    assert.equal((await call(port, '/v1/facts/history', { id: fact.id }, historyToken)).status, 503);
    assert.equal((await call(port, '/v1/facts/list', { ...filter, cursor: firstPage.body.nextCursor }, valid)).status, 503);
    assert.equal((await call(port, '/v1/facts/write', input, valid)).status, 503);
    assert.equal(service.db.prepare('SELECT COUNT(*) AS n FROM ledger_operations').get().n, 11);
  } finally {
    if (service?.server.listening) { service.server.close(); await once(service.server, 'close'); }
    if (service?.db.isOpen) service.db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path'); rmSync(temp, { recursive: true, force: true });
  }
});

test('read-only is the default and pending recovery cannot start', async () => {
  const prefix = join(tmpdir(), 'vintage-ledger-readonly-'), temp = mkdtempSync(prefix);
  let service;
  try {
    const path = join(temp, 'fixture.sqlite'), keyFile = join(temp, 'keys.json'), recovery = join(temp, 'recovery.sqlite');
    initializeNewLedgerDatabase(path, { businessId: 'example-shop', grant });
    writeFileSync(keyFile, JSON.stringify({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'example-key' }] }));
    const env = config(path, keyFile); delete env.VINTAGE_LEDGER_ENABLE_WRITES;
    service = prepareLedgerService(env); service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
    assert.equal((await call(service.server.address().port, '/v1/facts/history', { id: fact.id }, await signed({ scope: 'ledger:read ledger:history' }))).status, 400);
    assert.equal((await call(service.server.address().port, '/v1/facts/write', { operationId: 'operation-a', expectedRevision: 0, fact }, await signed())).status, 403);
    assert.equal((await call(service.server.address().port, '/v1/facts/read', { id: fact.id }, await signed())).status, 404);
    service.server.close(); await once(service.server, 'close'); service.db.close(); service = null;
    await prepareLedgerRecovery(path, recovery);
    assert.throws(() => prepareLedgerService(config(recovery, keyFile, 'true')));
    assert.throws(() => prepareLedgerService({ ...config(path, keyFile), VINTAGE_LEDGER_BUSINESS_ID: 'other-shop' }));
    writeFileSync(keyFile, JSON.stringify({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'example-key', d: 'example' }] }));
    assert.throws(() => prepareLedgerService(config(path, keyFile)));
  } finally {
    if (service?.server.listening) { service.server.close(); await once(service.server, 'close'); }
    if (service?.db.isOpen) service.db.close();
    if (!resolve(temp).startsWith(resolve(prefix))) throw new Error('Unexpected temporary path'); rmSync(temp, { recursive: true, force: true });
  }
});
