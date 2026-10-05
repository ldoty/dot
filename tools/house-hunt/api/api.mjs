// House Hunt API. Routes (all require a family_house_hunt access token):
//   GET    /all              -> { hoods, listings, places, mail, notes: { text, rev, updatedAt, updatedByName } }
//   PUT    /hoods/{id}       { name, summary, pool, elementary, middle, high, schoolNote, price, priceNote,
//                             sales, status, rank, visited, fitNote, facts, drives, ll, notes, source,
//                             order, rev, byName } -> the saved neighborhood
//   DELETE /hoods/{id}       (its listings move to unsorted)
//   PUT    /listings/{id}    { address, hoodId, rank, price, beds, baths, sqft, url, status, notes, reviewed, …, rev, byName }
//   DELETE /listings/{id}
//   PUT    /notes            { text, rev, byName } -> the saved notes
// Places (parks, the airport, family) are map reference points, loaded by scripts/seed.mjs; read-only here.
// Listings also arrive by email (ingest.mjs); `mail` is the last few emails it handled, newest first.
// Every write carries the rev it was edited from (0 = new). If someone else saved in between,
// the write is refused with 409 and the current row, so nobody's notes are silently overwritten.
// The token is re-verified here (signature, issuer, client, expiry, group); API Gateway's
// authorizer is not trusted on its own.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { verifyAccessToken } from './verify-token.mjs';
import { cleanListing, listingOut } from './listing.mjs';

const { TABLE, GROUP, ISSUER, CLIENT_ID } = process.env;
const PK = 'TOOL';
const STATUSES = ['shortlist', 'explore', 'nogo'];
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const json = (statusCode, body) => ({
  statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const whole = (v, max) => (Number.isInteger(v) && v >= 0 && v <= max ? v : null);
const webUrl = (v) => {
  try { const u = new URL(str(v, 500)); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : ''; } catch { return ''; }
};

// [lat, lng] in range, or null
const latLng = (v) => (Array.isArray(v) && v.length === 2 && v.every(Number.isFinite)
  && Math.abs(v[0]) <= 90 && Math.abs(v[1]) <= 180 ? [v[0], v[1]] : null);
const hoodOut = (i) => ({
  id: i.sk.slice(5), name: i.name, summary: i.summary || '', pool: i.pool, elementary: i.elementary, middle: i.middle, high: i.high,
  schoolNote: i.schoolNote || '', price: i.price ?? null, priceNote: i.priceNote, sales: i.sales ?? null,
  status: i.status, rank: i.rank ?? null, visited: i.visited || '', fitNote: i.fitNote || '',
  facts: i.facts || [], drives: i.drives || [], ll: i.ll || null, notes: i.notes,
  source: i.source, order: i.order, rev: i.rev, updatedAt: i.updatedAt, updatedByName: i.updatedByName || '',
});
const placeOut = (i) => ({ id: i.sk.slice(6), kind: i.kind, name: i.name, note: i.note || '', ll: i.ll || null });
const mailOut = (i) => ({ receivedAt: i.receivedAt, subject: i.subject, from: i.from, outcome: i.outcome, found: i.found ?? 0, added: i.added ?? 0, updated: i.updated ?? 0 });
const notesOut = (i) => (i
  ? { text: i.text, rev: i.rev, updatedAt: i.updatedAt, updatedByName: i.updatedByName || '' }
  : { text: '', rev: 0, updatedAt: null, updatedByName: '' });

// Writes item only if the stored row is still at `rev` (0 = must not exist yet).
async function putAt(item, rev) {
  try {
    await db.send(new PutCommand({
      TableName: TABLE,
      Item: { ...item, rev: rev + 1 },
      ...(rev === 0
        ? { ConditionExpression: 'attribute_not_exists(pk)' }
        : { ConditionExpression: 'rev = :rev', ExpressionAttributeValues: { ':rev': rev } }),
    }));
    return true;
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') return false;
    throw e;
  }
}
const current = async (sk) => (await db.send(new GetCommand({ TableName: TABLE, Key: { pk: PK, sk } }))).Item;

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
  const id = event.pathParameters?.id;
  if (id !== undefined && !/^[A-Za-z0-9_-]{1,40}$/.test(id)) return json(400, { error: 'bad id' });
  // byName is the editor's first name from the page's ID token: display only, never used for access
  const stamp = { updatedAt: new Date().toISOString(), updatedBy: claims.username, updatedByName: str(body.byName, 40) };
  const rev = whole(body.rev, 1e9);

  switch (event.routeKey) {
    case 'GET /all': {
      const r = await db.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': PK },
      }));
      const hoods = r.Items.filter((i) => i.sk.startsWith('HOOD#')).map(hoodOut);
      const places = r.Items.filter((i) => i.sk.startsWith('PLACE#')).map(placeOut);
      const listings = r.Items.filter((i) => i.sk.startsWith('LISTING#')).map(listingOut);
      const mail = r.Items.filter((i) => i.sk.startsWith('MAIL#')).map(mailOut).sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1)).slice(0, 10);
      return json(200, { hoods, listings, places, mail, notes: notesOut(r.Items.find((i) => i.sk === 'NOTES')) });
    }
    case 'PUT /hoods/{id}': {
      const name = str(body.name, 120);
      if (!name) return json(400, { error: 'name required' });
      if (rev === null) return json(400, { error: 'rev required' });
      if (body.price != null && whole(body.price, 1e8) === null) return json(400, { error: 'price must be whole dollars' });
      if (body.sales != null && whole(body.sales, 10000) === null) return json(400, { error: 'sales must be a whole number' });
      const status = body.status ?? 'explore';
      if (!STATUSES.includes(status)) return json(400, { error: `status must be one of ${STATUSES.join(', ')}` });
      if (body.rank != null && whole(body.rank, 99) === null) return json(400, { error: 'rank must be a whole number' });
      if (body.ll != null && !latLng(body.ll)) return json(400, { error: 'll must be [lat, lng]' });
      const facts = body.facts ?? [];
      if (!Array.isArray(facts) || facts.length > 12 || facts.some((f) => typeof f !== 'string')) return json(400, { error: 'facts must be up to 12 lines' });
      const drives = body.drives ?? [];
      if (!Array.isArray(drives) || drives.length > 8 || drives.some((d) => !d || !str(d.to, 60) || whole(d.min, 600) === null
        || (d.mi != null && !(Number.isFinite(d.mi) && d.mi >= 0 && d.mi < 1000)))) return json(400, { error: 'drives must be up to 8 of { to, min, mi }' });
      const item = {
        pk: PK, sk: `HOOD#${id}`, name,
        pool: str(body.pool, 200), elementary: str(body.elementary, 80), middle: str(body.middle, 80), high: str(body.high, 80),
        summary: str(body.summary, 300), schoolNote: str(body.schoolNote, 300),
        price: body.price ?? null, priceNote: str(body.priceNote, 300), sales: body.sales ?? null,
        status, rank: status === 'shortlist' ? body.rank ?? null : null, visited: str(body.visited, 40), fitNote: str(body.fitNote, 200),
        facts: facts.map((f) => str(f, 200)).filter(Boolean),
        drives: drives.map((d) => ({ to: str(d.to, 60), min: d.min, mi: d.mi ?? null })), ll: latLng(body.ll),
        notes: str(body.notes, 5000), source: webUrl(body.source),
        order: Number.isFinite(body.order) ? body.order : Date.now(), ...stamp,
      };
      if (!(await putAt(item, rev))) {
        const now = await current(item.sk);
        return json(409, { error: 'changed by someone else', current: now ? hoodOut(now) : null });
      }
      return json(200, hoodOut({ ...item, rev: rev + 1 }));
    }
    case 'DELETE /hoods/{id}': {
      await db.send(new DeleteCommand({ TableName: TABLE, Key: { pk: PK, sk: `HOOD#${id}` } }));
      const r = await db.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
        ExpressionAttributeValues: { ':pk': PK, ':p': 'LISTING#' },
      }));
      // A listing being edited right now keeps its neighborhood; it can be moved by hand
      for (const l of r.Items.filter((i) => i.hoodId === id)) await putAt({ ...l, hoodId: null, rank: null, ...stamp }, l.rev);
      return json(200, { id });
    }
    case 'PUT /listings/{id}': {
      if (rev === null) return json(400, { error: 'rev required' });
      const { listing, error } = cleanListing(body, id);
      if (error) return json(400, { error });
      const now = new Date().toISOString();
      const { id: _, ...fields } = listing;
      const item = { pk: PK, sk: `LISTING#${id}`, ...fields, firstSeenAt: fields.firstSeenAt || now, ...stamp };
      if (!(await putAt(item, rev))) {
        const cur = await current(item.sk);
        return json(409, { error: 'changed by someone else', current: cur ? listingOut(cur) : null });
      }
      return json(200, listingOut({ ...item, rev: rev + 1 }));
    }
    case 'DELETE /listings/{id}':
      await db.send(new DeleteCommand({ TableName: TABLE, Key: { pk: PK, sk: `LISTING#${id}` } }));
      return json(200, { id });
    case 'PUT /notes': {
      if (rev === null) return json(400, { error: 'rev required' });
      const item = { pk: PK, sk: 'NOTES', text: str(body.text, 20000), ...stamp };
      if (!(await putAt(item, rev))) return json(409, { error: 'changed by someone else', current: notesOut(await current('NOTES')) });
      return json(200, notesOut({ ...item, rev: rev + 1 }));
    }
    default:
      return json(404, { error: 'no route' });
  }
};
