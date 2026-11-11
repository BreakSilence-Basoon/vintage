import { lstatSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createLocalJWKSet } from 'jose';
import { createAccessTokenVerifier } from '@vintage/access-token';
import { createHistoryHandler, createOwnHistoryHandler, createOwnScheduleHandler } from '@vintage/timetable-read-api';
import { createTimetableStore } from '@vintage/timetable-store';
import { createLoopbackServer } from './server.mjs';
import { createAdminHandler } from './admin-handler.mjs';
import { createAdminScheduleList } from './admin-schedule-list.mjs';
import { createAdminStaffList } from './admin-staff-list.mjs';
import { createLoginFlow } from '@vintage/oidc-login';
import { createMemorySessionStore } from '@vintage/oidc-login/session';
import { createBrowserAuth } from '@vintage/oidc-login/browser';

function publicKeys(path) {
  if (!isAbsolute(path) || statSync(path).size > 1024 * 1024) throw new Error('Invalid key file');
  const jwks = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(jwks?.keys) || !jwks.keys.length || jwks.keys.length > 20) throw new Error('Invalid key set');
  const ids = new Set();
  for (const key of jwks.keys) {
    if (key?.kty !== 'RSA' || typeof key.kid !== 'string' || !key.kid || ids.has(key.kid) ||
        typeof key.n !== 'string' || typeof key.e !== 'string' ||
        ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'].some((name) => name in key) ||
        (key.use && key.use !== 'sig') || (key.alg && key.alg !== 'RS256') ||
        (key.key_ops && (!Array.isArray(key.key_ops) || key.key_ops.length !== 1 || key.key_ops[0] !== 'verify'))) {
      throw new Error('Invalid public verification key');
    }
    ids.add(key.kid);
  }
  return createLocalJWKSet(jwks);
}

export function prepareService(env, { browserAuth = null } = {}) {
  const { VINTAGE_ISSUER: issuer, VINTAGE_AUDIENCE: audience, VINTAGE_CLIENT_ID: client,
    VINTAGE_REQUIRED_SCOPE: scope, VINTAGE_JWKS_FILE: keyFile, VINTAGE_DATABASE_FILE: databaseFile,
    VINTAGE_PORT: portText, VINTAGE_ENABLE_WRITES: writesText, VINTAGE_WRITE_SCOPE: writeScope } = env;
  if (!keyFile || !databaseFile || !isAbsolute(databaseFile) || !/^\d{1,5}$/.test(portText ?? '')) {
    throw new Error('Configuration incomplete');
  }
  const port = Number(portText);
  if (port < 1 || port > 65535) throw new Error('Invalid port');
  if (writesText !== undefined && writesText !== 'false' && writesText !== 'true') throw new Error('Invalid write setting');
  const allowWrites = writesText === 'true';
  if (allowWrites && (!writeScope || writeScope === scope)) throw new Error('Distinct write scope required');
  const keyResolver = publicKeys(keyFile);
  const verifyAuthorization = createAccessTokenVerifier({ issuer, audience, clientIds: [client],
    requiredScopes: [scope], keyResolver });
  const verifyWriteAuthorization = allowWrites ? createAccessTokenVerifier({ issuer, audience, clientIds: [client],
    requiredScopes: [scope, writeScope], keyResolver }) : null;
  if (allowWrites && !lstatSync(databaseFile).isFile()) throw new Error('Existing regular database required');
  const db = new DatabaseSync(databaseFile, { readOnly: !allowWrites });
  try {
    const store = createTimetableStore(db);
    const read = createHistoryHandler({ ...store, verifyAuthorization });
    const readOwn = createOwnHistoryHandler({ ...store, verifyAuthorization });
    const readSchedule = createOwnScheduleHandler({ ...store, verifyAuthorization });
    if (allowWrites && ![3, 4, 5, 6, 7, 8, 9, 10, 11].includes(db.prepare('PRAGMA user_version').get().user_version)) throw new Error('Migration required');
    const write = allowWrites ? createAdminHandler({ db, verifyWriteAuthorization }) : null;
    const listSchedules = allowWrites ? createAdminScheduleList({ db, verifyWriteAuthorization }) : null;
    const listStaff = allowWrites ? createAdminStaffList({ db, verifyWriteAuthorization }) : null;
    const handle = async (request) => {
      if (browserAuth) {
        const authResponse = await browserAuth.handleAuth(request);
        if (authResponse) return authResponse;
        const authorized = await browserAuth.authorize(request);
        if (authorized.response) return authorized.response;
        request = authorized.request;
      }
      if (new URL(request.url).pathname === '/v1/me/history') return readOwn(request);
      if (new URL(request.url).pathname === '/v1/me/shifts') return readSchedule(request);
      if (request.method === 'GET' && listSchedules && new URL(request.url).pathname === '/v1/admin/shifts') return listSchedules(request);
      if (request.method === 'GET' && listStaff && new URL(request.url).pathname === '/v1/admin/staff') return listStaff(request);
      if (request.method === 'GET' && write && /^\/v1\/admin\/shifts\//.test(new URL(request.url).pathname)) return write(request);
      return request.method === 'POST' && write ? write(request) : read(request);
    };
    return { server: createLoopbackServer(handle, { allowWrites, browserLogin: !!browserAuth }), db, port };
  } catch (error) {
    db.close();
    throw error;
  }
}

// fetchImplementation is a trusted test adapter, never controlled by a request.
export async function prepareBrowserService(env, { fetchImplementation } = {}) {
  const { VINTAGE_ISSUER: issuer, VINTAGE_AUDIENCE: audience, VINTAGE_CLIENT_ID: clientId,
    VINTAGE_REQUIRED_SCOPE: readScope, VINTAGE_WRITE_SCOPE: writeScope, VINTAGE_ENABLE_WRITES: writes,
    VINTAGE_JWKS_FILE: keyFile, VINTAGE_PUBLIC_ORIGIN: publicOrigin, VINTAGE_CLIENT_SECRET_FILE: secretFile } = env;
  let origin;
  try { origin = new URL(publicOrigin); } catch { throw new Error('Invalid public origin'); }
  if (origin.protocol !== 'https:' || origin.origin !== publicOrigin || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('Invalid public origin');
  }
  if (!secretFile || !isAbsolute(secretFile)) throw new Error('Invalid secret file');
  const info = lstatSync(secretFile);
  if (!info.isFile() || info.size < 1 || info.size > 8192) throw new Error('Invalid secret file');
  const clientSecret = readFileSync(secretFile, 'utf8').trim();
  if (!clientSecret) throw new Error('Invalid secret file');
  const keyResolver = publicKeys(keyFile);
  const verifyAccessToken = createAccessTokenVerifier({ issuer, audience, clientIds: [clientId], requiredScopes: [readScope], keyResolver });
  const verifyWriteAccessToken = writes === 'true' ? createAccessTokenVerifier({ issuer, audience, clientIds: [clientId], requiredScopes: [readScope, writeScope], keyResolver }) : undefined;
  const flow = await createLoginFlow({ issuer, clientId, clientSecret, redirectUri: `${publicOrigin}/auth/callback`, audience,
    readScope, writeScope: writes === 'true' ? writeScope : undefined, verifyAccessToken, verifyWriteAccessToken, fetchImplementation });
  const sessions = createMemorySessionStore({ verifyAccessToken });
  const browserAuth = createBrowserAuth({ publicOrigin, flow, sessions });
  return prepareService(env, { browserAuth });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const enabled = process.env.VINTAGE_ENABLE_BROWSER_LOGIN;
    if (enabled !== undefined && enabled !== 'true' && enabled !== 'false') throw new Error('Invalid login setting');
    const { server, db, port } = enabled === 'true' ? await prepareBrowserService(process.env) : prepareService(process.env);
    server.on('error', () => { db.close(); process.exitCode = 1; });
    server.on('close', () => { if (db.isOpen) db.close(); });
    server.listen(port, '127.0.0.1');
  } catch {
    console.error('Could not start: check the required configuration and database.');
    process.exitCode = 1;
  }
}
