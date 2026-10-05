// Cognito custom-authentication triggers, for two ways of getting a tool's tokens without a password:
//
// - Single sign-on: dot-y.co/handoff starts CUSTOM_AUTH for a tool's own client and answers the
//   one challenge with your dot-y.co (home client) access token. Accepted only if it's a genuine,
//   unexpired home-client access token for the same user.
// - Dot on your behalf: on a tool's *delegated* client, the answer must instead be an assertion
//   signed by Dot's KMS key, for that client and user (see platform/api/delegation.mjs).
//   Other signers (DELEGATION_SIGNERS, e.g. luke_finances) work the same way, but only on
//   clients whose rule lists them in `delegates`, and only for the users core allows them.
//
// Each client accepts only its own kind, so a dot-y.co session can't get a delegated token and
// Dot can't get a regular one. Either way the pre-token gate still requires the tool's group.
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { KMSClient, GetPublicKeyCommand } from '@aws-sdk/client-kms';
import { verifyAccessToken } from './verify-token.mjs';
import { assertionIssuer, verifyAssertion, publicKeyFromDer } from './delegation.mjs';

const ssm = new SSMClient({});
const kms = new KMSClient({});
// { "<issuer>": { "key": "<KMS key ARN>", "users": ["<sub>", ...] (omitted = anyone) } }
const signers = JSON.parse(process.env.DELEGATION_SIGNERS || '{}');
let homeClientId = null;
const rules = new Map(), publicKeys = new Map();
async function homeClient() {
  homeClientId ??= (await ssm.send(new GetParameterCommand({ Name: process.env.HOME_CLIENT_PARAM }))).Parameter.Value;
  return homeClientId;
}
async function signerKey(issuer) {
  if (!publicKeys.has(issuer)) {
    publicKeys.set(issuer, publicKeyFromDer((await kms.send(new GetPublicKeyCommand({ KeyId: signers[issuer].key }))).PublicKey));
  }
  return publicKeys.get(issuer);
}
/** The app's access rule, or null if it isn't registered */
async function ruleFor(clientId) {
  if (!rules.has(clientId)) {
    try {
      rules.set(clientId, JSON.parse((await ssm.send(new GetParameterCommand({ Name: `/family/apps/${clientId}` }))).Parameter.Value));
    } catch (e) {
      if (e.name !== 'ParameterNotFound') throw e;
      return null;
    }
  }
  return rules.get(clientId);
}

/** One custom challenge; tokens only if it was answered correctly */
export const define = async (event) => {
  const session = event.request.session || [];
  const last = session[session.length - 1];
  if (session.length === 0) {
    event.response = { challengeName: 'CUSTOM_CHALLENGE', issueTokens: false, failAuthentication: false };
  } else if (session.length === 1 && last.challengeName === 'CUSTOM_CHALLENGE' && last.challengeResult === true) {
    event.response = { issueTokens: true, failAuthentication: false };
  } else {
    event.response = { issueTokens: false, failAuthentication: true };
  }
  return event;
};

export const create = async (event) => {
  event.response = { publicChallengeParameters: { kind: 'dot-y-session' }, privateChallengeParameters: {}, challengeMetadata: 'DOT_Y_SSO' };
  return event;
};

export const verify = async (event) => {
  let ok = false;
  const clientId = event.callerContext?.clientId;
  const answer = event.request.challengeAnswer || '';
  const rule = await ruleFor(clientId);
  if (rule?.delegated) {
    const issuer = assertionIssuer(answer), sub = event.request.userAttributes?.sub;
    const signer = Object.hasOwn(signers, issuer) ? signers[issuer] : null;
    if (!signer) console.warn('delegation: rejected', 'unknown signer');
    else if (!(rule.delegates ?? ['dot']).includes(issuer)) console.warn('delegation: rejected', `${rule.app} doesn't accept ${issuer}`);
    else if (signer.users && !signer.users.includes(sub)) console.warn('delegation: rejected', `${issuer} may not act for this user`);
    else {
      try {
        const c = verifyAssertion(answer, { publicKey: await signerKey(issuer), issuer, clientId, username: event.userName, sub });
        console.log(JSON.stringify({ delegation: rule.app, by: issuer, user: event.userName, channel: c.channel }));
        ok = true;
      } catch (e) {
        console.warn('delegation: rejected', e.message);
      }
    }
  } else if (rule) {
    try {
      const issuer = `https://cognito-idp.${event.region}.amazonaws.com/${event.userPoolId}`;
      const c = await verifyAccessToken({ authorization: `Bearer ${answer}` }, { issuer, clientId: await homeClient(), group: null });
      ok = c.username === event.userName;
      if (!ok) console.warn('sso: token is for a different user');
    } catch (e) {
      if (!e.status) throw e;
      console.warn('sso: rejected', e.message);
    }
  }
  event.response = { answerCorrect: ok };
  return event;
};
