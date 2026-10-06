// Public sign-up endpoint behind dot-y.co/sms (no sign-in; it's the call to action carriers
// verify). POST /optin { name, email, phone?, consent, consentText?, page }
// Texts are optional: carriers reject a form where agreeing to texts (or giving a phone number)
// is required to use the service. Every sign-up stores pk = SIGNUP#<email>, sk = AT#<ISO time>;
// only a checked box also stores pk = PHONE#<E.164>, sk = CONSENT#<ISO time> with the exact
// consent text shown.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { CONSENT_TEXT, CONSENT_VERSION } from './program.mjs';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const json = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** US numbers only: "(864) 555-0123", "864.555.0123", "+1 864 555 0123" -> "+18645550123" */
export function toE164(input) {
  const d = String(input || '').replace(/\D/g, '');
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(ten) ? `+1${ten}` : null;
}

const clean = (s) => String(s).replace(/\s+/g, ' ').trim();

export const handler = async (event, { now = () => new Date() } = {}) => {
  if (event.routeKey !== 'POST /optin') return json(404, { error: 'no route' });
  let b;
  try {
    b = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString() : event.body || '');
  } catch {
    return json(400, { error: 'Something went wrong reading the form. Please try again.' });
  }
  // Hidden field people never see; bots fill it in. Pretend success, store nothing.
  if (b.company) return json(200, { ok: true });

  const name = typeof b.name === 'string' ? clean(b.name) : '';
  if (!name || name.length > 100) return json(400, { error: 'Please enter your name.' });
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(400, { error: 'Please enter a valid email address.' });
  const texts = b.consent === true;
  const given = typeof b.phone === 'string' && b.phone.trim() !== '';
  const phone = given ? toE164(b.phone) : null;
  if (given && !phone) return json(400, { error: 'Please enter a valid US mobile number, or leave it blank.' });
  if (texts && !phone) return json(400, { error: 'To get texts, please enter your mobile number.' });
  if (texts && (typeof b.consentText !== 'string' || clean(b.consentText) !== CONSENT_TEXT)) {
    return json(400, { error: 'The consent wording didn’t match. Please reload the page and try again.' });
  }

  const at = now().toISOString();
  const from = {
    page: typeof b.page === 'string' ? b.page.slice(0, 300) : null,
    ip: event.requestContext?.http?.sourceIp ?? null,
    userAgent: event.requestContext?.http?.userAgent?.slice(0, 300) ?? null,
  };
  await db.send(new PutCommand({
    TableName: process.env.TABLE,
    Item: { pk: `SIGNUP#${email}`, sk: `AT#${at}`, name, email, phone, texts, signedUpAt: at, ...from },
  }));
  if (texts) {
    await db.send(new PutCommand({
      TableName: process.env.TABLE,
      Item: {
        pk: `PHONE#${phone}`, sk: `CONSENT#${at}`,
        name, email, phone, consentedAt: at, consentText: CONSENT_TEXT, consentVersion: CONSENT_VERSION, ...from,
      },
    }));
    console.log('opt-in recorded', phone.slice(0, -4) + '****');
  }
  return json(200, { ok: true, name, texts });
};
