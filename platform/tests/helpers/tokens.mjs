// Signs Cognito-shaped access tokens with a throwaway key, and points fetch() at its JWKS,
// so verifyAccessToken() runs its real signature checks in tests.
import { generateKeyPairSync, sign } from 'node:crypto';

export const ISSUER = 'https://cognito-idp.test/pool';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256' };

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => (url === `${ISSUER}/.well-known/jwks.json`
  ? { ok: true, json: async () => ({ keys: [jwk] }) }
  : realFetch(url, opts));

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** A valid access token for clientId/group; `over` replaces or adds claims. */
export function accessToken({ clientId, group, ...over } = {}) {
  const claims = {
    iss: ISSUER, token_use: 'access', client_id: clientId, username: 'test-user',
    exp: Math.floor(Date.now() / 1000) + 600, 'cognito:groups': group ? [group] : [], ...over,
  };
  const h = b64({ alg: 'RS256', kid: 'test-key' }), p = b64(claims);
  return `${h}.${p}.${sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url')}`;
}

/** Same claims, but signed by a different key: must be rejected. */
export function forgedToken(opts) {
  const [h, p] = accessToken(opts).split('.');
  return `${h}.${p}.${Buffer.from('not-a-signature').toString('base64url')}`;
}
