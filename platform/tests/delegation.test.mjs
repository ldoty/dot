import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { makeDelegation, verifyAssertion } from '../api/delegation.mjs';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const signer = async (b) => sign('RSA-SHA256', b, privateKey);

function fakeCognito(respond) {
  const calls = [];
  const fetch = async (url, o) => {
    const target = o.headers['X-Amz-Target'].split('.').pop();
    const body = JSON.parse(o.body);
    calls.push({ url, target, body });
    const [status, json] = respond(target, body);
    return { ok: status < 300, status, json: async () => json };
  };
  return { fetch, calls };
}
const happy = (target) => (target === 'InitiateAuth'
  ? [200, { ChallengeName: 'CUSTOM_CHALLENGE', Session: 's1', ChallengeParameters: { USERNAME: 'luke-sub' } }]
  : [200, { AuthenticationResult: { AccessToken: 'budget-token', ExpiresIn: 300 } }]);
const who = { clientId: 'budget-dot', sub: 'luke-sub', username: 'luke-sub', channel: 'web' };

test('gets the asker’s token from the delegated client, answering with a signed assertion', async () => {
  const g = fakeCognito(happy);
  const tokenFor = makeDelegation({ sign: signer, region: 'us-east-1', fetch: g.fetch });
  assert.equal(await tokenFor(who), 'budget-token');
  assert.equal(g.calls[0].url, 'https://cognito-idp.us-east-1.amazonaws.com/');
  assert.deepEqual(g.calls[0].body, { AuthFlow: 'CUSTOM_AUTH', ClientId: 'budget-dot', AuthParameters: { USERNAME: 'luke-sub' } });
  const r = g.calls[1].body;
  assert.equal(r.Session, 's1');
  const c = verifyAssertion(r.ChallengeResponses.ANSWER, { publicKey, clientId: 'budget-dot', username: 'luke-sub', sub: 'luke-sub' });
  assert.equal(c.channel, 'web');
  assert.ok(c.exp - c.iat <= 120);
});

test('caches per tool and person until shortly before expiry', async () => {
  const g = fakeCognito(happy);
  let now = 1_000_000;
  const tokenFor = makeDelegation({ sign: signer, region: 'us-east-1', fetch: g.fetch, now: () => now });
  await tokenFor(who);
  await tokenFor(who);
  assert.equal(g.calls.length, 2, 'one exchange');
  await tokenFor({ ...who, sub: 'amber-sub', username: 'amber-sub' });
  assert.equal(g.calls.length, 4, 'Amber gets her own token, never Luke’s');
  now += 250_000; // within a minute of expiry
  await tokenFor(who);
  assert.equal(g.calls.length, 6);
});

test('a non-member’s refusal comes back as `denied` with the gate’s message', async () => {
  const g = fakeCognito((t) => (t === 'InitiateAuth' ? happy(t)
    : [400, { __type: 'UserLambdaValidationException', message: "PreTokenGeneration failed with error You don't have access to family_budget. Ask an admin to add you." }]));
  const tokenFor = makeDelegation({ sign: signer, region: 'us-east-1', fetch: g.fetch });
  await assert.rejects(tokenFor(who), (e) => e.denied && /^You don't have access to family_budget/.test(e.message));
});
