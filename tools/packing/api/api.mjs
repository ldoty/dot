// Packing API: one packing list, kept whole in a single row (it's small: categories and items).
// Routes (all require a lukes_packing access token):
//   GET /list  -> { categories: [{ id, name }], items: [{ id, text, categoryId, status }], rev }
//   PUT /list  { categories, items, rev } -> { rev }   (409 { error, current } if someone saved since `rev`)
// status is '' (to pack), 'b' (to buy), 'c' (to check), 'v' (to verify) or 'x' (packed).
// The token is re-verified here (signature, issuer, client, expiry, group); API Gateway's
// authorizer is not trusted on its own.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { verifyAccessToken } from './verify-token.mjs';

const { TABLE, GROUP, ISSUER, CLIENT_ID } = process.env;
const KEY = { pk: 'TOOL', sk: 'LIST#main' };
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const STATUSES = ['', 'b', 'c', 'v', 'x'];
// Far above a real list, far below DynamoDB's 400 KB row limit.
const MAX_CATEGORIES = 100, MAX_ITEMS = 1500;
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const json = (statusCode, body) => ({
  statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

const out = (row) => ({ categories: row?.categories || [], items: row?.items || [], rev: row?.rev || 0 });
const clean = (s, max) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '');

// Keep only the fields the page uses, so the row can't grow junk; refuse anything malformed
// rather than guess, since a bad save would overwrite the whole list.
function parseList(body) {
  const { categories, items } = body;
  if (!Array.isArray(categories) || !Array.isArray(items)) return 'categories and items must be lists';
  if (categories.length > MAX_CATEGORIES || items.length > MAX_ITEMS) return 'too many';
  const cats = [], seen = new Set();
  for (const c of categories) {
    const name = clean(c?.name, 200);
    if (!ID.test(c?.id) || seen.has(c.id) || !name) return 'bad category';
    seen.add(c.id);
    cats.push({ id: c.id, name });
  }
  const its = [], seenItems = new Set();
  for (const i of items) {
    const text = clean(i?.text, 500);
    const status = i?.status ?? '';
    if (!ID.test(i?.id) || seenItems.has(i.id) || !text || !seen.has(i.categoryId) || !STATUSES.includes(status)) return 'bad item';
    seenItems.add(i.id);
    its.push({ id: i.id, text, categoryId: i.categoryId, status });
  }
  return { categories: cats, items: its };
}

export const handler = async (event) => {
  let claims;
  try {
    claims = await verifyAccessToken(event.headers, { issuer: ISSUER, clientId: CLIENT_ID, group: GROUP });
  } catch (e) {
    if (!e.status) throw e;
    console.warn('denied', e.message);
    return json(e.status, { error: e.status === 403 ? 'forbidden' : 'unauthorized' });
  }

  let body = {};
  if (event.body) {
    try {
      body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body);
    } catch {
      return json(400, { error: 'bad json' });
    }
  }

  const current = async () => out((await db.send(new GetCommand({ TableName: TABLE, Key: KEY }))).Item);

  switch (event.routeKey) {
    case 'GET /list':
      return json(200, await current());
    case 'PUT /list': {
      const list = parseList(body || {});
      if (typeof list === 'string') return json(400, { error: list });
      const rev = body.rev;
      if (!Number.isInteger(rev) || rev < 0) return json(400, { error: 'rev required' });
      try {
        await db.send(new PutCommand({
          TableName: TABLE,
          Item: { ...KEY, ...list, rev: rev + 1, updatedAt: new Date().toISOString(), updatedBy: claims.username },
          ...(rev === 0
            ? { ConditionExpression: 'attribute_not_exists(pk)' }
            : { ConditionExpression: 'rev = :rev', ExpressionAttributeValues: { ':rev': rev } }),
        }));
      } catch (e) {
        if (e.name !== 'ConditionalCheckFailedException') throw e;
        return json(409, { error: 'changed', current: await current() });
      }
      return json(200, { rev: rev + 1 });
    }
    default:
      return json(404, { error: 'no route' });
  }
};
