// Single sign-on between dot-y.co and the tools, as Cognito custom-authentication triggers.
//
// A tool with no sign-in sends you to dot-y.co/handoff, which hands back your dot-y.co (home
// client) access token. The tool then starts CUSTOM_AUTH for its own client and answers the one
// challenge with that token. `verify` accepts it only if it's a genuine, unexpired home-client
// access token for the same user. Cognito then issues the tool's own tokens, and the pre-token
// gate still refuses them unless the user is in the tool's group.
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { verifyAccessToken } from './verify-token.mjs';

const ssm = new SSMClient({});
let homeClientId = null;
async function homeClient() {
  homeClientId ??= (await ssm.send(new GetParameterCommand({ Name: process.env.HOME_CLIENT_PARAM }))).Parameter.Value;
  return homeClientId;
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
  try {
    const issuer = `https://cognito-idp.${event.region}.amazonaws.com/${event.userPoolId}`;
    const c = await verifyAccessToken({ authorization: `Bearer ${event.request.challengeAnswer || ''}` }, { issuer, clientId: await homeClient(), group: null });
    ok = c.username === event.userName;
    if (!ok) console.warn('sso: token is for a different user');
  } catch (e) {
    if (!e.status) throw e;
    console.warn('sso: rejected', e.message);
  }
  event.response = { answerCorrect: ok };
  return event;
};
