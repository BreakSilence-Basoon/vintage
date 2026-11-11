import { AdminAccessError, AdminConflictError, AdminRequestError, applyAuthenticatedOperation } from '@vintage/timetable-store/admin';

const routes = new Map([
  ['/v1/admin/viewers', 'add-viewer'],
  ['/v1/admin/history', 'add-history'],
  ['/v1/admin/history/close', 'close-history'],
  ['/v1/admin/viewers/deactivate', 'deactivate-viewer'],
  ['/v1/admin/viewers/reactivate', 'reactivate-viewer'],
  ['/v1/admin/locations', 'add-location'],
  ['/v1/admin/shifts', 'add-shift'],
  ['/v1/admin/shifts/update', 'update-shift'],
  ['/v1/admin/shifts/cancel', 'cancel-shift'],
  ['/v1/admin/shifts/restore', 'restore-shift'],
  ['/v1/admin/shifts/copy', 'copy-shift'],
]);
const reply = (status, body, extra = {}) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...extra } });

export function createAdminHandler({ db, verifyWriteAuthorization } = {}) {
  if (!db || typeof verifyWriteAuthorization !== 'function') throw new Error('Trusted database and verifier required');
  return async function handle(request) {
    if (request.method === 'GET') {
      const match = /^\/v1\/admin\/shifts\/([A-Za-z0-9_-]{1,128})$/.exec(new URL(request.url).pathname);
      if (!match) return reply(404, { error: 'not_found' });
      const identity = await verifyWriteAuthorization(request.headers.get('authorization'));
      if (!identity) return reply(401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
      try {
        const version = db.prepare('PRAGMA user_version').get().user_version;
        const row = db.prepare(`SELECT s.id, s.staff_id AS staffId, s.location_id AS locationId, s.starts_at AS startsAt,
          s.ends_at AS endsAt, s.grace_minutes AS graceMinutes, s.revision, s.active FROM memberships m
          JOIN scheduled_shifts s ON s.business_id = m.business_id
          WHERE m.issuer = ? AND m.subject = ? AND m.role = 'ADMIN' AND m.active = 1 AND s.id = ? ${version >= 10 ? 'AND m.token_valid_after <= ?' : ''}`)
          .get(identity.issuer, identity.subject, match[1], ...(version >= 10 ? [Number.isSafeInteger(identity.issuedAt) && identity.issuedAt >= 0 ? identity.issuedAt : -1] : []));
        if (!row) return reply(404, { error: 'not_found' });
        return reply(200, { id: row.id, staffId: row.staffId, locationId: row.locationId, startsAt: row.startsAt,
          endsAt: row.endsAt, graceMinutes: row.graceMinutes, revision: row.revision, active: row.active === 1 });
      } catch { return reply(503, { error: 'unavailable' }); }
    }
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
      const result = applyAuthenticatedOperation(db, identity, operation, input);
      return reply(200, { ok: true, replayed: result.replayed });
    } catch (error) {
      if (error instanceof AdminRequestError) return reply(400, { error: 'invalid_request' });
      if (error instanceof AdminAccessError) return reply(403, { error: 'forbidden' });
      if (error instanceof AdminConflictError) return reply(409, { error: 'conflict' });
      return reply(503, { error: 'unavailable' });
    }
  };
}
