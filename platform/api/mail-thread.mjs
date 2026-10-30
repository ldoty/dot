// Email threads, for anyone in the family who answers mail (Dot at dot@, Molly at molly@): one thread is
// one conversation, a reply's own words without the quoted thread, and the reply itself threaded under
// the message it answers and marked as automatic (so vacation replies never come back and loop).
// Symlinked into each tool that answers mail.
import { createHash } from 'node:crypto';

export const MESSAGE_ID = /^<[^<>\s"\\]{1,250}>$/;

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

export const oneLine = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim();
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);

/** The raw reply: plain text, threaded under the message it answers, marked as automatic */
export function replyMessage({ name = 'Dot', from, to, subject, inReplyTo, references = [], body, date = new Date() }) {
  const subj = oneLine(subject).slice(0, 150) || `Your note to ${name}`;
  const ids = [...references, inReplyTo].filter((r) => MESSAGE_ID.test(r || ''));
  const refs = [...new Set(ids)];
  const kept = refs.length > 10 ? [refs[0], ...refs.slice(-9)] : refs; // the root and the latest
  return [
    `From: ${name} <${from}>`,
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
