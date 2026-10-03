import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeTable } from '../../../platform/tests/helpers/fake-table.mjs';

process.env.TABLE = 'dot-y-sms-consent';
const table = fakeTable();
const { handler, toE164 } = await import('../api/optin.mjs');
const { CONSENT_TEXT, CONSENT_VERSION } = await import('../api/program.mjs');
const NOW = new Date('2026-10-03T13:30:00Z');
const post = (body) => handler({
  routeKey: 'POST /optin', body: JSON.stringify(body),
  requestContext: { http: { sourceIp: '203.0.113.7', userAgent: 'Mozilla/5.0 (iPhone)' } },
}, { now: () => NOW }).then((r) => ({ status: r.statusCode, body: JSON.parse(r.body) }));
const good = { name: 'Jane Doty', phone: '(864) 555-0123', consent: true, consentText: CONSENT_TEXT, page: 'https://dot-y.co/sms' };
beforeEach(() => table.clear());

test('a valid opt-in stores name, number, time, the exact consent text, and where it came from', async () => {
  const r = await post(good);
  assert.deepEqual(r, { status: 200, body: { ok: true, name: 'Jane Doty' } });
  const item = table.get('PHONE#+18645550123', 'CONSENT#2026-10-03T13:30:00.000Z');
  assert.equal(item.name, 'Jane Doty');
  assert.equal(item.phone, '+18645550123');
  assert.equal(item.consentedAt, '2026-10-03T13:30:00.000Z');
  assert.equal(item.consentText, CONSENT_TEXT);
  assert.equal(item.consentVersion, CONSENT_VERSION);
  assert.equal(item.ip, '203.0.113.7');
  assert.equal(item.userAgent, 'Mozilla/5.0 (iPhone)');
  assert.equal(item.page, 'https://dot-y.co/sms');
});

test('consent must be explicitly true, with the exact wording shown', async () => {
  for (const consent of [false, 'true', undefined]) assert.equal((await post({ ...good, consent })).status, 400);
  assert.equal((await post({ ...good, consentText: CONSENT_TEXT.replace('STOP to opt out', 'reply to opt out') })).status, 400);
  assert.equal((await post({ ...good, consentText: CONSENT_TEXT.replace(/ /g, '  \n ') })).status, 200, 'whitespace differences from the page are fine');
  assert.equal(table.keys().length, 1);
});

test('name and US mobile number are required and validated', async () => {
  assert.equal((await post({ ...good, name: '  ' })).status, 400);
  assert.equal((await post({ ...good, name: 'x'.repeat(101) })).status, 400);
  for (const phone of ['555-0123', '(064) 555-0123', '+44 20 7946 0958', '']) assert.equal((await post({ ...good, phone })).status, 400, phone);
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
