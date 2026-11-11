import { mayAccessTimetable } from '@vintage/timetable-policy';

const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const identityPart = (value) => typeof value === 'string' && value.length > 0 && value.length <= 2048 && value === value.trim();
const timestamp = (value) => {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) && date.toISOString() === value;
};
const reply = (status, body, extra = {}) => Response.json(body, {
  status, headers: { 'Cache-Control': 'no-store', ...extra },
});
function parseCursor(value) {
  if (typeof value !== 'string' || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid cursor');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) throw new Error('Invalid cursor');
  const parts = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(parts) || parts.length !== 2 || !timestamp(parts[0]) || !id(parts[1])) throw new Error('Invalid cursor');
  return { startsAt: parts[0], id: parts[1] };
}
const makeCursor = (record) => Buffer.from(JSON.stringify([record.startsAt, record.id])).toString('base64url');

// These functions are server-owned adapters, not values from request headers.
export function createHistoryHandler({ verifyAuthorization, findAccessAndHistory } = {}) {
  if (![verifyAuthorization, findAccessAndHistory].every((value) => typeof value === 'function')) {
    throw new Error('Trusted authentication and data adapters are required');
  }
  return async function handle(request) {
    try {
      if (request.method !== 'GET') return reply(404, { error: 'not_found' });
      const match = /^\/v1\/history\/([A-Za-z0-9_-]{1,128})$/.exec(new URL(request.url).pathname);
      if (!match) return reply(404, { error: 'not_found' });
      const identity = await verifyAuthorization(request.headers.get('authorization'));
      if (!identity || !identityPart(identity.issuer) || !identityPart(identity.subject)) {
        return reply(401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
      }
      // Actor and record must come from one consistent server-side read so a
      // role or membership change cannot be paired with a stale decision.
      const found = await findAccessAndHistory(identity.issuer, identity.subject, match[1], identity.issuedAt);
      const { actor, record } = found ?? {};
      if (!actor || !id(actor.businessId) || !id(actor.staffId) || !record || record.id !== match[1] || !id(record.staffId) ||
          !mayAccessTimetable({ actor, resource: record, action: 'history:read' })) {
        return reply(404, { error: 'not_found' });
      }
      if (!timestamp(record.startsAt) || (record.endsAt !== null && !timestamp(record.endsAt)) ||
          (record.endsAt !== null && record.endsAt < record.startsAt)) throw new Error('Invalid stored record');
      return reply(200, { id: record.id, startsAt: record.startsAt, endsAt: record.endsAt });
    } catch {
      return reply(503, { error: 'unavailable' });
    }
  };
}

// The store resolves the current identity and its own records in one database query.
export function createOwnHistoryHandler({ verifyAuthorization, findOwnHistory } = {}) {
  if (typeof verifyAuthorization !== 'function' || typeof findOwnHistory !== 'function') throw new Error('Trusted authentication and data adapters are required');
  return async function handle(request) {
    try {
      const url = new URL(request.url);
      if (request.method !== 'GET' || url.pathname !== '/v1/me/history') return reply(404, { error: 'not_found' });
      const identity = await verifyAuthorization(request.headers.get('authorization'));
      if (!identity || !identityPart(identity.issuer) || !identityPart(identity.subject)) return reply(401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
      if ([...url.searchParams.keys()].some((key) => !['limit', 'cursor'].includes(key)) ||
          url.searchParams.getAll('limit').length > 1 || url.searchParams.getAll('cursor').length > 1) return reply(400, { error: 'invalid_request' });
      const limitText = url.searchParams.get('limit') ?? '50';
      if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(limitText)) return reply(400, { error: 'invalid_request' });
      const limit = Number(limitText);
      let cursor = null;
      const value = url.searchParams.get('cursor');
      if (value !== null) {
        try { cursor = parseCursor(value); } catch { return reply(400, { error: 'invalid_request' }); }
      }
      const records = await findOwnHistory(identity.issuer, identity.subject, cursor, limit + 1, identity.issuedAt);
      if (records === null) return reply(404, { error: 'not_found' });
      if (!Array.isArray(records) || records.length > limit + 1 || records.some((record) => !id(record.id) || !timestamp(record.startsAt) ||
          (record.endsAt !== null && (!timestamp(record.endsAt) || record.endsAt < record.startsAt)))) throw new Error('Invalid stored record');
      const page = records.slice(0, limit).map(({ id, startsAt, endsAt }) => ({ id, startsAt, endsAt }));
      const last = page.at(-1);
      const nextCursor = records.length > limit ? makeCursor(last) : null;
      return reply(200, { records: page, nextCursor });
    } catch { return reply(503, { error: 'unavailable' }); }
  };
}

export function createOwnScheduleHandler({ verifyAuthorization, findOwnShifts } = {}) {
  if (typeof verifyAuthorization !== 'function' || typeof findOwnShifts !== 'function') throw new Error('Trusted authentication and data adapters are required');
  return async function handle(request) {
    try {
      const url = new URL(request.url);
      if (request.method !== 'GET' || url.pathname !== '/v1/me/shifts') return reply(404, { error: 'not_found' });
      const identity = await verifyAuthorization(request.headers.get('authorization'));
      if (!identity || !identityPart(identity.issuer) || !identityPart(identity.subject)) return reply(401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
      if ([...url.searchParams.keys()].some((key) => !['from', 'to', 'limit', 'cursor'].includes(key)) ||
          ['from', 'to', 'limit', 'cursor'].some((key) => url.searchParams.getAll(key).length > 1)) return reply(400, { error: 'invalid_request' });
      const from = url.searchParams.get('from'), to = url.searchParams.get('to');
      const limitText = url.searchParams.get('limit') ?? '50';
      if (!timestamp(from) || !timestamp(to) || from >= to || Date.parse(to) - Date.parse(from) > 62 * 86400000 ||
          !/^(?:[1-9]|[1-9][0-9]|100)$/.test(limitText)) return reply(400, { error: 'invalid_request' });
      let cursor = null;
      if (url.searchParams.has('cursor')) {
        try { cursor = parseCursor(url.searchParams.get('cursor')); } catch { return reply(400, { error: 'invalid_request' }); }
      }
      const limit = Number(limitText);
      const rows = await findOwnShifts(identity.issuer, identity.subject, from, to, cursor, limit + 1, identity.issuedAt);
      if (rows === null) return reply(404, { error: 'not_found' });
      if (!Array.isArray(rows) || rows.length > limit + 1 || rows.some((row) => !id(row.id) || !id(row.locationId) ||
          typeof row.locationLabel !== 'string' || row.locationLabel !== row.locationLabel.trim() || !row.locationLabel || row.locationLabel.length > 100 || /[\p{Cc}]/u.test(row.locationLabel) ||
          !timestamp(row.startsAt) || !timestamp(row.endsAt) || row.endsAt <= row.startsAt ||
          !Number.isInteger(row.graceMinutes) || row.graceMinutes < 0 || row.graceMinutes > 180)) throw new Error('Invalid stored shift');
      const shifts = rows.slice(0, limit).map(({ id, locationId, locationLabel, startsAt, endsAt, graceMinutes }) =>
        ({ id, location: { id: locationId, label: locationLabel }, startsAt, endsAt, graceMinutes }));
      return reply(200, { shifts, nextCursor: rows.length > limit ? makeCursor(shifts.at(-1)) : null });
    } catch { return reply(503, { error: 'unavailable' }); }
  };
}
