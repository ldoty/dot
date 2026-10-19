// One daily limit on everything Dot-y sends someone without being asked: the house's automation texts,
// Lists' reminders and Dot's scheduled asks, together (at most PER_DAY a person a day). Each tool also
// keeps its own limits; this one bounds the total, so no mix of automations can turn into a stream of
// texts. Replies to someone's own message don't count: they asked.
//
// The count lives in its own small table (tools/sms/infra/sends.tf, SSM /family/sms/sends-table-arn),
// one row per person per day in the family's time zone, taken with a conditional write before
// anything is sent, so two senders at once can't both take the last one.
//
// Rows: SENDS#<sub> / <local date>   { n, rev, expires (3 days) }
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

export const PER_DAY = 50;
const TRIES = 5;

/** A local date, YYYY-MM-DD */
const dayIn = (t, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);

/**
 * deps: db (DynamoDB document client), table, timeZone, now(). -> take(sub): { ok, n } — ok: one more may
 * go to this person today, and it's been counted; n: how many today, counting it
 */
export function makeSendLimit({ db, table, timeZone = 'America/New_York', now = () => new Date() }) {
  return async function take(sub) {
    const t = now();
    const key = { pk: `SENDS#${sub}`, sk: dayIn(t, timeZone) };
    for (let i = 0; i < TRIES; i++) {
      const row = (await db.send(new GetCommand({ TableName: table, Key: key }))).Item;
      const n = row?.n ?? 0;
      if (n >= PER_DAY) return { ok: false, n };
      try {
        await db.send(new PutCommand({
          TableName: table, Item: { ...key, n: n + 1, rev: (row?.rev ?? 0) + 1, expires: Math.floor(t.getTime() / 1000) + 3 * 86_400 },
          ...(row ? { ConditionExpression: 'rev = :rev', ExpressionAttributeValues: { ':rev': row.rev } } : { ConditionExpression: 'attribute_not_exists(pk)' }),
        }));
        return { ok: true, n: n + 1 };
      } catch (e) {
        if (e.name !== 'ConditionalCheckFailedException') throw e; // someone else counted one meanwhile: read again
      }
    }
    // Couldn't count it: send nothing rather than risk going over
    return { ok: false, n: null };
  };
}

export const LIMIT_REACHED = `today's limit of ${PER_DAY} texts and emails from Dot-y is reached`;
