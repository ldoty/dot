// __TITLE__ API. Routes (all require a __GROUP__ access token):
//   GET    /items        -> [{ id, name, updatedAt }]
//   PUT    /items/{id}   { name } -> { id }
//   DELETE /items/{id}
// The token is re-verified here (signature, issuer, client, expiry, group); API Gateway's
// authorizer is not trusted on its own.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { verifyAccessToken } from './verify-token.mjs';

const { TABLE, GROUP, ISSUER, CLIENT_ID } = process.env;
const PK = 'TOOL';
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const json = (statusCode, body) => ({
  statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

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

  switch (event.routeKey) {
    case 'GET /items': {
      const r = await db.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
        ExpressionAttributeValues: { ':pk': PK, ':p': 'ITEM#' },
      }));
      return json(200, r.Items.map((i) => ({ id: i.sk.slice(5), name: i.name, updatedAt: i.updatedAt })));
    }
    case 'PUT /items/{id}': {
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 200) : '';
      if (!name) return json(400, { error: 'name required' });
      await db.send(new PutCommand({
        TableName: TABLE,
        Item: { pk: PK, sk: `ITEM#${id}`, name, updatedAt: new Date().toISOString(), updatedBy: claims.username },
      }));
      return json(200, { id });
    }
    case 'DELETE /items/{id}':
      await db.send(new DeleteCommand({ TableName: TABLE, Key: { pk: PK, sk: `ITEM#${id}` } }));
      return json(200, { id });
    default:
      return json(404, { error: 'no route' });
  }
};
