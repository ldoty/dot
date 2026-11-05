// Chamber API for the page. Every route requires a lukes_chamber access token, re-verified here
// (signature, issuer, client, expiry, group); API Gateway's authorizer is not trusted on its own.
// The board writes through api/ingest.mjs instead; rows are listed there.
//
//   GET /readings?since=<ms>&fields=a,b  -> { now, fields: [...], rows: [[t, ...values], ...] }
//       Readings after `since` (at most 3 days back), oldest first; t is epoch ms. Rows are
//       arrays, not objects, and `fields` narrows the columns, to keep 3 days well inside
//       Lambda's 6 MB response limit.
//   GET /readings.csv?since=<ms>         -> text/csv, every field, at most the last 24 hours
//   GET /settings                         -> { spec, desired, active, activeAt }
//   PUT /settings  { values: {...} }      -> the same, after saving a new desired version
//       Edits merge onto what's saved (or what the board runs), are checked as a whole, and get a
//       version above any the board has applied or refused, so it always picks them up.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { verifyAccessToken } from './verify-token.mjs';
import { SPEC, settingsOf, validate } from './settings.mjs';

const { TABLE, GROUP, ISSUER, CLIENT_ID } = process.env;
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const HOUR = 3600e3;
const MAX_JSON_SPAN = 72 * HOUR;
const MAX_CSV_SPAN = 24 * HOUR;
const NOT_FIELDS = new Set(['pk', 'sk', 'expires']);

export const ROUTES = ['GET /readings', 'GET /readings.csv', 'GET /settings', 'PUT /settings'];

const json = (statusCode, body) => ({
  statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

const get = async (sk) => (await db.send(new GetCommand({ TableName: TABLE, Key: { pk: 'STATE', sk } }))).Item;

// Readings in (since, now], oldest first. One partition per UTC day; each can pass DynamoDB's
// 1 MB page, so follow LastEvaluatedKey.
async function readings(since, now) {
  const out = [];
  const sinceIso = new Date(since).toISOString();
  for (let day = Date.parse(sinceIso.slice(0, 10)); day <= now; day += 24 * HOUR) {
    let start;
    do {
      const r = await db.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': `R#${new Date(day).toISOString().slice(0, 10)}` },
        ExclusiveStartKey: start,
      }));
      for (const item of r.Items ?? []) if (item.sk > sinceIso) out.push(item);
      start = r.LastEvaluatedKey;
    } while (start);
  }
  return out;
}

// A `since` query parameter, clamped to the allowed span; missing means two hours.
function sinceParam(q, now, maxSpan) {
  const n = Number(q?.since);
  const since = q?.since !== undefined && Number.isFinite(n) ? n : now - 2 * HOUR;
  return Math.min(now, Math.max(since, now - maxSpan));
}

function fieldNames(items) {
  const names = new Set();
  for (const item of items) for (const k of Object.keys(item)) if (!NOT_FIELDS.has(k)) names.add(k);
  return [...names].sort();
}

async function settingsState() {
  const [desired, active] = await Promise.all([get('DESIRED'), get('ACTIVE')]);
  return {
    spec: SPEC,
    desired: desired ? { version: desired.version, values: desired.values } : null,
    active: active?.fields ?? null,
    activeAt: active?.at ?? null,
  };
}

async function saveSettings(values, username) {
  const edit = validate(values);
  if (edit.error) return json(400, { error: edit.error, ...(await settingsState()) });
  const [desired, active] = await Promise.all([get('DESIRED'), get('ACTIVE')]);
  const merged = validate({ ...settingsOf(active?.fields), ...desired?.values, ...edit.values });
  if (merged.error) return json(400, { error: merged.error, ...(await settingsState()) });
  // Above anything the board has applied or refused: it ignores a version it has already seen.
  const version = Math.max(desired?.version ?? 0, active?.fields?.version ?? 0, active?.fields?.rejected ?? 0) + 1;
  const at = new Date().toISOString();
  try {
    await db.send(new PutCommand({
      TableName: TABLE,
      Item: { pk: 'STATE', sk: 'DESIRED', version, values: merged.values, rev: version, at, by: username },
      ...(desired
        ? { ConditionExpression: 'rev = :rev', ExpressionAttributeValues: { ':rev': desired.rev } }
        : { ConditionExpression: 'attribute_not_exists(pk)' }),
    }));
  } catch (e) {
    if (e.name !== 'ConditionalCheckFailedException') throw e;
    return json(409, { error: 'Settings changed in the meantime. Check them and try again.', ...(await settingsState()) });
  }
  await db.send(new PutCommand({
    TableName: TABLE,
    Item: { pk: 'SETLOG', sk: `${at}#saved#${version}`, event: 'saved', version, values: merged.values, by: username },
  }));
  return json(200, await settingsState());
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
  const q = event.queryStringParameters;
  const now = Date.now();

  switch (event.routeKey) {
    case 'GET /readings': {
      const items = await readings(sinceParam(q, now, MAX_JSON_SPAN), now);
      let fields = fieldNames(items);
      if (q?.fields) {
        const want = new Set(q.fields.split(','));
        fields = fields.filter((f) => want.has(f));
      }
      const rows = items.map((i) => [Date.parse(i.sk), ...fields.map((f) => (i[f] === undefined ? null : i[f]))]);
      return json(200, { now, fields, rows });
    }
    case 'GET /readings.csv': {
      const items = await readings(sinceParam(q, now, MAX_CSV_SPAN), now);
      const fields = fieldNames(items);
      const lines = [['iso_time', 'epoch_s', ...fields].join(',')];
      for (const i of items) {
        lines.push([i.sk, Math.round(Date.parse(i.sk) / 1000), ...fields.map((f) => (i[f] === undefined ? '' : i[f]))].join(','));
      }
      return {
        statusCode: 200,
        headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="chamber.csv"' },
        body: `${lines.join('\n')}\n`,
      };
    }
    case 'GET /settings':
      return json(200, await settingsState());
    case 'PUT /settings':
      return saveSettings(body.values, claims.username);
    default:
      return json(404, { error: 'no route' });
  }
};
