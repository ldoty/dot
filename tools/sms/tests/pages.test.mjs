// The public pages carrier reviewers check: required wording, the unchecked consent box,
// links between pages, no unfinished content, and a working form.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { CONSENT_TEXT, PROGRAM } from '../api/program.mjs';

const read = (p) => readFileSync(new URL(`../../../platform/core/portal/${p}.html`, import.meta.url), 'utf8');
const pages = { sms: read('sms'), privacy: read('privacy'), terms: read('terms') };
const text = (html) => new JSDOM(html).window.document.body.textContent.replace(/\s+/g, ' ');

test('the operator’s legal name, program name and contact appear on all three pages', () => {
  for (const [name, html] of Object.entries(pages)) {
    const t = text(html);
    assert.ok(t.includes(PROGRAM.operator), `${name}: legal name`);
    assert.ok(t.includes(PROGRAM.name), `${name}: program name`);
    assert.ok(t.includes(PROGRAM.contact), `${name}: contact email`);
  }
});

test('no placeholder or unfinished content anywhere', () => {
  for (const [name, html] of Object.entries(pages)) {
    assert.doesNotMatch(text(html), /lorem|ipsum|coming soon|placeholder|your legal name|contact email/i, name);
    // Marker words are checked case-sensitively: "todo list" is a real example message
    assert.doesNotMatch(text(html), /\bTODO\b|\bTBD\b|\bFIXME\b|\[[A-Z][A-Z ]+\]/, name);
  }
});

// The Twilio campaign is registered without “Embedded links”: the pages mustn't promise them
test('no page says messages contain links', () => {
  for (const [name, html] of Object.entries(pages)) assert.doesNotMatch(text(html), /(messages|texts)[^.]*\b(contain|include)[^.]*links/i, name);
});

test('each page links to the other two', () => {
  const links = (html) => [...new JSDOM(html).window.document.querySelectorAll('a')].map((a) => a.getAttribute('href'));
  assert.ok(['/privacy', '/terms'].every((h) => links(pages.sms).includes(h)));
  assert.ok(['/sms', '/terms'].every((h) => links(pages.privacy).includes(h)));
  assert.ok(['/sms', '/privacy'].every((h) => links(pages.terms).includes(h)));
});

test('/sms: consent box is not pre-checked, shows the exact consent text, and links the policies inside the form', () => {
  const d = new JSDOM(pages.sms).window.document;
  const box = d.getElementById('consent');
  assert.equal(box.type, 'checkbox');
  assert.equal(box.checked, false);
  assert.equal(box.hasAttribute('checked'), false);
  assert.equal(d.getElementById('consent-text').textContent.replace(/\s+/g, ' ').trim(), CONSENT_TEXT);
  const formLinks = [...d.querySelectorAll('#optin a')].map((a) => a.getAttribute('href'));
  assert.deepEqual(formLinks, ['/privacy', '/terms']);
  assert.ok(d.getElementById('name') && d.getElementById('email') && d.getElementById('phone'));
  // Twilio rejected forced consent (error 30923): the box and the number must be optional
  assert.equal(box.required, false);
  assert.equal(d.getElementById('phone').required, false);
  assert.match(d.getElementById('optional').textContent, /Text messages are optional/);
  const t = text(pages.sms);
  assert.ok(t.includes(PROGRAM.number));
  assert.match(t, /family assistant app/);
  assert.match(t, /invitation only/);
  assert.doesNotMatch(t, /his family|for himself/);
  for (const ex of ['Taking out the trash is on your todo list', 'Don’t forget you have a meeting with Jon today']) assert.ok(t.includes(ex));
});

test('/privacy has the required sharing sentence verbatim and covers collection, retention and deletion', () => {
  const t = text(pages.privacy);
  assert.ok(t.includes('No mobile information will be shared with third parties or affiliates for marketing or promotional purposes. Text messaging originator opt-in data and consent will not be shared with any third parties.'));
  for (const topic of [/name and email address/i, /mobile number/i, /message content/i, /How long we keep it/, /deleted/i]) assert.match(t, topic);
});

test('/terms has the required items', () => {
  const t = text(pages.terms);
  for (const s of ['Message frequency varies', 'Msg & data rates may apply', 'Reply STOP to cancel', 'Reply HELP for help', 'Carriers are not liable for delayed or undelivered messages', PROGRAM.contact]) {
    assert.ok(t.includes(s), s);
  }
  assert.ok([...new JSDOM(pages.terms).window.document.querySelectorAll('a')].some((a) => a.getAttribute('href') === '/privacy'));
});

const form = () => {
  const posts = [];
  const dom = new JSDOM(pages.sms, {
    runScripts: 'dangerously', url: 'https://dot-y.co/sms',
    beforeParse(w) {
      w.fetch = async (url, o = {}) => {
        if (url === '/sms-config.json') return { ok: true, json: async () => ({ optinUrl: 'https://api.test/optin' }) };
        posts.push({ url, body: JSON.parse(o.body) });
        return { ok: true, json: async () => ({ ok: true }) };
      };
    },
  });
  const d = dom.window.document, submit = () => d.getElementById('optin').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  d.getElementById('name').value = 'Jane Doty';
  d.getElementById('email').value = 'jane@example.com';
  return { dom, d, posts, submit, settle: () => new Promise((r) => setTimeout(r, 30)) };
};

test('/sms form: joins without texts when the box is unchecked and the number blank', async () => {
  const { dom, d, posts, submit, settle } = form();
  submit();
  await settle();
  assert.equal(posts.length, 1);
  assert.deepEqual({ ...posts[0].body, page: undefined }, { name: 'Jane Doty', email: 'jane@example.com', phone: '', consent: false, company: '', consentText: null, page: undefined });
  assert.match(d.getElementById('done').textContent, /We’ll email your Dot-y sign-in to jane@example\.com\. You didn’t sign up for texts/);
  dom.window.close();
});

test('/sms form: with the box checked, needs a number and posts the exact consent text', async () => {
  const { dom, d, posts, submit, settle } = form();
  d.getElementById('consent').checked = true;
  submit();
  assert.match(d.getElementById('error').textContent, /enter your mobile number/, 'box without a number is refused');
  d.getElementById('phone').value = '555-0123';
  submit();
  assert.match(d.getElementById('error').textContent, /valid US mobile number/);
  assert.equal(posts.length, 0);
  d.getElementById('phone').value = '(864) 555-0123';
  submit();
  await settle();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'https://api.test/optin');
  assert.deepEqual({ ...posts[0].body, page: undefined }, { name: 'Jane Doty', email: 'jane@example.com', phone: '(864) 555-0123', consent: true, company: '', consentText: CONSENT_TEXT, page: undefined });
  assert.equal(d.getElementById('optin').hidden, true);
  assert.match(d.getElementById('done').textContent, /Thanks, Jane Doty\. .*You’re also signed up for Dot-y texts/);
  dom.window.close();
});
