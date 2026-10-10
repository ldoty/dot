import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeTable } from '../../../platform/tests/helpers/fake-table.mjs';
import { twilioSignature } from '../../../platform/api/twilio.mjs';

process.env.TABLE = 'dot-y-sms-consent';
const table = fakeTable();
const { createWebhook, keyword, makeFindMember, NOT_SET_UP, TEXT_ONLY } = await import('../api/webhook.mjs');

const SID = 'AC' + '1'.repeat(32);
const TOKEN = 'twilio-token';
const HOST = 'abc123.execute-api.us-east-1.amazonaws.com';
const PHONE = '+18645550123';
const NOW = new Date('2026-10-10T15:00:00Z');
const LUKE = { sub: 'luke-sub', username: 'luke-sub' };

function webhook({ member = LUKE } = {}) {
  const turns = [], lookups = [];
  const handle = createWebhook({
    twilio: async () => ({ accountSid: SID, authToken: TOKEN }),
    findMember: async (phone) => { lookups.push(phone); return member; },
    startTurn: async (p) => { turns.push(p); },
    now: () => NOW,
  });
  return { handle, turns, lookups };
}

/** A request as Twilio sends it: form-encoded, signed for this URL */
function inbound(fields, { token = TOKEN, base64 = false, sign = true } = {}) {
  const params = { AccountSid: SID, MessageSid: 'SM' + '9'.repeat(32), From: PHONE, To: '+18645684810', NumMedia: '0', ...fields };
  for (const k of Object.keys(params)) if (params[k] === undefined) delete params[k];
  const body = new URLSearchParams(params).toString();
  return {
    routeKey: 'POST /twilio', rawPath: '/twilio', rawQueryString: '',
    requestContext: { domainName: HOST },
    headers: sign ? { 'x-twilio-signature': twilioSignature(token, `https://${HOST}/twilio`, params) } : {},
    body: base64 ? Buffer.from(body).toString('base64') : body, isBase64Encoded: base64,
  };
}
const message = (r) => /<Message>([\s\S]*)<\/Message>/.exec(r.body)?.[1] ?? null;
const consent = (at = '2026-10-03T13:30:00.000Z', phone = PHONE) => table.put({ pk: `PHONE#${phone}`, sk: `CONSENT#${at}`, phone });
const optout = (at, phone = PHONE) => table.put({ pk: `PHONE#${phone}`, sk: `OPTOUT#${at}`, phone });
beforeEach(() => table.clear());

test('an opted-in family member’s text goes to Dot, and Twilio gets an empty reply', async () => {
  consent();
  const { handle, turns } = webhook();
  const r = await handle(inbound({ Body: '  What’s on Saturday?  ' }));
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['content-type'], 'text/xml');
  assert.equal(r.body, '<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  assert.deepEqual(turns, [{ userId: 'luke-sub', username: 'luke-sub', phone: PHONE, text: 'What’s on Saturday?', messageSid: 'SM' + '9'.repeat(32) }]);
});

test('base64 bodies (as API Gateway may send them) are read the same way', async () => {
  consent();
  const { handle, turns } = webhook();
  assert.equal((await handle(inbound({ Body: 'Hi' }, { base64: true }))).statusCode, 200);
  assert.equal(turns[0].text, 'Hi');
});

test('unsigned, forged or other-account requests are refused before anything happens', async () => {
  consent();
  const { handle, turns, lookups } = webhook();
  assert.equal((await handle(inbound({ Body: 'Hi' }, { sign: false }))).statusCode, 403);
  assert.equal((await handle(inbound({ Body: 'Hi' }, { token: 'guess' }))).statusCode, 403);
  assert.equal((await handle(inbound({ Body: 'STOP', AccountSid: 'AC' + '2'.repeat(32) }))).statusCode, 403);
  const tampered = inbound({ Body: 'Hi' });
  tampered.body = tampered.body.replace('Hi', 'Delete+everything');
  assert.equal((await handle(tampered)).statusCode, 403);
  const elsewhere = inbound({ Body: 'Hi' });
  elsewhere.requestContext.domainName = 'evil.example.com';
  assert.equal((await handle(elsewhere)).statusCode, 403, 'the signature covers the URL');
  assert.deepEqual([turns.length, lookups.length], [0, 0]);
  assert.deepEqual(table.keys(), ['CONSENT#2026-10-03T13:30:00.000Z'], 'nothing recorded');
  assert.equal((await handle({ ...inbound({ Body: 'Hi' }), routeKey: 'GET /twilio' })).statusCode, 404);
});

test('STOP is recorded and stops Dot; Twilio sends the reply, so we don’t', async () => {
  consent();
  const { handle, turns } = webhook();
  const r = await handle(inbound({ Body: 'Stop', OptOutType: 'STOP' }));
  assert.equal(message(r), null);
  const row = table.get(`PHONE#${PHONE}`, 'OPTOUT#2026-10-10T15:00:00.000Z');
  assert.equal(row.said, 'Stop');
  await handle(inbound({ Body: 'Are you there?' }));
  assert.equal(turns.length, 0, 'opted out: ignored');
});

test('START after STOP is recorded as consent and Dot answers again', async () => {
  consent('2026-10-03T13:30:00.000Z');
  optout('2026-10-05T10:00:00.000Z');
  const { handle, turns } = webhook();
  assert.equal(message(await handle(inbound({ Body: 'START' }))), null);
  const row = table.get(`PHONE#${PHONE}`, 'CONSENT#2026-10-10T15:00:00.000Z');
  assert.equal(row.consentVersion, 'keyword');
  assert.equal(row.consentText, 'Texted “START” to (864) 568-4810');
  await handle(inbound({ Body: 'Hi again' }));
  assert.equal(turns.length, 1);
});

test('“Yes” is an answer for Dot, not an opt-in', async () => {
  consent();
  const { handle, turns } = webhook();
  await handle(inbound({ Body: 'Yes', OptOutType: 'START' }));
  assert.deepEqual(turns.map((t) => t.text), ['Yes']);
  assert.equal(table.keys().length, 1, 'no new consent row');
});

test('HELP gets no reply from us (Twilio sends the registered one) and doesn’t reach Dot', async () => {
  consent();
  const { handle, turns } = webhook();
  const r = await handle(inbound({ Body: 'help' }));
  assert.equal(message(r), null);
  assert.equal(turns.length, 0);
  assert.equal(table.keys().length, 1);
});

test('keywords come from OptOutType, or Twilio’s default words when it’s missing', () => {
  assert.equal(keyword({ OptOutType: 'STOP', Body: 'please stop texting' }), 'STOP');
  assert.equal(keyword({ Body: ' unsubscribe ' }), 'STOP');
  assert.equal(keyword({ Body: 'stop all' }), 'STOP');
  assert.equal(keyword({ Body: 'Unstop' }), 'START');
  assert.equal(keyword({ Body: 'Yes' }), null);
  assert.equal(keyword({ Body: 'yes', OptOutType: 'START' }), null, 'even when Twilio calls it an opt-in');
  assert.equal(keyword({ Body: 'info' }), 'HELP');
  assert.equal(keyword({ Body: 'Stop by the store on the way home' }), null);
  assert.equal(keyword({ Body: 'help me plan Saturday' }), null);
});

test('a number that never opted in gets nothing, and isn’t even looked up', async () => {
  const { handle, turns, lookups } = webhook();
  const r = await handle(inbound({ Body: 'Hi' }));
  assert.equal(message(r), null);
  assert.deepEqual([turns.length, lookups.length], [0, 0]);
});

test('the newest consent or opt-out decides', async () => {
  const { handle, turns } = webhook();
  optout('2026-10-01T00:00:00.000Z');
  consent('2026-10-02T00:00:00.000Z');
  table.put({ pk: `PHONE#${PHONE}`, sk: 'WELCOME' }); // other rows don't count
  await handle(inbound({ Body: 'one' }));
  optout('2026-10-04T00:00:00.000Z');
  await handle(inbound({ Body: 'two' }));
  assert.deepEqual(turns.map((t) => t.text), ['one']);
});

test('an opted-in number that isn’t a family member’s is told so, and Dot never runs', async () => {
  consent();
  const { handle, turns } = webhook({ member: null });
  const r = await handle(inbound({ Body: 'Hi' }));
  assert.equal(message(r), NOT_SET_UP);
  assert.match(NOT_SET_UP, /^Dot-y: /);
  assert.equal(turns.length, 0);
});

test('a picture with no words gets a short note', async () => {
  consent();
  const { handle, turns } = webhook();
  assert.equal(message(await handle(inbound({ Body: '', NumMedia: '1' }))), TEXT_ONLY);
  assert.equal(turns.length, 0);
});

test('non-US or malformed senders are ignored', async () => {
  const { handle, turns, lookups } = webhook();
  for (const From of ['+447700900123', 'client:abc', undefined]) {
    assert.equal(message(await handle(inbound({ Body: 'Hi', From }))), null);
  }
  assert.deepEqual([turns.length, lookups.length, table.keys().length], [0, 0, 0]);
});

// --- who's texting: Cognito users with that verified number, in family_assistant ---

function fakeCognito(users, groups = { 'luke-sub': ['family_assistant'] }) {
  const calls = [];
  return {
    calls,
    send: async (cmd) => {
      calls.push({ name: cmd.constructor.name, input: cmd.input });
      if (cmd.constructor.name === 'ListUsersCommand') {
        const phone = /^phone_number = "(.+)"$/.exec(cmd.input.Filter)[1];
        return { Users: users.filter((u) => u.Attributes.some((a) => a.Name === 'phone_number' && a.Value === phone)) };
      }
      return { Groups: (groups[cmd.input.Username] ?? []).map((GroupName) => ({ GroupName })) };
    },
  };
}
const user = (name, phone, { verified = 'true', status = 'CONFIRMED', enabled = true } = {}) => ({
  Username: name, Enabled: enabled, UserStatus: status,
  Attributes: [{ Name: 'sub', Value: name }, { Name: 'phone_number', Value: phone }, { Name: 'phone_number_verified', Value: verified }],
});

test('a verified number on a family_assistant member is that member', async () => {
  const cognito = fakeCognito([user('luke-sub', PHONE)]);
  const find = makeFindMember({ cognito, poolId: 'pool', group: 'family_assistant' });
  assert.deepEqual(await find(PHONE), LUKE);
  assert.deepEqual(cognito.calls[0].input, { UserPoolId: 'pool', Filter: `phone_number = "${PHONE}"` });
});

test('unverified, disabled, unconfirmed, shared or non-member numbers are nobody', async () => {
  const find = (users, groups) => makeFindMember({ cognito: fakeCognito(users, groups), poolId: 'pool', group: 'family_assistant' })(PHONE);
  assert.equal(await find([user('luke-sub', PHONE, { verified: 'false' })]), null, 'anyone can set their own number; only an admin verifies it');
  assert.equal(await find([user('luke-sub', PHONE, { enabled: false })]), null);
  assert.equal(await find([user('luke-sub', PHONE, { status: 'FORCE_CHANGE_PASSWORD' })]), null);
  assert.equal(await find([user('luke-sub', PHONE), user('amber-sub', PHONE)], { 'luke-sub': ['family_assistant'], 'amber-sub': ['family_assistant'] }), null);
  assert.equal(await find([user('luke-sub', PHONE)], { 'luke-sub': ['family_budget'] }), null);
  assert.equal(await find([]), null);
});

test('only a plain E.164 number reaches the Cognito filter', async () => {
  const cognito = fakeCognito([]);
  const find = makeFindMember({ cognito, poolId: 'pool', group: 'family_assistant' });
  assert.equal(await find('+18645550123" or email = "x'), null);
  assert.equal(cognito.calls.length, 0);
});
