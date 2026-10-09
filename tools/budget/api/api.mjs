// Budget API. The household has three budgets ("docs"): shared, Luke, Amber. Each has its own
// working copy, saved versions and tags (names for versions; "default" opens on load).
// Personal docs also follow a Shared tag for their share of the shared costs.
//
//   GET    /all                       -> { docs: {doc: {state, rev}}, versions: {doc: [...]}, tags: {doc: [{name, versionId}]}, plans: [{id, name, plan, rev}] }
//   GET    /defaults                  -> { state }   the household's starting numbers (Reset)
//   PUT    /docs/{doc}/state          { state, rev } -> { rev }   409 + current { state, rev } if rev is stale
//   PUT    /docs/{doc}/versions/{id}  { name, savedAt, state }
//   DELETE /docs/{doc}/versions/{id}  409 if a tag points at it
//   PUT    /docs/{doc}/tags/{name}    { versionId }  (a version of that doc)
//   DELETE /docs/{doc}/tags/{name}    "default" can't be deleted
//   PUT    /plans/{id}                { name, plan, rev } -> { rev }   409 + current { name, plan, rev } if rev is stale
//   DELETE /plans/{id}
//
// Rows (pk = HOUSEHOLD#<id>): DOC#<doc>#STATE, DOC#<doc>#VERSION#<id>, TAG#<doc>#<name>, DEFAULTS,
// PLAN#<id> (a named plan on the Planning tab: which Shared tag applies from which month, plus one-off amounts).
//
// Auth is checked twice. API Gateway's JWT authorizer runs first, but this handler
// does not trust it: it re-verifies the token's signature against the pool's JWKS
// and checks issuer, expiry, token_use, client_id and the family_budget group itself.
// Dot reads the budget for whoever asks it, with a token from the delegated client
// (platform/api/delegation.mjs). Those tokens are read-only: any write is refused here.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { verifyAccessToken } from './verify-token.mjs';

const { TABLE, HOUSEHOLD, GROUP, ISSUER, CLIENT_ID, DELEGATED_CLIENT_ID } = process.env;
const PK = `HOUSEHOLD#${HOUSEHOLD}`;
const DOCS = ['shared', 'Luke', 'Amber'];
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// --- Data --------------------------------------------------------------------

const json = (statusCode, body) => ({
  statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const getItem = async (sk) => (await db.send(new GetCommand({ TableName: TABLE, Key: { pk: PK, sk } }))).Item;
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const stateKey = (doc) => `DOC#${doc}#STATE`;
const versionKey = (doc, id) => `DOC#${doc}#VERSION#${id}`;

async function queryAll(prefix) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const r = await db.send(new QueryCommand({
      TableName: TABLE,
      // DynamoDB rejects an empty begins_with value, so "everything" is a plain partition query
      ...(prefix
        ? { KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)', ExpressionAttributeValues: { ':pk': PK, ':p': prefix } }
        : { KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': PK } }),
      ExclusiveStartKey,
    }));
    items.push(...r.Items);
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function getAll() {
  const perDoc = () => Object.fromEntries(DOCS.map((d) => [d, []]));
  const out = { docs: {}, versions: perDoc(), tags: perDoc(), plans: [] };
  for (const i of await queryAll('')) {
    if (i.sk.startsWith('PLAN#')) { out.plans.push({ id: i.sk.slice(5), name: i.name, plan: JSON.parse(i.plan), rev: i.rev }); continue; }
    const [kind, doc, sub, id] = i.sk.split('#');
    if (!DOCS.includes(doc)) continue;
    if (kind === 'TAG' && sub) out.tags[doc].push({ name: sub, versionId: i.versionId });
    if (kind !== 'DOC') continue;
    if (sub === 'STATE') out.docs[doc] = { state: JSON.parse(i.state), rev: i.rev };
    if (sub === 'VERSION') out.versions[doc].push({ id, name: i.name, savedAt: i.savedAt, state: JSON.parse(i.state) });
  }
  for (const d of DOCS) out.versions[d].sort((a, b) => b.savedAt - a.savedAt);
  out.plans.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

async function putState(doc, body, user) {
  const expected = body.rev ?? null;
  if (!isObj(body.state) || !(expected === null || Number.isInteger(expected))) return json(400, { error: 'bad body' });
  const rev = (expected ?? 0) + 1;
  try {
    await db.send(new PutCommand({
      TableName: TABLE,
      Item: { pk: PK, sk: stateKey(doc), state: JSON.stringify(body.state), rev, updatedAt: new Date().toISOString(), updatedBy: user },
      ...(expected === null
        ? { ConditionExpression: 'attribute_not_exists(pk)' }
        : { ConditionExpression: 'rev = :rev', ExpressionAttributeValues: { ':rev': expected } }),
    }));
  } catch (e) {
    if (e.name !== 'ConditionalCheckFailedException') throw e;
    const cur = await getItem(stateKey(doc));
    return json(409, { state: JSON.parse(cur.state), rev: cur.rev });
  }
  return json(200, { rev });
}

// The plan is checked strictly: the page and Dot both read it, so a malformed one shouldn't get in.
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const TAG = /^[a-z0-9][a-z0-9_-]{0,29}$/;
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const isId = (v) => typeof v === 'string' && ID.test(v);
// Accounts: a starting balance (negative for a loan), a yearly rate, optionally the Shared budget line
// that pays the loan down (paidBy, an item name) and whether the month's savings land there.
// One-offs land in an account, or move money from it to another (to).
function cleanPlan(p) {
  if (!isObj(p) || !MONTH.test(p.start) || !Number.isInteger(p.months) || p.months < 1 || p.months > 120) return null;
  const accounts = p.accounts ?? [];
  if (!Number.isFinite(p.balance ?? 0) || !Array.isArray(p.steps) || !Array.isArray(p.oneOffs) || !Array.isArray(accounts)) return null;
  if (p.steps.length > 60 || p.oneOffs.length > 100 || accounts.length > 20) return null;
  const steps = p.steps.map((s) => (isObj(s) && MONTH.test(s.from) && TAG.test(s.tag) ? { from: s.from, tag: s.tag } : null));
  const accts = accounts.map((a) => (isObj(a) && isId(a.id) && typeof a.name === 'string' && Number.isFinite(a.balance)
    && Number.isFinite(a.rate) && a.rate >= -100 && a.rate <= 100 && (a.paidBy === undefined || typeof a.paidBy === 'string')
    ? { id: a.id, name: a.name.slice(0, 60), balance: a.balance, rate: a.rate, ...(a.paidBy ? { paidBy: a.paidBy.slice(0, 60) } : {}), ...(a.savings === true ? { savings: true } : {}) }
    : null));
  const oneOffs = p.oneOffs.map((o) => (isObj(o) && isId(o.id) && MONTH.test(o.month) && typeof o.label === 'string' && Number.isFinite(o.amount)
    && (o.account === undefined || isId(o.account)) && (o.to === undefined || isId(o.to))
    ? { id: o.id, month: o.month, label: o.label.slice(0, 60), amount: o.amount, ...(o.account ? { account: o.account } : {}), ...(o.to ? { to: o.to } : {}) }
    : null));
  if (steps.includes(null) || oneOffs.includes(null) || accts.includes(null)) return null;
  return { start: p.start, months: p.months, balance: p.balance ?? 0, steps, oneOffs, accounts: accts };
}

async function putPlan(id, body, user) {
  const expected = body.rev ?? null, plan = cleanPlan(body.plan);
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : '';
  if (!plan || !name || !(expected === null || Number.isInteger(expected))) return json(400, { error: 'bad plan' });
  const rev = (expected ?? 0) + 1;
  try {
    await db.send(new PutCommand({
      TableName: TABLE,
      Item: { pk: PK, sk: `PLAN#${id}`, name, plan: JSON.stringify(plan), rev, updatedAt: new Date().toISOString(), updatedBy: user },
      ...(expected === null
        ? { ConditionExpression: 'attribute_not_exists(pk)' }
        : { ConditionExpression: 'rev = :rev', ExpressionAttributeValues: { ':rev': expected } }),
    }));
  } catch (e) {
    if (e.name !== 'ConditionalCheckFailedException') throw e;
    const cur = await getItem(`PLAN#${id}`);
    // A plan someone else deleted comes back as gone, not as a conflict to merge
    if (!cur) return json(404, { error: 'plan deleted' });
    return json(409, { name: cur.name, plan: JSON.parse(cur.plan), rev: cur.rev });
  }
  return json(200, { rev });
}

async function putVersion(doc, id, body, user) {
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : '';
  if (!name || !isObj(body.state)) return json(400, { error: 'bad body' });
  await db.send(new PutCommand({
    TableName: TABLE,
    Item: {
      pk: PK, sk: versionKey(doc, id), name, savedAt: Number(body.savedAt) || Date.now(),
      state: JSON.stringify(body.state), updatedBy: user,
    },
  }));
  return json(200, { id });
}

async function deleteVersion(doc, id) {
  const tagged = (await queryAll(`TAG#${doc}#`)).filter((t) => t.versionId === id).map((t) => t.sk.split('#')[2]);
  if (tagged.length) return json(409, { error: 'tagged', tags: tagged });
  await db.send(new DeleteCommand({ TableName: TABLE, Key: { pk: PK, sk: versionKey(doc, id) } }));
  return json(200, { id });
}

async function putTag(doc, name, body, user) {
  const versionId = body.versionId;
  if (typeof versionId !== 'string' || !(await getItem(versionKey(doc, versionId)))) return json(400, { error: `no such ${doc} version` });
  await db.send(new PutCommand({
    TableName: TABLE,
    Item: { pk: PK, sk: `TAG#${doc}#${name}`, versionId, updatedAt: new Date().toISOString(), updatedBy: user },
  }));
  return json(200, { name, versionId });
}

// --- Handler -----------------------------------------------------------------

export const handler = async (event) => {
  let claims;
  try {
    claims = await verifyAccessToken(event.headers, { issuer: ISSUER, clientId: [CLIENT_ID, DELEGATED_CLIENT_ID].filter(Boolean), group: GROUP });
  } catch (e) {
    if (!e.status) throw e;
    console.warn('denied', e.message);
    return json(e.status, { error: e.status === 403 ? 'forbidden' : 'unauthorized' });
  }

  const viaDot = claims.via === 'dot' || (DELEGATED_CLIENT_ID && claims.client_id === DELEGATED_CLIENT_ID);
  if (viaDot && !event.routeKey?.startsWith('GET ')) {
    console.warn('denied: Dot is read-only', event.routeKey, claims.username);
    return json(403, { error: 'read-only' });
  }

  let body = {};
  if (event.body) {
    try {
      body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body);
    } catch {
      return json(400, { error: 'bad json' });
    }
  }
  const { doc, id, name } = event.pathParameters ?? {};
  if (doc !== undefined && !DOCS.includes(doc)) return json(400, { error: 'bad doc' });
  if (id !== undefined && !/^[A-Za-z0-9_-]{1,40}$/.test(id)) return json(400, { error: 'bad id' });
  if (name !== undefined && !/^[a-z0-9][a-z0-9_-]{0,29}$/.test(name)) return json(400, { error: 'bad tag name' });
  const user = claims.username;

  switch (event.routeKey) {
    case 'GET /all':
      return json(200, await getAll());
    case 'GET /defaults': {
      const d = await getItem('DEFAULTS');
      return d ? json(200, { state: JSON.parse(d.state) }) : json(404, { error: 'not found' });
    }
    case 'PUT /docs/{doc}/state':
      return putState(doc, body, user);
    case 'PUT /docs/{doc}/versions/{id}':
      return putVersion(doc, id, body, user);
    case 'DELETE /docs/{doc}/versions/{id}':
      return deleteVersion(doc, id);
    case 'PUT /docs/{doc}/tags/{name}':
      return putTag(doc, name, body, user);
    case 'PUT /plans/{id}':
      return putPlan(id, body, user);
    case 'DELETE /plans/{id}':
      await db.send(new DeleteCommand({ TableName: TABLE, Key: { pk: PK, sk: `PLAN#${id}` } }));
      return json(200, { id });
    case 'DELETE /docs/{doc}/tags/{name}':
      if (name === 'default') return json(400, { error: 'default can’t be deleted' });
      await db.send(new DeleteCommand({ TableName: TABLE, Key: { pk: PK, sk: `TAG#${doc}#${name}` } }));
      return json(200, { name });
    default:
      return json(404, { error: 'no route' });
  }
};
