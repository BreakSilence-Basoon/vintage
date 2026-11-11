import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserAuth } from '../src/browser.mjs';

const origin = 'https://app.example.invalid';
const binding = 'a'.repeat(43);
const id = 'b'.repeat(43);
const oldId = 'c'.repeat(43);
const token = 'synthetic-access-token';
const cookie = (name, value) => `__Host-vintage-${name}=${value}`;
const request = (path, options = {}) => new Request(origin + path, options);

function fixture() {
  const active = new Map([[oldId, { accessToken: token }]]);
  const calls = [];
  const flow = {
    async begin(options) { calls.push(options); return { authorizationUrl: 'https://id.example.invalid/authorize', browserBinding: binding }; },
    async finish(url, received) { assert.equal(url, `${origin}/auth/callback?code=example&state=example`); assert.equal(received, binding); return { accessToken: token, expiresAt: Date.now() + 60000 }; },
  };
  const sessions = {
    async issue(result) { active.set(id, result); return id; },
    async get(value) { return active.get(value) ?? null; },
    revoke(value) { return active.delete(value); },
  };
  return { auth: createBrowserAuth({ publicOrigin: origin, flow, sessions }), active, calls };
}

test('browser login uses protected cookies, rotates the session and never returns the access token', async () => {
  const { auth, active, calls } = fixture();
  const start = await auth.handleAuth(request('/auth/start-write'));
  assert.equal(start.status, 302);
  assert.equal(start.headers.get('location'), 'https://id.example.invalid/authorize');
  assert.deepEqual(calls, [{ write: true }]);
  assert.match(start.headers.get('set-cookie'), /Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=300/);
  const callback = await auth.handleAuth(request('/auth/callback?code=example&state=example', { headers: { cookie: `${cookie('login', binding)}; ${cookie('session', oldId)}` } }));
  assert.equal(callback.status, 200);
  assert.equal(active.has(oldId), false);
  const cookies = callback.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  assert.ok(cookies.some((value) => value.startsWith(cookie('session', id))));
  assert.ok(!(await callback.text()).includes(token));
  assert.equal(callback.headers.get('cache-control'), 'no-store');
  const authorized = await auth.authorize(request('/records', { headers: { cookie: cookie('session', id) } }));
  assert.equal(authorized.request.headers.get('authorization'), `Bearer ${token}`);
  assert.equal(authorized.request.headers.has('cookie'), false);
});

test('rejects ambiguous cookies, mixed credentials and cross-origin changes', async () => {
  const { auth, active } = fixture();
  const duplicate = `${cookie('session', oldId)}; ${cookie('session', oldId)}`;
  assert.equal((await auth.authorize(request('/records', { headers: { cookie: duplicate } }))).response.status, 400);
  assert.equal((await auth.authorize(request('/records', { headers: { cookie: cookie('session', oldId), authorization: 'Bearer example' } }))).response.status, 400);
  assert.equal((await auth.authorize(request('/records', { method: 'POST', headers: { cookie: cookie('session', oldId), origin: 'https://other.example.invalid' } }))).response.status, 403);
  assert.ok((await auth.authorize(request('/records', { method: 'POST', headers: { cookie: cookie('session', oldId), origin } }))).request);
  assert.equal((await auth.handleAuth(request('/auth/logout', { method: 'POST', headers: { cookie: cookie('session', oldId), origin: 'https://other.example.invalid' } }))).status, 403);
  assert.equal(active.has(oldId), true);
  assert.equal((await auth.handleAuth(request('/auth/logout', { method: 'POST', headers: { cookie: duplicate, origin } }))).status, 400);
  const logout = await auth.handleAuth(request('/auth/logout', { method: 'POST', headers: { cookie: cookie('session', oldId), origin } }));
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await auth.authorize(request('/records', { headers: { cookie: cookie('session', oldId) } }))).response.status, 401);
});

test('rejects invalid login bindings and leaves bearer-only requests unchanged', async () => {
  const { auth, active } = fixture();
  const result = await auth.handleAuth(request('/auth/callback?code=example&state=example', { headers: { cookie: `${cookie('login', binding)}; ${cookie('session', oldId)}; ${cookie('session', oldId)}` } }));
  assert.equal(result.status, 401);
  assert.equal(active.has(id), false);
  const direct = request('/records', { headers: { authorization: 'Bearer example' } });
  assert.equal((await auth.authorize(direct)).request, direct);
  assert.throws(() => createBrowserAuth({ publicOrigin: 'http://app.example.invalid' }), /Invalid browser/);
});
