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
//   GET /automations, POST /automations, PUT|PATCH|DELETE /automations/{id}
//                           -> what runs by itself, and when: see automations.mjs (from Dot, changes
//                              need the person's OK first). Dot's writes are declared in the manifest:
//                              the only non-GET routes a via-Dot token may use, besides POST /commands
//   GET  /sent              -> [{ sentAt, channel, text, about, automation }] texts automations sent this
//                              person in the last two days, newest first (notify.mjs)
//   GET /access, PUT|DELETE /grants/{id}, GET /log
//                           -> admins only (family_house:admin), never via Dot: see access.mjs
// Groups are the family's (dot-y.co/family, platform/api/people.mjs); a grant names one by id.
// What the house reports comes from the relay (api/relay-ws.mjs), already cut to the ceiling;
// grants (api/grants.mjs) narrow it per person, and the relay checks every command against its own
// ceiling again. Dot's tokens are read-only here except POST /commands, where the asker's grants
// apply exactly as on the page, and the automation routes, the same way. Every command, allowed or not, leaves an audit row.
// The token is re-verified here (signature, issuer, client, expiry, group); API Gateway's
// authorizer is not trusted on its own.
//
// Rows written here: PENDING / <confirm id>         a command waiting for its confirmation (expires)
//                    CMD#<UTC day> / <ISO>#<id>    the audit trail, kept a year (expires)
import { randomBytes } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { verifyAccessToken } from './verify-token.mjs';
import { validateManifest, writeRoutes } from './dot-manifest.mjs';
import { atLeast, grantsFor, levelFor } from './grants.mjs';
import { ID, KEY, parseData } from './protocol.mjs';
import { makeAccess } from './access.mjs';
import { makePeople } from './people.mjs';
import { makeAutomations } from './automations.mjs';
import { createNotify } from './notify.mjs';
import { makeSendLimit } from './send-limit.mjs';

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

// An automation's fields, as Dot sends them (automation.mjs checks them)
const AUTOMATION_FIELDS = {
  name: { type: 'string', description: 'Short name, e.g. “Kitchen lights on weekday mornings”' },
  when: {
    type: 'object',
    description: 'What sets it off, one of: { "at": "HH:MM" } (24-hour, the house’s local time); { "sun": "sunrise" | "sunset", "offset": minutes, -180 to 180 }; '
      + '{ "changes": entity id from house_state (e.g. person.luke_doty), "to": "home" | "not_home" | "on" | "off" } (not_home is leaving home)',
  },
  repeat: {
    type: 'object',
    description: 'Which days: { "rule": a calendar RRULE (no "RRULE:"), "start"?: "YYYY-MM-DD" }, the same rules as lists and scheduled asks. Leave out for every day. '
      + 'Weekdays: FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR. Every other Monday: FREQ=WEEKLY;INTERVAL=2;BYDAY=MO. First Saturday: FREQ=MONTHLY;BYDAY=1SA. UNTIL=YYYYMMDD ends it (no COUNT)',
  },
  actions: {
    type: 'array',
    maxItems: 20,
    description: 'What it switches: devices this person controls (from house_state)',
    items: {
      type: 'object',
      properties: {
        entity_id: { type: 'string' },
        action: { type: 'string', enum: ['turn_on', 'turn_off'] },
        data: { type: 'object', description: 'Optional, for turn_on on a light: { "brightness_pct": 1–100, "transition": seconds to fade }' },
      },
      required: ['entity_id', 'action'],
      additionalProperties: false,
    },
  },
  notify: { type: 'object', description: '{ "message": … }: text this to the person making it (only them) each time it runs; plain words, no links, up to 160 characters. null removes it' },
};

export const MANIFEST = validateManifest({
  name: 'house',
  title: 'House',
  description: 'The house’s lights and switches from Home Assistant, by room, and who’s home, as the person asking may see them.',
  operations: [{
    name: 'state',
    description: 'Every room with its devices: name, kind (domain), state (on/off; a person: home or not_home), brightness (0–255) where it has one, and when it last changed. '
      + 'Only rooms and devices this person may see. relay.stale = true means the house hasn’t reported in over 10 minutes, so states may be out of date: say so.',
    path: '/home',
    input: {
      type: 'object',
      properties: { area: { type: 'string', pattern: '^[a-z0-9_]+$', description: 'Optional room id (from an earlier answer) to see just that room' } },
      additionalProperties: false,
    },
  }, {
    name: 'automations',
    description: 'What the house does by itself, and when (e.g. every weekday at 6:00 AM, turn on the kitchen lights): each automation’s id, name, '
      + 'what it does in words (says), its days (repeat: an RRULE and its start), time or sunrise/sunset offset, devices and actions, whether it’s on, paused or stopped (and why), when it runs next (next_at, for a clock time), '
      + 'whose it is, whether this person may change it (can_change), and how its last run went. Only the ones this person may see. '
      + 'Times are the house’s local time. To make, change or delete one, use house_automation_create, _change or _delete.',
    path: '/automations',
    role: 'automations',
    input: { type: 'object', properties: {}, additionalProperties: false },
  }, {
    name: 'sent',
    description: 'Texts the house’s automations sent this person in the last two days, newest first (“Dot-y, Leaving home: check the garage”), '
      + 'with which automation sent each. When they reply to one, find it here.',
    path: '/sent',
    role: 'sent',
    input: { type: 'object', properties: {}, additionalProperties: false },
  }, {
    name: 'automation_create',
    description: 'Make an automation, something the house does by itself (every weekday at 6:00 turn on the kitchen lights; when Luke leaves home, text him). '
      + 'It needs control of every device it switches, and to see what sets it off. It must switch something or text. It always asks them first.',
    method: 'POST',
    path: '/automations',
    input: { type: 'object', properties: AUTOMATION_FIELDS, required: ['name', 'when'], additionalProperties: false },
  }, {
    name: 'automation_change',
    description: 'Change, pause (enabled: false) or resume (enabled: true) an automation, by its id from house_automations: only the fields given change '
      + '(actions, if given, replace them all). Only its owner or an admin may. It always asks them first.',
    method: 'PATCH',
    path: '/automations/{id}',
    input: {
      type: 'object',
      properties: { id: { type: 'string', pattern: '^[a-z0-9]{8,24}$' }, ...AUTOMATION_FIELDS, enabled: { type: 'boolean' } },
      required: ['id'],
      additionalProperties: false,
    },
  }, {
    name: 'automation_delete',
    description: 'Delete an automation, by its id from house_automations. Only its owner or an admin may. It always asks them first.',
    method: 'DELETE',
    path: '/automations/{id}',
    input: { type: 'object', properties: { id: { type: 'string', pattern: '^[a-z0-9]{8,24}$' } }, required: ['id'], additionalProperties: false },
  }],
});

/** deps: table, group, issuer, clientIds, dotClientId, toRelay(connectionId, message), members(), admins(), people, now(), sleep(ms), timeZone (the house's) */
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
  const access = makeAccess({ db, table, all, members: deps.members, people: deps.people, now: deps.now });
  const automations = makeAutomations({ db, table, get, all, members: deps.members, admins: deps.admins, people: deps.people, toRelay: deps.toRelay, now: deps.now, timeZone: deps.timeZone });
  const personFor = async (claims, admin) => {
    const [grants, groups] = await Promise.all([all('GRANT'), deps.people.groups()]);
    // Grants name a family group by id
    return { admin, grants: grantsFor(claims.sub, grants, groups.map((g) => ({ name: g.id, members: g.members }))) };
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

  // The automation routes; Dot may use only the ones its manifest declares (writeRoutes)
  const AUTOMATION_ROUTES = ['POST /automations', 'PUT /automations/{id}', 'PATCH /automations/{id}', 'DELETE /automations/{id}'];
  const DOT_WRITES = ['POST /commands', ...writeRoutes(MANIFEST)];
  const bodyOf = (event) => {
    try {
      return JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString() : event.body || '');
    } catch {
      return undefined;
    }
  };

  const handler = async (event) => {
    let claims;
    try {
      claims = await verifyAccessToken(event.headers, { issuer: deps.issuer, clientId: deps.clientIds, group: deps.group });
    } catch (e) {
      if (!e.status) throw e;
      console.warn('denied', e.message);
      return json(e.status, { error: e.status === 403 ? 'forbidden' : 'unauthorized' });
    }
    const viaDot = claims.via === 'dot' || (!!deps.dotClientId && claims.client_id === deps.dotClientId);
    if (viaDot && !event.routeKey?.startsWith('GET ') && !DOT_WRITES.includes(event.routeKey)) {
      console.warn('denied: Dot is read-only here', event.routeKey, claims.username);
      return json(403, { error: 'read-only' });
    }
    const admin = (claims['cognito:groups'] ?? []).includes(`${deps.group}:admin`);

    // Who may do what is for admins on the page; Dot never reads or changes it
    const ADMIN_ROUTES = ['GET /access', 'PUT /grants/{id}', 'DELETE /grants/{id}', 'GET /log'];
    if (ADMIN_ROUTES.includes(event.routeKey)) {
      if (viaDot) return json(403, { error: 'read-only' });
      if (!admin) return json(403, { error: 'admins only' });
      let body = {};
      if (event.body) {
        try {
          body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body) ?? {};
        } catch {
          return json(400, { error: 'bad json' });
        }
      }
      const p = event.pathParameters ?? {};
      const by = claims.username;
      switch (event.routeKey) {
        case 'GET /access': return access.read();
        case 'GET /log': return access.log();
        default: {
          const r = event.routeKey === 'PUT /grants/{id}' ? await access.putGrant(p.id, body, by) : await access.deleteGrant(p.id, by);
          // A grant gone may stop someone's automation: tell the relay now, not in 5 minutes
          if (r.statusCode === 200) await automations.publish();
          return r;
        }
      }
    }

    if (event.routeKey === 'GET /automations') return automations.list(claims.sub, admin);
    if (AUTOMATION_ROUTES.includes(event.routeKey)) {
      const body = event.routeKey.startsWith('DELETE') ? {} : bodyOf(event);
      if (!body || typeof body !== 'object') return json(400, { error: 'bad json' });
      const op = { POST: 'create', PUT: 'replace', PATCH: 'patch', DELETE: 'delete' }[event.routeKey.split(' ')[0]];
      const who = { sub: claims.sub, username: claims.username, isAdmin: admin, via: viaDot ? 'dot' : 'page' };
      return automations.change(op, who, event.pathParameters?.id, body, event.queryStringParameters?.confirm_id);
    }

    switch (event.routeKey) {
      case 'GET /dot':
        return json(200, MANIFEST);
      case 'GET /sent': {
        const t = deps.now().getTime();
        const days = [0, 1, 2].map((d) => new Date(t - d * 86_400_000).toISOString().slice(0, 10));
        const sent = (await Promise.all(days.map((d) => all(`SENT#${d}`)))).flat()
          .filter((r) => r.to === claims.sub && !r.error && t - Date.parse(r.sentAt) < 2 * 86_400_000)
          .sort((a, b) => (a.sentAt < b.sentAt ? 1 : -1));
        return json(200, sent.map((r) => ({ sentAt: r.sentAt, channel: r.channel, text: r.text, about: `House automation “${r.name}”`, automation: r.automation })));
      }
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
  // The house-publish Lambda (every 5 minutes): the relay's set catches up with anyone who left House
  handler.publish = automations.publish;
  handler.automations = automations;
  return handler;
}

// The people in a Cognito group (only in Lambda): the tool's, for the access pickers, and its admins'.
// Usernames are subs.
export async function inGroup(GroupName) {
  const { CognitoIdentityProviderClient, ListUsersInGroupCommand } = await import('@aws-sdk/client-cognito-identity-provider');
  const idp = new CognitoIdentityProviderClient({});
  const out = [];
  let NextToken;
  do {
    const r = await idp.send(new ListUsersInGroupCommand({ UserPoolId: process.env.USER_POOL_ID, GroupName, NextToken }));
    for (const u of r.Users) {
      const attr = (n) => u.Attributes?.find((a) => a.Name === n)?.Value;
      out.push({ sub: attr('sub') ?? u.Username, name: attr('name') || attr('given_name') || attr('email') || u.Username });
    }
    NextToken = r.NextToken;
  } while (NextToken);
  return out;
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
  toRelay, members: () => inGroup(env.GROUP), admins: () => inGroup(`${env.GROUP}:admin`), people: makePeople({ db, table: env.PEOPLE_TABLE }), now: () => new Date(), timeZone: env.TIME_ZONE, sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

// The house-publish Lambda's entry (infra/api.tf: every 5 minutes)
export const publish = () => handler.publish();

// The house-notify Lambda's entry (infra/notify.tf): texts an automation's owner, if it may
async function contact(sub) {
  const { CognitoIdentityProviderClient, AdminGetUserCommand } = await import('@aws-sdk/client-cognito-identity-provider');
  const u = await new CognitoIdentityProviderClient({}).send(new AdminGetUserCommand({ UserPoolId: env.USER_POOL_ID, Username: sub }));
  const attr = (n) => u.UserAttributes?.find((a) => a.Name === n)?.Value;
  return { phone: u.Enabled !== false && attr('phone_number_verified') === 'true' ? attr('phone_number') : null };
}
let twilio;
async function sendTextLive(phone, body) {
  const { twilioConfig, sendText } = await import('./twilio.mjs');
  const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
  twilio ??= twilioConfig(async () => (await new SSMClient({}).send(new GetParameterCommand({ Name: env.TWILIO_PARAM, WithDecryption: true }))).Parameter.Value);
  return sendText(await twilio(), phone, body);
}
export const notify = createNotify({
  db, table: env.TABLE, get: async (pk, sk) => (await db.send(new GetCommand({ TableName: env.TABLE, Key: { pk, sk } }))).Item,
  automations: handler.automations, contact, text: sendTextLive, now: () => new Date(),
  limit: makeSendLimit({ db, table: env.SENDS_TABLE, timeZone: env.TIME_ZONE }),
});
