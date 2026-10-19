// The page's "What Dot knows" view, against the real handler and notes on the fake table
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { ISSUER, accessToken } from '../../../platform/tests/helpers/tokens.mjs';
import { createHandler } from '../api/handler.mjs';
import { makeNotes } from '../api/memory.mjs';
import { makeSchedules } from '../api/schedules.mjs';
import { db, store, table } from './helpers/deps.mjs';

const HTML = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8').replace('<script src="family-auth.js"></script>', '');
const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const API = 'https://fn.test';
const LUKE = 'luke-sub', AMBER = 'amber-sub';
const notes = makeNotes({ db, table: 'lukes-assistant' });
const schedules = makeSchedules({ db, table: 'lukes-assistant', now: () => new Date('2026-10-19T16:00:00Z') });
const handle = createHandler({ auth: { issuer: ISSUER, clientId: 'assistant-client', group: 'family_assistant' }, store, notes, schedules });
const opened = [];

async function open({ sub = LUKE, admin = false, confirm = true } = {}) {
  const tok = accessToken({ clientId: 'assistant-client', sub, 'cognito:groups': admin ? ['family_assistant', 'family_assistant:admin'] : ['family_assistant'] });
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: 'https://assistant.dot-y.co/#memory', pretendToBeVisual: true,
    beforeParse(w) {
      w.FamilyAuth = { init: async () => ({ email: 't' }), accessToken: async () => tok, autoLogin: () => false, login() {}, logout() {} };
      w.confirm = () => confirm;
      w.fetch = async (url, o = {}) => {
        if (url === 'config.json') return { ok: true, status: 200, json: async () => ({ apiUrl: API }) };
        const res = { chunks: [] };
        await handle({ rawPath: url.slice(API.length), requestContext: { http: { method: o.method || 'GET' } }, headers: { authorization: o.headers.authorization }, body: o.body },
          (status) => { res.status = status; return { write: (c) => res.chunks.push(c), end() {} }; });
        return { ok: res.status < 300, status: res.status, json: async () => JSON.parse(res.chunks.join('')) };
      };
    },
  });
  opened.push(dom.window);
  await wait(120);
  const d = dom.window.document;
  return { d, w: dom.window, notes: () => [...d.querySelectorAll('.note')], section: (i) => d.querySelectorAll('.memory .card')[i] };
}
afterEach(() => { while (opened.length) opened.pop().close(); });
beforeEach(async () => {
  table.clear();
  await notes.save('personal', LUKE, { title: 'Daytime', body: 'Turn on all the lights.' }, { by: LUKE, byName: 'Luke', source: { channel: 'sms', conversationId: 'c1' } });
  await notes.save('household', LUKE, { title: 'Dentist', body: 'Dr. Patel.' }, { by: LUKE, byName: 'Luke', source: { channel: 'web', conversationId: 'c2' } });
});

test('shows your own notes and the household’s, with where each came from', async () => {
  const p = await open();
  assert.equal(p.d.querySelector('.memory h2').textContent, 'What Dot knows');
  assert.equal(p.section(0).querySelector('strong').textContent, 'Daytime');
  assert.match(p.section(0).querySelector('small').textContent, /From Luke · by text/);
  assert.equal(p.section(1).querySelector('strong').textContent, 'Dentist');
  assert.ok(p.d.querySelector('.chat').classList.contains('notes-open'), 'the composer is hidden');
});

test('someone else sees the household’s notes, not yours, and can’t edit the household’s', async () => {
  const p = await open({ sub: AMBER });
  assert.match(p.section(0).textContent, /Nothing yet/);
  assert.equal(p.section(1).querySelector('strong').textContent, 'Dentist');
  assert.equal(p.section(1).querySelector('[data-edit-note]'), null);
});

test('edit your own note', async () => {
  const p = await open();
  p.section(0).querySelector('[data-edit-note]').click();
  await wait();
  const f = p.d.querySelector('[data-save-note]');
  f.querySelector('textarea').value = 'All lights on, except the master bedroom.';
  f.dispatchEvent(new p.w.Event('submit', { bubbles: true, cancelable: true }));
  await wait(120);
  assert.equal(p.section(0).querySelector('p').textContent, 'All lights on, except the master bedroom.');
  assert.equal((await notes.forPerson(LUKE)).personal[0].body, 'All lights on, except the master bedroom.');
});

test('an admin deletes a household note', async () => {
  const p = await open({ admin: true });
  p.section(1).querySelector('[data-del-note]').click();
  await wait(120);
  assert.match(p.section(1).textContent, /Nothing yet/);
  assert.deepEqual((await notes.forPerson(LUKE)).household, []);
});

// ---- scheduled asks ----

const SUNDAY = { title: 'Sunday budget', ask: 'Give me an overview of this month’s budget.', time: '13:00', repeat: { rule: 'FREQ=WEEKLY;BYDAY=SU', tz: 'America/New_York', start: '2026-10-19', n: 0 }, by: 'sms' };

test('your scheduled asks show under What Dot knows, with when they run; delete one', async () => {
  await schedules.create(LUKE, SUNDAY, { via: 'sms' });
  await schedules.create(AMBER, { ...SUNDAY, title: 'Amber’s' }, { via: 'sms' });
  const p = await open();
  const card = p.section(2);
  assert.equal(card.querySelector('h3').textContent, 'Scheduled for you');
  assert.deepEqual([...card.querySelectorAll('strong')].map((e) => e.textContent), ['Sunday budget'], 'only your own');
  assert.equal(card.querySelector('p').textContent, 'Every Sunday at 1:00 PM, by text: “Give me an overview of this month’s budget.”');
  assert.match(card.querySelector('small').textContent, /^Not sent yet · next Sun, Oct 25, 1:00 PM$/);
  card.querySelector('[data-del-sched]').click();
  await wait(120);
  assert.deepEqual(await schedules.list(LUKE), []);
  assert.equal((await schedules.list(AMBER)).length, 1);
  assert.match(p.section(2).textContent, /Nothing yet. Ask Dot: “Text me a budget overview every Sunday at 1.”/);
});

test('you can’t delete someone else’s scheduled ask', async () => {
  const theirs = await schedules.create(AMBER, SUNDAY, { via: 'sms' });
  const tok = accessToken({ clientId: 'assistant-client', sub: LUKE, 'cognito:groups': ['family_assistant', 'family_assistant:admin'] });
  const res = {};
  await handle({ rawPath: `/schedules/${theirs.id}`, requestContext: { http: { method: 'DELETE' } }, headers: { authorization: `Bearer ${tok}` } },
    (status) => { res.status = status; return { write() {}, end() {} }; });
  assert.equal(res.status, 404, 'not even an admin');
  assert.equal((await schedules.list(AMBER)).length, 1);
});
