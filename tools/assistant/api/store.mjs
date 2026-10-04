// Conversation storage, one table (lukes-assistant):
//   pk = USER#<sub>, sk = CONV#<id>            { title, channel, createdAt, updatedAt }
//   pk = USER#<sub>, sk = MSG#<id>#<seq:000000> { role, content (JSON) }
//   pk = AUDIT,      sk = <iso time>#<id>        { user, username, channel, tool, action, outcome, detail }
//     what Dot did on someone's behalf with their access (admins see everyone's, others their own)
// History is append-only (a message is never edited): prompt caching depends on an unchanged
// prefix, and the API rejects edited history that carries thinking blocks.
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

export function makeStore({ db, table }) {
  const pk = (userId) => `USER#${userId}`;
  const msgKey = (id, seq) => `MSG#${id}#${String(seq).padStart(6, '0')}`;

  async function query(userId, prefix) {
    const items = [];
    let ExclusiveStartKey;
    do {
      const r = await db.send(new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
        ExpressionAttributeValues: { ':pk': pk(userId), ':p': prefix },
        ExclusiveStartKey,
      }));
      items.push(...r.Items);
      ExclusiveStartKey = r.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }

  return {
    async createConversation(userId, { id, title, channel = 'web', now = new Date() }) {
      const at = now.toISOString();
      const conv = { id, title, channel, createdAt: at, updatedAt: at };
      await db.send(new PutCommand({
        TableName: table,
        Item: { pk: pk(userId), sk: `CONV#${id}`, ...conv },
        ConditionExpression: 'attribute_not_exists(pk)',
      }));
      return conv;
    },

    async getConversation(userId, id) {
      const r = await db.send(new GetCommand({ TableName: table, Key: { pk: pk(userId), sk: `CONV#${id}` } }));
      if (!r.Item) return null;
      const { pk: _p, sk: _s, ...conv } = r.Item;
      return conv;
    },

    async listConversations(userId) {
      return (await query(userId, 'CONV#'))
        .map(({ pk: _p, sk: _s, ...conv }) => conv)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    },

    async loadMessages(userId, id) {
      return (await query(userId, `MSG#${id}#`)).map((i) => ({ role: i.role, content: JSON.parse(i.content) }));
    },

    /** Appends message number `seq`; refuses to overwrite one that exists */
    async appendMessage(userId, id, seq, message, now = new Date()) {
      await db.send(new PutCommand({
        TableName: table,
        Item: { pk: pk(userId), sk: msgKey(id, seq), role: message.role, content: JSON.stringify(message.content) },
        ConditionExpression: 'attribute_not_exists(pk)',
      }));
      await db.send(new UpdateCommand({
        TableName: table,
        Key: { pk: pk(userId), sk: `CONV#${id}` },
        UpdateExpression: 'SET updatedAt = :t',
        ExpressionAttributeValues: { ':t': now.toISOString() },
      }));
    },

    async addAudit(entry, now = new Date()) {
      const at = now.toISOString();
      await db.send(new PutCommand({
        TableName: table,
        Item: { pk: 'AUDIT', sk: `${at}#${Math.random().toString(36).slice(2, 8)}`, at, ...entry },
      }));
    },

    /** Newest first; only `user`'s entries when given */
    async listAudit({ user, limit = 200 } = {}) {
      const items = [];
      let ExclusiveStartKey;
      do {
        const r = await db.send(new QueryCommand({
          TableName: table, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': 'AUDIT' }, ExclusiveStartKey,
        }));
        items.push(...r.Items);
        ExclusiveStartKey = r.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return items
        .filter((i) => !user || i.user === user)
        .sort((a, b) => (a.sk < b.sk ? 1 : -1))
        .slice(0, limit)
        .map(({ pk: _p, sk: _s, ...e }) => e);
    },

    async deleteConversation(userId, id) {
      for (const i of await query(userId, `MSG#${id}#`)) {
        await db.send(new DeleteCommand({ TableName: table, Key: { pk: i.pk, sk: i.sk } }));
      }
      await db.send(new DeleteCommand({ TableName: table, Key: { pk: pk(userId), sk: `CONV#${id}` } }));
    },
  };
}
