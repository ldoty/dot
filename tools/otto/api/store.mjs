// Otto's table, shared by the API, the agent's API, the sweep and the mail worker.
//
// Rows: CMD / <id>                 a command: { prompt, source: page | asked | schedule | email | clear, status, by,
//                                   createdAt, rev, confirm { id, until }?, schedule?, mail?, brief?, cleared?,
//                                   startedAt?, finishedAt?, result?, sends?, expires (30 days) }
//       SCHED / <id>               a schedule (schedules.mjs)
//       PENDING / <confirm id>     a schedule change from Dot or Claude Code waiting for the person's OK
//       MAIL / <id>                a message to otto@ (mail.mjs): { from, subject, text, messageId, references,
//                                   receivedAt, expires (8 days, as the mail bucket keeps it) }
//       SENT#<UTC day> / <sentAt>#<command>   an email Otto sent: { to, subject, text, command, expires (3 days) }
//       BRIEF / <Message-ID>       an email a schedule sent (a brief), so a reply to it can clear it (agent.mjs
//                                   clear): { command, expires (8 days) }
//       AGENT / SEEN               when the agent at home last asked for work: { at }
//
// A command's status: asking (staged through Dot or Claude Code: waits for the person's OK) -> queued ->
// running (the agent took it) -> done | failed; or discarded (by the person, before it ran).
// Command ids sort by when they were made, so the queue is oldest first.
import { randomBytes } from 'node:crypto';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

export const CMD_ID = /^c[a-z0-9]{8}[a-f0-9]{8}$/;
export const KEEP_COMMANDS_S = 30 * 86_400;
export const MAX_PROMPT = 4000;
export const MAX_RESULT = 20_000;
export const CLEAR_LABEL = 'Otto/Clear';
// What a reply to a brief can do, always in these words: the email only decides whether it happens
export const CLEAR_PROMPT = `Clear the brief: find every thread labeled ${CLEAR_LABEL} (search label:otto-clear, in pages until none are left), `
  + `remove UNREAD and ${CLEAR_LABEL} from each, and leave everything else as it is. Then email Luke one line with the count.`;
export const KEEP_BRIEFS_S = 8 * 86_400;
export const STATUSES = ['asking', 'queued', 'running', 'done', 'failed', 'discarded'];

export const commandId = (now) => `c${now.getTime().toString(36).padStart(8, '0')}${randomBytes(4).toString('hex')}`;
export const scheduleId = () => `s${randomBytes(5).toString('hex')}`;

export function makeStore({ db, table }) {
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
  /** Writes `item` if it's new (rev undefined) or still at `rev`; false if someone else got there first */
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
  const put = (item) => db.send(new PutCommand({ TableName: table, Item: item }));
  const del = (pk, sk) => db.send(new DeleteCommand({ TableName: table, Key: { pk, sk } }));
  return { get, all, putAt, put, del };
}

/** A command as the person sees it */
export const commandOut = (r) => ({
  id: r.sk, prompt: r.prompt, source: r.source, status: r.status, createdAt: r.createdAt,
  ...(r.schedule ? { schedule: r.schedule } : {}), ...(r.startedAt ? { startedAt: r.startedAt } : {}),
  ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}), ...(r.result !== undefined ? { result: r.result } : {}),
});
