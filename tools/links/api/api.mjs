// Links API: bookmarks grouped into sections. Each section is someone's own until they share it, like a
// list: the maker owns it and shares it with people or family groups to see or to edit
// (platform/api/sharing.mjs); its links follow. Routes (all require a family_links access token):
//   GET    /all              -> { sections: [{ id, name, order, owner, level, share, rev }], links: [{ id, sectionId, title, url, order }] }
//                               only the sections this person can see, and their links
//   PUT    /sections/{id}    { name, order, share?, rev }   new: they own it; edit: rename, reorder; share: owner only
//   DELETE /sections/{id}    owner only; also deletes its links
//   PUT    /links/{id}       { sectionId, title, url, order }   url must be http(s); edit on its section (both, if moved)
//   DELETE /links/{id}       edit on its section
//   GET    /share-options    -> { people: [{ sub, name }], groups: [{ id, name }] }   who a section can be shared with
// Rows (pk = TOOL): SECTION#<id> { name, order, owner, share, rev }, LINK#<id> { sectionId, title, url, order }.
// A section someone can't see answers 404, as if it weren't there. Sections are rev-checked (409 with the current one).
// The token is re-verified here (signature, issuer, client, expiry, group); API Gateway's
// authorizer is not trusted on its own.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient, ListUsersInGroupCommand } from '@aws-sdk/client-cognito-identity-provider';
import { verifyAccessToken } from './verify-token.mjs';
import { atLeast, levelOf, parseShare } from './sharing.mjs';
import { makePeople } from './people.mjs';

const PK = 'TOOL';

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

const byOrder = (a, b) => a.order - b.order;
const sectionOut = (i, level) => ({ id: i.sk.slice(8), name: i.name, order: i.order, owner: i.owner, level, share: i.share ?? [], rev: i.rev ?? 0 });
const linkOut = (i) => ({ id: i.sk.slice(5), sectionId: i.sectionId, title: i.title, url: i.url, order: i.order });

/** deps: table, group, issuer, clientId, db (document client), people (platform/api/people.mjs), members() -> [{ sub, name }] */
export function createApi(deps) {
  const { db, table } = deps;
  const get = async (sk) => (await db.send(new GetCommand({ TableName: table, Key: { pk: PK, sk } }))).Item;
  const del = (sk) => db.send(new DeleteCommand({ TableName: table, Key: { pk: PK, sk } }));
  async function queryPrefix(prefix) {
    const items = [];
    let ExclusiveStartKey;
    do {
      const r = await db.send(new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
        ExpressionAttributeValues: { ':pk': PK, ':p': prefix },
        ExclusiveStartKey,
      }));
      items.push(...r.Items);
      ExclusiveStartKey = r.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }

  return async (event) => {
    let claims;
    try {
      claims = await verifyAccessToken(event.headers, { issuer: deps.issuer, clientId: deps.clientId, group: deps.group });
    } catch (e) {
      if (!e.status) throw e;
      console.warn('denied', e.message);
      return json(e.status, { error: e.status === 403 ? 'forbidden' : 'unauthorized' });
    }

    let body = {};
    if (event.body) {
      try {
        body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body) ?? {};
      } catch {
        return json(400, { error: 'bad json' });
      }
    }
    const id = event.pathParameters?.id;
    if (id !== undefined && !/^[A-Za-z0-9_-]{1,40}$/.test(id)) return json(400, { error: 'bad id' });
    const sub = claims.sub;
    const person = { sub, groupIds: new Set((await deps.people.groups()).filter((g) => g.members.includes(sub)).map((g) => g.id)) };
    /** A section and this person's level on it ('none' when it isn't there) */
    const section = async (sid) => {
      const row = sid ? await get(`SECTION#${sid}`) : null;
      return { row, level: row ? levelOf(person, row) : 'none' };
    };
    const stamp = { updatedAt: new Date().toISOString(), updatedBy: claims.username };
    const order = Number.isFinite(body.order) ? body.order : Date.now();

    switch (event.routeKey) {
      case 'GET /all': {
        const visible = (await queryPrefix('SECTION#')).map((s) => ({ s, level: levelOf(person, s) })).filter((x) => x.level !== 'none');
        const ids = new Set(visible.map((x) => x.s.sk.slice(8)));
        return json(200, {
          sections: visible.map((x) => sectionOut(x.s, x.level)).sort(byOrder),
          links: (await queryPrefix('LINK#')).filter((l) => ids.has(l.sectionId)).map(linkOut).sort(byOrder),
        });
      }

      case 'PUT /sections/{id}': {
        const name = text(body.name, 80);
        if (!name) return json(400, { error: 'name required' });
        let share;
        try {
          share = body.share === undefined ? undefined : parseShare(body.share);
        } catch (e) {
          return json(400, { error: e.message });
        }
        const { row, level } = await section(id);
        let item;
        if (!row) {
          item = { pk: PK, sk: `SECTION#${id}`, name, order, owner: sub, share: share ?? [], rev: 1, ...stamp };
        } else {
          if (level === 'none') return json(404, { error: 'no such section' });
          if (!atLeast(level, 'edit')) return json(403, { error: 'you can only see this section' });
          const rev = row.rev ?? 0;
          if (body.rev !== rev) return json(409, { error: 'changed', current: sectionOut(row, level) });
          const next = share ?? row.share ?? [];
          if (JSON.stringify(next) !== JSON.stringify(row.share ?? []) && level !== 'owner') return json(403, { error: 'only the owner shares a section' });
          item = { ...row, name, order, share: next, rev: rev + 1, ...stamp };
        }
        try {
          await db.send(new PutCommand({
            TableName: table, Item: item,
            ...(row ? { ConditionExpression: 'rev = :rev', ExpressionAttributeValues: { ':rev': row.rev ?? 0 } } : { ConditionExpression: 'attribute_not_exists(pk)' }),
          }));
        } catch (e) {
          if (e.name !== 'ConditionalCheckFailedException') throw e;
          const cur = await get(`SECTION#${id}`);
          return cur && levelOf(person, cur) !== 'none' ? json(409, { error: 'changed', current: sectionOut(cur, levelOf(person, cur)) }) : json(404, { error: 'no such section' });
        }
        return json(200, sectionOut(item, row ? level : 'owner'));
      }
      case 'DELETE /sections/{id}': {
        const { row, level } = await section(id);
        if (!row || level === 'none') return json(404, { error: 'no such section' });
        if (level !== 'owner') return json(403, { error: 'only the owner deletes a section' });
        for (const l of (await queryPrefix('LINK#')).filter((i) => i.sectionId === id)) await del(l.sk);
        await del(`SECTION#${id}`);
        return json(200, { id });
      }

      case 'PUT /links/{id}': {
        const url = safeUrl(body.url);
        if (!url) return json(400, { error: 'url must start with http:// or https://' });
        const sectionId = text(body.sectionId, 40);
        const to = await section(sectionId);
        if (to.level === 'none') return json(400, { error: 'no such section' });
        if (!atLeast(to.level, 'edit')) return json(403, { error: 'you can only see this section' });
        // An existing link is changed only by someone who may edit where it is now
        const old = await get(`LINK#${id}`);
        if (old && old.sectionId !== sectionId) {
          const from = await section(old.sectionId);
          if (from.level === 'none') return json(404, { error: 'no such link' });
          if (!atLeast(from.level, 'edit')) return json(403, { error: 'you can only see that link’s section' });
        }
        const title = text(body.title, 120) || new URL(url).hostname;
        await db.send(new PutCommand({ TableName: table, Item: { pk: PK, sk: `LINK#${id}`, sectionId, title, url, order, ...stamp } }));
        return json(200, { id, url, title });
      }
      case 'DELETE /links/{id}': {
        const old = await get(`LINK#${id}`);
        const { level } = await section(old?.sectionId);
        if (!old || level === 'none') return json(404, { error: 'no such link' });
        if (!atLeast(level, 'edit')) return json(403, { error: 'you can only see this section' });
        await del(`LINK#${id}`);
        return json(200, { id });
      }

      case 'GET /share-options': {
        const [list, names, groups] = await Promise.all([deps.members(), deps.people.names(), deps.people.groups()]);
        return json(200, {
          people: list.filter((m) => m.sub !== sub).map((m) => ({ sub: m.sub, name: names.get(m.sub) ?? m.name })).sort((a, b) => a.name.localeCompare(b.name)),
          groups: groups.map((g) => ({ id: g.id, name: g.name })),
        });
      }

      default:
        return json(404, { error: 'no route' });
    }
  };
}

const idp = new CognitoIdentityProviderClient({});
/** Everyone in family_links, to share a section with */
async function members() {
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
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
export const handler = createApi({
  db, table: env.TABLE, group: env.GROUP, issuer: env.ISSUER, clientId: env.CLIENT_ID,
  people: makePeople({ db, table: env.PEOPLE_TABLE }), members,
});
