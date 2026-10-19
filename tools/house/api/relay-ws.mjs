// The relay's side of the House tool: API Gateway WebSocket routes, invoked per message.
//   $connect     the relay dials in with x-house-key, checked against the SecureString at
//                RELAY_KEY_PARAM (set by hand, never in tofu state). Its connection id is kept so
//                stage 2 can send it commands; a newer connection replaces an older one.
//   $disconnect  forget the connection, if it's still the current one
//   sync         what the house reports (relay/protocol.mjs). Only the current connection may sync
//   result       how a command went, for the API Lambda waiting on it (api.mjs)
//   ran          how an automation's run went (automation.mjs): kept as its last run, and an audit
//                row per action, like a command's
//   $default     anything else is refused
// The relay has already cut everything to the ceiling; this stores it as given, checked field by
// field. Its role can only read that key and write these rows, so a leaked key can paint a false
// picture of the house but can't read anything back or send a command.
//
// Rows: RELAY / CONN               { connectionId, connectedAt, lastSync }
//       AREA / <area id>          { name }
//       ENTITY / <entity id>      { name, area, domain, state, attrs, updated, actions }
//       RESULT / <command id>     { ok, error, at }   read once by the waiting API Lambda; expires in a day
//       RAN / <automation id>     { at, key, ok, results }   its last run
//       CMD#<UTC day> / <ISO>#<id>  audit, via 'automation', as the automation's owner (read from AUTO)
// Change messages for one entity are a second or more apart (the relay batches), and a full sync
// every 5 minutes rewrites everything, so an out-of-order write heals on its own.
import { createHash, timingSafeEqual } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { parseResult, parseSync } from './protocol.mjs';
import { parseRan } from './automation.mjs';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
const MAX_BODY = 128 * 1024;

const reply = (statusCode) => ({ statusCode });

// Compare digests so the check takes the same time whatever the key's length or contents
function keyMatches(given, expected) {
  if (typeof given !== 'string' || !given || !expected) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

async function keys(table, pk) {
  const out = [];
  let ExclusiveStartKey;
  do {
    const r = await db.send(new QueryCommand({
      TableName: table, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': pk }, ExclusiveStartKey,
    }));
    out.push(...r.Items.map((i) => i.sk));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

/** deps: table, relayKey() -> the key, now() -> Date */
export function createRelayWs({ table, relayKey, now = () => new Date() }) {
  const current = async () => (await db.send(new GetCommand({ TableName: table, Key: { pk: 'RELAY', sk: 'CONN' } }))).Item;

  return async (event) => {
    const { routeKey, connectionId } = event.requestContext ?? {};
    switch (routeKey) {
      case '$connect': {
        if (!keyMatches(event.headers?.['x-house-key'], await relayKey())) {
          console.warn('refused: bad relay key');
          return reply(401);
        }
        await db.send(new PutCommand({ TableName: table, Item: { pk: 'RELAY', sk: 'CONN', connectionId, connectedAt: now().toISOString(), lastSync: (await current())?.lastSync ?? null } }));
        console.log('relay connected', connectionId);
        return reply(200);
      }
      case '$disconnect': {
        const conn = await current();
        if (conn?.connectionId === connectionId) {
          await db.send(new UpdateCommand({ TableName: table, Key: { pk: 'RELAY', sk: 'CONN' }, UpdateExpression: 'SET connectionId = :n', ExpressionAttributeValues: { ':n': null } }));
        }
        return reply(200);
      }
      case 'result': {
        if ((await current())?.connectionId !== connectionId) {
          console.warn('refused: result from an old connection', connectionId);
          return reply(403);
        }
        let r;
        try {
          r = parseResult(JSON.parse(event.body || ''));
        } catch (e) {
          console.warn('refused:', e.message, String(event.body).slice(0, 200));
          return reply(400);
        }
        const expires = Math.floor(now().getTime() / 1000) + 86_400;
        await db.send(new PutCommand({ TableName: table, Item: { pk: 'RESULT', sk: r.id, ok: r.ok, error: r.error, at: now().toISOString(), expires } }));
        return reply(200);
      }
      case 'ran': {
        if ((await current())?.connectionId !== connectionId) {
          console.warn('refused: ran from an old connection', connectionId);
          return reply(403);
        }
        let r;
        try {
          r = parseRan(JSON.parse(event.body || ''));
        } catch (e) {
          console.warn('refused:', e.message, String(event.body).slice(0, 200));
          return reply(400);
        }
        const item = async (pk, sk) => (await db.send(new GetCommand({ TableName: table, Key: { pk, sk } }))).Item;
        const [auto, names] = await Promise.all([item('AUTO', r.id), Promise.all(r.results.map(async (x) => (await item('ENTITY', x.entity_id))?.name ?? null))]);
        const ok = r.results.every((x) => x.ok);
        await db.send(new PutCommand({ TableName: table, Item: { pk: 'RAN', sk: r.id, at: r.at, key: r.key, ok, results: r.results } }));
        const expires = Math.floor(now().getTime() / 1000) + 365 * 86_400;
        await Promise.all(r.results.map((x, i) => db.send(new PutCommand({
          TableName: table,
          Item: {
            pk: `CMD#${r.at.slice(0, 10)}`, sk: `${r.at}#${r.id}${i}`, who: auto?.owner ?? null, via: 'automation', automation: r.id, automationName: auto?.name ?? null,
            entity_id: x.entity_id, name: names[i], action: x.action, data: auto?.actions?.find((y) => y.entity_id === x.entity_id && y.action === x.action)?.data ?? {},
            outcome: x.ok ? 'done' : 'failed', error: x.error ?? null, expires,
          },
        }))));
        return reply(200);
      }
      case 'sync': {
        if ((await current())?.connectionId !== connectionId) {
          console.warn('refused: sync from an old connection', connectionId);
          return reply(403);
        }
        const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString() : event.body || '';
        if (raw.length > MAX_BODY) return reply(413);
        let msg;
        try {
          msg = parseSync(JSON.parse(raw));
        } catch (e) {
          console.warn('refused:', e.message);
          return reply(400);
        }
        const at = now().toISOString();
        const puts = msg.entities.map(({ id, ...e }) => db.send(new PutCommand({ TableName: table, Item: { pk: 'ENTITY', sk: id, ...e } })));
        if (msg.full) {
          puts.push(...msg.areas.map((a) => db.send(new PutCommand({ TableName: table, Item: { pk: 'AREA', sk: a.id, name: a.name } }))));
          // Whatever the house no longer reports (left the ceiling, removed, area deleted) goes
          const keepE = new Set(msg.entities.map((e) => e.id)), keepA = new Set(msg.areas.map((a) => a.id));
          const [oldE, oldA] = await Promise.all([keys(table, 'ENTITY'), keys(table, 'AREA')]);
          puts.push(...oldE.filter((k) => !keepE.has(k)).map((sk) => db.send(new DeleteCommand({ TableName: table, Key: { pk: 'ENTITY', sk } }))));
          puts.push(...oldA.filter((k) => !keepA.has(k)).map((sk) => db.send(new DeleteCommand({ TableName: table, Key: { pk: 'AREA', sk } }))));
        }
        await Promise.all(puts);
        await db.send(new UpdateCommand({ TableName: table, Key: { pk: 'RELAY', sk: 'CONN' }, UpdateExpression: 'SET lastSync = :t', ExpressionAttributeValues: { ':t': at } }));
        return reply(200);
      }
      default:
        return reply(400);
    }
  };
}

let cachedKey;
async function relayKeyFromSsm() {
  cachedKey ??= ssm.send(new GetParameterCommand({ Name: process.env.RELAY_KEY_PARAM, WithDecryption: true }))
    .then((r) => r.Parameter.Value)
    .catch((e) => { cachedKey = undefined; throw e; });
  return cachedKey;
}

export const handler = createRelayWs({ table: process.env.TABLE, relayKey: relayKeyFromSsm });
