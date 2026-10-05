// SimpleFIN Bridge (https://www.simplefin.org/protocol.html).
//
// The secret in SSM is either:
//   - a setup token: base64 of a one-time claim URL. POSTing to it returns the access URL, and the
//     token is spent, so the caller must store the access URL right away (sync.mjs does), or
//   - the access URL itself: https://user:pass@host/path, read-only, revocable at the Bridge.
// fetch refuses URLs with credentials in them, so they move into a Basic auth header.

export const PLACEHOLDER = 'paste-simplefin-setup-token-or-access-url';

/** 'access' | 'setup' | 'missing' for the stored secret */
export function secretKind(secret) {
  const s = String(secret || '').trim();
  if (!s || s === PLACEHOLDER) return 'missing';
  if (/^https:\/\/[^/\s]+:[^/\s]+@/.test(s)) return 'access';
  return claimUrl(s) ? 'setup' : 'missing';
}

function claimUrl(token) {
  try {
    const url = Buffer.from(token.trim(), 'base64').toString('utf8').trim();
    return /^https:\/\/\S+$/.test(url) ? url : null;
  } catch {
    return null;
  }
}

/** Spends a setup token; returns the access URL */
export async function claim(token, { fetch = globalThis.fetch } = {}) {
  const url = claimUrl(token);
  if (!url) throw new Error('That isn’t a SimpleFIN setup token.');
  const res = await fetch(url, { method: 'POST', headers: { 'content-length': '0' } });
  if (res.status === 403) throw new Error('SimpleFIN refused the setup token: it was already used or doesn’t exist. Make a new one at the Bridge.');
  if (!res.ok) throw new Error(`SimpleFIN claim failed (${res.status}).`);
  const access = (await res.text()).trim();
  if (secretKind(access) !== 'access') throw new Error('SimpleFIN’s claim answer wasn’t an access URL.');
  return access;
}

/** GET /accounts. `start`/`end` are Date; returns SimpleFIN's AccountSet ({ errors, accounts }) */
export async function fetchAccounts(accessUrl, { start, end, accounts, fetch = globalThis.fetch } = {}) {
  const u = new URL(accessUrl);
  const auth = Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64');
  u.username = ''; u.password = '';
  const base = u.toString().replace(/\/+$/, '');
  const q = new URLSearchParams();
  if (start) q.set('start-date', String(Math.floor(start.getTime() / 1000)));
  if (end) q.set('end-date', String(Math.floor(end.getTime() / 1000)));
  for (const id of accounts || []) q.append('account', id); // only these accounts
  const res = await fetch(`${base}/accounts?${q}`, { headers: { authorization: `Basic ${auth}` } });
  if (res.status === 403) throw Object.assign(new Error('SimpleFIN refused the access URL (revoked?). Make a new setup token at the Bridge.'), { revoked: true });
  if (!res.ok) throw new Error(`SimpleFIN answered ${res.status}.`);
  const body = await res.json();
  // Older servers send `errors` (strings); newer ones `errlist` ({ code, msg, ... })
  const errors = [...(body.errors || []), ...(body.errlist || []).map((e) => e.msg || e.message || e.code)].filter(Boolean).map(String);
  return { errors, accounts: body.accounts || [] };
}
