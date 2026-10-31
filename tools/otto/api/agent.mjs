// Otto's own API: what the agent at home (agent/otto.mjs, Proxmox CT 103) calls. It can't sign in, so these
// routes have no authorizer; every request must carry the agent key in x-otto-key, checked here against
// the SecureString at AGENT_KEY_PARAM (set by hand, never in tofu state; also in the container's
// /etc/otto/agent-key). The agent holds no AWS credentials at all: this Lambda's role does the AWS work.
//   POST /agent/next                 -> { command: { id, prompt, source, mail? } | null } the oldest queued command,
//                                       now running; also marks the agent seen
//   POST /agent/commands/{id}        { ok, result } -> { id, status } a running command finished
//   POST /agent/send                 { command, subject, text } -> { sent: true } an email to the owner, from otto@
// What a stolen key can do: take queued commands (and so keep them from Otto), write results, and email
// the owner, at most MAX_SENDS per command and within the owner's daily limit on everything Dot-y sends
// unasked (send-limit.mjs). It can't queue anything, read the owner's mail, or email anyone else:
// the only address it ever sends to is the owner's verified email, looked up here.
import { createHash, timingSafeEqual } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { CognitoIdentityProviderClient, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { CMD_ID, MAX_RESULT, commandOut, makeStore } from './store.mjs';
import { LIMIT_REACHED, makeSendLimit } from './send-limit.mjs';
import { newMessage, oneLine, replyMessage } from './mail-thread.mjs';

export const MAX_SENDS = 3;     // emails per command
const MAX_SUBJECT = 150;
const MAX_TEXT = 20_000;
const KEY_TTL_MS = 5 * 60_000;
const KEEP_SENT_S = 3 * 86_400;

const json = (statusCode, body) => ({
  statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const digest = (s) => createHash('sha256').update(String(s)).digest();

/**
 * deps: db, table, agentKey() -> the key, owner (the sub Otto works for), ownerEmail() -> their verified email or null,
 *       limit(sub) -> { ok } (send-limit.mjs), sendRaw({ to, raw }) -> { MessageId }, address (otto@…), now()
 */
export function createAgentApi(deps) {
  const { get, all, putAt, put } = makeStore({ db: deps.db, table: deps.table });

  async function next() {
    const t = deps.now();
    await put({ pk: 'AGENT', sk: 'SEEN', at: t.toISOString() });
    const queued = (await all('CMD')).filter((r) => r.status === 'queued').sort((a, b) => (a.sk < b.sk ? -1 : 1));
    for (const row of queued) {
      const item = { ...row, status: 'running', startedAt: t.toISOString(), rev: row.rev + 1 };
      if (!(await putAt(item, row.rev))) continue; // discarded or taken meanwhile: the next one
      const mail = row.mail ? await get('MAIL', row.mail) : null;
      console.log('command taken', JSON.stringify({ id: row.sk, source: row.source }));
      return json(200, {
        command: {
          id: row.sk, prompt: row.prompt, source: row.source,
          ...(mail ? { mail: { from: mail.from, subject: mail.subject, text: mail.text, receivedAt: mail.receivedAt } } : {}),
        },
      });
    }
    return json(200, { command: null });
  }

  async function finish(id, body) {
    if (!CMD_ID.test(id ?? '')) return json(404, { error: 'no such command' });
    const row = await get('CMD', id);
    if (!row) return json(404, { error: 'no such command' });
    if (row.status !== 'running') return json(409, { error: `it’s ${row.status}` });
    const ok = body.ok === true;
    const result = typeof body.result === 'string' ? body.result.slice(0, MAX_RESULT) : '';
    const t = deps.now().toISOString();
    const item = { ...row, status: ok ? 'done' : 'failed', result, finishedAt: t, rev: row.rev + 1 };
    if (!(await putAt(item, row.rev))) return json(409, { error: 'it changed meanwhile' });
    if (row.schedule) {
      const s = await get('SCHED', row.schedule);
      if (s) await putAt({ ...s, lastRun: { at: t, outcome: ok ? 'done' : 'failed', command: id }, rev: s.rev + 1 }, s.rev);
    }
    console.log('command finished', JSON.stringify({ id, ok }));
    return json(200, { id, status: commandOut(item).status });
  }

  async function send(body) {
    const id = body.command;
    const subject = oneLine(body.subject).slice(0, MAX_SUBJECT);
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, MAX_TEXT) : '';
    if (!subject || !text) return json(400, { error: 'subject and text required' });
    // Only during a command's run, and a few per run: a send is part of doing something asked
    const row = CMD_ID.test(id ?? '') ? await get('CMD', id) : null;
    if (!row || row.status !== 'running') return json(409, { error: 'only while a command is running' });
    if ((row.sends ?? 0) >= MAX_SENDS) return json(429, { error: `at most ${MAX_SENDS} emails per command` });
    const to = await deps.ownerEmail();
    if (!to) return json(409, { error: 'the owner has no verified email' });
    // Counted on the command first, rev-checked, so two sends at once can't both take the last one
    if (!(await putAt({ ...row, sends: (row.sends ?? 0) + 1, rev: row.rev + 1 }, row.rev))) return json(409, { error: 'the command changed meanwhile; try again' });
    if (!(await deps.limit(deps.owner)).ok) return json(429, { error: LIMIT_REACHED });

    // An answer to an email to otto@ goes in that thread; anything else starts one
    const mail = row.mail ? await get('MAIL', row.mail) : null;
    const t = deps.now();
    const raw = mail?.messageId
      ? replyMessage({ name: 'Otto', from: deps.address, to, subject: mail.subject, inReplyTo: mail.messageId, references: mail.references ?? [], body: text, date: t })
      : newMessage({ name: 'Otto', from: deps.address, to, subject, body: text, date: t });
    await deps.sendRaw({ to, raw });
    const sentAt = t.toISOString();
    await put({
      pk: `SENT#${sentAt.slice(0, 10)}`, sk: `${sentAt}#${id}`, toSub: deps.owner, subject, text: text.slice(0, 600), command: id,
      sentAt, expires: Math.floor(t.getTime() / 1000) + KEEP_SENT_S,
    });
    console.log('email sent', JSON.stringify({ command: id }));
    return json(200, { sent: true });
  }

  return async function handler(event) {
    const given = event.headers?.['x-otto-key'] ?? '';
    const key = await deps.agentKey();
    if (!key || !given || !timingSafeEqual(digest(given), digest(key))) {
      console.warn('denied: bad agent key');
      return json(401, { error: 'unauthorized' });
    }
    let body = {};
    if (event.body) {
      try {
        body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body) ?? {};
      } catch {
        return json(400, { error: 'bad json' });
      }
      if (typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'bad json' });
    }
    switch (event.routeKey) {
      case 'POST /agent/next': return next();
      case 'POST /agent/commands/{id}': return finish(event.pathParameters?.id, body);
      case 'POST /agent/send': return send(body);
      default: return json(404, { error: 'no route' });
    }
  };
}

let live;
export const handler = async (event) => (live ??= (() => {
  const env = process.env;
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const ssm = new SSMClient({});
  const cognito = new CognitoIdentityProviderClient({});
  const ses = new SESv2Client({});
  let cached = null;
  return createAgentApi({
    db, table: env.TABLE, owner: env.OWNER, address: env.OTTO_ADDRESS, now: () => new Date(),
    agentKey: async () => {
      if (cached && cached.until > Date.now()) return cached.key;
      const r = await ssm.send(new GetParameterCommand({ Name: env.AGENT_KEY_PARAM, WithDecryption: true }));
      cached = { key: r.Parameter.Value.trim(), until: Date.now() + KEY_TTL_MS };
      return cached.key;
    },
    ownerEmail: async () => {
      const u = await cognito.send(new AdminGetUserCommand({ UserPoolId: env.USER_POOL_ID, Username: env.OWNER }));
      const attr = (n) => u.UserAttributes?.find((a) => a.Name === n)?.Value;
      return u.Enabled && attr('email_verified') === 'true' ? attr('email') : null;
    },
    limit: makeSendLimit({ db, table: env.SENDS_TABLE, timeZone: env.TIME_ZONE || 'America/New_York' }),
    sendRaw: ({ to, raw }) => ses.send(new SendEmailCommand({
      FromEmailAddress: env.OTTO_ADDRESS, Destination: { ToAddresses: [to] }, Content: { Raw: { Data: Buffer.from(raw) } },
    })),
  });
})())(event);
