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
      const found = await findAccessAndHistory(identity.issuer, identity.subject, match[1]);
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
