// The family's groups and display names, kept once for every tool (platform/family, table
// family-people) and edited by family admins at dot-y.co/family. A tool reads them, never writes:
// its role may only GetItem/Query that table. Symlinked into each tool that grants by group.
//
// Rows: GROUP / <id>    { name, members: [cognito sub], rev, changedBy, changedAt }
//       PERSON / <sub>  { name }                      a display name, over Cognito's
//
// A tool's grants name a group by its id (`group:<id>`), never its name: delete "kids" and make a
// new "kids", and the old group's grants stay dead instead of quietly applying to the new one.
import { QueryCommand } from '@aws-sdk/lib-dynamodb';

export const GROUP_ID = /^g[a-z0-9]{8,20}$/;

/** db: a DynamoDB document client; reads are cached for ttlMs (an admin's change shows within a minute) */
export function makePeople({ db, table, ttlMs = 60_000, now = () => Date.now() }) {
  const cache = new Map(); // pk -> { at, items }
  async function rows(pk) {
    const hit = cache.get(pk);
    if (hit && now() - hit.at < ttlMs) return hit.items;
    const items = [];
    let ExclusiveStartKey;
    do {
      const r = await db.send(new QueryCommand({ TableName: table, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': pk }, ExclusiveStartKey }));
      items.push(...r.Items);
      ExclusiveStartKey = r.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    cache.set(pk, { at: now(), items });
    return items;
  }
  return {
    /** [{ id, name, members }] */
    async groups() {
      return (await rows('GROUP')).map((g) => ({ id: g.sk, name: g.name, members: g.members ?? [] })).sort((a, b) => a.name.localeCompare(b.name));
    },
    /** Map sub -> display name, for the people who have one set */
    async names() {
      return new Map((await rows('PERSON')).filter((p) => p.name).map((p) => [p.sk, p.name]));
    },
  };
}
