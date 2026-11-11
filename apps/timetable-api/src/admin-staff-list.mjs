const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const reply = (status, body, extra = {}) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...extra } });

export function createAdminStaffList({ db, verifyWriteAuthorization } = {}) {
  if (!db || typeof verifyWriteAuthorization !== 'function') throw new Error('Trusted database and verifier required');
  return async function handle(request) {
    try {
      const url = new URL(request.url);
      if (request.method !== 'GET' || url.pathname !== '/v1/admin/staff') return reply(404, { error: 'not_found' });
      const identity = await verifyWriteAuthorization(request.headers.get('authorization'));
      if (!identity) return reply(401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
      if ([...url.searchParams.keys()].some((key) => !['limit', 'cursor'].includes(key)) ||
          ['limit', 'cursor'].some((key) => url.searchParams.getAll(key).length > 1)) return reply(400, { error: 'invalid_request' });
      const limitText = url.searchParams.get('limit') ?? '50';
      const cursor = url.searchParams.get('cursor');
      if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(limitText) || (cursor !== null && !id(cursor))) return reply(400, { error: 'invalid_request' });
      const version = db.prepare('PRAGMA user_version').get().user_version;
      const cursorFilter = cursor === null ? '' : 'AND s.id > ?';
      const query = db.prepare(`SELECT s.id, COUNT(t.subject) AS memberships, MIN(t.role) AS role, MIN(t.active) AS active
        FROM memberships m LEFT JOIN staff s ON s.business_id = m.business_id ${cursorFilter}
        LEFT JOIN memberships t ON t.business_id = s.business_id AND t.staff_id = s.id
        WHERE m.issuer = ? AND m.subject = ? AND m.role = 'ADMIN' AND m.active = 1 ${version >= 10 ? 'AND m.token_valid_after <= ?' : ''}
        GROUP BY s.id ORDER BY s.id ASC LIMIT ?`);
      const limit = Number(limitText);
      const rows = query.all(...(cursor === null ? [] : [cursor]), identity.issuer, identity.subject,
        ...(version >= 10 ? [Number.isSafeInteger(identity.issuedAt) && identity.issuedAt >= 0 ? identity.issuedAt : -1] : []), limit + 1);
      if (!rows.length) return reply(404, { error: 'not_found' });
      const records = rows.filter((row) => row.id !== null);
      if (records.some((row) => !id(row.id) || !Number.isSafeInteger(row.memberships) || row.memberships < 0 ||
          (row.memberships === 1 && (!['ADMIN', 'VIEWER'].includes(row.role) || ![0, 1].includes(row.active))))) throw new Error('Invalid staff data');
      const staff = records.slice(0, limit).map((row) => ({ id: row.id, role: row.memberships === 1 ? row.role : null,
        status: row.memberships === 1 ? (row.active === 1 ? 'active' : 'inactive') : 'needs_review' }));
      return reply(200, { staff, nextCursor: records.length > limit ? staff.at(-1).id : null });
    } catch { return reply(503, { error: 'unavailable' }); }
  };
}
