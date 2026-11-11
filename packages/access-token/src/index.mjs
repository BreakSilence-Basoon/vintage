import { jwtVerify } from 'jose';

const nonempty = (value) => typeof value === 'string' && value.length > 0 && value.trim() === value;
const scopeToken = (value) => typeof value === 'string' && /^[\x21\x23-\x5B\x5D-\x7E]+$/.test(value);

// keyResolver must come from the configured trusted issuer, never from a token.
export function createAccessTokenVerifier({ issuer, audience, clientIds, requiredScopes, keyResolver } = {}) {
  let url;
  try { url = new URL(issuer); } catch { throw new Error('Invalid issuer'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !nonempty(issuer)) {
    throw new Error('Issuer must be a clean HTTPS URL');
  }
  if (!nonempty(audience) || !Array.isArray(clientIds) || !clientIds.length || !clientIds.every(nonempty) ||
      !Array.isArray(requiredScopes) || !requiredScopes.length || !requiredScopes.every(scopeToken) || typeof keyResolver !== 'function') {
    throw new Error('Invalid access token verifier configuration');
  }
  const clients = new Set(clientIds);
  const scopes = [...new Set(requiredScopes)];

  return async function verifyAuthorization(header) {
    if (typeof header !== 'string' || header.length > 8192) return null;
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(header);
    if (!match) return null;
    try {
      const { payload, protectedHeader } = await jwtVerify(match[1], keyResolver, {
        algorithms: ['RS256'], issuer, audience, maxTokenAge: '15m',
        requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat', 'jti', 'client_id', 'scope'],
      });
      const type = typeof protectedHeader.typ === 'string' ? protectedHeader.typ.toLowerCase() : '';
      if (!['at+jwt', 'application/at+jwt'].includes(type) || !nonempty(payload.sub) ||
          !nonempty(payload.jti) || !nonempty(payload.client_id) || !clients.has(payload.client_id) ||
          typeof payload.scope !== 'string') return null;
      const granted = new Set(payload.scope.split(' ').filter(Boolean));
      if (!scopes.every((scope) => granted.has(scope))) return null;
      return { issuer, subject: payload.sub, clientId: payload.client_id,
        expiresAt: Math.min(payload.exp, payload.iat + 900) * 1000 };
    } catch {
      return null;
    }
  };
}
