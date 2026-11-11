const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const timestamp = (value) => {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) && date.toISOString() === value;
};
const reply = (status, body, extra = {}) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...extra } });
function cursorFrom(value) {
  if (typeof value !== 'string' || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid cursor');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) throw new Error('Invalid cursor');
  const pair = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(pair) || pair.length !== 2 || !timestamp(pair[0]) || !id(pair[1])) throw new Error('Invalid cursor');
  return pair;
}

export function createAdminScheduleList({ db, verifyWriteAuthorization } = {}) {
  if (!db || typeof verifyWriteAuthorization !== 'function') throw new Error('Trusted database and verifier required');
  return async function handle(request) {
    try {
      const url = new URL(request.url);
      if (request.method !== 'GET' || url.pathname !== '/v1/admin/shifts') return reply(404, { error: 'not_found' });
      const identity = await verifyWriteAuthorization(request.headers.get('authorization'));
      if (!identity) return reply(401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
      if ([...url.searchParams.keys()].some((key) => !['from', 'to', 'limit', 'cursor', 'status'].includes(key)) ||
          ['from', 'to', 'limit', 'cursor', 'status'].some((key) => url.searchParams.getAll(key).length > 1)) return reply(400, { error: 'invalid_request' });
      const from = url.searchParams.get('from'), to = url.searchParams.get('to');
      const limitText = url.searchParams.get('limit') ?? '50';
      const status = url.searchParams.get('status') ?? 'active';
      if (!timestamp(from) || !timestamp(to) || from >= to || Date.parse(to) - Date.parse(from) > 62 * 86400000 ||
          !/^(?:[1-9]|[1-9][0-9]|100)$/.test(limitText) || !['active', 'canceled', 'all'].includes(status)) return reply(400, { error: 'invalid_request' });
      let cursor = null;
      if (url.searchParams.has('cursor')) {
        try { cursor = cursorFrom(url.searchParams.get('cursor')); } catch { return reply(400, { error: 'invalid_request' }); }
      }
      const filter = status === 'all' ? '' : 'AND s.active = ?';
      const cursorFilter = cursor ? 'AND (s.starts_at, s.id) < (?, ?)' : '';
      const query = db.prepare(`SELECT s.id, s.staff_id AS staffId, s.location_id AS locationId, l.label AS locationLabel,
        s.starts_at AS startsAt, s.ends_at AS endsAt, s.grace_minutes AS graceMinutes, s.revision, s.active
        FROM memberships m LEFT JOIN scheduled_shifts s ON s.business_id = m.business_id AND s.starts_at < ? AND s.ends_at > ? ${filter} ${cursorFilter}
        LEFT JOIN schedule_locations l ON l.business_id = s.business_id AND l.id = s.location_id
        WHERE m.issuer = ? AND m.subject = ? AND m.role = 'ADMIN' AND m.active = 1
        ORDER BY s.starts_at DESC, s.id DESC LIMIT ?`);
      const limit = Number(limitText);
      const rows = query.all(to, from, ...(status === 'all' ? [] : [status === 'active' ? 1 : 0]), ...(cursor ?? []), identity.issuer, identity.subject, limit + 1);
      if (!rows.length) return reply(404, { error: 'not_found' });
      const records = rows.filter((row) => row.id !== null);
      if (records.some((row) => !id(row.id) || !id(row.staffId) || !id(row.locationId) || typeof row.locationLabel !== 'string' ||
          !row.locationLabel || row.locationLabel !== row.locationLabel.trim() || row.locationLabel.length > 100 || /[\p{Cc}]/u.test(row.locationLabel) ||
          !timestamp(row.startsAt) || !timestamp(row.endsAt) || row.endsAt <= row.startsAt || !Number.isInteger(row.graceMinutes) ||
          row.graceMinutes < 0 || row.graceMinutes > 180 || !Number.isSafeInteger(row.revision) || row.revision < 1 || ![0, 1].includes(row.active))) throw new Error('Invalid stored shift');
      const shifts = records.slice(0, limit).map(({ id, staffId, locationId, locationLabel, startsAt, endsAt, graceMinutes, revision, active }) =>
        ({ id, staffId, location: { id: locationId, label: locationLabel }, startsAt, endsAt, graceMinutes, revision, active: active === 1 }));
      const last = shifts.at(-1);
      const nextCursor = records.length > limit ? Buffer.from(JSON.stringify([last.startsAt, last.id])).toString('base64url') : null;
      return reply(200, { shifts, nextCursor });
    } catch { return reply(503, { error: 'unavailable' }); }
  };
}
