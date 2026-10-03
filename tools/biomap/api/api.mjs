// Biomap API (all routes need a lukes_biomap access token, re-verified here):
//   GET /deck      -> the published deck, with `images` mapping each photo path to a signed URL (1 hour)
//   GET /progress  -> { progress, rev }   404 if nothing saved yet
//   PUT /progress  { progress, rev }      -> { rev }; 409 + current { progress, rev } if rev is stale
// The collection lives in a private bucket (deck.json + photos/), published by scripts/publish.sh.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { verifyAccessToken } from './verify-token.mjs';

const { TABLE, BUCKET, GROUP, ISSUER, CLIENT_ID } = process.env;
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const json = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function deck() {
  let raw;
  try {
    raw = await (await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'deck.json' }))).Body.transformToString();
  } catch (e) {
    if (e.name === 'NoSuchKey') return json(404, { error: 'No deck published yet. Run tools/biomap/scripts/publish.sh.' });
    throw e;
  }
  const d = JSON.parse(raw);
  const paths = [...new Set(d.taxa.map((t) => t.image_path).filter(Boolean))];
  d.images = Object.fromEntries(await Promise.all(paths.map(async (p) => [
    p, await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: `photos/${p}` }), { expiresIn: 3600 }),
  ])));
  return json(200, d);
}

async function putProgress(userId, body) {
  const expected = body.rev ?? null;
  const p = body.progress;
  if (!p || typeof p !== 'object' || typeof p.cards !== 'object' || !(expected === null || Number.isInteger(expected))) {
    return json(400, { error: 'bad body' });
  }
  const text = JSON.stringify(p);
  if (text.length > 350_000) return json(413, { error: 'progress too large' });
  const rev = (expected ?? 0) + 1;
  try {
    await db.send(new PutCommand({
      TableName: TABLE,
      Item: { pk: `USER#${userId}`, sk: 'PROGRESS', progress: text, rev, updatedAt: new Date().toISOString() },
      ...(expected === null
        ? { ConditionExpression: 'attribute_not_exists(pk)' }
        : { ConditionExpression: 'rev = :rev', ExpressionAttributeValues: { ':rev': expected } }),
    }));
  } catch (e) {
    if (e.name !== 'ConditionalCheckFailedException') throw e;
    const cur = (await db.send(new GetCommand({ TableName: TABLE, Key: { pk: `USER#${userId}`, sk: 'PROGRESS' } }))).Item;
    return json(409, { progress: JSON.parse(cur.progress), rev: cur.rev });
  }
  return json(200, { rev });
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
  const userId = claims.sub || claims.username;

  switch (event.routeKey) {
    case 'GET /deck':
      return deck();
    case 'GET /progress': {
      const item = (await db.send(new GetCommand({ TableName: TABLE, Key: { pk: `USER#${userId}`, sk: 'PROGRESS' } }))).Item;
      return item ? json(200, { progress: JSON.parse(item.progress), rev: item.rev }) : json(404, { error: 'not found' });
    }
    case 'PUT /progress': {
      let body;
      try {
        body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString() : event.body || '');
      } catch {
        return json(400, { error: 'bad json' });
      }
      return putProgress(userId, body);
    }
    default:
      return json(404, { error: 'no route' });
  }
};
