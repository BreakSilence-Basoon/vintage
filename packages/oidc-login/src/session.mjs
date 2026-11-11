import { createHash, randomBytes } from 'node:crypto';

const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const nonempty = (value) => typeof value === 'string' && value.length > 0 && value === value.trim();
const sameIdentity = (a, b) => a && b && nonempty(a.issuer) && nonempty(a.subject) && nonempty(a.clientId) &&
  a.issuer === b.issuer && a.subject === b.subject && a.clientId === b.clientId;

// This store manages server-side state only; it does not set cookies or authorize data.
export function createMemorySessionStore({ verifyAccessToken, maxSessions = 1000 } = {}) {
  if (typeof verifyAccessToken !== 'function' || !Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 1000) {
    throw new Error('Invalid session configuration');
  }
  const sessions = new Map();
  const discard = (key) => {
    const entry = sessions.get(key);
    if (!entry) return false;
    clearTimeout(entry.timer);
    sessions.delete(key);
    return true;
  };
  const prune = () => { for (const [key, entry] of sessions) if (entry.expiresAt <= Date.now()) discard(key); };
  return {
    async issue(login) {
      if (!login || typeof login.accessToken !== 'string' || !login.accessToken.length || login.accessToken.length > 8192 ||
          !Number.isFinite(login.expiresAt)) throw new Error('Invalid session');
      let verified;
      try { verified = await verifyAccessToken(`Bearer ${login.accessToken}`); } catch { throw new Error('Invalid session'); }
      if (!sameIdentity(login.identity, verified) || !Number.isFinite(verified.expiresAt)) throw new Error('Invalid session');
      const expiresAt = Math.min(login.expiresAt, verified.expiresAt, Date.now() + 900000);
      if (expiresAt <= Date.now()) throw new Error('Invalid session');
      prune();
      if (sessions.size >= maxSessions) throw new Error('Session capacity reached');
      const sessionId = randomBytes(32).toString('base64url');
      const key = digest(sessionId);
      if (sessions.has(key)) throw new Error('Session collision');
      const timer = setTimeout(() => discard(key), Math.max(0, expiresAt - Date.now()));
      timer.unref();
      sessions.set(key, { identity: { issuer: verified.issuer, subject: verified.subject, clientId: verified.clientId },
        accessToken: login.accessToken, expiresAt, timer });
      return sessionId;
    },
    async get(sessionId) {
      if (!validId(sessionId)) return null;
      const key = digest(sessionId);
      const entry = sessions.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= Date.now()) { discard(key); return null; }
      let verified;
      try { verified = await verifyAccessToken(`Bearer ${entry.accessToken}`); } catch { verified = null; }
      if (sessions.get(key) !== entry) return null;
      if (!sameIdentity(entry.identity, verified) || !Number.isFinite(verified.expiresAt) ||
          verified.expiresAt <= Date.now() || entry.expiresAt <= Date.now()) { discard(key); return null; }
      return { identity: { ...entry.identity }, accessToken: entry.accessToken, expiresAt: Math.min(entry.expiresAt, verified.expiresAt) };
    },
    revoke(sessionId) { return validId(sessionId) ? discard(digest(sessionId)) : false; },
  };
}
