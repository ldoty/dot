// Sends Lists' reminders. EventBridge runs it every minute (infra/sweep.tf; one at a time), in AWS so
// reminders come even when the home server is down. The table is the only source of truth: an
// item's reminder is due when its REMIND# index row's time has passed (api.mjs keeps those rows in
// step with the items), so a missed minute is simply caught up by the next one.
//
// Each reminder is claimed before it's sent: the item is rewritten with remind.sentAt, conditional on
// its rev. A sweep that loses that race, or finds the item done, deleted or moved to another time,
// sends nothing. A failed send is recorded, not retried, so nobody gets the same text twice.
// A repeating item in schedule mode that wasn't ticked off rolls on to its next occurrence here
// (repeat.mjs), is reminded again, and gets the row for the one after.
//
// Texts go through the Dot-y number's registered campaign ("reminder and assistant texts"; no
// links, ever), only to a verified phone, and Twilio refuses anyone who replied STOP. Email comes
// from Dot (dot@dot-y.co), so a reply reaches Dot. Either way the person can answer "done" or
// "snooze an hour", and Dot finds the reminder through GET /reminders/recent.
//
// Rows written: SENT#<UTC day> / <sentAt>#<list>#<item>   { to, listId, list, itemId, text, channel, sentAt,
//                                                          error, expires (3 days) }
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { reminderKey } from './model.mjs';
import { advance } from './repeat.mjs';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const LOOKBACK_DAYS = 2; // reminders due up to a day or so ago still go out (the sweep was down, say)

export const smsBody = (text, list) => `Dot-y reminder: ${text.length > 120 ? `${text.slice(0, 119)}…` : text} (${list}). Reply done, or snooze for a while.`;

/**
 * deps: table, now(), contact(sub) -> { phone, email } (verified only; null if not),
 *       sendText(phone, body), sendEmail({ to, subject, text })
 */
export function createSweep(deps) {
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

  return async () => {
    const now = deps.now();
    const days = Array.from({ length: LOOKBACK_DAYS }, (_, i) => new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10));
    const due = (await Promise.all(days.map((d) => all(`REMIND#${d}`)))).flat().filter((r) => r.sk.split('#')[0] <= now.toISOString());
    const results = [];
    for (const r of due) {
      const at = r.sk.split('#')[0];
      const item = await get(`ITEMS#${r.listId}`, r.itemId);
      const list = await get('LIST', r.listId);
      // Done, deleted, already sent or moved to another time since this row was written: nothing to send
      const key = item && list && reminderKey(r.listId, r.itemId, item);
      if (!key || key.sk !== r.sk) {
        await del(r.pk, r.sk);
        continue;
      }
      const sentAt = now.toISOString();
      // Already reminded and not ticked off: a schedule-mode repeat rolls on to this occurrence
      const due = item.remind.sentAt ? advance(item, { at: sentAt, done: false }) : item;
      const claimed = { ...due, remind: { ...due.remind, sentAt }, rev: item.rev + 1 };
      try {
        await db.send(new PutCommand({
          TableName: table, Item: claimed,
          ConditionExpression: 'rev = :rev', ExpressionAttributeValues: { ':rev': item.rev },
        }));
      } catch (e) {
        if (e.name === 'ConditionalCheckFailedException') continue; // changed meanwhile; the next sweep decides
        throw e;
      }
      await del(r.pk, r.sk);
      const after = reminderKey(r.listId, r.itemId, claimed);
      if (after) await db.send(new PutCommand({ TableName: table, Item: { ...after, listId: r.listId, itemId: r.itemId } }));

      const to = item.remind.to;
      const pref = (await get('PREF', to))?.channel ?? 'sms';
      const who = await deps.contact(to);
      let channel = item.remind.channel ?? pref;
      if (channel === 'sms' && !who.phone) channel = 'email';
      if (channel === 'email' && !who.email) channel = who.phone ? 'sms' : null;
      let error = null;
      try {
        if (!channel) throw new Error('no verified phone or email');
        if (channel === 'sms') await deps.sendText(who.phone, smsBody(item.text, list.name));
        else {
          await deps.sendEmail({
            to: who.email,
            subject: `Reminder: ${item.text.slice(0, 80)}`,
            text: `${item.text}\n\nFrom your list “${list.name}”.${item.notes ? `\n\n${item.notes}` : ''}\n\nReply to tell Dot “done” or “snooze an hour”.`,
          });
        }
      } catch (e) {
        error = e.message.slice(0, 200);
        console.warn('reminder not sent', JSON.stringify({ list: r.listId, item: r.itemId, channel, error }));
      }
      await db.send(new PutCommand({
        TableName: table,
        Item: {
          pk: `SENT#${sentAt.slice(0, 10)}`, sk: `${sentAt}#${r.listId}#${r.itemId}`, to, listId: r.listId, list: list.name, itemId: r.itemId,
          text: item.text, channel, sentAt, error, expires: Math.floor(now.getTime() / 1000) + 3 * 86_400,
        },
      }));
      results.push({ itemId: r.itemId, channel, error });
    }
    if (results.length) console.log('sweep', JSON.stringify(results));
    return results;
  };
}

// ---- Lambda wiring ----

async function contact(sub) {
  const { CognitoIdentityProviderClient, AdminGetUserCommand } = await import('@aws-sdk/client-cognito-identity-provider');
  const u = await new CognitoIdentityProviderClient({}).send(new AdminGetUserCommand({ UserPoolId: process.env.USER_POOL_ID, Username: sub }));
  const attr = (n) => u.UserAttributes?.find((a) => a.Name === n)?.Value;
  return {
    phone: attr('phone_number_verified') === 'true' ? attr('phone_number') : null,
    email: attr('email_verified') === 'true' ? attr('email') : null,
  };
}

let twilio;
async function sendTextLive(phone, body) {
  const { twilioConfig, sendText } = await import('./twilio.mjs');
  const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
  twilio ??= twilioConfig(async () => (await new SSMClient({}).send(new GetParameterCommand({ Name: process.env.TWILIO_PARAM, WithDecryption: true }))).Parameter.Value);
  return sendText(await twilio(), phone, body);
}

async function sendEmailLive({ to, subject, text }) {
  const { SESv2Client, SendEmailCommand } = await import('@aws-sdk/client-sesv2');
  await new SESv2Client({}).send(new SendEmailCommand({
    FromEmailAddress: `Dot <${process.env.FROM_ADDRESS}>`,
    Destination: { ToAddresses: [to] },
    Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text } } } },
  }));
}

export const handler = createSweep({
  table: process.env.TABLE, now: () => new Date(), contact, sendText: sendTextLive, sendEmail: sendEmailLive,
});
