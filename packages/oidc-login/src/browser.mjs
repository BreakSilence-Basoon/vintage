const loginCookie = '__Host-vintage-login';
const sessionCookie = '__Host-vintage-session';
const cookieValue = /^[A-Za-z0-9_-]{43}$/;
const secureCookie = (name, value, maxAge) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
const reply = (status, body, headers = new Headers()) => {
  headers.set('Cache-Control', 'no-store');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  return Response.json(body, { status, headers });
};

// Undefined means absent; null means malformed or duplicated.
function readCookie(header, name) {
  if (!header) return undefined;
  const values = header.split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (!values.length) return undefined;
  if (values.length !== 1) return null;
  const value = values[0].slice(name.length + 1);
  return cookieValue.test(value) ? value : null;
}

export function createBrowserAuth({ publicOrigin, flow, sessions } = {}) {
  let origin;
  try { origin = new URL(publicOrigin); } catch { throw new Error('Invalid public origin'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
      typeof publicOrigin !== 'string' || publicOrigin !== origin.origin ||
      typeof flow?.begin !== 'function' || typeof flow?.finish !== 'function' ||
      typeof sessions?.issue !== 'function' || typeof sessions?.get !== 'function' || typeof sessions?.revoke !== 'function') {
    throw new Error('Invalid browser authentication configuration');
  }
  const callbackPath = '/auth/callback';
  const allowedOrigin = origin.origin;
  return {
    async handleAuth(request) {
      const url = new URL(request.url);
      if ((url.pathname === '/auth/start' || url.pathname === '/auth/start-write') && request.method === 'GET' && !url.search) {
        try {
          const started = await flow.begin({ write: url.pathname === '/auth/start-write' });
          const destination = new URL(started.authorizationUrl);
          if (destination.protocol !== 'https:' || destination.username || destination.password || !cookieValue.test(started.browserBinding)) throw new Error('Invalid login start');
          const headers = new Headers({ Location: started.authorizationUrl, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
          headers.append('Set-Cookie', secureCookie(loginCookie, started.browserBinding, 300));
          return new Response(null, { status: 302, headers });
        } catch { return reply(503, { error: 'unavailable' }); }
      }
      if (url.pathname === callbackPath && request.method === 'GET') {
        const headers = new Headers();
        headers.append('Set-Cookie', secureCookie(loginCookie, '', 0));
        try {
          const binding = readCookie(request.headers.get('cookie'), loginCookie);
          const old = readCookie(request.headers.get('cookie'), sessionCookie);
          if (!binding || old === null) throw new Error('Invalid login cookie');
          const callback = new URL(callbackPath + url.search, allowedOrigin);
          const result = await flow.finish(callback.href, binding);
          const session = await sessions.issue(result);
          if (old) sessions.revoke(old);
          const seconds = Math.max(0, Math.floor((Math.min(result.expiresAt, Date.now() + 900000) - Date.now()) / 1000));
          headers.append('Set-Cookie', secureCookie(sessionCookie, session, seconds));
          return reply(200, { ok: true }, headers);
        } catch { return reply(401, { error: 'login_failed' }, headers); }
      }
      if (url.pathname === '/auth/logout' && request.method === 'POST') {
        if (request.headers.get('origin') !== allowedOrigin) return reply(403, { error: 'forbidden' });
        const session = readCookie(request.headers.get('cookie'), sessionCookie);
        if (session === null) return reply(400, { error: 'invalid_request' });
        if (session) sessions.revoke(session);
        const headers = new Headers();
        headers.append('Set-Cookie', secureCookie(sessionCookie, '', 0));
        return reply(200, { ok: true }, headers);
      }
      if (url.pathname.startsWith('/auth/')) return reply(404, { error: 'not_found' });
      return null;
    },
    async authorize(request) {
      const session = readCookie(request.headers.get('cookie'), sessionCookie);
      if (session === undefined) return { request };
      if (!session || request.headers.has('authorization')) return { response: reply(400, { error: 'invalid_request' }) };
      if (request.method !== 'GET' && request.method !== 'HEAD' && request.headers.get('origin') !== allowedOrigin) {
        return { response: reply(403, { error: 'forbidden' }) };
      }
      const current = await sessions.get(session);
      if (!current) return { response: reply(401, { error: 'unauthorized' }) };
      const headers = new Headers(request.headers);
      headers.delete('cookie');
      headers.set('authorization', `Bearer ${current.accessToken}`);
      return { request: new Request(request, { headers }) };
    },
  };
}
