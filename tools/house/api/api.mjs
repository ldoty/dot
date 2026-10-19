// House API. Routes (a family_house token, or Dot's delegated one for the person asking):
//   GET /home[?area=<id>]  -> { you: { admin }, relay: { connected, lastSync, stale }, areas: [{ id, name,
//                             entities: [{ id, name, domain, state, attrs, updated, level }] }] }
//                             only what the caller may at least read; entities without an area
//                             come last under { id: null, name: 'Other' }
//   GET /dot               -> this tool's description for Dot (platform/api/dot-manifest.mjs)
// What the house reports comes from the relay (api/relay-ws.mjs), already cut to the ceiling;
// grants (api/grants.mjs) narrow it per person. Dot's tokens are read-only here for now; stage 2
// lets them through to POST /commands, and only there.
// The token is re-verified here (signature, issuer, client, expiry, group); API Gateway's
// authorizer is not trusted on its own.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { verifyAccessToken } from './verify-token.mjs';
import { validateManifest } from './dot-manifest.mjs';
import { atLeast, grantsFor, levelFor } from './grants.mjs';

const { TABLE, GROUP, ISSUER, CLIENT_ID, DOT_CLIENT_ID } = process.env;
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
// The relay sends everything every 5 minutes; past this its picture of the house may be old
const STALE_MS = 11 * 60_000;

const json = (statusCode, body) => ({
  statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

export const MANIFEST = validateManifest({
  name: 'house',
  title: 'House',
  description: 'The house’s lights and switches from Home Assistant, by room, as the person asking may see them.',
  operations: [{
    name: 'state',
    description: 'Every room with its devices: name, kind (domain), state (on/off), brightness (0–255) where it has one, and when it last changed. '
      + 'Only rooms and devices this person may see. relay.stale = true means the house hasn’t reported in over 10 minutes, so states may be out of date: say so.',
    path: '/home',
    input: {
      type: 'object',
      properties: { area: { type: 'string', pattern: '^[a-z0-9_]+$', description: 'Optional room id (from an earlier answer) to see just that room' } },
      additionalProperties: false,
    },
  }],
});

async function all(pk) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const r = await db.send(new QueryCommand({
      TableName: TABLE, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': pk }, ExclusiveStartKey,
    }));
    items.push(...r.Items);
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

export const handler = async (event) => {
  let claims;
  try {
    claims = await verifyAccessToken(event.headers, { issuer: ISSUER, clientId: [CLIENT_ID, DOT_CLIENT_ID].filter(Boolean), group: GROUP });
  } catch (e) {
    if (!e.status) throw e;
    console.warn('denied', e.message);
    return json(e.status, { error: e.status === 403 ? 'forbidden' : 'unauthorized' });
  }
  const viaDot = claims.via === 'dot' || (!!DOT_CLIENT_ID && claims.client_id === DOT_CLIENT_ID);
  if (viaDot && !event.routeKey?.startsWith('GET ')) {
    console.warn('denied: Dot is read-only', event.routeKey, claims.username);
    return json(403, { error: 'read-only' });
  }
  const admin = (claims['cognito:groups'] ?? []).includes(`${GROUP}:admin`);

  switch (event.routeKey) {
    case 'GET /dot':
      return json(200, MANIFEST);
    case 'GET /home': {
      const only = event.queryStringParameters?.area;
      if (only !== undefined && !/^[a-z0-9_]+$/.test(only)) return json(400, { error: 'bad area' });
      const [areas, entities, grants, groups, conn] = await Promise.all([
        all('AREA'), all('ENTITY'), all('GRANT'), all('GROUP'),
        (async () => (await db.send(new GetCommand({ TableName: TABLE, Key: { pk: 'RELAY', sk: 'CONN' } }))).Item)(),
      ]);
      const person = { admin, grants: grantsFor(claims.sub, grants, groups) };
      const byName = areas.map((a) => ({ id: a.sk, name: a.name })).sort((x, y) => x.name.localeCompare(y.name));
      const rooms = [...byName, { id: null, name: 'Other' }]
        .filter((a) => only === undefined || a.id === only)
        .map((a) => ({
          ...a,
          entities: entities
            .filter((e) => (e.area ?? null) === a.id)
            .map((e) => ({ id: e.sk, name: e.name, domain: e.domain, state: e.state, attrs: e.attrs ?? {}, updated: e.updated, level: levelFor(person, { id: e.sk, area: e.area }) }))
            .filter((e) => atLeast(e.level, 'read'))
            .sort((x, y) => x.name.localeCompare(y.name)),
        }))
        .filter((a) => a.entities.length);
      const lastSync = conn?.lastSync ?? null;
      return json(200, {
        you: { admin },
        relay: { connected: !!conn?.connectionId, lastSync, stale: !lastSync || Date.now() - Date.parse(lastSync) > STALE_MS },
        areas: rooms,
      });
    }
    default:
      return json(404, { error: 'no route' });
  }
};
