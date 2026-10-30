// Calendars API: the family's Google calendars, each person reaching only the ones granted to them.
// The Google service account's key is read here and nowhere else; Dot reaches calendars through
// this API as the person asking (its delegated token), so grants decide for Dot exactly as for the page.
// Routes (a family_calendars token, or Dot's delegated one):
//   GET    /calendars                       -> [{ calendar, name, time_zone, read_only? }]   what they can see
//   GET    /events?calendar&start&end&query&max_results -> [Event]                         (google-calendar.mjs)
//   GET    /agenda?days=1..14               -> [{ calendar, …Event }] across their calendars, by start
//   POST   /events                          { calendar, title, start, end?, all_day?, … } -> the event   edit
//   PUT    /events/{calendar}/{eventId}     { only what changes } -> the event                         edit
//   DELETE /events/{calendar}/{eventId}     edit. From Dot: 202 { confirm_id, prompt } first, then again with
//                                           ?confirm_id= (Dot's code sends it only after the person's own reply)
//   GET    /admin                           -> { calendars, grants, people, groups }       family_calendars:admin,
//   PUT    /calendars/{alias}               { googleId } -> the calendar (checked live    never via Dot
//                                           with Google: shared with Dot's account, and how)
//   DELETE /calendars/{alias}               (and its grants)
//   PUT    /grants/{id}, DELETE /grants/{id}  { who, calendar: alias | '*', level: read | edit, rev? }
// No admin override on events: admins add calendars and grant access, and see only what's granted
// to them too. A calendar Google shares read-only stays read-only whatever the grant says.
// The token is re-verified here (signature, issuer, client, expiry, group); API Gateway's
// authorizer is not trusted on its own.
//
// Rows: CAL / <alias>     { googleId, name, role (Google's: reader | writer | owner), rev, addedBy, addedAt }
//       GRANT / <id>      { who: sub:… | group:…, calendar: alias | '*', level, rev, changedBy, changedAt }
//       PENDING / <id>    an event deletion waiting for its confirmation (2 minutes)
import { randomBytes } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { verifyAccessToken } from './verify-token.mjs';
import { makePeople } from './people.mjs';
import { makeCalendar } from './google-calendar.mjs';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ALIAS = /^[a-z][a-z0-9_]{0,23}$/;
const GRANT_ID = /^[a-z0-9]{6,24}$/;
const WHO = /^(sub:[0-9a-f-]{36}|group:g[a-z0-9]{8,20})$/;
const GOOGLE_ID = /^[A-Za-z0-9._%+-]{1,200}@[A-Za-z0-9.-]{1,120}$/;
const LEVELS = ['none', 'read', 'edit'];
const CONFIRM_MS = 2 * 60_000;
const ADMIN_ROUTES = ['GET /admin', 'PUT /calendars/{alias}', 'DELETE /calendars/{alias}', 'PUT /grants/{id}', 'DELETE /grants/{id}'];

const json = (statusCode, body) => ({
  statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const rank = (l) => Math.max(0, LEVELS.indexOf(l));

/** This person's level on each calendar: highest matching grant, none without one */
export function levelsFor({ sub, groupIds }, grants, aliases) {
  const out = Object.fromEntries(aliases.map((a) => [a, 0]));
  for (const g of grants) {
    const mine = g.who === `sub:${sub}` || (g.who.startsWith('group:') && groupIds.has(g.who.slice(6)));
    if (!mine) continue;
    for (const a of g.calendar === '*' ? aliases : [g.calendar]) if (a in out) out[a] = Math.max(out[a], rank(g.level));
  }
  return Object.fromEntries(Object.entries(out).map(([a, r]) => [a, LEVELS[r]]));
}

/** deps: table, group, issuer, clientIds, dotClientId, people, members(), google: { accessToken, fetch? }, timeZone, now() */
export function createApi(deps) {
  const { table } = deps;
  const get = async (pk, sk) => (await db.send(new GetCommand({ TableName: table, Key: { pk, sk } }))).Item;
  const del = (pk, sk) => db.send(new DeleteCommand({ TableName: table, Key: { pk, sk } }));
  async function all(pk) {
    const items = [];
    let ExclusiveStartKey;
    do {
      const r = await db.send(new QueryCommand({ TableName: table, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': pk }, ExclusiveStartKey }));
      items.push(...r.Items);
      ExclusiveStartKey = r.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }
  async function putAt(item, rev) {
    try {
      await db.send(new PutCommand({
        TableName: table, Item: item,
        ...(rev === undefined ? { ConditionExpression: 'attribute_not_exists(pk)' } : { ConditionExpression: 'rev = :rev', ExpressionAttributeValues: { ':rev': rev } }),
      }));
      return true;
    } catch (e) {
      if (e.name === 'ConditionalCheckFailedException') return false;
      throw e;
    }
  }
  const googleCall = async (path, init = {}) => {
    const r = await (deps.google.fetch ?? fetch)(`https://www.googleapis.com/calendar/v3${path}`, {
      ...init, headers: { authorization: `Bearer ${await deps.google.accessToken()}`, 'content-type': 'application/json' },
    });
    return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
  };

  /** The person's calendars as google-calendar.mjs wants them: { alias: googleId } and which are read-only */
  async function calendarFor(person) {
    const [cals, grants] = await Promise.all([all('CAL'), all('GRANT')]);
    const levels = levelsFor(person, grants, cals.map((c) => c.sk));
    const mine = cals.filter((c) => levels[c.sk] !== 'none');
    const calendars = Object.fromEntries(mine.map((c) => [c.sk, c.googleId]));
    const readOnly = mine.filter((c) => levels[c.sk] !== 'edit' || !['writer', 'owner'].includes(c.role)).map((c) => c.sk);
    return makeCalendar({ accessToken: deps.google.accessToken, calendars, readOnly, timeZone: deps.timeZone, fetch: deps.google.fetch });
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
    const admin = (claims['cognito:groups'] ?? []).includes(`${deps.group}:admin`);
    let body = {};
    if (event.body) {
      try {
        body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body) ?? {};
      } catch {
        return json(400, { error: 'bad json' });
      }
    }
    const p = event.pathParameters ?? {};
    const q = event.queryStringParameters ?? {};
    const sub = claims.sub;
    const at = deps.now().toISOString();

    if (ADMIN_ROUTES.includes(event.routeKey)) {
      if (viaDot) return json(403, { error: 'read-only' });
      if (!admin) return json(403, { error: 'admins only' });
      switch (event.routeKey) {
        case 'GET /admin': {
          const [cals, grants, list, names, groups] = await Promise.all([all('CAL'), all('GRANT'), deps.members(), deps.people.names(), deps.people.groups()]);
          return json(200, {
            calendars: cals.map((c) => ({ alias: c.sk, googleId: c.googleId, name: c.name, role: c.role, rev: c.rev })).sort((a, b) => a.alias.localeCompare(b.alias)),
            grants: grants.map((g) => ({ id: g.sk, who: g.who, calendar: g.calendar, level: g.level, rev: g.rev })),
            people: list.map((m) => ({ sub: m.sub, name: names.get(m.sub) ?? m.name })).sort((a, b) => a.name.localeCompare(b.name)),
            groups: groups.map((g) => ({ id: g.id, name: g.name })),
          });
        }
        case 'PUT /calendars/{alias}': {
          if (!ALIAS.test(p.alias ?? '')) return json(400, { error: 'short name: lowercase letters, digits and _, starting with a letter' });
          const googleId = String(body.googleId ?? '').trim();
          if (!GOOGLE_ID.test(googleId)) return json(400, { error: 'that isn’t a Google calendar ID' });
          // Checked live: Dot's account must already have it shared, and Google says how
          const cal = await googleCall(`/calendars/${encodeURIComponent(googleId)}`);
          if (!cal.ok) return json(422, { error: 'Dot’s Google account can’t see that calendar. Share it with calendar-manager@home-host-510501.iam.gserviceaccount.com first.' });
          const sub2 = await googleCall('/users/me/calendarList', { method: 'POST', body: JSON.stringify({ id: googleId }) });
          const role = sub2.body.accessRole ?? 'reader';
          const old = await get('CAL', p.alias);
          if (body.rev === undefined && old) return json(409, { error: `there’s already a calendar called ${p.alias}` });
          const item = { pk: 'CAL', sk: p.alias, googleId, name: cal.body.summary ?? p.alias, role, rev: (body.rev ?? 0) + 1, addedBy: old?.addedBy ?? claims.username, addedAt: old?.addedAt ?? at };
          if (!(await putAt(item, body.rev))) return json(409, { error: 'changed by someone else' });
          console.log('calendar saved', JSON.stringify({ alias: p.alias, googleId, role, by: claims.username }));
          return json(200, { alias: p.alias, googleId, name: item.name, role, rev: item.rev });
        }
        case 'DELETE /calendars/{alias}': {
          if (!ALIAS.test(p.alias ?? '')) return json(400, { error: 'bad name' });
          const orphans = (await all('GRANT')).filter((g) => g.calendar === p.alias);
          await Promise.all([del('CAL', p.alias), ...orphans.map((g) => del('GRANT', g.sk))]);
          console.log('calendar removed', JSON.stringify({ alias: p.alias, by: claims.username }));
          return json(200, { alias: p.alias, removedGrants: orphans.map((g) => g.sk) });
        }
        case 'PUT /grants/{id}': {
          if (!GRANT_ID.test(p.id ?? '')) return json(400, { error: 'bad id' });
          if (!WHO.test(body.who ?? '') || !['read', 'edit'].includes(body.level)) return json(400, { error: 'a grant is { who: sub:… or group:…, calendar, level: read or edit }' });
          if (body.calendar !== '*' && !(await get('CAL', body.calendar))) return json(400, { error: 'no such calendar' });
          if (body.rev !== undefined && !Number.isInteger(body.rev)) return json(400, { error: 'bad rev' });
          const item = { pk: 'GRANT', sk: p.id, who: body.who, calendar: body.calendar, level: body.level, rev: (body.rev ?? 0) + 1, changedBy: claims.username, changedAt: at };
          if (!(await putAt(item, body.rev))) return json(409, { error: 'changed by someone else', current: await get('GRANT', p.id) });
          console.log('grant saved', JSON.stringify({ id: p.id, who: body.who, calendar: body.calendar, level: body.level, by: claims.username }));
          return json(200, { id: p.id, who: item.who, calendar: item.calendar, level: item.level, rev: item.rev });
        }
        default: {
          if (!GRANT_ID.test(p.id ?? '')) return json(400, { error: 'bad id' });
          await del('GRANT', p.id);
          return json(200, { id: p.id });
        }
      }
    }

    const groupIds = new Set((await deps.people.groups()).filter((g) => g.members.includes(sub)).map((g) => g.id));
    const cal = await calendarFor({ sub, groupIds });
    const run = async (fn) => {
      try {
        return json(200, await fn());
      } catch (e) {
        // google-calendar.mjs refuses unknown and read-only calendars with a clear message
        const status = /^Unknown calendar|read-only for you/.test(e.message) ? 403
          : /^(Unknown color|Unrecognized date|people must|At most|Each person|Too many people)|isn’t an email/.test(e.message) ? 400 : 502;
        return json(status, { error: e.message });
      }
    };

    switch (event.routeKey) {
      case 'GET /calendars':
        return run(() => cal.listCalendars());
      case 'GET /events':
        return run(() => cal.listEvents({ calendar: q.calendar, start: q.start, end: q.end, ...(q.query ? { query: q.query } : {}), ...(q.max_results ? { max_results: Number(q.max_results) } : {}) }));
      case 'GET /agenda': {
        const days = Math.min(14, Math.max(1, Number(q.days) || 7));
        const start = q.start ?? at.slice(0, 10);
        const end = new Date(Date.parse(start) + days * 86_400_000).toISOString().slice(0, 10);
        return run(async () => {
          const mine = await cal.listCalendars();
          const lists = await Promise.all(mine.map(async (c) => (await cal.listEvents({ calendar: c.calendar, start, end, max_results: 100 })).map((e) => ({ calendar: c.calendar, calendar_name: c.name, ...e }))));
          return lists.flat().sort((a, b) => String(a.start).localeCompare(String(b.start)));
        });
      }
      case 'POST /events':
        return run(() => cal.createEvent(body));
      case 'PUT /events/{calendar}/{eventId}':
        return run(() => cal.updateEvent({ ...body, calendar: p.calendar, event_id: p.eventId }));
      case 'DELETE /events/{calendar}/{eventId}': {
        if (viaDot) {
          const confirmId = q.confirm_id;
          if (!confirmId) {
            const id = randomBytes(12).toString('hex');
            await db.send(new PutCommand({ TableName: table, Item: { pk: 'PENDING', sk: id, who: sub, calendar: p.calendar, eventId: p.eventId, until: deps.now().getTime() + CONFIRM_MS, expires: Math.floor(deps.now().getTime() / 1000) + 86_400 } }));
            return json(202, { confirm_id: id, prompt: `Delete that event from the ${p.calendar} calendar?` });
          }
          // Single use, the same person, the same event, within two minutes
          const pending = /^[a-f0-9]{24}$/.test(confirmId) ? await get('PENDING', confirmId) : null;
          if (pending) await del('PENDING', confirmId);
          if (!pending || pending.who !== sub || pending.calendar !== p.calendar || pending.eventId !== p.eventId || pending.until < deps.now().getTime()) {
            return json(400, { error: 'that confirmation doesn’t match or has expired; ask again' });
          }
        }
        return run(() => cal.deleteEvent({ calendar: p.calendar, event_id: p.eventId }));
      }
      default:
        return json(404, { error: 'no route' });
    }
  };
}

// ---- Lambda wiring ----

async function members() {
  const { CognitoIdentityProviderClient, ListUsersInGroupCommand } = await import('@aws-sdk/client-cognito-identity-provider');
  const idp = new CognitoIdentityProviderClient({});
  const out = [];
  let NextToken;
  do {
    const r = await idp.send(new ListUsersInGroupCommand({ UserPoolId: process.env.USER_POOL_ID, GroupName: process.env.GROUP, NextToken }));
    for (const u of r.Users) {
      const attr = (n) => u.Attributes?.find((a) => a.Name === n)?.Value;
      out.push({ sub: attr('sub') ?? u.Username, name: attr('name') || attr('given_name') || attr('email') || u.Username });
    }
    NextToken = r.NextToken;
  } while (NextToken);
  return out;
}

let accessToken;
async function googleToken() {
  if (!accessToken) {
    const { makeGoogleAuth } = await import('./google.mjs');
    const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
    const ssm = new SSMClient({});
    accessToken = makeGoogleAuth({ loadKey: async () => JSON.parse((await ssm.send(new GetParameterCommand({ Name: process.env.GOOGLE_KEY_PARAM, WithDecryption: true }))).Parameter.Value) });
  }
  return accessToken();
}

const env = process.env;
export const handler = createApi({
  table: env.TABLE, group: env.GROUP, issuer: env.ISSUER,
  clientIds: [env.CLIENT_ID, env.DOT_CLIENT_ID].filter(Boolean), dotClientId: env.DOT_CLIENT_ID,
  people: makePeople({ db, table: env.PEOPLE_TABLE }), members,
  google: { accessToken: googleToken }, timeZone: env.TIME_ZONE ?? 'America/New_York', now: () => new Date(),
});
