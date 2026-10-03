// Public opt-in endpoint for the Dot-y texting program (no sign-in; it's the call to action
// carriers verify). POST /optin { name, phone, consent: true, consentText, page }
// Stores pk = PHONE#<E.164>, sk = CONSENT#<ISO time> with the exact consent text shown.
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
  const phone = toE164(b.phone);
  if (!phone) return json(400, { error: 'Please enter a valid US mobile number.' });
  if (b.consent !== true) return json(400, { error: 'Please check the box to agree to receive messages.' });
  if (typeof b.consentText !== 'string' || clean(b.consentText) !== CONSENT_TEXT) {
    return json(400, { error: 'The consent wording didn’t match. Please reload the page and try again.' });
  }

  const at = now().toISOString();
  await db.send(new PutCommand({
    TableName: process.env.TABLE,
    Item: {
      pk: `PHONE#${phone}`, sk: `CONSENT#${at}`,
      name, phone, consentedAt: at, consentText: CONSENT_TEXT, consentVersion: CONSENT_VERSION,
      page: typeof b.page === 'string' ? b.page.slice(0, 300) : null,
      ip: event.requestContext?.http?.sourceIp ?? null,
      userAgent: event.requestContext?.http?.userAgent?.slice(0, 300) ?? null,
    },
  }));
  console.log('opt-in recorded', phone.slice(0, -4) + '****');
  return json(200, { ok: true, name });
};
