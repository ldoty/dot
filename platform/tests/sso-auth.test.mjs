import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { ISSUER, accessToken, forgedToken } from './helpers/tokens.mjs';

// The trigger builds the real pool issuer; serve the test key's JWKS there too.
const POOL_ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_pool';
const inner = globalThis.fetch;
globalThis.fetch = (url, opts) => inner(url === `${POOL_ISSUER}/.well-known/jwks.json` ? `${ISSUER}/.well-known/jwks.json` : url, opts);

process.env.HOME_CLIENT_PARAM = '/family/core/home-client-id';
mockClient(SSMClient).on(GetParameterCommand, { Name: '/family/core/home-client-id' }).resolves({ Parameter: { Value: 'home-client' } });
const { define, create, verify } = await import('../core/lambda/sso-auth.mjs');

const home = (over = {}) => accessToken({ clientId: 'home-client', iss: POOL_ISSUER, username: 'luke-sub', ...over });
const answer = (token, userName = 'luke-sub') => verify({
  region: 'us-east-1', userPoolId: 'us-east-1_pool', userName,
  callerContext: { clientId: 'biomap-client' },
  request: { challengeAnswer: token, userAttributes: { sub: userName } },
}).then((e) => e.response.answerCorrect);

test('define: one custom challenge, tokens only after a correct answer, no retries', async () => {
  const run = async (session) => (await define({ request: { session }, response: {} })).response;
  assert.deepEqual(await run([]), { challengeName: 'CUSTOM_CHALLENGE', issueTokens: false, failAuthentication: false });
  assert.equal((await run([{ challengeName: 'CUSTOM_CHALLENGE', challengeResult: true }])).issueTokens, true);
  const wrong = await run([{ challengeName: 'CUSTOM_CHALLENGE', challengeResult: false }]);
  assert.deepEqual([wrong.issueTokens, wrong.failAuthentication], [false, true]);
  // A password (SRP) step first, or a second try, is never part of this flow.
  assert.equal((await run([{ challengeName: 'SRP_A', challengeResult: true }])).failAuthentication, true);
  assert.equal((await run([
    { challengeName: 'CUSTOM_CHALLENGE', challengeResult: false },
    { challengeName: 'CUSTOM_CHALLENGE', challengeResult: true },
  ])).failAuthentication, true);
});

test('create: no secret in the challenge', async () => {
  const r = (await create({ request: {}, response: {} })).response;
  assert.deepEqual(r.privateChallengeParameters, {});
});

test('verify: accepts your own valid dot-y.co sign-in', async () => {
  assert.equal(await answer(home()), true);
});

test('verify: refuses anyone else’s sign-in, a tool’s token, and bad tokens', async () => {
  assert.equal(await answer(home(), 'someone-else'), false);
  assert.equal(await answer(home({ clientId: 'budget-client' })), false); // tool tokens can't hop to another tool
  assert.equal(await answer(home({ exp: 1 })), false);
  assert.equal(await answer(home({ token_use: 'id' })), false);
  assert.equal(await answer(home({ iss: 'https://cognito-idp.us-east-1.amazonaws.com/other-pool' })), false);
  assert.equal(await answer(forgedToken({ clientId: 'home-client', iss: POOL_ISSUER, username: 'luke-sub' })), false);
  assert.equal(await answer(''), false);
  assert.equal(await answer(undefined), false);
});
