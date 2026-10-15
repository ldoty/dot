// Dot by email: dot@dot-y.co. SES stores each message in the mail bucket (platform/email, prefix
// dot/) and its gate (platform/email/lambda/dot.mjs) checks SES's virus, spam and DMARC verdicts,
// skips automatic mail, and finds the family_assistant member whose verified email sent it. Only
// the gate's role may invoke this function (asynchronously), with
//   { userId, username, from, bucket, key }
// Here Dot reads the message, runs one turn as that person (channel email), and replies in the same
// thread from dot@dot-y.co. One email thread is one conversation: replies carry on where it left off.
// Photos attached go to Claude like texted ones, and are kept a week in Dot's photo bucket (store.mjs).
import { createHash } from 'node:crypto';
import { simpleParser } from 'mailparser';
import { BetaFallbackState } from '@anthropic-ai/sdk';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { runTurn } from './agent.mjs';
import { errorMessage, liveDeps } from './handler.mjs';

export const MAX_BODY = 20_000;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 3_750_000; // Bedrock's limit for one image
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
// Pictures inside the HTML (multipart/related) smaller than this are logos and signatures, not photos
const MIN_INLINE_PHOTO = 20_000;
const EMAIL = /^[^\s@<>"',;()[\]\\]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const MESSAGE_ID = /^<[^<>\s"\\]{1,250}>$/;

/** The first message of the thread: replies name it first in References */
export function threadRoot(parsed) {
  const refs = [].concat(parsed.references || []).filter((r) => MESSAGE_ID.test(r));
  return refs[0] || (MESSAGE_ID.test(parsed.inReplyTo || '') ? parsed.inReplyTo : null) || parsed.messageId || null;
}

/** One person's thread, one conversation; the same id each time, nobody else's */
export const conversationIdFor = (userId, root) => 'm' + createHash('sha256').update(`${userId}\n${root}`).digest('base64url').slice(0, 24);

/** A reply's own words: quoted lines ("> …") and the "On …, Dot wrote:" line that introduces them go */
export function withoutQuotes(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter((l) => !/^\s*>/.test(l));
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  if (/wrote:\s*$/.test(lines.at(-1) || '')) {
    const last = lines.pop();
    if (!/^On\s/.test(last) && /^On\s/.test(lines.at(-1) || '')) lines.pop(); // wrapped onto two lines
  }
  return lines.join('\n').trim();
}

/** The photos Claude can look at, and how many attachments were left out */
export function photosIn(attachments = []) {
  const images = [];
  let skipped = 0;
  for (const a of attachments) {
    const type = String(a.contentType || '').toLowerCase();
    if (a.related && type.startsWith('image/') && a.size < MIN_INLINE_PHOTO) continue;
    if (IMAGE_TYPES.includes(type) && a.size <= MAX_IMAGE_BYTES && images.length < MAX_IMAGES) {
      images.push({ media_type: type, data: Buffer.from(a.content).toString('base64') });
    } else skipped++;
  }
  return { images, skipped };
}

const oneLine = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim();
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);

/** The raw reply: plain text, threaded under the message it answers, marked as automatic */
export function replyMessage({ from, to, subject, inReplyTo, references = [], body, date = new Date() }) {
  const subj = oneLine(subject).slice(0, 150) || 'Your note to Dot';
  const ids = [...references, inReplyTo].filter((r) => MESSAGE_ID.test(r || ''));
  const refs = [...new Set(ids)];
  const kept = refs.length > 10 ? [refs[0], ...refs.slice(-9)] : refs; // the root and the latest
  return [
    `From: Dot <${from}>`,
    `To: ${to}`,
    `Subject: ${encodeHeader(/^re:/i.test(subj) ? subj : `Re: ${subj}`)}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    ...(MESSAGE_ID.test(inReplyTo || '') ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(kept.length ? [`References: ${kept.join(' ')}`] : []),
    // Mail systems don't answer automatic mail, so a vacation reply never comes back to Dot
    'Auto-Submitted: auto-replied',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body).toString('base64').replace(/.{1,76}/g, '$&\r\n').trimEnd(),
    '',
  ].join('\r\n');
}

/** deps: what liveDeps() returns, plus getRaw(bucket, key) -> Buffer, send({ to, raw }), address (dot@…) */
export function createEmailWorker(depsOrFactory) {
  let deps = typeof depsOrFactory === 'function' ? null : depsOrFactory;
  return async (event) => {
    deps ??= depsOrFactory();
    const { userId, username, from, bucket, key } = event || {};
    if (!userId || !EMAIL.test(from || '') || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket || '') || !/^dot\/[A-Za-z0-9]{1,100}$/.test(key || '')) {
      console.error('bad event', Object.keys(event || {}));
      return;
    }
    const parsed = await simpleParser(await deps.getRaw(bucket, key));
    // The gate checked the sender; this is the same message, so its From must say the same
    const senders = parsed.from?.value || [];
    if (senders.length !== 1 || String(senders[0].address || '').toLowerCase() !== from) {
      console.error('sender mismatch', key);
      return;
    }
    const now = deps.now ? deps.now() : new Date();
    const subject = oneLine(parsed.subject).slice(0, 200);
    const id = conversationIdFor(userId, threadRoot(parsed) || key);
    const existing = await deps.store.getConversation(userId, id);
    let body = String(parsed.text || '').trim();
    // A reply quotes the thread, which the conversation already has
    if (existing) body = withoutQuotes(body);
    if (body.length > MAX_BODY) body = `${body.slice(0, MAX_BODY)}\n\n[The rest of the email was cut]`;
    const { images, skipped } = photosIn(parsed.attachments);
    const note = skipped ? `[${skipped} attachment${skipped > 1 ? 's' : ''} couldn’t be opened: Dot reads photos (JPEG, PNG, GIF, WebP), not other files]` : '';
    const said = [subject && !existing ? `Subject: ${subject}` : '', body, note].filter(Boolean).join('\n\n');

    let reply;
    try {
      const forUser = deps.forUser ? await deps.forUser({ sub: userId, username }, 'email') : {};
      const r = await runTurn({
        ...deps, ...forUser, fallbackState: new BetaFallbackState(), userId, channel: 'email', text: said || '(empty email)', images,
        conversationId: existing ? id : undefined, newConversationId: id, title: subject || undefined, now: () => now,
      });
      reply = r.text.trim() || (r.stopReason === 'refusal' ? 'Dot declined to answer that one.' : 'Dot had no answer for that. Try asking another way.');
    } catch (e) {
      console.error('turn failed', e);
      reply = errorMessage(e);
    }
    await deps.send({
      to: from,
      raw: replyMessage({ from: deps.address, to: from, subject: parsed.subject, inReplyTo: parsed.messageId, references: [].concat(parsed.references || []), body: reply, date: now }),
    });
    console.log('replied', key);
  };
}

function liveEmailDeps(env = process.env) {
  const s3 = new S3Client({});
  const ses = new SESv2Client({});
  return {
    ...liveDeps(env),
    address: env.DOT_ADDRESS,
    getRaw: async (bucket, key) => Buffer.from(await (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body.transformToByteArray()),
    send: ({ to, raw }) => ses.send(new SendEmailCommand({
      FromEmailAddress: env.DOT_ADDRESS, Destination: { ToAddresses: [to] }, Content: { Raw: { Data: Buffer.from(raw) } },
    })),
  };
}

export const handler = createEmailWorker(() => liveEmailDeps());
