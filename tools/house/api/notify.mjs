// Texts an automation's owner when it runs (automation.mjs `notify`): "when Luke leaves home, text him".
// The relay only says that an automation ran (relay-ws.mjs hands that here, asynchronously); everything
// else is decided here, from what's stored:
//   - the automation must be one that may run now (automations.mjs runnable(): its owner is still in
//     House and can still see what sets it off), and have a notify;
//   - the text goes only to its owner, to their verified phone (Cognito), with its own stored message;
//   - once per run (NOTIFIED row, conditional), and at most PER_DAY a day per automation, so even a relay
//     key in the wrong hands can't turn this into a stream of texts;
//   - within the person's daily limit on everything Dot-y sends unasked (platform/api/send-limit.mjs).
// Texts go through the Dot-y number's registered campaign, with no links (automation.mjs refuses them).
//
// The text says which automation sent it ("Dot-y, Leaving home: check the garage"), and a SENT row keeps
// it for two days, so when its owner texts Dot back ("turn them off then"), Dot knows what they mean
// (GET /sent, the manifest's `sent` role).
//
// Rows: NOTIFIED / <automation id>#<run key>   { at, expires (2 days) }
//       SENT#<UTC day> / <ISO>#<id>#<run key>   { to, automation, name, text, channel, sentAt, error, expires (3 days) }
//       CMD#<UTC day> / <ISO>#<id>n             audit: via 'automation', action 'notify'
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { AUTO_ID } from './automation.mjs';
import { LIMIT_REACHED } from './send-limit.mjs';

export const PER_DAY = 10;

/** The text as sent: from Dot-y, saying which automation it is */
export const textFor = (row) => `Dot-y, ${row.name}: ${row.notify.message}`;
const KEY = /^(\d{4}-\d{2}-\d{2})@\d{1,4}$/;

/**
 * deps: db, table, get(pk, sk), automations (automations.mjs), contact(sub) -> { phone }, text(phone, body), now(),
 * limit(sub) -> { ok } (send-limit.mjs: counts one, if there's room today)
 */
export function createNotify({ db, table, get, automations, contact, text, now, limit }) {
  return async ({ id, key } = {}) => {
    const day = KEY.exec(key ?? '')?.[1];
    if (!AUTO_ID.test(id ?? '') || !day) return { sent: false, why: 'bad request' };
    const row = await get('AUTO', id);
    const may = row?.notify && (await automations.runnable()).some((a) => a.id === id);
    if (!may) {
      console.warn('notify: not allowed', id);
      return { sent: false, why: 'not allowed' };
    }
    const t = now();
    try {
      await db.send(new PutCommand({
        TableName: table, Item: { pk: 'NOTIFIED', sk: `${id}#${key}`, at: t.toISOString(), expires: Math.floor(t.getTime() / 1000) + 2 * 86_400 },
        ConditionExpression: 'attribute_not_exists(pk)',
      }));
    } catch (e) {
      if (e.name === 'ConditionalCheckFailedException') return { sent: false, why: 'already sent' };
      throw e;
    }
    let sentToday = 0, ExclusiveStartKey;
    do {
      const r = await db.send(new QueryCommand({
        TableName: table, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)', ExpressionAttributeValues: { ':pk': 'NOTIFIED', ':p': `${id}#${day}@` }, ExclusiveStartKey,
      }));
      sentToday += r.Items.length;
      ExclusiveStartKey = r.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    if (sentToday > PER_DAY) {
      console.warn('notify: over the daily limit', id);
      return { sent: false, why: 'daily limit' };
    }

    let outcome = 'done', error = null;
    const body = textFor(row);
    try {
      if (!(await limit(row.owner)).ok) throw new Error(LIMIT_REACHED);
      const who = await contact(row.owner);
      if (!who.phone) throw new Error('no verified phone');
      await text(who.phone, body);
    } catch (e) {
      outcome = 'failed';
      error = e.message.slice(0, 200);
      console.warn('notify: not sent', id, error);
    }
    const at = t.toISOString();
    await db.send(new PutCommand({
      TableName: table,
      Item: {
        pk: `SENT#${at.slice(0, 10)}`, sk: `${at}#${id}#${key}`, to: row.owner, automation: id, name: row.name, text: body, channel: 'sms',
        sentAt: at, error, expires: Math.floor(t.getTime() / 1000) + 3 * 86_400,
      },
    }));
    await db.send(new PutCommand({
      TableName: table,
      Item: {
        pk: `CMD#${at.slice(0, 10)}`, sk: `${at}#${id}n`, who: row.owner, via: 'automation', automation: id, automationName: row.name,
        entity_id: row.when?.changes ?? null, name: 'a text', action: 'notify', data: {}, outcome, error, expires: Math.floor(t.getTime() / 1000) + 365 * 86_400,
      },
    }));
    return { sent: outcome === 'done', ...(error ? { why: error } : {}) };
  };
}
