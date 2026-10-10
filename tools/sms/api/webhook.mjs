// Twilio's inbound-text webhook for (864) 568-4810: POST /twilio (form-encoded, signed by Twilio).
//
//   1. Refuse anything without a valid X-Twilio-Signature for our account.
//   2. Keywords: Twilio's Advanced Opt-Out sends the registered STOP / HELP / START replies itself
//      (and blocks texts after STOP); here we only record them, so the consent table has the whole
//      story: STOP adds pk = PHONE#<E.164>, sk = OPTOUT#<time>; START adds a CONSENT#<time>.
//   3. Anything else is for Dot, but only from a number that is opted in (its latest CONSENT# is
//      newer than its latest OPTOUT#) and belongs to a family member: a Cognito user with that
//      verified phone_number in the family_assistant group (the same gate as the web page).
//      Unknown numbers get no answer at all.
//   4. Dot's turn can outlast Twilio's 15-second webhook timeout, so it runs in Dot's own SMS
//      worker (tools/assistant/api/sms.mjs), invoked asynchronously; the worker texts the reply.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { CognitoIdentityProviderClient, ListUsersCommand, AdminListGroupsForUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { PROGRAM } from './program.mjs';
import { maskPhone, twilioConfig, validTwilioSignature } from './twilio.mjs';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Twilio's default keywords, for when a message arrives without OptOutType. Not YES: Twilio counts
// it as opt-in, but to Dot it's an answer ("Delete it?" "Yes"), so it goes to Dot like any text.
const KEYWORDS = {
  STOP: ['STOP', 'STOPALL', 'STOP ALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'REVOKE'],
  START: ['START', 'UNSTOP'],
  HELP: ['HELP', 'INFO'],
};
export function keyword(params) {
  const said = String(params.Body || '').trim().toUpperCase().replace(/\s+/g, ' ');
  const type = String(params.OptOutType || '').toUpperCase();
  if (type in KEYWORDS && !(type === 'START' && said === 'YES')) return type;
  return Object.keys(KEYWORDS).find((k) => KEYWORDS[k].includes(said)) || null;
}

export const NOT_SET_UP = `${PROGRAM.name}: This number isn't set up to text Dot yet. For help, email ${PROGRAM.contact}.`;
export const TEXT_ONLY = `${PROGRAM.name}: Dot can only read text messages for now.`;

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const twiml = (message) => ({
  statusCode: 200,
  headers: { 'content-type': 'text/xml' },
  body: `<?xml version="1.0" encoding="UTF-8"?><Response>${message ? `<Message>${xml(message)}</Message>` : ''}</Response>`,
});

/** Opted in now? The newest CONSENT# or OPTOUT# row for the number decides. */
export async function optedIn(phone) {
  const r = await db.send(new QueryCommand({
    TableName: process.env.TABLE, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': `PHONE#${phone}` },
  }));
  let latest = null;
  for (const { sk } of r.Items ?? []) {
    const m = /^(CONSENT|OPTOUT)#(.+)$/.exec(sk);
    if (m && (!latest || m[2] > latest.at)) latest = { kind: m[1], at: m[2] };
  }
  return latest?.kind === 'CONSENT';
}

/**
 * deps: twilio() -> { accountSid, authToken }, findMember(phone) -> { sub, username } | null,
 *       startTurn({ userId, username, phone, text, messageSid }), now()
 */
export function createWebhook({ twilio, findMember, startTurn, now = () => new Date() }) {
  return async (event) => {
    if (event.routeKey !== 'POST /twilio') return { statusCode: 404, body: 'no route' };
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString() : event.body || '';
    const params = Object.fromEntries(new URLSearchParams(raw));
    // Twilio signs the exact URL it was given: this API's own address
    const url = `https://${event.requestContext?.domainName}${event.rawPath}${event.rawQueryString ? `?${event.rawQueryString}` : ''}`;
    const { accountSid, authToken } = await twilio();
    const signature = event.headers?.['x-twilio-signature'];
    if (!validTwilioSignature(authToken, url, params, signature) || params.AccountSid !== accountSid) {
      console.warn('refused: bad signature');
      return { statusCode: 403, body: 'forbidden' };
    }
    const phone = /^\+1\d{10}$/.test(params.From || '') ? params.From : null;
    if (!phone) return twiml();
    const at = now().toISOString();

    const kw = keyword(params);
    if (kw === 'STOP' || kw === 'START') {
      await db.send(new PutCommand({
        TableName: process.env.TABLE,
        Item: kw === 'STOP'
          ? { pk: `PHONE#${phone}`, sk: `OPTOUT#${at}`, phone, optedOutAt: at, said: params.Body, messageSid: params.MessageSid }
          : {
            pk: `PHONE#${phone}`, sk: `CONSENT#${at}`, phone, consentedAt: at, consentVersion: 'keyword',
            consentText: `Texted “${String(params.Body).trim()}” to ${PROGRAM.number}`, messageSid: params.MessageSid,
          },
      }));
      console.log(kw === 'STOP' ? 'opt-out recorded' : 'opt-in by text recorded', maskPhone(phone));
      return twiml();
    }
    if (kw === 'HELP') return twiml();

    if (!(await optedIn(phone))) {
      console.log('ignored: not opted in', maskPhone(phone));
      return twiml();
    }
    const member = await findMember(phone);
    if (!member) {
      console.log('not a member', maskPhone(phone));
      return twiml(NOT_SET_UP);
    }
    const text = String(params.Body || '').trim();
    if (!text) return twiml(TEXT_ONLY);
    await startTurn({ userId: member.sub, username: member.username, phone, text: text.slice(0, 2000), messageSid: params.MessageSid });
    console.log('to Dot', maskPhone(phone), params.MessageSid);
    return twiml();
  };
}

/** The family member with this verified number, if they may use Dot (Cognito users are named by sub) */
export function makeFindMember({ cognito, poolId, group }) {
  return async (phone) => {
    if (!/^\+1\d{10}$/.test(phone)) return null; // also keeps the filter below well-formed
    const r = await cognito.send(new ListUsersCommand({ UserPoolId: poolId, Filter: `phone_number = "${phone}"` }));
    const attr = (u, name) => u.Attributes?.find((a) => a.Name === name)?.Value;
    // A user can change their own phone_number, but only an admin can mark it verified
    const users = (r.Users ?? []).filter((u) => u.Enabled && u.UserStatus === 'CONFIRMED'
      && attr(u, 'phone_number') === phone && attr(u, 'phone_number_verified') === 'true');
    if (users.length !== 1) return null; // a number shared by two people can't say who's asking
    const groups = await cognito.send(new AdminListGroupsForUserCommand({ UserPoolId: poolId, Username: users[0].Username }));
    if (!(groups.Groups ?? []).some((g) => g.GroupName === group)) return null;
    return { sub: attr(users[0], 'sub') || users[0].Username, username: users[0].Username };
  };
}

function liveWebhook(env = process.env) {
  const ssm = new SSMClient({});
  const lambda = new LambdaClient({});
  return createWebhook({
    twilio: twilioConfig(async () => (await ssm.send(new GetParameterCommand({ Name: env.TWILIO_PARAM, WithDecryption: true }))).Parameter.Value),
    findMember: makeFindMember({ cognito: new CognitoIdentityProviderClient({}), poolId: env.USER_POOL_ID, group: env.GROUP }),
    startTurn: (payload) => lambda.send(new InvokeCommand({
      FunctionName: env.WORKER, InvocationType: 'Event', Payload: Buffer.from(JSON.stringify(payload)),
    })),
  });
}

let live;
export const handler = async (event) => (live ??= liveWebhook())(event);
