// Lists API. Routes (a family_lists token, or Dot's delegated one for the person asking):
//   GET    /lists                          -> [{ id, name, layout, columns, level, owner, open, total }]  what they can see
//   POST   /lists                          { name, layout?, columns? } -> the list   (they own it; shared with nobody)
//   GET    /lists/{id}                     -> { list: { …, share, rev }, items: [Item] }
//   PUT    /lists/{id}                     { name, layout, columns, share?, rev } -> the list   edit; share: owner only
//   DELETE /lists/{id}                     owner. From Dot: 202 { confirm_id, prompt } first, then again with
//                                          ?confirm_id= (Dot's code sends it only after the person's own reply)
//   PUT    /lists/{id}/items/{itemId}      { text, done, notes, due, urgent, important, column, order, assignee,
//                                            remind, repeat, rev? } -> the item   edit; no rev: new; rev: replace that version
//                                          ticking off a repeating item moves it to its next occurrence (repeat.mjs)
//   DELETE /lists/{id}/items/{itemId}      edit
//   GET    /prefs, PUT /prefs              { channel: sms | email }: how their reminders come by default
//   GET    /reminders/recent               reminders sent to them in the last 2 days (to act on "done" or "snooze")
//   GET    /automations                    -> their reminders still to come, as automations (the shape every tool's
//                                          share, platform/api/dot-manifest.mjs): Dot lists them with the house's and
//                                          its scheduled asks
//   GET    /share-options                  -> { people: [{ sub, name }], groups: [{ id, name }] }   who a list can be shared with
//   GET    /dot                            this tool's description for Dot (platform/api/dot-manifest.mjs)
// A conflicting write gets 409 and the current version. Dot may change lists the person can edit,
// as them, but never who a list is shared with (403 from a via-Dot token).
// The token is re-verified here (signature, issuer, client, expiry, group); API Gateway's
// authorizer is not trusted on its own.
//
// Rows: LIST / <id>                     { name, layout, columns, owner, share, rev, createdAt, updatedAt }
//       ITEMS#<list> / <item id>        { text, done, doneAt, notes, due, urgent, important, column, order, assignee,
//                                         remind: { at, channel, to, sentAt }, repeat: { rule, mode, tz, start, n, lastDoneAt },
//                                         rev, createdBy, updatedAt, updatedBy }
//       REMIND#<UTC day> / <at>#<list>#<item>   the sweep's index of reminders still to send (sweep.mjs)
//       PREF / <sub>                    { channel }
//       PENDING / <id>                  a list deletion waiting for its confirmation (2 minutes)
import { randomBytes } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { verifyAccessToken } from './verify-token.mjs';
import { validateManifest } from './dot-manifest.mjs';
import { makePeople } from './people.mjs';
import { CHANNELS, ID, atLeast, levelOf, parseItem, parseList, parseShare, reminderKey, settle } from './model.mjs';
import { describe, localParts } from './repeat.mjs';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const CONFIRM_MS = 2 * 60_000;
const RECENT_MS = 2 * 86_400_000;

const json = (statusCode, body) => ({
  statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const listOut = ({ pk: _p, sk, ...l }) => ({ id: sk, ...l, share: l.share ?? [] });
// A repeat comes with its rule in words ("every other Tuesday"), for the page and Dot
const itemOut = ({ pk: _p, sk, ...i }) => ({ id: sk, ...i, ...(i.repeat ? { repeat: { ...i.repeat, text: describe(i.repeat.rule) } } : {}) });

export const MANIFEST = validateManifest({
  name: 'lists',
  title: 'Lists',
  description: 'The family’s to-do lists and checklists (groceries, errands, projects), each with its own layout: a checklist, an Eisenhower matrix (urgent × important) or a board of columns.',
  operations: [
    {
      name: 'all',
      description: 'Every list this person can see: id, name, layout, their level (read, edit or owner), and how many items are open.',
      path: '/lists',
      input: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'list',
      description: 'One list with all its items: text, done, notes, due date, urgent and important (the matrix), column (the board), order, '
        + 'assignee, and reminder (at, sentAt). Also who it’s shared with and the list’s rev.',
      path: '/lists/{id}',
      input: { type: 'object', properties: { id: { type: 'string', pattern: '^[a-z0-9]{6,24}$' } }, required: ['id'], additionalProperties: false },
    },
    {
      name: 'reminders',
      description: 'Reminders sent to this person in the last two days, newest first, with their list and item ids. When they reply to a reminder '
        + '(“done”, “snooze an hour”), find it here.',
      path: '/reminders/recent',
      role: 'sent',
      input: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'automations',
      description: 'Their reminders still to come, as automations: each one’s item and list, when it’s next sent, how it repeats, and how it comes '
        + '(text or email). Only reminders they set, on lists they can still see.',
      path: '/automations',
      role: 'automations',
      input: { type: 'object', properties: {}, additionalProperties: false },
    },
  ],
});

const BY = { sms: 'by text', email: 'by email' };
const clock = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

/**
 * A reminder as an automation (the shape in dot-manifest.mjs): "Every other Tuesday at 9:00 AM: remind you
 * “Bins out” (Chores), by text". at: when it's next sent; tz: the item's own, else the family's
 */
export function reminderAutomation({ listId, list, item, level, at, channel, tz }) {
  const zone = item.repeat?.tz ?? tz;
  const [day, time] = localParts(at, zone);
  const when = item.repeat
    ? `${describe(item.repeat.rule).replace(/^./, (c) => c.toUpperCase())} at ${clock(time)}`
    : `On ${new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${day}T12:00:00Z`))} at ${clock(time)}`;
  const text = item.text.length > 80 ? `${item.text.slice(0, 79)}…` : item.text;
  return {
    id: `${listId}.${item.sk}`, kind: 'reminder', name: text.length > 60 ? `${text.slice(0, 59)}…` : text,
    says: `${when}: remind you “${text}” (${list.name}), ${BY[channel]}`,
    status: 'on', mine: true, can_change: atLeast(level, 'edit'),
    last_run: item.remind.sentAt ? { at: item.remind.sentAt, outcome: 'done' } : null, next_at: at,
    listId, list: list.name, itemId: item.sk,
  };
}

/** deps: table, group, issuer, clientIds, dotClientId, people (platform/api/people.mjs), members() -> [{ sub, name }], now(), timeZone (the family's) */
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
  /** Put with a rev check; false if someone else changed it first */
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
  const revOf = (b) => (b.rev === undefined ? undefined : Number.isInteger(b.rev) ? b.rev : NaN);

  async function deleteList(id) {
    const items = await all(`ITEMS#${id}`);
    await Promise.all(items.flatMap((i) => {
      const k = reminderKey(id, i.sk, i);
      return [del(i.pk, i.sk), ...(k ? [del(k.pk, k.sk)] : [])];
    }));
    await del('LIST', id);
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
    if (viaDot && event.routeKey === 'PUT /prefs') return json(403, { error: 'read-only' });

    let body = {};
    if (event.body) {
      try {
        body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body) ?? {};
      } catch {
        return json(400, { error: 'bad json' });
      }
    }
    const p = event.pathParameters ?? {};
    if ((p.id !== undefined && !ID.test(p.id)) || (p.itemId !== undefined && !ID.test(p.itemId))) return json(400, { error: 'bad id' });
    const sub = claims.sub;
    const now = deps.now();
    const at = now.toISOString();
    const groupIds = new Set((await deps.people.groups()).filter((g) => g.members.includes(sub)).map((g) => g.id));
    const person = { sub, groupIds };
    /** The list and this person's level on it; 404 rather than 403 for lists they can't see */
    const load = async () => {
      const row = await get('LIST', p.id);
      const level = row ? levelOf(person, row) : 'none';
      return { row, level, missing: !row || level === 'none' };
    };

    switch (event.routeKey) {
      case 'GET /dot':
        return json(200, MANIFEST);

      case 'GET /lists': {
        const visible = (await all('LIST')).map((l) => ({ l, level: levelOf(person, l) })).filter((x) => x.level !== 'none');
        const counts = await Promise.all(visible.map(async ({ l }) => {
          const items = await all(`ITEMS#${l.sk}`);
          return { open: items.filter((i) => !i.done).length, total: items.length };
        }));
        return json(200, visible.map(({ l, level }, i) => ({ id: l.sk, name: l.name, layout: l.layout, columns: l.columns, owner: l.owner, level, ...counts[i] }))
          .sort((a, b) => a.name.localeCompare(b.name)));
      }

      case 'POST /lists': {
        let fields;
        try {
          fields = parseList(body);
        } catch (e) {
          return json(400, { error: e.message });
        }
        const item = { pk: 'LIST', sk: `l${randomBytes(6).toString('hex')}`, ...fields, owner: sub, share: [], rev: 1, createdAt: at, updatedAt: at };
        await putAt(item);
        return json(200, { ...listOut(item), level: 'owner' });
      }

      case 'GET /lists/{id}': {
        const { row, level, missing } = await load();
        if (missing) return json(404, { error: 'no such list' });
        const items = (await all(`ITEMS#${p.id}`)).map(itemOut).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
        return json(200, { list: { ...listOut(row), level }, items });
      }

      case 'PUT /lists/{id}': {
        const { row, level, missing } = await load();
        if (missing) return json(404, { error: 'no such list' });
        if (!atLeast(level, 'edit')) return json(403, { error: 'you can only see this list' });
        let fields, share = row.share ?? [];
        try {
          fields = parseList(body);
          if (body.share !== undefined) share = parseShare(body.share);
        } catch (e) {
          return json(400, { error: e.message });
        }
        const shareChanged = JSON.stringify(share) !== JSON.stringify(row.share ?? []);
        if (shareChanged && viaDot) return json(403, { error: 'Dot can’t change who a list is shared with' });
        if (shareChanged && level !== 'owner') return json(403, { error: 'only the owner shares a list' });
        const rev = revOf(body);
        if (rev === undefined || Number.isNaN(rev)) return json(400, { error: 'rev is required' });
        const item = { ...row, ...fields, share, rev: rev + 1, updatedAt: at };
        if (!(await putAt(item, rev))) return json(409, { error: 'changed by someone else', current: listOut(await get('LIST', p.id)) });
        return json(200, { ...listOut(item), level });
      }

      case 'DELETE /lists/{id}': {
        const { row, level, missing } = await load();
        if (missing) return json(404, { error: 'no such list' });
        if (level !== 'owner') return json(403, { error: 'only the owner deletes a list' });
        if (viaDot) {
          const confirmId = event.queryStringParameters?.confirm_id;
          if (!confirmId) {
            const id = randomBytes(12).toString('hex');
            await db.send(new PutCommand({ TableName: table, Item: { pk: 'PENDING', sk: id, who: sub, listId: p.id, until: now.getTime() + CONFIRM_MS, expires: Math.floor(now.getTime() / 1000) + 86_400 } }));
            return json(202, { confirm_id: id, prompt: `Delete the list “${row.name}” and everything on it?` });
          }
          // Single use, the same person, the same list, within two minutes
          const pending = /^[a-f0-9]{24}$/.test(confirmId) ? await get('PENDING', confirmId) : null;
          if (pending) await del('PENDING', confirmId);
          if (!pending || pending.who !== sub || pending.listId !== p.id || pending.until < now.getTime()) {
            return json(400, { error: 'that confirmation doesn’t match or has expired; ask again' });
          }
        }
        await deleteList(p.id);
        console.log('list deleted', JSON.stringify({ id: p.id, name: row.name, by: claims.username, via: viaDot ? 'dot' : 'page' }));
        return json(200, { id: p.id });
      }

      case 'PUT /lists/{id}/items/{itemId}': {
        const { level, missing } = await load();
        if (missing) return json(404, { error: 'no such list' });
        if (!atLeast(level, 'edit')) return json(403, { error: 'you can only see this list' });
        let fields;
        try {
          fields = parseItem(body);
        } catch (e) {
          return json(400, { error: e.message });
        }
        const rev = revOf(body);
        if (Number.isNaN(rev)) return json(400, { error: 'bad rev' });
        const old = rev === undefined ? null : await get(`ITEMS#${p.id}`, p.itemId);
        if (rev !== undefined && !old) return json(404, { error: 'no such item' });
        // A reminder belongs to whoever set it; a changed time is a new reminder, sent again
        if (fields.remind) {
          const same = old?.remind && old.remind.at === fields.remind.at && old.remind.channel === fields.remind.channel;
          fields.remind = same ? old.remind : { ...fields.remind, to: sub, sentAt: null };
        }
        const settled = settle(fields, old, at);
        const item = {
          pk: `ITEMS#${p.id}`, sk: p.itemId, ...settled,
          doneAt: settled.done ? (old?.done ? old.doneAt : at) : null,
          rev: (rev ?? 0) + 1, createdBy: old?.createdBy ?? sub, createdAt: old?.createdAt ?? at, updatedAt: at, updatedBy: sub,
        };
        if (!(await putAt(item, rev))) {
          const cur = await get(`ITEMS#${p.id}`, p.itemId);
          return json(409, { error: 'changed by someone else', current: cur ? itemOut(cur) : null });
        }
        const before = old && reminderKey(p.id, p.itemId, old), after = reminderKey(p.id, p.itemId, item);
        if (before && (!after || before.sk !== after.sk)) await del(before.pk, before.sk);
        if (after && (!before || before.sk !== after.sk)) await db.send(new PutCommand({ TableName: table, Item: { ...after, listId: p.id, itemId: p.itemId } }));
        return json(200, itemOut(item));
      }

      case 'DELETE /lists/{id}/items/{itemId}': {
        const { level, missing } = await load();
        if (missing) return json(404, { error: 'no such list' });
        if (!atLeast(level, 'edit')) return json(403, { error: 'you can only see this list' });
        const old = await get(`ITEMS#${p.id}`, p.itemId);
        const k = old && reminderKey(p.id, p.itemId, old);
        await Promise.all([del(`ITEMS#${p.id}`, p.itemId), ...(k ? [del(k.pk, k.sk)] : [])]);
        return json(200, { id: p.itemId });
      }

      case 'GET /prefs':
        return json(200, { channel: (await get('PREF', sub))?.channel ?? 'sms' });
      case 'PUT /prefs':
        if (!CHANNELS.includes(body.channel)) return json(400, { error: `channel: ${CHANNELS.join(' or ')}` });
        await db.send(new PutCommand({ TableName: table, Item: { pk: 'PREF', sk: sub, channel: body.channel } }));
        return json(200, { channel: body.channel });

      case 'GET /share-options': {
        const [list, names, groups] = await Promise.all([deps.members(), deps.people.names(), deps.people.groups()]);
        return json(200, {
          people: list.filter((m) => m.sub !== sub).map((m) => ({ sub: m.sub, name: names.get(m.sub) ?? m.name })).sort((a, b) => a.name.localeCompare(b.name)),
          groups: groups.map((g) => ({ id: g.id, name: g.name })),
        });
      }

      case 'GET /reminders/recent': {
        const days = [0, 1, 2].map((d) => new Date(now.getTime() - d * 86_400_000).toISOString().slice(0, 10));
        const sent = (await Promise.all(days.map((d) => all(`SENT#${d}`)))).flat()
          .filter((r) => r.to === sub && !r.error && now.getTime() - Date.parse(r.sentAt) < RECENT_MS)
          .sort((a, b) => (a.sentAt < b.sentAt ? 1 : -1));
        // `about` and `channel` make each one the shape every tool's sent texts share (role 'sent')
        return json(200, sent.map((r) => ({
          sentAt: r.sentAt, listId: r.listId, list: r.list, itemId: r.itemId, text: r.text, channel: r.channel, about: `Lists reminder (${r.list})`,
        })));
      }

      case 'GET /automations': {
        const visible = (await all('LIST')).map((l) => ({ l, level: levelOf(person, l) })).filter((x) => x.level !== 'none');
        const pref = (await get('PREF', sub))?.channel ?? 'sms';
        const out = (await Promise.all(visible.map(async ({ l, level }) => (await all(`ITEMS#${l.sk}`))
          .filter((i) => i.remind?.to === sub)
          .map((i) => ({ i, key: reminderKey(l.sk, i.sk, i) }))
          .filter((x) => x.key)
          .map(({ i, key }) => reminderAutomation({
            listId: l.sk, list: l, item: i, level, at: key.sk.split('#')[0], channel: i.remind.channel ?? pref, tz: deps.timeZone,
          }))))).flat();
        return json(200, out.sort((a, b) => a.next_at.localeCompare(b.next_at)));
      }

      default:
        return json(404, { error: 'no route' });
    }
  };
}

// The people in this tool's group, for sharing (only in Lambda). Usernames are subs.
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

const env = process.env;
export const handler = createApi({
  table: env.TABLE, group: env.GROUP, issuer: env.ISSUER,
  clientIds: [env.CLIENT_ID, env.DOT_CLIENT_ID].filter(Boolean), dotClientId: env.DOT_CLIENT_ID,
  people: makePeople({ db, table: env.PEOPLE_TABLE }), members, now: () => new Date(), timeZone: env.TIME_ZONE || 'America/New_York',
});
