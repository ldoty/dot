// Google service-account sign-in: the key JSON lives in SSM (SecureString); the access token
// is cached until shortly before it expires.
import { sign } from 'node:crypto';

export function makeGoogleAuth({ loadKey, fetch = globalThis.fetch, scope = 'https://www.googleapis.com/auth/calendar' }) {
  let key = null, token = null, expires = 0;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

  return async function accessToken() {
    if (token && Date.now() < expires - 60_000) return token;
    key ??= await loadKey();
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: key.client_email, scope, aud: key.token_uri, iat: now, exp: now + 3600 })}`;
    const assertion = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), key.private_key).toString('base64url')}`;
    const res = await fetch(key.token_uri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
    const body = await res.json();
    if (!res.ok || !body.access_token) throw new Error(`Google sign-in failed: ${body.error || res.status}`);
    token = body.access_token;
    expires = Date.now() + body.expires_in * 1000;
    return token;
  };
}
