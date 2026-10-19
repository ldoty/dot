// Runs scheduled asks (schedules.mjs). EventBridge invokes it every minute (infra/scheduled.tf; one at a
// time, never retried). For each ask that's due it claims the run (moving the ask on to its next time,
// rev-checked, so it runs once), then runs one turn as its owner and sends them the answer:
//   - only while they're still an enabled family_assistant member (Cognito), to their verified phone or
//     email, and never more than an hour late (a run that was missed is recorded, not made up later);
//   - read-only: the turn gets only Dot's reading tools (forUser readOnly), whatever the ask says;
//   - within their daily limit on what Dot-y sends unasked (platform/api/send-limit.mjs), checked before
//     the turn runs, so a run past it costs nothing;
//   - its message is marked (SCHEDULED_MARK), so it never counts as the person's reply to a confirmation.
// By text, the run is the latest texting conversation, so replying carries on from it; by email, the
// message starts a thread whose replies come back to the same conversation (email.mjs conversationIdFor).
import { randomBytes } from 'node:crypto';
import { BetaFallbackState } from '@anthropic-ai/sdk';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { runTurn } from './agent.mjs';
import { liveDeps } from './handler.mjs';
import { SCHEDULED_MARK } from './confirm.mjs';
import { cognitoContact, makeSchedules } from './schedules.mjs';
import { toTexts } from './sms.mjs';
import { conversationIdFor } from './email.mjs';
import { maskPhone, sendText, twilioConfig } from './twilio.mjs';
import { LIMIT_REACHED, makeSendLimit } from './send-limit.mjs';

export const LATE_MS = 60 * 60_000;

/** The run's message: what to do, and that they aren't there to ask */
export function runText(s, name) {
  const set = new Date(s.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return `${SCHEDULED_MARK} “${s.title}”, which ${name || 'they'} set up on ${set}. They aren't in the conversation right now: answer as a message to them that reads well on its own, `
    + `with no questions you need answered first. You can only read now, not change anything; if the ask needs a change, say what you'd do, and that they can reply to have you do it.]\n\n${s.ask}`;
}

/** The email that carries a run's answer: a new thread, so replies come back to this conversation */
export function scheduledEmail({ from, to, subject, body, messageId, date }) {
  const ascii = /^[\x20-\x7e]*$/.test(subject) ? subject : `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;
  return [
    `From: Dot <${from}>`, `To: ${to}`, `Subject: ${ascii}`, `Date: ${date.toUTCString().replace('GMT', '+0000')}`, `Message-ID: ${messageId}`,
    'Auto-Submitted: auto-generated', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '',
    Buffer.from(body).toString('base64').replace(/.{1,76}/g, '$&\r\n').trimEnd(), '',
  ].join('\r\n');
}

/**
 * deps: what liveDeps() returns (store, forUser, client, …), plus schedules (schedules.mjs),
 * contact(sub) -> { member, phone, email } (member: enabled and in family_assistant; phone and email
 * verified only), text(phone, body), sendRaw({ to, raw }), address (dot@…), people { sub: { name } },
 * limit(sub) -> { ok } (send-limit.mjs)
 */
export function createScheduleRunner(depsOrFactory) {
  let deps = typeof depsOrFactory === 'function' ? null : depsOrFactory;

  async function runOne(s, sub, now) {
    const who = await deps.contact(sub);
    if (!who.member) return { ok: false, error: 'no longer uses Dot' };
    const by = s.by === 'sms' && who.phone ? 'sms' : who.email ? 'email' : who.phone ? 'sms' : null;
    if (!by) return { ok: false, error: 'no verified phone or email' };
    if (!(await deps.limit(sub)).ok) return { ok: false, error: LIMIT_REACHED };
    const name = deps.people?.[sub]?.name;
    const messageId = `<s${randomBytes(9).toString('hex')}@${deps.address.split('@')[1]}>`;
    let reply, conversationId;
    try {
      const forUser = await deps.forUser({ sub, username: sub }, by, { readOnly: true, scheduled: s.sk });
      const r = await runTurn({
        ...deps, ...forUser, fallbackState: new BetaFallbackState(), userId: sub, channel: by, text: runText(s, name), title: s.title,
        ...(by === 'email' ? { newConversationId: conversationIdFor(sub, messageId) } : {}), now: () => now,
      });
      conversationId = r.conversationId;
      reply = r.text.trim();
      if (!reply) throw new Error(r.stopReason === 'refusal' ? 'declined' : 'no answer');
    } catch (e) {
      console.error('scheduled turn failed', s.sk, e.message);
      reply = `Dot couldn’t do your scheduled “${s.title}” this time. It will try again next time.`;
      conversationId ??= null;
      await send(by, who, s, reply, messageId, now).catch(() => {});
      return { ok: false, error: e.message.slice(0, 200), conversationId };
    }
    try {
      await send(by, who, s, reply, messageId, now);
    } catch (e) {
      console.warn('scheduled answer not sent', s.sk, by, e.message);
      return { ok: false, error: `not sent: ${e.message.slice(0, 180)}`, conversationId, by };
    }
    return { ok: true, conversationId, by };
  }

  async function send(by, who, s, reply, messageId, now) {
    if (by === 'sms') {
      const texts = toTexts(reply);
      texts[0] = `Dot-y, ${s.title}: ${texts[0]}`;
      for (const body of texts) await deps.text(who.phone, body);
      console.log('scheduled sent', s.sk, maskPhone(who.phone));
    } else {
      const body = `${reply}\n\n(Your scheduled ask “${s.title}”. Reply to ask Dot more, or tell Dot to stop it.)`;
      await deps.sendRaw({ to: who.email, raw: scheduledEmail({ from: deps.address, to: who.email, subject: s.title, body, messageId, date: now }) });
      console.log('scheduled sent', s.sk, 'email');
    }
  }

  return async () => {
    deps ??= depsOrFactory();
    const now = deps.now ? deps.now() : new Date();
    const at = now.toISOString();
    const done = [];
    for (const row of await deps.schedules.due(at)) {
      const s = await deps.schedules.claim(row, at);
      if (!s) continue;
      const result = now - Date.parse(s.nextAt) > LATE_MS ? { ok: false, error: 'missed: the runner was down at that time' } : await runOne(s, row.sub, now);
      await deps.schedules.recordRun(row.sub, row.id, { at, ...result });
      done.push({ id: row.id, ok: result.ok, error: result.error });
    }
    if (done.length) console.log('scheduled', JSON.stringify(done));
    return done;
  };
}

// ---- Lambda wiring ----

function liveRunnerDeps(env = process.env) {
  const base = liveDeps(env);
  const ssm = new SSMClient({});
  const ses = new SESv2Client({});
  const twilio = twilioConfig(async () => (await ssm.send(new GetParameterCommand({ Name: env.TWILIO_PARAM, WithDecryption: true }))).Parameter.Value);
  return {
    ...base,
    people: JSON.parse(env.PEOPLE || '{}'),
    address: env.DOT_ADDRESS,
    schedules: makeSchedules({ db: DynamoDBDocumentClient.from(new DynamoDBClient({})), table: env.TABLE }),
    text: async (to, body) => sendText(await twilio(), to, body),
    sendRaw: ({ to, raw }) => ses.send(new SendEmailCommand({ FromEmailAddress: env.DOT_ADDRESS, Destination: { ToAddresses: [to] }, Content: { Raw: { Data: Buffer.from(raw) } } })),
    contact: (sub) => cognitoContact(env, sub),
    limit: makeSendLimit({ db: DynamoDBDocumentClient.from(new DynamoDBClient({})), table: env.SENDS_TABLE, timeZone: env.TIME_ZONE }),
  };
}

export const handler = createScheduleRunner(() => liveRunnerDeps());
