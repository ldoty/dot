// dot@dot-y.co: SES has stored the message in the mail bucket (prefix dot/) and invokes this with
// its headers and SES's verdicts, never the body. A message reaches Dot only if:
//   1. it is addressed to Dot, and SES found no virus, didn't call it spam, and DMARC passed
//      (the From domain vouches for it, so the From address isn't forged);
//   2. it isn't automatic mail (Auto-Submitted, Precedence bulk/junk/list), so Dot never answers
//      a vacation reply or a mailing list, and two auto-responders can't loop through it;
//   3. its one From address is the verified email of exactly one enabled, confirmed Cognito user in
//      family_assistant (the same gate as the web page and texting).
// Anything else is dropped without an answer (no backscatter to forged senders). Dot's turn can take
// minutes, so it runs in Dot's own email worker (tools/assistant/api/email.mjs), invoked asynchronously.
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { CognitoIdentityProviderClient, ListUsersCommand, AdminListGroupsForUserCommand } from '@aws-sdk/client-cognito-identity-provider';

// Plain addresses only: this also keeps the Cognito filter below well-formed
const EMAIL = /^[^\s@<>"',;()[\]\\]+@[a-z0-9.-]+\.[a-z]{2,}$/;

/** "Luke Doty <Luke.Doty@gmail.com>" -> "luke.doty@gmail.com"; null for anything else */
export function address(from) {
  const s = String(from || '').trim();
  const a = (/<([^<>]*)>\s*$/.exec(s)?.[1] ?? s).trim().toLowerCase();
  return EMAIL.test(a) ? a : null;
}

/** Why a message must not reach Dot, or null if it may (still subject to the member check) */
export function refusal(record, dotAddress) {
  const { mail, receipt } = record.ses;
  if (!(receipt.recipients || []).some((r) => r.toLowerCase() === dotAddress)) return 'not addressed to Dot';
  for (const v of ['virusVerdict', 'spamVerdict', 'dmarcVerdict']) {
    if (receipt[v]?.status !== 'PASS') return `${v} ${receipt[v]?.status || 'missing'}`;
  }
  if (!/^[A-Za-z0-9]{1,100}$/.test(mail.messageId || '')) return 'bad message id';
  const header = (name) => (mail.headers || []).filter((h) => h.name.toLowerCase() === name).map((h) => h.value.trim().toLowerCase());
  if (header('auto-submitted').some((v) => v !== 'no')) return 'automatic mail';
  if (header('precedence').some((v) => ['bulk', 'junk', 'list'].includes(v))) return 'bulk mail';
  const from = mail.commonHeaders?.from || [];
  if (from.length !== 1 || !address(from[0])) return 'not one plain From address';
  if (address(from[0]) === dotAddress) return 'from Dot';
  return null;
}

/** The family member with this verified email, if they may use Dot (Cognito users are named by sub) */
export function makeFindMember({ cognito, poolId, group }) {
  return async (email) => {
    if (!EMAIL.test(email || '')) return null;
    const r = await cognito.send(new ListUsersCommand({ UserPoolId: poolId, Filter: `email = "${email}"` }));
    const attr = (u, name) => u.Attributes?.find((a) => a.Name === name)?.Value;
    const users = (r.Users ?? []).filter((u) => u.Enabled && u.UserStatus === 'CONFIRMED'
      && String(attr(u, 'email')).toLowerCase() === email && attr(u, 'email_verified') === 'true');
    if (users.length !== 1) return null; // an address shared by two people can't say who's asking
    const groups = await cognito.send(new AdminListGroupsForUserCommand({ UserPoolId: poolId, Username: users[0].Username }));
    if (!(groups.Groups ?? []).some((g) => g.GroupName === group)) return null;
    return { sub: attr(users[0], 'sub') || users[0].Username, username: users[0].Username };
  };
}

/** deps: dotAddress, bucket, prefix, findMember(email), startTurn({ userId, username, from, bucket, key }) */
export function createGate({ dotAddress, bucket, prefix, findMember, startTurn, log = console.log }) {
  return async (event) => {
    for (const record of event.Records || []) {
      const id = record.ses?.mail?.messageId;
      const why = refusal(record, dotAddress);
      if (why) { log(JSON.stringify({ ignored: why, messageId: id })); continue; }
      const from = address(record.ses.mail.commonHeaders.from[0]);
      const member = await findMember(from);
      if (!member) { log(JSON.stringify({ ignored: 'not a member', messageId: id })); continue; }
      await startTurn({ userId: member.sub, username: member.username, from, bucket, key: prefix + id });
      log(JSON.stringify({ toDot: id }));
    }
  };
}

let live;
export const handler = async (event) => (live ??= (() => {
  const lambda = new LambdaClient({});
  return createGate({
    dotAddress: process.env.DOT_ADDRESS,
    bucket: process.env.BUCKET,
    prefix: process.env.PREFIX,
    findMember: makeFindMember({ cognito: new CognitoIdentityProviderClient({}), poolId: process.env.USER_POOL_ID, group: process.env.GROUP }),
    startTurn: (payload) => lambda.send(new InvokeCommand({
      FunctionName: process.env.WORKER, InvocationType: 'Event', Payload: Buffer.from(JSON.stringify(payload)),
    })),
  });
})())(event);
