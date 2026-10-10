// Twilio for the Dot-y texting program: checking that a webhook really came from Twilio, and
// sending a text. Two SSM SecureStrings that Luke sets by hand, never in OpenTofu state:
//   /family/sms/twilio          { "accountSid": "AC…", "apiKeySid": "SK…", "apiKeySecret": "…", "messagingServiceSid": "MG…" }
//     for sending: a revocable API key, read by the opt-in Lambda and Dot's SMS worker
//   /family/sms/twilio-webhook  { "accountSid": "AC…", "authToken": "…" }
//     for checking signatures (Twilio signs with the Auth Token; an API key can't), read by the webhook only
// Texts go out through the Messaging Service: it carries the A2P 10DLC campaign and its
// Advanced Opt-Out (STOP, HELP, START replies), and Twilio refuses to text anyone who said STOP.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Twilio's X-Twilio-Signature: HMAC-SHA1 of the full URL plus each POST param (sorted) as key+value */
export function twilioSignature(authToken, url, params) {
  const data = Object.keys(params).sort().reduce((s, k) => s + k + params[k], url);
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

export function validTwilioSignature(authToken, url, params, signature) {
  if (!authToken || typeof signature !== 'string') return false;
  const want = Buffer.from(twilioSignature(authToken, url, params));
  const got = Buffer.from(signature);
  return want.length === got.length && timingSafeEqual(want, got);
}

const FORMATS = {
  send: { accountSid: /^AC\w{32}$/, apiKeySid: /^SK\w{32}$/, apiKeySecret: /^\S+$/, messagingServiceSid: /^MG\w{32}$/ },
  webhook: { accountSid: /^AC\w{32}$/, authToken: /^\S+$/ },
};

/** Loads one set of credentials ('send' or 'webhook') once per container; `load()` returns the SecureString's JSON */
export function twilioConfig(load, kind = 'send') {
  let cached;
  return async () => {
    cached ??= load().then((raw) => {
      const c = JSON.parse(raw);
      const bad = Object.keys(FORMATS[kind]).filter((k) => !FORMATS[kind][k].test(c[k] || ''));
      if (bad.length) throw new Error(`Twilio ${kind} settings are missing or malformed: ${bad.join(', ')}`);
      return c;
    }).catch((e) => { cached = undefined; throw e; });
    return cached;
  };
}

/** Sends one text through the Messaging Service; resolves to the message SID */
export async function sendText({ accountSid, apiKeySid, apiKeySecret, messagingServiceSid }, to, body, fetchFn = fetch) {
  const r = await fetchFn(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${apiKeySid}:${apiKeySecret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, MessagingServiceSid: messagingServiceSid, Body: body }).toString(),
  });
  const out = await r.json().catch(() => ({}));
  // 21610: the number replied STOP. Twilio won't deliver, which is what we want.
  if (!r.ok) throw Object.assign(new Error(`Twilio ${r.status}: ${out.message || 'send failed'}`), { status: r.status, code: out.code });
  return out.sid;
}

/** "+18645550123" -> "+1864555****", for logs */
export const maskPhone = (p) => String(p || '').slice(0, -4) + '****';
