// Twilio for the Dot-y texting program: checking that a webhook really came from Twilio, and
// sending a text. The credentials are an SSM SecureString (/family/sms/twilio) that Luke sets by
// hand, never in OpenTofu state:
//   { "accountSid": "AC…", "authToken": "…", "messagingServiceSid": "MG…" }
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

/** Loads the credentials once per container; `load()` returns the SecureString's JSON */
export function twilioConfig(load) {
  let cached;
  return async () => {
    cached ??= load().then((raw) => {
      const c = JSON.parse(raw);
      if (!/^AC\w{32}$/.test(c.accountSid || '') || !c.authToken || !/^MG\w{32}$/.test(c.messagingServiceSid || '')) {
        throw new Error('Twilio settings need accountSid, authToken and messagingServiceSid');
      }
      return c;
    }).catch((e) => { cached = undefined; throw e; });
    return cached;
  };
}

/** Sends one text through the Messaging Service; resolves to the message SID */
export async function sendText({ accountSid, authToken, messagingServiceSid }, to, body, fetchFn = fetch) {
  const r = await fetchFn(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
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
