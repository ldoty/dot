// House API. Routes (a family_house token, or Dot's delegated one for the person asking):
//   GET  /home[?area=<id>]  -> { you: { admin }, relay: { connected, lastSync, stale }, areas: [{ id, name,
//                              entities: [{ id, name, domain, state, attrs, updated, level, actions? }] }] }
//                              only what the caller may at least read (actions: only where they may
//                              control); entities without an area come last under { id: null, name: 'Other' }
//   POST /commands          { entity_id, action, data?, confirm_id? }
//                              -> 200 { ok: true }                  the house did it
//                                 202 { confirm_id, prompt }        their level is `confirm`: ask, then send
//                                                                   the same command with confirm_id (2 minutes)
//                                 400 bad input or an action the device doesn't take, 403 not theirs to control,
//                                 404 unknown device, 502 the house refused or failed, 504 the house is offline
//                                 or didn't answer. Never queued: a command runs now or not at all.
//   GET  /dot               -> this tool's description for Dot (platform/api/dot-manifest.mjs)
// What the house reports comes from the relay (api/relay-ws.mjs), already cut to the ceiling;
// grants (api/grants.mjs) narrow it per person, and the relay checks every command against its own
// ceiling again. Dot's tokens are read-only here except POST /commands, where the asker's grants
// apply exactly as on the page. Every command, allowed or not, leaves an audit row.
// The token is re-verified here (signature, issuer, client, expiry, group); API Gateway's
// authorizer is not trusted on its own.
//
// Rows written here: PENDING / <confirm id>         a command waiting for its confirmation (expires)
//                    CMD#<UTC day> / <ISO>#<id>    the audit trail, kept a year (expires)
import { randomBytes } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { verifyAccessToken } from './verify-token.mjs';
import { validateManifest } from './dot-manifest.mjs';
import { atLeast, grantsFor, levelFor } from './grants.mjs';
import { ID, KEY, parseData } from './protocol.mjs';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
// The relay sends everything every 5 minutes; past this its picture of the house may be old
const STALE_MS = 11 * 60_000;
const CONFIRM_MS = 2 * 60_000;
const ANSWER_MS = 5000;   // how long a command may take; the relay drops it after this
const POLL_MS = 150;
const KEEP_AUDIT_S = 365 * 86_400;

const json = (statusCode, body) => ({
  statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

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

/** deps: table, group, issuer, clientIds, dotClientId, toRelay(connectionId, message), now(), sleep(ms) */
export function createApi(deps) {
  const { table } = deps;
  const get = async (pk, sk) => (await db.send(new GetCommand({ TableName: table, Key: { pk, sk } }))).Item;
  async function all(pk) {
    const items = [];
    let ExclusiveStartKey;
    do {
      const r = await db.send(new QueryCommand({
        TableName: table, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': pk }, ExclusiveStartKey,
      }));
      items.push(...r.Items);
      ExclusiveStartKey = r.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }
  const personFor = async (claims, admin) => {
    const [grants, groups] = await Promise.all([all('GRANT'), all('GROUP')]);
    return { admin, grants: grantsFor(claims.sub, grants, groups) };
  };

  async function command(claims, admin, via, body) {
    const now = deps.now();
    const at = now.toISOString();
    const audit = (cmd, outcome, error = null) => db.send(new PutCommand({
      TableName: table,
      Item: {
        pk: `CMD#${at.slice(0, 10)}`, sk: `${at}#${cmd.id}`, who: claims.sub, username: claims.username, via,
        entity_id: cmd.entity_id, name: cmd.name, action: cmd.action, data: cmd.data, outcome, error,
        expires: Math.floor(now.getTime() / 1000) + KEEP_AUDIT_S,
      },
    }));

    const { entity_id: entityId, action, confirm_id: confirmId } = body;
    if (!ID.test(entityId ?? '') || !KEY.test(action ?? '')) return json(400, { error: 'entity_id and action required' });
    let data;
    try {
      data = parseData(body.data);
    } catch (e) {
      return json(400, { error: `bad ${e.message}` });
    }
    const entity = await get('ENTITY', entityId);
    if (!entity) return json(404, { error: 'unknown device' });
    const cmd = { id: randomBytes(12).toString('hex'), entity_id: entityId, name: entity.name, action, data };

    const level = levelFor(await personFor(claims, admin), { id: entityId, area: entity.area });
    if (!atLeast(level, 'confirm')) {
      await audit(cmd, 'denied');
      console.warn('denied: no control grant', claims.username, entityId, action);
      return json(403, { error: 'not allowed' });
    }
    const allowed = entity.actions?.[action];
    if (!allowed) return json(400, { error: `${entity.name} can’t ${action.replace(/_/g, ' ')}` });
    const extra = Object.keys(data).filter((k) => !allowed.includes(k));
    if (extra.length) return json(400, { error: `${extra.join(', ')} isn’t possible for ${action}` });

    if (level === 'confirm') {
      if (!confirmId) {
        const id = randomBytes(12).toString('hex');
        await db.send(new PutCommand({
          TableName: table,
          Item: { pk: 'PENDING', sk: id, who: claims.sub, entity_id: entityId, action, data, until: now.getTime() + CONFIRM_MS, expires: Math.floor(now.getTime() / 1000) + 86_400 },
        }));
        return json(202, { confirm_id: id, prompt: `${action === 'turn_off' ? 'Turn off' : action === 'turn_on' ? 'Turn on' : action.replace(/_/g, ' ')} ${entity.name}?` });
      }
      // Single use, the same person, the same command, within two minutes
      const pending = /^[a-f0-9]{24}$/.test(confirmId) ? await get('PENDING', confirmId) : null;
      if (pending) await db.send(new DeleteCommand({ TableName: table, Key: { pk: 'PENDING', sk: confirmId } }));
      if (!pending || pending.who !== claims.sub || pending.entity_id !== entityId || pending.action !== action
        || !same(pending.data ?? {}, data) || pending.until < now.getTime()) {
        return json(400, { error: 'that confirmation doesn’t match or has expired; ask again' });
      }
    }

    const conn = await get('RELAY', 'CONN');
    if (!conn?.connectionId) {
      await audit(cmd, 'offline');
      return json(504, { error: 'The house is offline' });
    }
    try {
      await deps.toRelay(conn.connectionId, { type: 'command', id: cmd.id, entity_id: entityId, action, data, expires: now.getTime() + ANSWER_MS });
    } catch (e) {
      await audit(cmd, 'offline', e.name ?? e.message);
      return json(504, { error: 'The house is offline' });
    }
    for (let waited = 0; waited < ANSWER_MS + 1000; waited += POLL_MS) {
      const r = await get('RESULT', cmd.id);
      if (r) {
        await audit(cmd, r.ok ? 'done' : 'failed', r.error ?? null);
        return r.ok ? json(200, { ok: true }) : json(502, { error: r.error });
      }
      await deps.sleep(POLL_MS);
    }
    await audit(cmd, 'timeout');
    return json(504, { error: 'The house didn’t answer' });
  }

  return async (event) => {
    let claims;
    try {
      claims = await verifyAccessToken(event.headers, { issuer: deps.issuer, clientId: deps.clientIds, group: deps.group });
    } catch (e) {
      if (!e.status) throw e;
      console.warn('denied', e.message);
      return json(e.status, { error: e.status === 403 ? 'forbidden' : 'unauthorized' });
    }
    const viaDot = claims.via === 'dot' || (!!deps.dotClientId && claims.client_id === deps.dotClientId);
    if (viaDot && !event.routeKey?.startsWith('GET ') && event.routeKey !== 'POST /commands') {
      console.warn('denied: Dot is read-only here', event.routeKey, claims.username);
      return json(403, { error: 'read-only' });
    }
    const admin = (claims['cognito:groups'] ?? []).includes(`${deps.group}:admin`);

    switch (event.routeKey) {
      case 'GET /dot':
        return json(200, MANIFEST);
      case 'POST /commands': {
        let body;
        try {
          body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString() : event.body || '');
        } catch {
          return json(400, { error: 'bad json' });
        }
        if (!body || typeof body !== 'object') return json(400, { error: 'bad json' });
        return command(claims, admin, viaDot ? 'dot' : 'page', body);
      }
      case 'GET /home': {
        const only = event.queryStringParameters?.area;
        if (only !== undefined && !/^[a-z0-9_]+$/.test(only)) return json(400, { error: 'bad area' });
        const [areas, entities, person, conn] = await Promise.all([all('AREA'), all('ENTITY'), personFor(claims, admin), get('RELAY', 'CONN')]);
        const byName = areas.map((a) => ({ id: a.sk, name: a.name })).sort((x, y) => x.name.localeCompare(y.name));
        const rooms = [...byName, { id: null, name: 'Other' }]
          .filter((a) => only === undefined || a.id === only)
          .map((a) => ({
            ...a,
            entities: entities
              .filter((e) => (e.area ?? null) === a.id)
              .map((e) => {
                const level = levelFor(person, { id: e.sk, area: e.area });
                const out = { id: e.sk, name: e.name, domain: e.domain, state: e.state, attrs: e.attrs ?? {}, updated: e.updated, level };
                return atLeast(level, 'confirm') ? { ...out, actions: e.actions ?? {} } : out;
              })
              .filter((e) => atLeast(e.level, 'read'))
              .sort((x, y) => x.name.localeCompare(y.name)),
          }))
          .filter((a) => a.entities.length);
        const lastSync = conn?.lastSync ?? null;
        return json(200, {
          you: { admin },
          relay: { connected: !!conn?.connectionId, lastSync, stale: !lastSync || deps.now().getTime() - Date.parse(lastSync) > STALE_MS },
          areas: rooms,
        });
      }
      default:
        return json(404, { error: 'no route' });
    }
  };
}

// The relay's WebSocket connection, via API Gateway's management API (only in Lambda)
let mgmt;
async function toRelay(connectionId, message) {
  const { ApiGatewayManagementApiClient, PostToConnectionCommand } = await import('@aws-sdk/client-apigatewaymanagementapi');
  mgmt ??= new ApiGatewayManagementApiClient({ endpoint: process.env.RELAY_ENDPOINT });
  await mgmt.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: Buffer.from(JSON.stringify(message)) }));
}

const env = process.env;
export const handler = createApi({
  table: env.TABLE, group: env.GROUP, issuer: env.ISSUER,
  clientIds: [env.CLIENT_ID, env.DOT_CLIENT_ID].filter(Boolean), dotClientId: env.DOT_CLIENT_ID,
  toRelay, now: () => new Date(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});
