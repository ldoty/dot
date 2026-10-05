// A finances tool's table. One partition (pk = PARTITION: LUKE, AMBER, SHARED):
//   TXN#<date>#<hash>   a transaction: account, amount, description, merchant, line, source, asked
//   ACCT#<hash>         an account: name, org, balance, balanceDate, owner (mine | shared | off)
//   RULE#<merchant>     this merchant's transactions go to `line` (by: 'claude' or who filed it)
//   SETTINGS            { tag } which of Luke's budget tags to follow
//   BUDGET              the resolved budget lines (budget-lines.mjs), refreshed each sync
//   SYNC                the last sync: { startedAt, at, ok, message, counts, errors }
//   AUDIT#<at>#<rand>   each read of the budget made as Luke
// <hash> is the first 16 hex of sha256 over SimpleFIN's ids, so keys stay short and URL-safe.
import { createHash, randomBytes } from 'node:crypto';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

export const PK = 'LUKE'; // the default, for Luke's existing table and the tests
/** Whose account: 'mine' (Luke's own), 'shared' (a joint account: Shared lines only) or 'off' (not counted) */
export const OWNERS = ['mine', 'shared', 'off'];
export const ownerOf = (a) => (a ? (OWNERS.includes(a.owner) ? a.owner : a.include === false ? 'off' : 'mine') : 'mine');
/** May a transaction in an account with this owner be filed under this line? */
export const lineFits = (owner, line) => owner !== 'shared' || line.group === 'Shared' || line.kind === 'skip';
export const hash = (...parts) => createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
/** API id <-> sort key: "2026-10-03.0123456789abcdef" <-> "TXN#2026-10-03#0123456789abcdef" */
export const txnId = (sk) => sk.slice(4).replace('#', '.');
export const txnKey = (id) => (/^\d{4}-\d{2}-\d{2}\.[0-9a-f]{16}$/.test(id) ? `TXN#${id.replace('.', '#')}` : null);

export function makeStore({ db, table, pk = PK }) {
  const get = async (sk) => (await db.send(new GetCommand({ TableName: table, Key: { pk, sk } }))).Item || null;
  const put = (item) => db.send(new PutCommand({ TableName: table, Item: { ...item, pk } }));
  async function query(prefix) {
    const items = [];
    let ExclusiveStartKey;
    do {
      const r = await db.send(new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
        ExpressionAttributeValues: { ':pk': pk, ':p': prefix },
        ExclusiveStartKey,
      }));
      items.push(...r.Items);
      ExclusiveStartKey = r.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }

  return {
    get, put,
    txns: (prefix = '') => query(`TXN#${prefix}`),
    accounts: () => query('ACCT#'),
    rules: () => query('RULE#'),
    rule: (merchant) => get(`RULE#${merchant}`),
    // by: 'claude' for Claude's picks (until corrected), else the username who filed it
    putRule: (merchant, line, by) => (line
      ? put({ sk: `RULE#${merchant}`, line, by, updatedAt: new Date().toISOString() })
      : db.send(new DeleteCommand({ TableName: table, Key: { pk, sk: `RULE#${merchant}` } }))),
    settings: async () => ({ tag: 'default', ...(await get('SETTINGS')) }),
    budget: () => get('BUDGET'),
    sync: () => get('SYNC'),
    audit: (entry) => put({ sk: `AUDIT#${new Date().toISOString()}#${randomBytes(3).toString('hex')}`, ...entry }),
  };
}
