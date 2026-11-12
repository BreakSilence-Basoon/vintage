import { createAccessTokenVerifier } from '@vintage/access-token';

const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const validSubject = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512 && value === value.trim();

// Trusted server configuration and a current authoritative membership lookup are required.
// This decision alone is not an authorization boundary for a later database operation.
export function createLedgerAccessCheck({ issuer, audience, clientIds, keyResolver, businessId, readScope, writeScope, lookupMembership } = {}) {
  if (!validId(businessId) || typeof lookupMembership !== 'function' || typeof readScope !== 'string' ||
      typeof writeScope !== 'string' || readScope === writeScope) throw new Error('Invalid Ledger access configuration');
  const options = { issuer, audience, clientIds, keyResolver };
  const verifyRead = createAccessTokenVerifier({ ...options, requiredScopes: [readScope] });
  const verifyWrite = createAccessTokenVerifier({ ...options, requiredScopes: [readScope, writeScope] });
  return async function checkLedgerAccess(authorization, action) {
    try {
      if (!['read', 'write'].includes(action)) return null;
      const identity = await (action === 'read' ? verifyRead(authorization) : verifyWrite(authorization));
      if (!identity || !validSubject(identity.subject)) return null;
      const member = await lookupMembership(Object.freeze({ issuer: identity.issuer, subject: identity.subject }));
      if (!member || typeof member !== 'object' || Array.isArray(member) || member.issuer !== identity.issuer ||
          member.subject !== identity.subject || member.businessId !== businessId || !validId(member.actorId) ||
          member.active !== true || member.read !== true || (action === 'write' && member.write !== true) ||
          !Number.isSafeInteger(member.tokenValidAfter) || member.tokenValidAfter < 0 || identity.issuedAt < member.tokenValidAfter ||
          Date.now() >= identity.expiresAt) return null;
      return Object.freeze({ issuer: identity.issuer, subject: identity.subject, actorId: member.actorId, businessId, issuedAt: identity.issuedAt, expiresAt: identity.expiresAt });
    } catch { return null; }
  };
}
