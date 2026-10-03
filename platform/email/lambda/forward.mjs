// Forwards mail received by SES (already stored in S3 by the receipt rule) to a personal inbox.
// The message is re-sent from the dot-y.co address it was sent to (SES only sends from verified
// identities), with Reply-To set to the original sender so replying goes back to them.
// Spam and viruses flagged by SES are not forwarded.
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

const s3 = new S3Client({});
const ses = new SESv2Client({});
const { BUCKET, PREFIX = 'inbound/', FORWARDS = '{}' } = process.env;

/** Rewrites headers so the message can be re-sent; returns the new raw message */
export function rewrite(raw, { recipient, forwardTo }) {
  const split = raw.search(/\r?\n\r?\n/);
  const nl = raw.includes('\r\n') ? '\r\n' : '\n';
  let head = split < 0 ? raw : raw.slice(0, split);
  const body = split < 0 ? '' : raw.slice(split);
  // Unfold header lines so each header is one line
  const lines = head.split(/\r?\n/).reduce((out, line) => {
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1] += nl + line;
    else out.push(line);
    return out;
  }, []);
  const get = (name) => lines.find((l) => l.toLowerCase().startsWith(name.toLowerCase() + ':'));
  const from = get('From')?.replace(/^From:\s*/i, '').trim() || '';
  const name = (/^"?([^"<]+?)"?\s*</.exec(from)?.[1] || from.replace(/[<>]/g, '')).trim();
  const drop = /^(from|to|cc|bcc|reply-to|return-path|sender|dkim-signature|x-ses-[^:]*|message-id|arc-[^:]*|authentication-results|received-spf)\s*:/i;
  const kept = lines.filter((l) => !drop.test(l));
  const safeName = name.replace(/["\r\n]/g, '').slice(0, 80) || 'Someone';
  kept.unshift(
    `From: "${safeName} via ${recipient}" <${recipient}>`,
    `Reply-To: ${from}`,
    `To: ${forwardTo}`,
    `X-Original-To: ${recipient}`,
  );
  head = kept.join(nl);
  return head + body;
}

export const handler = async (event) => {
  const forwards = JSON.parse(FORWARDS);
  for (const record of event.Records || []) {
    const mail = record.ses.mail, receipt = record.ses.receipt;
    if (receipt.spamVerdict?.status === 'FAIL' || receipt.virusVerdict?.status === 'FAIL') {
      console.warn('not forwarding (spam/virus)', mail.messageId);
      continue;
    }
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: PREFIX + mail.messageId }));
    const raw = await obj.Body.transformToString();
    for (const recipient of receipt.recipients) {
      const forwardTo = forwards[recipient.toLowerCase()];
      if (!forwardTo) continue;
      const data = rewrite(raw, { recipient, forwardTo });
      await ses.send(new SendEmailCommand({
        FromEmailAddress: recipient,
        Destination: { ToAddresses: [forwardTo] },
        Content: { Raw: { Data: Buffer.from(data) } },
      }));
      console.log('forwarded', mail.messageId, 'for', recipient);
    }
  }
};
