import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureOrigin, fixtureSession, handleFixtureSession, fixtureResumePath } from './fixture-session.mjs';
const origin = 'http://127.0.0.1:3829';
const env = { NODE_ENV: 'development', VINTAD3E_LIBRARY_FIXTURE: '1' };
test('resume accepts internal paths only', () => {
  assert.equal(fixtureResumePath('/documents?tab=all'), '/documents?tab=all');
  for (const path of ['//example.invalid/', '/\\example.invalid/', '/auth/session-resume', 'https://example.invalid/', undefined]) assert.equal(fixtureResumePath(path), '/');
});
function post(action, headers = {}) { return new Request(`${origin}/api/fixture/${action}`, { method: 'POST', headers: { host: '127.0.0.1:3829', origin, ...headers } }); }
function cookie(response) { return response.headers.get('set-cookie').split(';')[0]; }
test('login returns only to a known synthetic publication', () => {
  const path = '/publications/00000000-0000-4000-8000-000000000001';
  assert.equal(handleFixtureSession(post('login'), 'login', env, 1000, path).headers.get('location'), path);
  assert.equal(handleFixtureSession(post('login'), 'login', env, 1000, '/mypage').headers.get('location'), '/mypage');
  assert.equal(handleFixtureSession(post('login'), 'login', env, 1000, '//example.invalid/').headers.get('location'), '/');
});

test('fixture login and logout rotate and revoke only local synthetic sessions', () => {
  assert.equal(fixtureOrigin(env), origin);
  const first = handleFixtureSession(post('login'), 'login', env, 1000);
  assert.equal(first.status, 303); const firstCookie = cookie(first);
  assert.equal(fixtureSession(firstCookie, '127.0.0.1:3829', env, 1001), true);
  assert.equal(fixtureSession(`${firstCookie}; ${firstCookie}`, '127.0.0.1:3829', env, 1001), false);
  assert.equal(fixtureSession(firstCookie, 'example.invalid', env, 1001), false);
  const second = handleFixtureSession(post('login', { cookie: firstCookie }), 'login', env, 1002);
  const secondCookie = cookie(second);
  assert.notEqual(firstCookie, secondCookie);
  assert.equal(fixtureSession(firstCookie, '127.0.0.1:3829', env, 1003), false);
  assert.equal(fixtureSession(secondCookie, '127.0.0.1:3829', env, 1003), true);
  assert.equal(handleFixtureSession(post('logout', { cookie: secondCookie }), 'logout', env, 1004).status, 303);
  assert.equal(fixtureSession(secondCookie, '127.0.0.1:3829', env, 1005), false);
});

test('fixture login only returns to known fixture paths', () => {
  assert.equal(handleFixtureSession(post('login'), 'login', env, 1000, '/confirmations/proposal-01').headers.get('location'), '/confirmations/proposal-01');
  assert.equal(handleFixtureSession(post('login'), 'login', env, 1000, '/confirmations/00000000-0000-4000-8000-000000000004').headers.get('location'), '/confirmations/00000000-0000-4000-8000-000000000004');
  assert.equal(handleFixtureSession(post('login'), 'login', env, 1000, '/confirmations/00000000-0000-4000-8000-000000000004?next=//example.invalid').headers.get('location'), '/');
  assert.equal(handleFixtureSession(post('login'), 'login', env, 1000, '/objects/new').headers.get('location'), '/objects/new');
  assert.equal(handleFixtureSession(post('login'), 'login', env, 1000, '/objects/00000000-0000-4000-8000-000000000003').headers.get('location'), '/objects/00000000-0000-4000-8000-000000000003');
  assert.equal(handleFixtureSession(post('login'), 'login', env, 1000, '/objects/00000000-0000-4000-8000-000000000009').headers.get('location'), '/objects/00000000-0000-4000-8000-000000000009');
  assert.equal(handleFixtureSession(post('login'), 'login', env, 1000, '/objects/00000000-0000-4000-8000-000000000011').headers.get('location'), '/objects/00000000-0000-4000-8000-000000000011');
  assert.equal(handleFixtureSession(post('login'), 'login', env, 1000, '/objects/00000000-0000-4000-8000-000000000108').headers.get('location'), '/objects/00000000-0000-4000-8000-000000000108');
  assert.equal(handleFixtureSession(post('login'), 'login', env, 1000, '/objects/00000000-0000-4000-8000-000000000108?next=//example.invalid').headers.get('location'), '/');
  assert.equal(handleFixtureSession(post('login'), 'login', env, 1000, '/objects/unknown').headers.get('location'), '/');
  for (const next of ['/members', '/meetings/00000000-0000-4000-8000-000000000004']) assert.equal(handleFixtureSession(post('login'), 'login', env, 1000, next).headers.get('location'), next);
  assert.equal(handleFixtureSession(post('login'), 'login', env, 1000, '/meetings/unknown').headers.get('location'), '/');
  for (const next of ['/ir/00000000-0000-4000-8000-000000000001', '/native/00000000-0000-4000-8000-000000000001']) assert.equal(handleFixtureSession(post('login'), 'login', env, 1000, next).headers.get('location'), next);
  assert.equal(handleFixtureSession(post('login'), 'login', env, 1000, '/ir/unknown').headers.get('location'), '/');
  for (const next of ['//example.invalid/', '/confirmations/other', 'https://example.invalid/']) {
    assert.equal(handleFixtureSession(post('login'), 'login', env, 1000, next).headers.get('location'), '/');
  }
});

test('fixture cannot activate in production or accept nonlocal and cross-origin requests', () => {
  const production = { ...env, NODE_ENV: 'production' };
  assert.equal(fixtureOrigin(production), null);
  assert.equal(handleFixtureSession(post('login'), 'login', production).status, 404);
  assert.equal(handleFixtureSession(post('login', { origin: 'https://other.invalid' }), 'login', env).status, 403);
  assert.equal(handleFixtureSession(post('login', { host: 'example.invalid' }), 'login', env).status, 403);
  const normalized = new Request('http://localhost:3829/api/fixture/login', { method: 'POST', headers: { host: '127.0.0.1:3829', origin } });
  assert.equal(handleFixtureSession(normalized, 'login', env).status, 303);
  assert.equal(fixtureOrigin({ ...env, VINTAD3E_LIBRARY_FIXTURE_ORIGIN: 'http://example.invalid:3829' }), null);
  const response = handleFixtureSession(post('login'), 'login', env, 1000);
  assert.equal(fixtureSession(cookie(response), '127.0.0.1:3829', env, 1000 + 30 * 60 * 1000), false);
});
