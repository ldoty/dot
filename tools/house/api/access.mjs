// Who may do what (admins only, from the page; Dot can't reach any of this). The rules themselves
// are in grants.mjs; this stores them.
//   GET    /access         -> { grants, groups, people, areas, entities }   people: members of the
//                             tool's group (Cognito), named as dot-y.co/family names them; groups: the
//                             family's (platform/api/people.mjs), edited there, granted here by id
//   PUT    /grants/{id}    { who, where, level, rev? } -> the grant      no rev: new; rev: replace that
//   DELETE /grants/{id}                                                   version (409 + current if it changed)
//   GET    /log            -> the last 7 days of commands, newest first (at most 200)
//
// Rows: GRANT / <id>    { who, where, level, rev, changedBy, changedAt }
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { parseGrant } from './grants.mjs';

const GRANT_ID = /^[a-z0-9]{6,24}$/;
const LOG_DAYS = 7;
const LOG_MAX = 200;

const json = (statusCode, body) => ({
  statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const grantOut = (g) => ({ id: g.sk, who: g.who, where: g.where, level: g.level, rev: g.rev });

/** deps: db, table, all(pk), members() -> [{ sub, name }], people (platform/api/people.mjs), now() */
export function makeAccess({ db, table, all, members, people, now }) {
  const get = async (pk, sk) => (await db.send(new GetCommand({ TableName: table, Key: { pk, sk } }))).Item;

  /** Put with a rev check; false if someone else changed it first */
  async function putAt(item, rev) {
    try {
      await db.send(new PutCommand({
        TableName: table, Item: item,
        ...(rev === undefined
          ? { ConditionExpression: 'attribute_not_exists(pk)' }
          : { ConditionExpression: 'rev = :rev', ExpressionAttributeValues: { ':rev': rev } }),
      }));
      return true;
    } catch (e) {
      if (e.name === 'ConditionalCheckFailedException') return false;
      throw e;
    }
  }
  const revOf = (body) => (body.rev === undefined ? undefined : Number.isInteger(body.rev) ? body.rev : NaN);

  return {
    async read() {
      const [grants, groups, list, names, areas, entities] = await Promise.all([all('GRANT'), people.groups(), members(), people.names(), all('AREA'), all('ENTITY')]);
      return json(200, {
        grants: grants.map(grantOut),
        groups: groups.map((g) => ({ id: g.id, name: g.name })),
        people: list.map((p) => ({ sub: p.sub, name: names.get(p.sub) ?? p.name })).sort((a, b) => a.name.localeCompare(b.name)),
        areas: areas.map((a) => ({ id: a.sk, name: a.name })).sort((a, b) => a.name.localeCompare(b.name)),
        entities: entities.map((e) => ({ id: e.sk, name: e.name, area: e.area ?? null })).sort((a, b) => a.name.localeCompare(b.name)),
      });
    },

    async putGrant(id, body, by) {
      if (!GRANT_ID.test(id ?? '')) return json(400, { error: 'bad id' });
      let g;
      try {
        g = parseGrant(body);
      } catch (e) {
        return json(400, { error: `bad ${e.message}` });
      }
      const rev = revOf(body);
      if (Number.isNaN(rev)) return json(400, { error: 'bad rev' });
      const item = { pk: 'GRANT', sk: id, ...g, rev: (rev ?? 0) + 1, changedBy: by, changedAt: now().toISOString() };
      if (!(await putAt(item, rev))) {
        const cur = await get('GRANT', id);
        return json(409, { error: 'changed by someone else', current: cur ? grantOut(cur) : null });
      }
      console.log('grant saved', JSON.stringify({ id, ...g, by }));
      return json(200, grantOut(item));
    },

    async deleteGrant(id, by) {
      if (!GRANT_ID.test(id ?? '')) return json(400, { error: 'bad id' });
      await db.send(new DeleteCommand({ TableName: table, Key: { pk: 'GRANT', sk: id } }));
      console.log('grant removed', JSON.stringify({ id, by }));
      return json(200, { id });
    },

    async log() {
      const today = now().getTime();
      const days = Array.from({ length: LOG_DAYS }, (_, i) => new Date(today - i * 86_400_000).toISOString().slice(0, 10));
      const rows = (await Promise.all(days.map((d) => all(`CMD#${d}`)))).flat();
      return json(200, rows
        .sort((a, b) => (a.sk < b.sk ? 1 : -1))
        .slice(0, LOG_MAX)
        .map((r) => ({ at: r.sk.split('#')[0], who: r.who, username: r.username, via: r.via, entity_id: r.entity_id, name: r.name, action: r.action, data: r.data ?? {}, outcome: r.outcome, error: r.error ?? null })));
    },
  };
}
