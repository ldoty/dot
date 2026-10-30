// Each person's other email addresses: mail from one to Dot (dot@) or Molly (molly@) counts as theirs,
// like the verified email on their account. Everyone manages their own, at dot-y.co/me; nobody else's.
//   GET    /me/emails                  -> { primary, emails: [{ address, state: 'verified' | 'pending', expires? }] }
//   POST   /me/emails                  { address } -> sends a code to that address; { address, state: 'pending', expires }
//   POST   /me/emails/verify           { address, code } -> { address, state: 'verified' }
//   DELETE /me/emails/{address}
// An address counts only once its code comes back: whoever adds it must be able to read its mail, or
// anyone could claim someone else's address and have their mail accepted as them. An address is one
// person's: not anyone's account email, not claimed by someone else (the claim row is unique).
//
// Rows (family-people): EMAIL / <address>          { sub, verifiedAt }   the claim; the mail gates read this
//                       EMAILS#<sub> / <address>   { state, codeHash, expires, tries, sentAt, verifiedAt }
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

export const EMAIL = /^[^\s@<>"',;()[\]\\]+@[a-z0-9.-]+\.[a-z]{2,}$/;
export const MAX_EMAILS = 5;
const CODE_TTL_MS = 30 * 60_000;
const RESEND_MS = 60_000;
const MAX_TRIES = 5;

const hash = (sub, address, code) => createHash('sha256').update(`${sub}|${address}|${code}`).digest();
const out = (r) => ({ address: r.sk, state: r.state, ...(r.state === 'pending' ? { expires: r.expires } : {}) });

/**
 * deps: db, table, users() -> [{ sub, name, email }] (every account), sendCode({ to, code, name }),
 *   now(), code?() -> '123456'
 * -> route(routeKey, claims, body, pathParameters) -> { status, body } | null (not an email route)
 */
export function emailRoutes(deps) {
  const { db, table } = deps;
  const makeCode = deps.code ?? (() => String(randomInt(0, 1_000_000)).padStart(6, '0'));
  const get = async (pk, sk) => (await db.send(new GetCommand({ TableName: table, Key: { pk, sk } }))).Item;
  const put = (Item, cond) => db.send(new PutCommand({ TableName: table, Item, ...cond }));
  const del = (pk, sk) => db.send(new DeleteCommand({ TableName: table, Key: { pk, sk } }));
  async function mine(sub) {
    const items = [];
    let ExclusiveStartKey;
    do {
      const r = await db.send(new QueryCommand({ TableName: table, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': `EMAILS#${sub}` }, ExclusiveStartKey }));
      items.push(...r.Items);
      ExclusiveStartKey = r.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }
  const clean = (v) => String(v ?? '').trim().toLowerCase();

  return async (routeKey, claims, body, p) => {
    const sub = claims.sub;
    const now = deps.now();
    switch (routeKey) {
      case 'GET /me/emails': {
        const me = (await deps.users()).find((u) => u.sub === sub);
        const rows = (await mine(sub)).filter((r) => r.state === 'verified' || r.expires > now.toISOString());
        return { status: 200, body: { primary: me?.email ?? null, emails: rows.map(out).sort((a, b) => a.address.localeCompare(b.address)) } };
      }

      case 'POST /me/emails': {
        const address = clean(body.address);
        if (!EMAIL.test(address) || address.length > 200) return { status: 400, body: { error: 'that isn’t an email address' } };
        const users = await deps.users();
        const me = users.find((u) => u.sub === sub);
        if (me?.email?.toLowerCase() === address) return { status: 409, body: { error: 'that’s already your account’s email' } };
        // Someone's account email can't be anyone else's extra address
        if (users.some((u) => u.email?.toLowerCase() === address)) return { status: 409, body: { error: 'that address belongs to another account' } };
        const claim = await get('EMAIL', address);
        if (claim && claim.sub !== sub) return { status: 409, body: { error: 'that address belongs to someone else here' } };
        if (claim) return { status: 409, body: { error: 'that address is already yours' } };
        const rows = await mine(sub);
        const row = rows.find((r) => r.sk === address);
        if (!row && rows.length >= MAX_EMAILS) return { status: 400, body: { error: `up to ${MAX_EMAILS} addresses` } };
        if (row?.sentAt && now - new Date(row.sentAt) < RESEND_MS) return { status: 429, body: { error: 'a code was just sent; wait a minute to send another' } };
        const code = makeCode();
        const item = {
          pk: `EMAILS#${sub}`, sk: address, state: 'pending', codeHash: hash(sub, address, code).toString('hex'),
          expires: new Date(now.getTime() + CODE_TTL_MS).toISOString(), tries: 0, sentAt: now.toISOString(),
        };
        await put(item);
        await deps.sendCode({ to: address, code, name: me?.name ?? 'someone' });
        console.log('email code sent', JSON.stringify({ sub }));
        return { status: 200, body: out(item) };
      }

      case 'POST /me/emails/verify': {
        const address = clean(body.address), code = String(body.code ?? '').replace(/\s/g, '');
        const row = await get(`EMAILS#${sub}`, address);
        if (!row || row.state !== 'pending') return { status: 404, body: { error: 'no code is waiting for that address' } };
        if (row.expires <= now.toISOString()) return { status: 410, body: { error: 'that code has expired; send a new one' } };
        if (row.tries >= MAX_TRIES) return { status: 429, body: { error: 'too many wrong codes; send a new one' } };
        const ok = /^\d{6}$/.test(code) && timingSafeEqual(hash(sub, address, code), Buffer.from(row.codeHash, 'hex'));
        if (!ok) {
          await put({ ...row, tries: row.tries + 1 });
          return { status: 400, body: { error: 'that’s not the code' } };
        }
        try {
          await put({ pk: 'EMAIL', sk: address, sub, verifiedAt: now.toISOString() }, { ConditionExpression: 'attribute_not_exists(pk)' });
        } catch (e) {
          if (e.name !== 'ConditionalCheckFailedException') throw e;
          return { status: 409, body: { error: 'that address belongs to someone else here' } };
        }
        await put({ pk: `EMAILS#${sub}`, sk: address, state: 'verified', verifiedAt: now.toISOString() });
        console.log('email verified', JSON.stringify({ sub }));
        return { status: 200, body: { address, state: 'verified' } };
      }

      case 'DELETE /me/emails/{address}': {
        const address = clean(decodeURIComponent(p.address ?? ''));
        await del(`EMAILS#${sub}`, address);
        // Only their own claim: never someone else's
        const claim = await get('EMAIL', address);
        if (claim?.sub === sub) await del('EMAIL', address);
        return { status: 200, body: { address } };
      }

      default:
        return null;
    }
  };
}
