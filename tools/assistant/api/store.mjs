// Conversation storage, one table (lukes-assistant):
//   pk = USER#<sub>, sk = CONV#<id>            { title, channel, createdAt, updatedAt }
//   pk = USER#<sub>, sk = MSG#<id>#<seq:000000> { role, content (JSON) }
//   pk = AUDIT,      sk = <iso time>#<id>        { user, username, channel, tool, action, outcome, detail }
//     what Dot did on someone's behalf with their access (admins see everyone's, others their own)
// History is append-only (a message is never edited): prompt caching depends on an unchanged
// prefix, and the API rejects edited history that carries thinking blocks.
// Photos (texted or emailed in) don't fit in a message item (400 KB at most): with a photo store
// (S3, `photos`) each is kept there for PHOTO_DAYS and the message holds { type: 'photo', key, at };
// loading puts the picture back while it's kept, or a note once it's gone. Without one, the note only.
// Texted conversations expire (DynamoDB TTL on expiresAt, epoch seconds) KEEP_DAYS after their
// last message: the Dot-y privacy policy (dot-y.co/privacy) keeps message content up to 12 months.
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

export const KEEP_DAYS = { sms: 365, email: 365 };
export const PHOTO_DAYS = 7;
// Each one goes to Claude again on every request, so only the latest few come back
export const MAX_PHOTOS_SHOWN = 6;

/** photos: { put(key, { media_type, data }), get(key) -> { media_type, data } | null, remove(key) } (data is base64) */
export function makeStore({ db, table, photos }) {
  const pk = (userId) => `USER#${userId}`;
  const expiry = (channel, now) => (KEEP_DAYS[channel] ? { expiresAt: Math.floor(now.getTime() / 1000) + KEEP_DAYS[channel] * 86400 } : {});
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
        Item: { pk: pk(userId), sk: `CONV#${id}`, ...conv, ...expiry(channel, now) },
        ConditionExpression: 'attribute_not_exists(pk)',
      }));
      return conv;
    },

    async getConversation(userId, id) {
      const r = await db.send(new GetCommand({ TableName: table, Key: { pk: pk(userId), sk: `CONV#${id}` } }));
      if (!r.Item) return null;
      const { pk: _p, sk: _s, expiresAt: _e, ...conv } = r.Item;
      return conv;
    },

    async listConversations(userId) {
      return (await query(userId, 'CONV#'))
        .map(({ pk: _p, sk: _s, expiresAt: _e, ...conv }) => conv)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    },

    /**
     * The conversation's messages, ready for Claude: kept photos come back as images (the newest
     * MAX_PHOTOS_SHOWN within PHOTO_DAYS of `now`). With `photos: false` (the page's transcript)
     * nothing is fetched and each photo is just "[Photo]".
     */
    async loadMessages(userId, id, { photos: show = true, now = new Date() } = {}) {
      const messages = (await query(userId, `MSG#${id}#`)).map((i) => ({ role: i.role, content: JSON.parse(i.content) }));
      const refs = messages.flatMap((m) => m.content.filter((b) => b.type === 'photo'));
      const fresh = refs.filter((b) => now - new Date(b.at) < PHOTO_DAYS * 86400e3).slice(-MAX_PHOTOS_SHOWN);
      const shown = new Map();
      if (show && photos) {
        await Promise.all(fresh.map(async (b) => {
          const got = await photos.get(b.key).catch((e) => { console.warn('photo not loaded:', e.message); return null; });
          if (got) shown.set(b, { type: 'image', source: { type: 'base64', media_type: got.media_type, data: got.data } });
        }));
      }
      for (const m of messages) {
        m.content = m.content.map((b) => (b.type !== 'photo' ? b
          : shown.get(b) ?? { type: 'text', text: show ? '[Photo, no longer kept]' : '[Photo]' }));
      }
      return messages;
    },

    /** Appends message number `seq`; refuses to overwrite one that exists. Photos in it go to the photo store. */
    async appendMessage(userId, id, seq, message, now = new Date(), channel = 'web') {
      const keep = expiry(channel, now);
      const content = await Promise.all(message.content.map(async (b, i) => {
        if (b.type !== 'image' || b.source?.type !== 'base64') return b;
        if (!photos) return { type: 'text', text: '[Photo, not kept]' };
        const key = `${userId}/${id}/${String(seq).padStart(6, '0')}-${i}`;
        await photos.put(key, { media_type: b.source.media_type, data: b.source.data });
        return { type: 'photo', key, at: now.toISOString() };
      }));
      await db.send(new PutCommand({
        TableName: table,
        Item: { pk: pk(userId), sk: msgKey(id, seq), role: message.role, content: JSON.stringify(content), ...keep },
        ConditionExpression: 'attribute_not_exists(pk)',
      }));
      // The conversation row outlives its last message, never the other way round
      await db.send(new UpdateCommand({
        TableName: table,
        Key: { pk: pk(userId), sk: `CONV#${id}` },
        UpdateExpression: keep.expiresAt ? 'SET updatedAt = :t, expiresAt = :e' : 'SET updatedAt = :t',
        ExpressionAttributeValues: { ':t': now.toISOString(), ...(keep.expiresAt && { ':e': keep.expiresAt }) },
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
        for (const b of JSON.parse(i.content)) if (b.type === 'photo' && photos) await photos.remove(b.key);
        await db.send(new DeleteCommand({ TableName: table, Key: { pk: i.pk, sk: i.sk } }));
      }
      await db.send(new DeleteCommand({ TableName: table, Key: { pk: pk(userId), sk: `CONV#${id}` } }));
    },
  };
}
