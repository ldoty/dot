import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { AMBER, KID, LUKE, adminToken, call, google, seed, table, token } from './helpers/calendars.mjs';

const HTML = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8').replace('<script src="family-auth.js"></script>', '');
const API = 'https://api.test';
const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const opened = [];
async function open(tok = token()) {
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: 'https://calendars.dot-y.co/', pretendToBeVisual: true,
    beforeParse(w) {
      w.FamilyAuth = { init: async () => ({ email: 't' }), accessToken: async () => tok, autoLogin: () => false, login() {}, logout() {} };
      w.confirm = () => true;
      w.fetch = async (url, o = {}) => {
        const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
        if (url === 'config.json') return json(200, { apiUrl: API });
        const r = await call(o.method || 'GET', url.slice(API.length), o.body ? JSON.parse(o.body) : undefined, tok);
        return json(r.status, r.body);
      };
    },
  });
  opened.push(dom.window);
  await wait(250);
  const d = dom.window.document, w = dom.window;
  return { d, w, $: (s) => d.querySelector(s), text: (s) => [...d.querySelectorAll(s)].map((e) => e.textContent.trim()), submit: async (f) => { f.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); await wait(); } };
}
afterEach(() => { while (opened.length) opened.pop().close(); });
beforeEach(seed);

test('the week ahead, a card a day, each event with its calendar', async () => {
  google.events['kids@group.calendar.google.com'] = [{ id: 'k1', summary: 'Soccer', start: { dateTime: '2026-10-21T22:00:00Z' }, end: { dateTime: '2026-10-21T23:00:00Z' } }];
  google.events['luke.doty@gmail.com'] = [{ id: 'l1', summary: '<b>Dentist</b>', start: { dateTime: '2026-10-20T14:00:00Z' }, end: { dateTime: '2026-10-20T15:00:00Z' } }];
  const p = await open();
  assert.equal(p.text('.day').length, 2);
  assert.match(p.text('.day')[0], /Dentist.*Luke Doty/s);
  assert.equal(p.d.querySelectorAll('.day b').length, 0, 'titles are escaped');
  assert.match(p.text('.day')[1], /Soccer.*L&A Kids/s);
});

test('no admin section unless you’re an admin', async () => {
  const p = await open(token(AMBER));
  assert.equal(p.$('#admin').hidden, true);
});

test('admin: add a calendar by its embed link, give a person access, remove access', async () => {
  google.calendars['school@group.calendar.google.com'] = { summary: 'School', role: 'reader' };
  const p = await open(adminToken());
  p.$('#cal-alias').value = 'School';
  p.$('#cal-id').value = 'https://calendar.google.com/calendar/embed?src=school%40group.calendar.google.com&ctz=America%2FNew_York';
  await p.submit(p.$('#add-cal'));
  assert.equal(table.get('CAL', 'school').googleId, 'school@group.calendar.google.com');
  assert.match(p.text('[data-cal="school"]')[0], /school · School.*read-only for Dot/s);
  p.$('#g-cal').value = 'school';
  p.$('#g-who').value = `sub:${KID}`;
  await p.submit(p.$('#add-grant'));
  assert.deepEqual((await call('GET', '/calendars', undefined, token(KID))).body.map((c) => c.calendar), ['school']);
  const row = [...p.d.querySelectorAll('[data-grant]')].find((li) => li.textContent.includes('Kid'));
  row.querySelector('[data-del-grant]').click();
  await wait();
  assert.deepEqual((await call('GET', '/calendars', undefined, token(KID))).body, []);
});

test('admin: a calendar not shared with Dot is explained', async () => {
  const p = await open(adminToken());
  p.$('#cal-alias').value = 'secret';
  p.$('#cal-id').value = 'secret@group.calendar.google.com';
  await p.submit(p.$('#add-cal'));
  assert.match(p.text('#admin .status.warn')[0], /Share it with calendar-manager@/);
  assert.equal(table.get('CAL', 'secret'), undefined);
  assert.equal(LUKE.length, 36);
});
