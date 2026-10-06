// Read-only checks of the live SMS pages and opt-in endpoint: `npm run test:live`.
// Never creates a consent record (only refused or bot-trapped submissions are sent).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONSENT_TEXT, PROGRAM } from '../api/program.mjs';

const SITE = 'https://dot-y.co';
const page = async (p) => { const r = await fetch(`${SITE}/${p}`); return { status: r.status, type: r.headers.get('content-type'), html: await r.text() }; };

test('the three pages are public HTML with the operator’s name and contact', async () => {
  for (const p of ['sms', 'privacy', 'terms']) {
    const r = await page(p);
    assert.equal(r.status, 200, p);
    assert.match(r.type, /text\/html/, p);
    assert.ok(r.html.includes(PROGRAM.operator) && r.html.includes(PROGRAM.contact), p);
  }
});

test('live /sms shows the unchecked, optional consent box with the exact wording', async () => {
  const { html } = await page('sms');
  assert.match(html, /Text messages are optional/);
  assert.doesNotMatch(/<input[^>]*id="phone"[^>]*>/.exec(html)[0], /required/);
  assert.match(html, /<input type="checkbox" id="consent" name="consent">/);
  const shown = /<span id="consent-text">([\s\S]*?)<\/span>/.exec(html)[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  assert.equal(shown, CONSENT_TEXT);
});

test('the opt-in endpoint is wired up, validates, and only accepts the dot-y.co origin', async () => {
  const { optinUrl } = await (await fetch(`${SITE}/sms-config.json`)).json();
  const post = (body) => fetch(optinUrl, { method: 'POST', headers: { 'content-type': 'application/json', origin: SITE }, body: JSON.stringify(body) });
  const refused = await post({ name: 'Live check', email: 'live@example.com', phone: '', consent: true, consentText: CONSENT_TEXT });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /enter your mobile number/);
  const trapped = await post({ name: 'Live check', phone: '(864) 555-0100', consent: true, consentText: CONSENT_TEXT, company: 'bot' });
  assert.equal(trapped.status, 200, 'bot-trap path answers without storing');
  const pre = (origin) => fetch(optinUrl, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
  assert.equal((await pre(SITE)).headers.get('access-control-allow-origin'), SITE);
  assert.equal((await pre('https://evil.example')).headers.get('access-control-allow-origin'), null);
});
