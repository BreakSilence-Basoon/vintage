import { lstatSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createLocalJWKSet } from 'jose';
import { createLedgerAuthorizedStore } from '@vintage/ledger-store';
import { verifyStructure } from '@vintage/ledger-store/backup';

function publicKeys(path) {
  if (!isAbsolute(path ?? '') || !lstatSync(path).isFile() || lstatSync(path).size > 1024 * 1024) throw new Error('Invalid keys');
  const jwks = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(jwks?.keys) || !jwks.keys.length || jwks.keys.length > 20) throw new Error('Invalid keys');
  const ids = new Set();
  for (const key of jwks.keys) {
    if (key?.kty !== 'RSA' || typeof key.kid !== 'string' || !key.kid || ids.has(key.kid) || typeof key.n !== 'string' || typeof key.e !== 'string' ||
        ['d','p','q','dp','dq','qi','oth','k'].some((name) => name in key) || (key.use && key.use !== 'sig') ||
        (key.alg && key.alg !== 'RS256') || (key.key_ops && (!Array.isArray(key.key_ops) || key.key_ops.length !== 1 || key.key_ops[0] !== 'verify'))) throw new Error('Invalid keys');
    ids.add(key.kid);
  }
  return createLocalJWKSet(jwks);
}

// Experimental loopback-only service; no browser sessions, TLS termination or public deployment.
export function prepareLedgerService(env) {
  const { VINTAGE_LEDGER_DATABASE_FILE: path, VINTAGE_LEDGER_JWKS_FILE: keyFile, VINTAGE_LEDGER_PORT: portText,
    VINTAGE_LEDGER_ISSUER: issuer, VINTAGE_LEDGER_AUDIENCE: audience, VINTAGE_LEDGER_CLIENT_ID: client,
    VINTAGE_LEDGER_BUSINESS_ID: businessId, VINTAGE_LEDGER_READ_SCOPE: readScope, VINTAGE_LEDGER_WRITE_SCOPE: writeScope,
    VINTAGE_LEDGER_ENABLE_WRITES: writesText } = env;
  if (!isAbsolute(path ?? '') || !lstatSync(path).isFile() || !/^\d{1,5}$/.test(portText ?? '')) throw new Error('Invalid configuration');
  const port = Number(portText);
  if (port < 1 || port > 65535 || (writesText !== undefined && !['true', 'false'].includes(writesText))) throw new Error('Invalid configuration');
  const allowWrites = writesText === 'true', keyResolver = publicKeys(keyFile);
  const db = new DatabaseSync(path, { readOnly: !allowWrites });
  try {
    verifyStructure(db);
    if (db.prepare('SELECT business_id FROM ledger_authority_config WHERE id=1').get()?.business_id !== businessId) throw new Error('Invalid authority');
    if (db.prepare('PRAGMA user_version').get().user_version === 2 && db.prepare('SELECT status FROM ledger_recovery_guard WHERE id=1').get()?.status !== 'unlocked') throw new Error('Recovery review required');
    const store = createLedgerAuthorizedStore(db, { issuer, audience, clientIds: [client], keyResolver, businessId, readScope, writeScope });
    const server = createServer({ maxHeaderSize: 16384 }, async (request, response) => {
      const reply = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(body)); };
      try {
        const count = (name) => request.rawHeaders.filter((_, i) => i % 2 === 0 && request.rawHeaders[i].toLowerCase() === name).length;
        const length = request.headers['content-length'], address = server.address();
        if (request.method !== 'POST' || !['/v1/facts/read', '/v1/facts/write'].includes(request.url) ||
            request.headers.host !== `127.0.0.1:${address.port}` || count('host') !== 1 || count('authorization') !== 1 ||
            count('content-type') !== 1 || count('content-length') !== 1 || request.headers.cookie || request.headers.origin ||
            request.headers['transfer-encoding'] || request.headers['content-encoding'] || !/^\d{1,5}$/.test(length ?? '') || Number(length) < 1 || Number(length) > 8192 ||
            !/^application\/json(?:\s*;\s*charset\s*=\s*(?:"utf-8"|utf-8))?\s*$/i.test(request.headers['content-type'] ?? '')) {
          request.resume(); return reply(400, { error: 'invalid_request' });
        }
        if (request.url === '/v1/facts/write' && !allowWrites) { request.resume(); return reply(403, { error: 'disabled' }); }
        const chunks = []; let size = 0;
        for await (const chunk of request) { size += chunk.length; if (size > 8192) return reply(400, { error: 'invalid_request' }); chunks.push(chunk); }
        if (size !== Number(length)) return reply(400, { error: 'invalid_request' });
        let input;
        try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { return reply(400, { error: 'invalid_request' }); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) return reply(400, { error: 'invalid_request' });
        try {
          if (request.url === '/v1/facts/read') {
            if (Object.keys(input).length !== 1 || !Object.hasOwn(input, 'id')) return reply(400, { error: 'invalid_request' });
            const result = await store.read(request.headers.authorization, input.id);
            return result ? reply(200, result) : reply(404, { error: 'not_found' });
          }
          return reply(200, await store.write(request.headers.authorization, input));
        } catch { return reply(503, { error: 'unavailable' }); }
      } catch { if (!response.headersSent) reply(500, { error: 'unavailable' }); else response.destroy(); }
    });
    server.headersTimeout = 10000; server.requestTimeout = 15000;
    return { server, db, port };
  } catch (error) { db.close(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { server, db, port } = prepareLedgerService(process.env);
    server.on('error', () => { if (db.isOpen) db.close(); process.exitCode = 1; });
    server.on('close', () => { if (db.isOpen) db.close(); });
    server.listen(port, '127.0.0.1');
  } catch { console.error('Ledger could not start; check configuration and protected database.'); process.exitCode = 1; }
}
