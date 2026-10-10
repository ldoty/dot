import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeTable } from '../../../platform/tests/helpers/fake-table.mjs';

process.env.TABLE = 'dot-y-sms-consent';
const table = fakeTable();
const { handler, toE164 } = await import('../api/optin.mjs');
const { CONSENT_TEXT, CONSENT_VERSION, OPT_IN_MESSAGE } = await import('../api/program.mjs');
const NOW = new Date('2026-10-03T13:30:00Z');
let sent, sendFails;
const text = async (to, body) => { if (sendFails) throw new Error('Twilio 500'); sent.push({ to, body }); };
const post = (body, now = NOW) => handler({
  routeKey: 'POST /optin', body: JSON.stringify(body),
  requestContext: { http: { sourceIp: '203.0.113.7', userAgent: 'Mozilla/5.0 (iPhone)' } },
}, { now: () => now, text }).then((r) => ({ status: r.statusCode, body: JSON.parse(r.body) }));
const good = { name: 'Jane Doty', email: 'Jane@Example.com', phone: '(864) 555-0123', consent: true, consentText: CONSENT_TEXT, page: 'https://dot-y.co/sms' };
beforeEach(() => { table.clear(); sent = []; sendFails = false; });

test('a valid opt-in stores name, number, time, the exact consent text, and where it came from', async () => {
  const r = await post(good);
  assert.deepEqual(r, { status: 200, body: { ok: true, name: 'Jane Doty', texts: true } });
  const item = table.get('PHONE#+18645550123', 'CONSENT#2026-10-03T13:30:00.000Z');
  assert.equal(item.name, 'Jane Doty');
  assert.equal(item.phone, '+18645550123');
  assert.equal(item.consentedAt, '2026-10-03T13:30:00.000Z');
  assert.equal(item.consentText, CONSENT_TEXT);
  assert.equal(item.consentVersion, CONSENT_VERSION);
  assert.equal(item.ip, '203.0.113.7');
  assert.equal(item.userAgent, 'Mozilla/5.0 (iPhone)');
  assert.equal(item.page, 'https://dot-y.co/sms');
  assert.equal(item.email, 'jane@example.com');
  const signup = table.get('SIGNUP#jane@example.com', 'AT#2026-10-03T13:30:00.000Z');
  assert.equal(signup.texts, true);
  assert.equal(signup.phone, '+18645550123');
});

// Carriers reject forced consent (Twilio error 30923): joining must work with no box and no number
test('texts are optional: joining without the box (or a number) works and stores no consent', async () => {
  for (const extra of [{ consent: false, phone: '' }, { consent: undefined, phone: undefined, consentText: undefined }, { consent: false }]) {
    table.clear();
    const r = await post({ ...good, ...extra });
    assert.deepEqual(r, { status: 200, body: { ok: true, name: 'Jane Doty', texts: false } }, JSON.stringify(extra));
    assert.deepEqual(table.keys(), ['AT#2026-10-03T13:30:00.000Z'], 'a sign-up row and no consent row');
  }
  assert.deepEqual(sent, [], 'no box, no text');
  const signup = table.get('SIGNUP#jane@example.com', 'AT#2026-10-03T13:30:00.000Z');
  assert.equal(signup.texts, false);
  assert.equal(signup.name, 'Jane Doty');
});

test('only consent: true signs up for texts, and only with the exact wording shown', async () => {
  for (const consent of [false, 'true', undefined, 1]) {
    assert.equal((await post({ ...good, consent })).status, 200);
    assert.ok(!table.keys().some((sk) => sk.startsWith('CONSENT#')), String(consent));
  }
  table.clear();
  assert.equal((await post({ ...good, consentText: CONSENT_TEXT.replace('STOP to opt out', 'reply to opt out') })).status, 400);
  assert.equal((await post({ ...good, consentText: undefined })).status, 400);
  assert.equal(table.keys().length, 0);
  assert.equal((await post({ ...good, consentText: CONSENT_TEXT.replace(/ /g, '  \n ') })).status, 200, 'whitespace differences from the page are fine');
  assert.equal(table.keys().filter((sk) => sk.startsWith('CONSENT#')).length, 1);
});

test('name and email are required; a mobile number is validated when given, and required for texts', async () => {
  assert.equal((await post({ ...good, name: '  ' })).status, 400);
  assert.equal((await post({ ...good, name: 'x'.repeat(101) })).status, 400);
  for (const email of ['', 'jane', 'jane@example', undefined]) assert.match((await post({ ...good, email })).body.error, /email/, String(email));
  for (const phone of ['555-0123', '(064) 555-0123', '+44 20 7946 0958']) {
    assert.equal((await post({ ...good, phone })).status, 400, phone);
    assert.equal((await post({ ...good, phone, consent: false })).status, 400, `${phone}, no texts`);
  }
  for (const phone of ['', '  ', undefined]) assert.match((await post({ ...good, phone })).body.error, /To get texts/, String(phone));
  assert.equal(table.keys().length, 0);
});

test('bots that fill the hidden field get a fake success and nothing is stored', async () => {
  assert.equal((await post({ ...good, company: 'Acme' })).status, 200);
  assert.equal(table.keys().length, 0);
});

test('US numbers normalize to E.164', () => {
  assert.equal(toE164('(864) 568-4810'), '+18645684810');
  assert.equal(toE164('+1 864.568.4810'), '+18645684810');
  assert.equal(toE164('18645684810'), '+18645684810');
  assert.equal(toE164('864-068-4810'), null);
});

test('only POST /optin is served, and bad JSON is a 400', async () => {
  assert.equal((await handler({ routeKey: 'GET /optin' })).statusCode, 404);
  assert.equal((await handler({ routeKey: 'POST /optin', body: '{nope' })).statusCode, 400);
});

// The registered opt-in message, word for word (Twilio campaign CMc5b4cf05876b704762116e9cde91f085)
test('the first opt-in from a number gets the registered confirmation text, once ever', async () => {
  assert.equal(OPT_IN_MESSAGE, "Dot-y: You're signed up for reminder and assistant texts from Dot-y (Luke Doty). Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.");
  await post(good);
  assert.deepEqual(sent, [{ to: '+18645550123', body: OPT_IN_MESSAGE }]);
  assert.equal(table.get('PHONE#+18645550123', 'WELCOME').sentAt, '2026-10-03T13:30:00.000Z');
  // The form is public: submitting the same number again (by anyone) records consent but texts nothing
  assert.equal((await post({ ...good, email: 'someone@example.com' }, new Date('2026-10-04T09:00:00Z'))).status, 200);
  assert.ok(table.get('PHONE#+18645550123', 'CONSENT#2026-10-04T09:00:00.000Z'));
  assert.equal(sent.length, 1);
  await post({ ...good, phone: '864-555-0199' });
  assert.deepEqual(sent.map((s) => s.to), ['+18645550123', '+18645550199']);
});

test('a failed confirmation text doesn’t fail the sign-up', async () => {
  sendFails = true;
  const r = await post(good);
  assert.deepEqual(r, { status: 200, body: { ok: true, name: 'Jane Doty', texts: true } });
  assert.ok(table.get('PHONE#+18645550123', 'CONSENT#2026-10-03T13:30:00.000Z'));
});
