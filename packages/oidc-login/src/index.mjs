import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as oidc from 'openid-client';

const nonempty = (value) => typeof value === 'string' && value.length > 0 && value === value.trim();
const scopeToken = (value) => typeof value === 'string' && /^[\x21\x23-\x5B\x5D-\x7E]+$/.test(value);
function httpsUrl(value, allowPath = true) {
  if (!nonempty(value)) throw new Error('Invalid configuration');
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid configuration'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (!allowPath && url.pathname !== '/')) {
    throw new Error('Invalid configuration');
  }
  return url;
}

// fetchImplementation and verifyAccessToken are trusted server adapters, never request input.
export async function createLoginFlow({ issuer, clientId, clientSecret, redirectUri, audience,
  readScope, writeScope, verifyAccessToken, verifyWriteAccessToken, fetchImplementation } = {}) {
  const issuerUrl = httpsUrl(issuer);
  const redirect = httpsUrl(redirectUri);
  httpsUrl(audience);
  if (!nonempty(clientId) || !nonempty(clientSecret) || !scopeToken(readScope) || readScope === 'openid' ||
      (writeScope !== undefined && (!scopeToken(writeScope) || writeScope === 'openid' || writeScope === readScope || typeof verifyWriteAccessToken !== 'function')) ||
      (writeScope === undefined && verifyWriteAccessToken !== undefined) ||
      typeof verifyAccessToken !== 'function' || (fetchImplementation !== undefined && typeof fetchImplementation !== 'function')) {
    throw new Error('Invalid configuration');
  }
  const options = { execute: [oidc.enableNonRepudiationChecks] };
  if (fetchImplementation) options[oidc.customFetch] = fetchImplementation;
  let config;
  try { config = await oidc.discovery(issuerUrl, clientId, clientSecret, undefined, options); }
  catch { throw new Error('Provider discovery failed'); }
  const metadata = config.serverMetadata();
  if (metadata.issuer !== issuer || !Array.isArray(metadata.code_challenge_methods_supported) || !metadata.code_challenge_methods_supported.includes('S256')) {
    throw new Error('Provider does not advertise PKCE S256');
  }
  for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.jwks_uri]) httpsUrl(endpoint);
  const pending = new Map();
  const discard = (state) => {
    const entry = pending.get(state);
    if (entry) clearTimeout(entry.timer);
    pending.delete(state);
  };
  const prune = () => { for (const [state, entry] of pending) if (entry.expiresAt <= Date.now()) discard(state); };

  return {
    async begin({ write = false } = {}) {
      if (typeof write !== 'boolean' || (write && !writeScope)) throw new Error('Invalid request');
      prune();
      if (pending.size >= 1000) throw new Error('Too many pending logins');
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const codeVerifier = oidc.randomPKCECodeVerifier();
      const browserBinding = randomBytes(32).toString('base64url');
      const challenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
      prune();
      if (pending.size >= 1000 || pending.has(state)) throw new Error('Too many pending logins');
      const url = oidc.buildAuthorizationUrl(config, {
        redirect_uri: redirect.href, scope: ['openid', readScope, ...(write ? [writeScope] : [])].join(' '),
        audience, resource: audience, state, nonce, code_challenge: challenge, code_challenge_method: 'S256',
      });
      const timer = setTimeout(() => discard(state), 300000);
      timer.unref();
      pending.set(state, { nonce, codeVerifier, browserBinding, write, timer, expiresAt: Date.now() + 300000 });
      return { authorizationUrl: url.href, browserBinding };
    },
    async finish(callbackUrl, browserBinding) {
      try {
        prune();
        const callback = new URL(callbackUrl);
        if (callback.origin !== redirect.origin || callback.pathname !== redirect.pathname || callback.username || callback.password || callback.hash ||
            callback.searchParams.getAll('state').length !== 1 || callback.searchParams.getAll('code').length !== 1 ||
            typeof browserBinding !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(browserBinding)) throw new Error('Invalid callback');
        const state = callback.searchParams.get('state');
        const entry = pending.get(state);
        if (!entry || !timingSafeEqual(Buffer.from(entry.browserBinding), Buffer.from(browserBinding))) throw new Error('Invalid callback');
        discard(state);
        const tokens = await oidc.authorizationCodeGrant(config, callback, {
          expectedState: state, expectedNonce: entry.nonce, pkceCodeVerifier: entry.codeVerifier,
        });
        const claims = tokens.claims();
        const verify = entry.write ? verifyWriteAccessToken : verifyAccessToken;
        const verified = await verify(`Bearer ${tokens.access_token}`);
        if (!claims || !verified || claims.iss !== issuer || verified.issuer !== issuer || verified.clientId !== clientId || claims.sub !== verified.subject ||
            typeof tokens.token_type !== 'string' || tokens.token_type.toLowerCase() !== 'bearer' ||
            !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0 || !Number.isFinite(verified.expiresAt)) throw new Error('Invalid token');
        const expiresAt = Math.min(verified.expiresAt, Date.now() + tokens.expires_in * 1000);
        if (expiresAt <= Date.now()) throw new Error('Invalid token');
        return { identity: verified, accessToken: tokens.access_token, expiresAt };
      } catch {
        throw new Error('Login failed');
      }
    },
  };
}
