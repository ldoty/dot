// Dot (or another trusted signer) acting on behalf of a family member.
//
// Dot never holds access of its own to a tool. For one request it gets a short-lived token for
// the asker, from the tool's *delegated* app client (modules/family-app `delegated = true`):
//
//   1. Dot signs an assertion with a KMS key only its role may use:
//        { iss: "dot", aud: <delegated client>, sub, username, channel, iat, exp (≤ 2 min) }
//   2. Dot runs Cognito custom auth on that client and answers the challenge with it.
//   3. core/lambda/sso-auth.mjs checks the signature, audience, user and expiry
//      (verifyAssertion below). Delegated clients accept nothing else, and normal clients
//      never accept an assertion, so Dot can't get a regular, writable token.
//   4. The pre-token gate still requires the tool's group, so Dot sees exactly what the asker
//      can, and it marks the token `via: "dot"`. Tools treat those tokens as read-only.
//
// Other signers work the same way with their own key and `iss` (e.g. "luke_finances" reading
// the budget). Core lists each signer and the users it may act for; a delegated client lists
// the signers it accepts (family-app `delegates`, default ["dot"]).
import { createPublicKey, verify } from 'node:crypto';

export const ISSUER = 'dot';
export const MAX_LIFETIME_S = 120;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const unb64 = (s) => JSON.parse(Buffer.from(s, 'base64url').toString());

/** Signs an assertion; `sign(bytes) -> Promise<Buffer>` is KMS Sign (RSASSA_PKCS1_V1_5_SHA_256) */
export async function signAssertion({ clientId, sub, username, channel, sign, issuer = ISSUER, now = Date.now() }) {
  const iat = Math.floor(now / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT', kid: issuer })}.${b64({ iss: issuer, aud: clientId, sub, username, channel, iat, exp: iat + 60 })}`;
  return `${unsigned}.${(await sign(Buffer.from(unsigned))).toString('base64url')}`;
}

/** Who claims to have signed `token` (unverified: only for picking the key to check it with) */
export function assertionIssuer(token) {
  try {
    return unb64(String(token || '').split('.')[1]).iss ?? null;
  } catch {
    return null;
  }
}

/** Throws unless `token` is a valid assertion from `issuer` for this client and user; returns its claims */
export function verifyAssertion(token, { publicKey, issuer = ISSUER, clientId, username, sub, now = Date.now() }) {
  const [h, p, sig] = String(token || '').split('.');
  if (!sig) throw new Error('malformed assertion');
  let header, c;
  try {
    header = unb64(h);
    c = unb64(p);
  } catch {
    throw new Error('malformed assertion');
  }
  if (header.alg !== 'RS256') throw new Error('bad alg');
  if (!verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig, 'base64url'))) throw new Error('bad signature');
  const t = Math.floor(now / 1000);
  if (c.iss !== issuer) throw new Error('wrong issuer');
  if (c.aud !== clientId) throw new Error('assertion is for another app');
  if (c.username !== username || (sub && c.sub !== sub)) throw new Error('assertion is for another user');
  if (!(c.exp > t) || !(c.iat <= t + 5) || c.exp - c.iat > MAX_LIFETIME_S) throw new Error('expired or too long-lived');
  return c;
}

/** KMS GetPublicKey's DER bytes -> a KeyObject */
export const publicKeyFromDer = (der) => createPublicKey({ key: Buffer.from(der), format: 'der', type: 'spki' });

/**
 * The signer's side: tokenFor({ clientId, sub, username, channel }) -> access token for that user on
 * that tool's delegated client. Cached per client + user until a minute before it expires.
 */
export function makeDelegation({ sign, region, issuer = ISSUER, fetch = globalThis.fetch, now = () => Date.now() }) {
  const cache = new Map();
  async function idp(target, body) {
    const res = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}` },
      body: JSON.stringify(body),
    });
    const j = await res.json();
    if (!res.ok) {
      // The sign-in gate's refusal, e.g. "You don't have access to family_budget. Ask an admin to add you."
      const message = String(j.message || `sign-in failed (${res.status})`).replace(/^PreTokenGeneration failed with error /, '');
      throw Object.assign(new Error(message), { status: res.status, denied: /access to/.test(message) });
    }
    return j;
  }
  return async function tokenFor({ clientId, sub, username, channel }) {
    const key = `${clientId}|${sub}`;
    const hit = cache.get(key);
    if (hit && hit.expires - 60_000 > now()) return hit.token;
    const c = await idp('InitiateAuth', { AuthFlow: 'CUSTOM_AUTH', ClientId: clientId, AuthParameters: { USERNAME: username } });
    const answer = await signAssertion({ clientId, sub, username, channel, sign, issuer, now: now() });
    const r = await idp('RespondToAuthChallenge', {
      ClientId: clientId, ChallengeName: 'CUSTOM_CHALLENGE', Session: c.Session,
      ChallengeResponses: { USERNAME: c.ChallengeParameters?.USERNAME || username, ANSWER: answer },
    });
    const t = r.AuthenticationResult;
    if (!t?.AccessToken) throw new Error('sign-in failed');
    cache.set(key, { token: t.AccessToken, expires: now() + t.ExpiresIn * 1000 });
    return t.AccessToken;
  };
}
