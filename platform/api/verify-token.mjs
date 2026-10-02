// Verifies a Cognito access token inside a tool's Lambda, without trusting API Gateway.
// Bundled into each tool's Lambda zip at deploy time (see the tool's infra/api.tf).
//
//   const claims = await verifyAccessToken(event.headers, { issuer, clientId, group });
//   -> the token's claims, or throws an Error with .status 401 (bad token) or 403 (not in group)
//
// Checks: RS256 signature against the pool's JWKS, issuer, token_use=access, client_id
// (so another tool's token is refused), expiry, and membership of `group`.
import { createPublicKey, verify } from 'node:crypto';

let jwks = null;
async function keyFor(issuer, kid) {
  if (!jwks || !jwks[kid]) {
    const res = await fetch(`${issuer}/.well-known/jwks.json`);
    if (!res.ok) throw new Error(`jwks ${res.status}`);
    jwks = Object.fromEntries((await res.json()).keys.map((k) => [k.kid, createPublicKey({ key: k, format: 'jwk' })]));
  }
  return jwks[kid];
}

const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString());

export async function verifyAccessToken(headers, { issuer, clientId, group }) {
  const fail = (status, msg) => Object.assign(new Error(msg), { status });
  const m = /^Bearer (.+)$/.exec(headers?.authorization ?? '');
  if (!m) throw fail(401, 'missing token');
  const [h, p, sig] = m[1].split('.');
  if (!sig) throw fail(401, 'malformed token');

  let header, c;
  try {
    header = b64json(h);
    c = b64json(p);
  } catch {
    throw fail(401, 'malformed token');
  }
  if (header.alg !== 'RS256') throw fail(401, 'bad alg');
  const key = await keyFor(issuer, header.kid);
  if (!key || !verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(sig, 'base64url'))) {
    throw fail(401, 'bad signature');
  }

  const now = Math.floor(Date.now() / 1000);
  if (c.iss !== issuer) throw fail(401, 'wrong issuer');
  if (c.token_use !== 'access') throw fail(401, 'not an access token');
  if (c.client_id !== clientId) throw fail(401, 'token is for another app');
  if (!(c.exp > now)) throw fail(401, 'expired');
  if (!(c['cognito:groups'] ?? []).includes(group)) throw fail(403, `not in ${group}`);
  return c;
}
