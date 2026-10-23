// The family's groups and display names (dot-y.co/family), for family admins only. Tools read the
// same table through platform/api/people.mjs; this is the only writer. Also each person's own
// arrangement of the dot-y.co home page. Routes (a dot-y.co token; dot-y.co's tokens carry all of
// a person's groups, and every route but /home needs family_admin among them):
//   GET    /home            -> { sections: [{ id, name, tiles: [tool group] }] | null, rev }   the caller's own
//   PUT    /home            { sections, rev } -> the same       rev 0: first save; 409 + current if it changed
//   GET    /people          -> { people: [{ sub, name, email, displayName }], groups: [{ id, name, members, rev }] }
//                              people: every account in the user pool (Cognito), with any display name set here
//   PUT    /people/{sub}    { name } -> { sub, name }            '' clears it (tools fall back to Cognito's)
//   PUT    /groups/{id}     { name, members, rev? } -> the group  no rev: new; rev: replace that version
//                                                                (409 + current if it changed); names are unique
//   DELETE /groups/{id}                                          tools' grants for it stop applying, for good
// This Lambda can't change anyone's access: it has no permission to touch Cognito groups, only to
// list users. Who may use a tool stays with each tool's Cognito group.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { verifyAccessToken } from './verify-token.mjs';
import { GROUP_ID } from './people.mjs';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const SUB = /^[0-9a-f-]{36}$/;
const NAME = /^[a-z0-9][a-z0-9 _-]{0,39}$/i;
// Home page sections: ids the page makes up, tiles named by their tool's Cognito group (apps.json).
// Only shapes are checked: the page shows a tile only if the person is in its group, whatever's saved.
const SECTION_ID = /^s[a-z0-9]{4,20}$/;
const TILE = /^[a-z0-9_*:-]{1,64}$/i;

const json = (statusCode, body) => ({
  statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const groupOut = (g) => ({ id: g.sk, name: g.name, members: g.members ?? [], rev: g.rev });
const homeOut = (h) => ({ sections: h?.sections ?? null, rev: h?.rev ?? 0 });

function badSections(sections) {
  if (!Array.isArray(sections) || sections.length > 30) return 'sections: a list, up to 30';
  const ids = new Set(), tiles = new Set();
  for (const s of sections) {
    if (!s || typeof s !== 'object' || !SECTION_ID.test(s.id ?? '') || ids.has(s.id)) return 'bad section id';
    if (typeof s.name !== 'string' || s.name.trim().length > 40) return 'section name: up to 40 characters';
    if (!Array.isArray(s.tiles) || s.tiles.length > 100) return 'bad tiles';
    for (const t of s.tiles) {
      if (typeof t !== 'string' || !TILE.test(t) || tiles.has(t)) return 'bad tiles'; // a tile sits in one place
      tiles.add(t);
    }
    ids.add(s.id);
  }
  return null;
}

/** deps: table, issuer, clientId (dot-y.co's), users() -> [{ sub, name, email }], now() */
export function createApi(deps) {
  const { table } = deps;
  const get = async (pk, sk) => (await db.send(new GetCommand({ TableName: table, Key: { pk, sk } }))).Item;
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

  return async (event) => {
    // Anyone signed in at dot-y.co may arrange their own home page (keyed by their own sub);
    // everything else is for family admins.
    const own = event.routeKey === 'GET /home' || event.routeKey === 'PUT /home';
    let claims;
    try {
      claims = await verifyAccessToken(event.headers, { issuer: deps.issuer, clientId: deps.clientId, group: own ? null : 'family_admin' });
    } catch (e) {
      if (!e.status) throw e;
      console.warn('denied', e.message);
      return json(e.status, { error: e.status === 403 ? 'family admins only' : 'unauthorized' });
    }
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
    const at = deps.now().toISOString();

    switch (event.routeKey) {
      case 'GET /home':
        return json(200, homeOut(await get('HOME', claims.sub)));
      case 'PUT /home': {
        const bad = badSections(body.sections);
        if (bad) return json(400, { error: bad });
        if (!Number.isInteger(body.rev) || body.rev < 0) return json(400, { error: 'bad rev' });
        const sections = body.sections.map((s) => ({ id: s.id, name: s.name.trim(), tiles: s.tiles }));
        const item = { pk: 'HOME', sk: claims.sub, sections, rev: body.rev + 1, changedAt: at };
        try {
          await db.send(new PutCommand({
            TableName: table, Item: item,
            ...(body.rev === 0
              ? { ConditionExpression: 'attribute_not_exists(pk)' }
              : { ConditionExpression: 'rev = :rev', ExpressionAttributeValues: { ':rev': body.rev } }),
          }));
        } catch (e) {
          if (e.name !== 'ConditionalCheckFailedException') throw e;
          return json(409, { error: 'changed elsewhere', current: homeOut(await get('HOME', claims.sub)) });
        }
        return json(200, homeOut(item));
      }
      case 'GET /people': {
        const [users, names, groups] = await Promise.all([deps.users(), all('PERSON'), all('GROUP')]);
        const display = new Map(names.map((n) => [n.sk, n.name]));
        return json(200, {
          people: users.map((u) => ({ ...u, displayName: display.get(u.sub) ?? null })).sort((a, b) => (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name)),
          groups: groups.map(groupOut).sort((a, b) => a.name.localeCompare(b.name)),
        });
      }
      case 'PUT /people/{sub}': {
        if (!SUB.test(p.sub ?? '')) return json(400, { error: 'bad sub' });
        const name = typeof body.name === 'string' ? body.name.trim() : null;
        if (name === null || name.length > 40) return json(400, { error: 'name: up to 40 characters' });
        if (!name) await db.send(new DeleteCommand({ TableName: table, Key: { pk: 'PERSON', sk: p.sub } }));
        else await db.send(new PutCommand({ TableName: table, Item: { pk: 'PERSON', sk: p.sub, name, changedBy: by, changedAt: at } }));
        console.log('name set', JSON.stringify({ sub: p.sub, name, by }));
        return json(200, { sub: p.sub, name: name || null });
      }
      case 'PUT /groups/{id}': {
        if (!GROUP_ID.test(p.id ?? '')) return json(400, { error: 'bad id' });
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!NAME.test(name)) return json(400, { error: 'name: letters, digits, spaces, - and _, up to 40' });
        const members = body.members;
        if (!Array.isArray(members) || members.length > 50 || members.some((s) => typeof s !== 'string' || !SUB.test(s))) return json(400, { error: 'bad members' });
        if (body.rev !== undefined && !Number.isInteger(body.rev)) return json(400, { error: 'bad rev' });
        if ((await all('GROUP')).some((g) => g.sk !== p.id && g.name.toLowerCase() === name.toLowerCase())) return json(409, { error: `there’s already a group called ${name}` });
        const item = { pk: 'GROUP', sk: p.id, name, members: [...new Set(members)], rev: (body.rev ?? 0) + 1, changedBy: by, changedAt: at };
        try {
          await db.send(new PutCommand({
            TableName: table, Item: item,
            ...(body.rev === undefined
              ? { ConditionExpression: 'attribute_not_exists(pk)' }
              : { ConditionExpression: 'rev = :rev', ExpressionAttributeValues: { ':rev': body.rev } }),
          }));
        } catch (e) {
          if (e.name !== 'ConditionalCheckFailedException') throw e;
          const cur = await get('GROUP', p.id);
          return json(409, { error: 'changed by someone else', current: cur ? groupOut(cur) : null });
        }
        console.log('group saved', JSON.stringify({ id: p.id, name, members: item.members, by }));
        return json(200, groupOut(item));
      }
      case 'DELETE /groups/{id}': {
        if (!GROUP_ID.test(p.id ?? '')) return json(400, { error: 'bad id' });
        await db.send(new DeleteCommand({ TableName: table, Key: { pk: 'GROUP', sk: p.id } }));
        console.log('group removed', JSON.stringify({ id: p.id, by }));
        return json(200, { id: p.id });
      }
      default:
        return json(404, { error: 'no route' });
    }
  };
}

// Every account in the pool, for picking members (only in Lambda). Usernames are subs.
async function users() {
  const { CognitoIdentityProviderClient, ListUsersCommand } = await import('@aws-sdk/client-cognito-identity-provider');
  const idp = new CognitoIdentityProviderClient({});
  const out = [];
  let PaginationToken;
  do {
    const r = await idp.send(new ListUsersCommand({ UserPoolId: process.env.USER_POOL_ID, PaginationToken }));
    for (const u of r.Users) {
      if (!u.Enabled) continue;
      const attr = (n) => u.Attributes?.find((a) => a.Name === n)?.Value;
      out.push({ sub: attr('sub') ?? u.Username, name: attr('name') || attr('given_name') || attr('email') || u.Username, email: attr('email') ?? null });
    }
    PaginationToken = r.PaginationToken;
  } while (PaginationToken);
  return out;
}

const env = process.env;
export const handler = createApi({ table: env.TABLE, issuer: env.ISSUER, clientId: env.CLIENT_ID, users, now: () => new Date() });
