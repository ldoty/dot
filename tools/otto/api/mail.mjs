// Mail to otto@dot-y.co. The gate in platform/email (otto.tf, the same gate as dot@ and molly@) lets a
// message through only with DMARC passing, not automatic, from the verified email of a lukes_otto member,
// and invokes this (asynchronously) with { userId, username, from, bucket, key }; only the gate's role
// may. This keeps the message's words (MAIL row, as long as the bucket keeps the message) and queues a
// command from `email`, so Otto answers in the same thread (agent.mjs send).
//
// An email is the owner asking, but what it carries (a forwarded message, a quoted thread) was often
// written by someone else, so the agent runs it with less than a queued command (agent/otto.mjs):
// it may read the inbox and answer the owner, nothing more. A reply to a brief (a schedule's email, BRIEF
// rows) can also clear it, which only ever queues CLEAR_PROMPT (agent.mjs clear).
import { simpleParser } from 'mailparser';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { KEEP_COMMANDS_S, commandId, makeStore } from './store.mjs';
import { MESSAGE_ID, oneLine } from './mail-thread.mjs';

const MAX_TEXT = 20_000;
const KEEP_MAIL_S = 8 * 86_400;

/** deps: db, table, owner (sub), getRaw(bucket, key) -> Buffer, now() */
export function createMailWorker(deps) {
  const { get, putAt } = makeStore({ db: deps.db, table: deps.table });
  return async (event) => {
    // The gate already checked who sent it; Otto works for one person
    if (event.userId !== deps.owner) {
      console.warn('mail: not from the owner, ignored');
      return { queued: false };
    }
    const parsed = await simpleParser(await deps.getRaw(event.bucket, event.key));
    const t = deps.now();
    const mailId = String(event.key).split('/').pop();
    const subject = oneLine(parsed.subject).slice(0, 150) || '(no subject)';
    const text = String(parsed.text || '').replace(/\r\n/g, '\n').trim().slice(0, MAX_TEXT);
    // Before the MAIL row: once that's written, SES delivering it again is ignored, so nothing may fail after it
    let brief = null;
    for (const ref of [parsed.inReplyTo, ...[].concat(parsed.references || [])].filter((r) => MESSAGE_ID.test(r || '')).slice(-12)) {
      if ((brief = (await get('BRIEF', ref))?.command)) break;
    }
    const fresh = await putAt({
      pk: 'MAIL', sk: mailId, from: event.from, subject, text,
      messageId: MESSAGE_ID.test(parsed.messageId || '') ? parsed.messageId : null,
      references: [].concat(parsed.references || []).filter((r) => MESSAGE_ID.test(r)).slice(-10),
      receivedAt: t.toISOString(), expires: Math.floor(t.getTime() / 1000) + KEEP_MAIL_S,
    });
    if (!fresh) return { queued: false }; // SES delivered it twice
    const id = commandId(t);
    await putAt({
      pk: 'CMD', sk: id, prompt: `Email from ${event.from}: “${subject}”`, source: 'email', mail: mailId, ...(brief ? { brief } : {}), status: 'queued',
      by: event.username, createdAt: t.toISOString(), rev: 1, expires: Math.floor(t.getTime() / 1000) + KEEP_COMMANDS_S,
    });
    console.log('mail queued', JSON.stringify({ command: id }));
    return { queued: true, command: id };
  };
}

let live;
export const handler = async (event) => (live ??= (() => {
  const s3 = new S3Client({});
  return createMailWorker({
    db: DynamoDBDocumentClient.from(new DynamoDBClient({})), table: process.env.TABLE, owner: process.env.OWNER, now: () => new Date(),
    getRaw: async (Bucket, Key) => Buffer.from(await (await s3.send(new GetObjectCommand({ Bucket, Key }))).Body.transformToByteArray()),
  });
})())(event);
