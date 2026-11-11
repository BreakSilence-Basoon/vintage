import { AdminAccessError, AdminRequestError, applyAuthenticatedOperation } from '@vintage/timetable-store/admin';

const routes = new Map([
  ['/v1/admin/viewers', 'add-viewer'],
  ['/v1/admin/history', 'add-history'],
  ['/v1/admin/viewers/deactivate', 'deactivate-viewer'],
]);
const reply = (status, body, extra = {}) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...extra } });

export function createAdminHandler({ db, verifyWriteAuthorization } = {}) {
  if (!db || typeof verifyWriteAuthorization !== 'function') throw new Error('Trusted database and verifier required');
  return async function handle(request) {
    if (request.method !== 'POST') return reply(404, { error: 'not_found' });
    const operation = routes.get(new URL(request.url).pathname);
    if (!operation) return reply(404, { error: 'not_found' });
    const identity = await verifyWriteAuthorization(request.headers.get('authorization'));
    if (!identity) return reply(401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:"utf-8"|utf-8))?\s*$/i.test(request.headers.get('content-type') ?? '')) {
      return reply(415, { error: 'unsupported_media_type' });
    }
    let input;
    try { input = await request.json(); } catch { return reply(400, { error: 'invalid_request' }); }
    try {
      applyAuthenticatedOperation(db, identity, operation, input);
      return reply(200, { ok: true });
    } catch (error) {
      if (error instanceof AdminRequestError) return reply(400, { error: 'invalid_request' });
      if (error instanceof AdminAccessError) return reply(403, { error: 'forbidden' });
      return reply(503, { error: 'unavailable' });
    }
  };
}
