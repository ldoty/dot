// Trip planner API. Each trip is one row holding everything about it: details, notes, itinerary
// and its packing list (small enough to save whole, rev-checked).
// Routes (all require a lukes_trip_planner access token):
//   GET    /trips        -> [{ id, name, type, where, start, end, items, packed, updatedAt }]  (by start date)
//   GET    /trips/{id}   -> { id, name, type, where, start, end, notes, itinerary, categories, items, rev }
//   PUT    /trips/{id}   { …that, rev } -> { rev }   rev 0 books a new trip; 409 { error, current } if
//                         someone saved since `rev`, 404 if the trip was deleted meanwhile
//   DELETE /trips/{id}
// A packing item's status is '' (to pack), 'b' (to buy), 'c' (to check), 'v' (to verify), 'p' (on the packed list) or 'x' (packed).
// The token is re-verified here (signature, issuer, client, expiry, group); API Gateway's
// authorizer is not trusted on its own.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { verifyAccessToken } from './verify-token.mjs';

const { TABLE, GROUP, ISSUER, CLIENT_ID } = process.env;
const PK = 'TOOL';
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const TYPES = ['backpacking'];
const STATUSES = ['', 'b', 'c', 'v', 'p', 'x'];
// Far above a real trip, far below DynamoDB's 400 KB row limit.
const MAX_CATEGORIES = 100, MAX_ITEMS = 1500, MAX_TEXT = 20000;
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const json = (statusCode, body) => ({
  statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

const key = (id) => ({ pk: PK, sk: `TRIP#${id}` });
const FIELDS = ['id', 'name', 'type', 'where', 'start', 'end', 'notes', 'itinerary', 'categories', 'items', 'rev'];
const tripOut = (row) => Object.fromEntries(FIELDS.map((f) => [f, row[f]]));
const summary = (row) => ({
  id: row.id, name: row.name, type: row.type, where: row.where, start: row.start, end: row.end,
  items: row.items.length, packed: row.items.filter((i) => i.status === 'x').length, updatedAt: row.updatedAt,
});
const line = (s, max) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '');
// Notes and the itinerary keep their line breaks; only trailing space goes.
const text = (s) => (typeof s === 'string' ? s.replace(/\r\n/g, '\n').replace(/\s+$/, '') : '');
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

// Keep only the fields the page uses, so a row can't grow junk; refuse anything malformed
// rather than guess, since every save replaces the whole trip.
function parseTrip(b) {
  const name = line(b.name, 200);
  if (!name) return 'name required';
  if (!TYPES.includes(b.type)) return 'unknown trip type';
  if (!isDate(b.start) || !isDate(b.end) || b.end < b.start) return 'bad dates';
  const notes = text(b.notes), itinerary = text(b.itinerary);
  if (notes.length > MAX_TEXT || itinerary.length > MAX_TEXT) return 'too long';
  const { categories = [], items = [] } = b;
  if (!Array.isArray(categories) || !Array.isArray(items)) return 'categories and items must be lists';
  if (categories.length > MAX_CATEGORIES || items.length > MAX_ITEMS) return 'too many';
  const cats = [], seen = new Set();
  for (const c of categories) {
    const cname = line(c?.name, 200);
    if (!ID.test(c?.id) || seen.has(c.id) || !cname) return 'bad category';
    seen.add(c.id);
    cats.push({ id: c.id, name: cname });
  }
  const its = [], seenItems = new Set();
  for (const i of items) {
    const itext = line(i?.text, 500);
    const status = i?.status ?? '';
    if (!ID.test(i?.id) || seenItems.has(i.id) || !itext || !seen.has(i.categoryId) || !STATUSES.includes(status)) return 'bad item';
    seenItems.add(i.id);
    its.push({ id: i.id, text: itext, categoryId: i.categoryId, status });
  }
  return { name, type: b.type, where: line(b.where, 200), start: b.start, end: b.end, notes, itinerary, categories: cats, items: its };
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
      body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body) || {};
    } catch {
      return json(400, { error: 'bad json' });
    }
  }
  const id = event.pathParameters?.id;
  if (id !== undefined && !ID.test(id)) return json(400, { error: 'bad id' });
  const get = async () => (await db.send(new GetCommand({ TableName: TABLE, Key: key(id) }))).Item;

  switch (event.routeKey) {
    case 'GET /trips': {
      const rows = [];
      let start;
      do {   // follow pages: DynamoDB stops at 1 MB
        const r = await db.send(new QueryCommand({
          TableName: TABLE,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
          ExpressionAttributeValues: { ':pk': PK, ':p': 'TRIP#' },
          ExclusiveStartKey: start,
        }));
        rows.push(...r.Items);
        start = r.LastEvaluatedKey;
      } while (start);
      rows.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.name.localeCompare(b.name)));
      return json(200, rows.map(summary));
    }
    case 'GET /trips/{id}': {
      const row = await get();
      return row ? json(200, tripOut(row)) : json(404, { error: 'no such trip' });
    }
    case 'PUT /trips/{id}': {
      const trip = parseTrip(body);
      if (typeof trip === 'string') return json(400, { error: trip });
      const rev = body.rev;
      if (!Number.isInteger(rev) || rev < 0) return json(400, { error: 'rev required' });
      const now = new Date().toISOString();
      try {
        await db.send(new PutCommand({
          TableName: TABLE,
          Item: { ...key(id), id, ...trip, rev: rev + 1, updatedAt: now, updatedBy: claims.username },
          ...(rev === 0
            ? { ConditionExpression: 'attribute_not_exists(pk)' }
            : { ConditionExpression: 'rev = :rev', ExpressionAttributeValues: { ':rev': rev } }),
        }));
      } catch (e) {
        if (e.name !== 'ConditionalCheckFailedException') throw e;
        const cur = await get();
        return cur ? json(409, { error: 'changed', current: tripOut(cur) }) : json(404, { error: 'no such trip' });
      }
      return json(200, { rev: rev + 1 });
    }
    case 'DELETE /trips/{id}':
      await db.send(new DeleteCommand({ TableName: TABLE, Key: key(id) }));
      return json(200, { id });
    default:
      return json(404, { error: 'no route' });
  }
};
