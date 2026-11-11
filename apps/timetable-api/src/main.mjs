import { lstatSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createLocalJWKSet } from 'jose';
import { createAccessTokenVerifier } from '@vintage/access-token';
import { createHistoryHandler } from '@vintage/timetable-read-api';
import { createTimetableStore } from '@vintage/timetable-store';
import { createLoopbackServer } from './server.mjs';
import { createAdminHandler } from './admin-handler.mjs';

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

export function prepareService(env) {
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
    const read = createHistoryHandler({ ...createTimetableStore(db), verifyAuthorization });
    if (allowWrites && db.prepare('PRAGMA user_version').get().user_version !== 3) throw new Error('Migration required');
    const write = allowWrites ? createAdminHandler({ db, verifyWriteAuthorization }) : null;
    const handle = (request) => request.method === 'POST' && write ? write(request) : read(request);
    return { server: createLoopbackServer(handle, { allowWrites }), db, port };
  } catch (error) {
    db.close();
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { server, db, port } = prepareService(process.env);
    server.on('error', () => { db.close(); process.exitCode = 1; });
    server.on('close', () => { if (db.isOpen) db.close(); });
    server.listen(port, '127.0.0.1');
  } catch {
    console.error('Could not start: check the required configuration and database.');
    process.exitCode = 1;
  }
}
