import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mockClient } from 'aws-sdk-client-mock';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { KMSClient, GetPublicKeyCommand } from '@aws-sdk/client-kms';
import { ISSUER, accessToken, forgedToken } from './helpers/tokens.mjs';
import { signAssertion } from '../api/delegation.mjs';

// The trigger builds the real pool issuer; serve the test key's JWKS there too.
const POOL_ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_pool';
const inner = globalThis.fetch;
globalThis.fetch = (url, opts) => inner(url === `${POOL_ISSUER}/.well-known/jwks.json` ? `${ISSUER}/.well-known/jwks.json` : url, opts);

process.env.HOME_CLIENT_PARAM = '/family/core/home-client-id';
process.env.DELEGATION_SIGNERS = JSON.stringify({
  dot: { key: 'arn:aws:kms:us-east-1:1:key/dot' },
  luke_finances: { key: 'arn:aws:kms:us-east-1:1:key/finances', users: ['luke-sub'] },
});
const rule = (r) => ({ Parameter: { Value: JSON.stringify(r) } });
const ssm = mockClient(SSMClient);
ssm.on(GetParameterCommand).rejects(Object.assign(new Error('nope'), { name: 'ParameterNotFound' }));
ssm.on(GetParameterCommand, { Name: '/family/core/home-client-id' }).resolves({ Parameter: { Value: 'home-client' } });
ssm.on(GetParameterCommand, { Name: '/family/apps/biomap-client' }).resolves(rule({ app: 'lukes_biomap', group: 'lukes_biomap', returns: ['https://biomap.dot-y.co/'] }));
ssm.on(GetParameterCommand, { Name: '/family/apps/budget-client' }).resolves(rule({ app: 'family_budget', group: 'family_budget' }));
ssm.on(GetParameterCommand, { Name: '/family/apps/budget-dot' }).resolves(rule({ app: 'family_budget', group: 'family_budget', delegated: true, delegates: ['dot', 'luke_finances'] }));
ssm.on(GetParameterCommand, { Name: '/family/apps/links-dot' }).resolves(rule({ app: 'family_links', group: 'family_links', delegated: true }));

// Dot's and Luke's Finances' signing keys (stand in for KMS), and an unrelated key
const dot = generateKeyPairSync('rsa', { modulusLength: 2048 });
const fin = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const der = (k) => ({ PublicKey: k.publicKey.export({ format: 'der', type: 'spki' }) });
const kms = mockClient(KMSClient);
kms.on(GetPublicKeyCommand, { KeyId: 'arn:aws:kms:us-east-1:1:key/dot' }).resolves(der(dot));
kms.on(GetPublicKeyCommand, { KeyId: 'arn:aws:kms:us-east-1:1:key/finances' }).resolves(der(fin));
const assertion = (over = {}, key = dot.privateKey) => signAssertion({
  clientId: 'budget-dot', sub: 'luke-sub', username: 'luke-sub', channel: 'web',
  sign: async (b) => sign('RSA-SHA256', b, key), ...over,
});
const { define, create, verify } = await import('../core/lambda/sso-auth.mjs');

const home = (over = {}) => accessToken({ clientId: 'home-client', iss: POOL_ISSUER, username: 'luke-sub', ...over });
const answer = (token, userName = 'luke-sub', clientId = 'biomap-client') => verify({
  region: 'us-east-1', userPoolId: 'us-east-1_pool', userName,
  callerContext: { clientId },
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

// --- Dot on your behalf: a tool's delegated client ---

test('delegated client: accepts Dot’s signed assertion for that client and user', async () => {
  assert.equal(await answer(await assertion(), 'luke-sub', 'budget-dot'), true);
});

test('delegated client: refuses your dot-y.co token, other keys, other apps, other users and stale assertions', async () => {
  assert.equal(await answer(home(), 'luke-sub', 'budget-dot'), false); // a dot-y.co session can't get a delegated token
  assert.equal(await answer(await assertion({}, other.privateKey), 'luke-sub', 'budget-dot'), false);
  assert.equal(await answer(await assertion({ clientId: 'links-dot' }), 'luke-sub', 'budget-dot'), false);
  assert.equal(await answer(await assertion({ sub: 'amber-sub', username: 'amber-sub' }), 'luke-sub', 'budget-dot'), false);
  assert.equal(await answer(await assertion({ now: Date.now() - 10 * 60e3 }), 'luke-sub', 'budget-dot'), false);
  assert.equal(await answer('', 'luke-sub', 'budget-dot'), false);
});

test('normal clients never accept Dot’s assertion, so Dot can’t get a writable token', async () => {
  assert.equal(await answer(await assertion({ clientId: 'budget-client' }), 'luke-sub', 'budget-client'), false);
});

test('an unregistered client accepts nothing', async () => {
  assert.equal(await answer(home(), 'luke-sub', 'mystery-client'), false);
});

// --- Other signers: Luke's Finances reads the budget as Luke ---

const finance = (over = {}, key = fin.privateKey) => assertion({ issuer: 'luke_finances', channel: 'sync', ...over }, key);

test('another signer: accepted on a client that lists it, for a user it may act for', async () => {
  assert.equal(await answer(await finance(), 'luke-sub', 'budget-dot'), true);
});

test('another signer: refused on clients that don’t list it, for other users, and with the wrong key', async () => {
  assert.equal(await answer(await finance({ clientId: 'links-dot' }), 'luke-sub', 'links-dot'), false); // links only takes Dot
  assert.equal(await answer(await finance({ sub: 'amber-sub', username: 'amber-sub' }), 'amber-sub', 'budget-dot'), false); // only Luke
  assert.equal(await answer(await finance({}, dot.privateKey), 'luke-sub', 'budget-dot'), false); // Dot's key can't sign as finance
  assert.equal(await answer(await assertion({}, fin.privateKey), 'luke-sub', 'budget-dot'), false); // finance's key can't pass as Dot
  assert.equal(await answer(await finance({ issuer: 'mallory' }, other.privateKey), 'luke-sub', 'budget-dot'), false); // unknown signer
  assert.equal(await answer(await finance({ issuer: 'hasOwnProperty' }), 'luke-sub', 'budget-dot'), false);
});

test('Dot still works on clients that don’t name their signers', async () => {
  assert.equal(await answer(await assertion({ clientId: 'links-dot' }), 'luke-sub', 'links-dot'), true);
});
