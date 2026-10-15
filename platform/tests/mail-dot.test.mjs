// dot@dot-y.co's gate: only a family_assistant member's own, DMARC-passing, non-automatic mail reaches Dot
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { address, createGate, makeFindMember, refusal } from '../email/lambda/dot.mjs';

const DOT = 'dot@dot-y.co';
const LUKE = { sub: 'luke-sub', username: 'luke-sub' };

/** An SES receipt event as the Lambda action gets it (headers and verdicts, no body) */
function record({ from = ['Luke Doty <Luke.Doty@gmail.com>'], recipients = [DOT], verdicts = {}, headers = [], messageId = 'abc123def' } = {}) {
  const pass = { status: 'PASS' };
  return {
    ses: {
      mail: { messageId, source: 'luke.doty@gmail.com', headers, commonHeaders: { from, to: [DOT], subject: 'Dentist' } },
      receipt: { recipients, virusVerdict: pass, spamVerdict: pass, dmarcVerdict: pass, spfVerdict: pass, dkimVerdict: pass, ...verdicts },
    },
  };
}

function gate(member = LUKE) {
  const turns = [], lookups = [], logs = [];
  const handle = createGate({
    dotAddress: DOT, bucket: 'dot-y-mail-abc', prefix: 'dot/',
    findMember: async (email) => { lookups.push(email); return member; },
    startTurn: async (p) => { turns.push(p); },
    log: (l) => logs.push(JSON.parse(l)),
  });
  return { run: (...records) => handle({ Records: records }), turns, lookups, logs };
}

test('a member’s mail starts a turn as them, pointing at the stored message', async () => {
  const g = gate();
  await g.run(record());
  assert.deepEqual(g.lookups, ['luke.doty@gmail.com'], 'looked up by the From address, lowercased');
  assert.deepEqual(g.turns, [{ userId: 'luke-sub', username: 'luke-sub', from: 'luke.doty@gmail.com', bucket: 'dot-y-mail-abc', key: 'dot/abc123def' }]);
});

test('virus, spam or DMARC not PASS: dropped before anyone is looked up', async () => {
  for (const verdicts of [
    { dmarcVerdict: { status: 'FAIL' } }, { dmarcVerdict: { status: 'GRAY' } }, { dmarcVerdict: undefined },
    { spamVerdict: { status: 'FAIL' } }, { virusVerdict: { status: 'PROCESSING_FAILED' } },
  ]) {
    const g = gate();
    await g.run(record({ verdicts }));
    assert.deepEqual([g.turns.length, g.lookups.length], [0, 0], JSON.stringify(verdicts));
  }
});

test('automatic and bulk mail never reaches Dot (no reply loops)', async () => {
  for (const headers of [[{ name: 'Auto-Submitted', value: 'auto-replied' }], [{ name: 'auto-submitted', value: 'auto-generated' }], [{ name: 'Precedence', value: 'bulk' }], [{ name: 'Precedence', value: 'list' }]]) {
    const g = gate();
    await g.run(record({ headers }));
    assert.equal(g.turns.length, 0, JSON.stringify(headers));
  }
  const g = gate();
  await g.run(record({ headers: [{ name: 'Auto-Submitted', value: 'no' }] }));
  assert.equal(g.turns.length, 1, '"no" means a person sent it');
});

test('one plain From address only, never Dot itself, and only mail addressed to Dot', async () => {
  for (const r of [
    record({ from: ['a@example.com', 'b@example.com'] }), record({ from: [] }), record({ from: ['undisclosed'] }),
    record({ from: ['Dot <dot@dot-y.co>'] }), record({ from: ['"x" <a"b@example.com>'] }),
    record({ recipients: ['contact@dot-y.co'] }), record({ messageId: '../inbound/x' }),
  ]) {
    const g = gate();
    await g.run(r);
    assert.equal(g.turns.length, 0, JSON.stringify(r.ses.mail.commonHeaders.from));
  }
});

test('not a member: dropped without an answer', async () => {
  const g = gate(null);
  await g.run(record());
  assert.equal(g.turns.length, 0);
  assert.equal(g.logs[0].ignored, 'not a member');
});

test('each message in an event is judged on its own', async () => {
  const g = gate();
  await g.run(record({ verdicts: { dmarcVerdict: { status: 'FAIL' } } }), record({ messageId: 'second' }));
  assert.deepEqual(g.turns.map((t) => t.key), ['dot/second']);
});

test('address() reads one plain address and refuses anything that could bend the Cognito filter', () => {
  assert.equal(address('Luke Doty <Luke.Doty@Gmail.com>'), 'luke.doty@gmail.com');
  assert.equal(address('amber@example.com'), 'amber@example.com');
  for (const bad of ['a"@example.com', 'x <a@b.com" or email = "c@d.com>', 'nobody', '', null]) assert.equal(address(bad), null, String(bad));
  assert.equal(refusal(record(), DOT), null);
});

// --- who's emailing: Cognito users with that verified email, in family_assistant ---

function fakeCognito(users, groups = { 'luke-sub': ['family_assistant'] }) {
  const calls = [];
  return {
    calls,
    send: async (cmd) => {
      calls.push({ name: cmd.constructor.name, input: cmd.input });
      if (cmd.constructor.name === 'ListUsersCommand') {
        const email = /^email = "(.+)"$/.exec(cmd.input.Filter)[1];
        return { Users: users.filter((u) => u.Attributes.some((a) => a.Name === 'email' && a.Value === email)) };
      }
      return { Groups: (groups[cmd.input.Username] ?? []).map((GroupName) => ({ GroupName })) };
    },
  };
}
const user = (name, email, { verified = 'true', status = 'CONFIRMED', enabled = true } = {}) => ({
  Username: name, Enabled: enabled, UserStatus: status,
  Attributes: [{ Name: 'sub', Value: name }, { Name: 'email', Value: email }, { Name: 'email_verified', Value: verified }],
});
const EMAIL = 'luke.doty@gmail.com';

test('a verified email on a family_assistant member is that member', async () => {
  const cognito = fakeCognito([user('luke-sub', EMAIL)]);
  assert.deepEqual(await makeFindMember({ cognito, poolId: 'pool', group: 'family_assistant' })(EMAIL), LUKE);
  assert.deepEqual(cognito.calls[0].input, { UserPoolId: 'pool', Filter: `email = "${EMAIL}"` });
});

test('unverified, disabled, unconfirmed, shared or non-member emails are nobody', async () => {
  const find = (users, groups) => makeFindMember({ cognito: fakeCognito(users, groups), poolId: 'pool', group: 'family_assistant' })(EMAIL);
  assert.equal(await find([user('luke-sub', EMAIL, { verified: 'false' })]), null);
  assert.equal(await find([user('luke-sub', EMAIL, { enabled: false })]), null);
  assert.equal(await find([user('luke-sub', EMAIL, { status: 'FORCE_CHANGE_PASSWORD' })]), null);
  assert.equal(await find([user('luke-sub', EMAIL), user('amber-sub', EMAIL)], { 'luke-sub': ['family_assistant'], 'amber-sub': ['family_assistant'] }), null);
  assert.equal(await find([user('luke-sub', EMAIL)], { 'luke-sub': ['family_budget'] }), null);
  assert.equal(await find([]), null);
});

test('only a plain address reaches the Cognito filter', async () => {
  const cognito = fakeCognito([]);
  const find = makeFindMember({ cognito, poolId: 'pool', group: 'family_assistant' });
  assert.equal(await find('a@b.com" or email = "c@d.com'), null);
  assert.equal(cognito.calls.length, 0);
});
