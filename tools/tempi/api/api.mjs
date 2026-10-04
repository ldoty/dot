// Tempi's OT Course API. Routes (all require a family_tempi access token):
//   GET /course    -> { html }               the course itself, kept off the public site
//   GET /progress  -> { progress, updatedAt } 404 if nothing saved yet
//   PUT /progress  { progress }              -> { updatedAt }  (last write wins)
// Progress is per user: module checkmarks, journal entries, slider and quiz answers.
// The token is re-verified here (signature, issuer, client, expiry, group); API Gateway's
// authorizer is not trusted on its own.
import { readFileSync } from 'node:fs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { verifyAccessToken } from './verify-token.mjs';

const { TABLE, GROUP, ISSUER, CLIENT_ID } = process.env;
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const COURSE = readFileSync(new URL('./course.html', import.meta.url), 'utf8');

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
  const key = { pk: `USER#${claims.sub || claims.username}`, sk: 'PROGRESS' };

  switch (event.routeKey) {
    case 'GET /course':
      return json(200, { html: COURSE });
    case 'GET /progress': {
      const item = (await db.send(new GetCommand({ TableName: TABLE, Key: key }))).Item;
      return item ? json(200, { progress: JSON.parse(item.progress), updatedAt: item.updatedAt }) : json(404, { error: 'not found' });
    }
    case 'PUT /progress': {
      let body;
      try {
        body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString() : event.body || '');
      } catch {
        return json(400, { error: 'bad json' });
      }
      const p = body?.progress;
      if (!p || typeof p !== 'object' || Array.isArray(p)) return json(400, { error: 'bad body' });
      const text = JSON.stringify(p);
      if (text.length > 350_000) return json(413, { error: 'progress too large' });
      const updatedAt = new Date().toISOString();
      await db.send(new PutCommand({ TableName: TABLE, Item: { ...key, progress: text, updatedAt } }));
      return json(200, { updatedAt });
    }
    default:
      return json(404, { error: 'no route' });
  }
};
