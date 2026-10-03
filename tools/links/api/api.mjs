// Links API: family bookmarks grouped into sections. Routes (all require a family_links access token):
//   GET    /all              -> { sections: [{ id, name, order }], links: [{ id, sectionId, title, url, order }] }
//   PUT    /sections/{id}    { name, order }
//   DELETE /sections/{id}    also deletes its links
//   PUT    /links/{id}       { sectionId, title, url, order }   url must be http(s)
//   DELETE /links/{id}
// Rows (pk = TOOL): SECTION#<id>, LINK#<id>.
// The token is re-verified here (signature, issuer, client, expiry, group); API Gateway's
// authorizer is not trusted on its own.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { verifyAccessToken } from './verify-token.mjs';

const { TABLE, GROUP, ISSUER, CLIENT_ID } = process.env;
const PK = 'TOOL';
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const json = (statusCode, body) => ({
  statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Only http(s) URLs, so a saved link can never run script when clicked */
function safeUrl(v) {
  try {
    const u = new URL(text(v, 2000));
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

async function queryPrefix(prefix) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const r = await db.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
      ExpressionAttributeValues: { ':pk': PK, ':p': prefix },
      ExclusiveStartKey,
    }));
    items.push(...r.Items);
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

const byOrder = (a, b) => a.order - b.order;

async function getAll() {
  const sections = (await queryPrefix('SECTION#'))
    .map((i) => ({ id: i.sk.slice(8), name: i.name, order: i.order })).sort(byOrder);
  const links = (await queryPrefix('LINK#'))
    .map((i) => ({ id: i.sk.slice(5), sectionId: i.sectionId, title: i.title, url: i.url, order: i.order })).sort(byOrder);
  return { sections, links };
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
  const id = event.pathParameters?.id;
  if (id !== undefined && !/^[A-Za-z0-9_-]{1,40}$/.test(id)) return json(400, { error: 'bad id' });
  const stamp = { updatedAt: new Date().toISOString(), updatedBy: claims.username };
  const order = Number.isFinite(body.order) ? body.order : Date.now();

  switch (event.routeKey) {
    case 'GET /all':
      return json(200, await getAll());

    case 'PUT /sections/{id}': {
      const name = text(body.name, 80);
      if (!name) return json(400, { error: 'name required' });
      await db.send(new PutCommand({ TableName: TABLE, Item: { pk: PK, sk: `SECTION#${id}`, name, order, ...stamp } }));
      return json(200, { id });
    }
    case 'DELETE /sections/{id}': {
      for (const l of (await queryPrefix('LINK#')).filter((i) => i.sectionId === id)) {
        await db.send(new DeleteCommand({ TableName: TABLE, Key: { pk: PK, sk: l.sk } }));
      }
      await db.send(new DeleteCommand({ TableName: TABLE, Key: { pk: PK, sk: `SECTION#${id}` } }));
      return json(200, { id });
    }

    case 'PUT /links/{id}': {
      const url = safeUrl(body.url);
      if (!url) return json(400, { error: 'url must start with http:// or https://' });
      const sectionId = text(body.sectionId, 40);
      if (!sectionId || !(await db.send(new GetCommand({ TableName: TABLE, Key: { pk: PK, sk: `SECTION#${sectionId}` } }))).Item) {
        return json(400, { error: 'no such section' });
      }
      const title = text(body.title, 120) || new URL(url).hostname;
      await db.send(new PutCommand({ TableName: TABLE, Item: { pk: PK, sk: `LINK#${id}`, sectionId, title, url, order, ...stamp } }));
      return json(200, { id, url, title });
    }
    case 'DELETE /links/{id}':
      await db.send(new DeleteCommand({ TableName: TABLE, Key: { pk: PK, sk: `LINK#${id}` } }));
      return json(200, { id });

    default:
      return json(404, { error: 'no route' });
  }
};
