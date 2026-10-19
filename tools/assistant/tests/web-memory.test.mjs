// The page's "What Dot knows" view, against the real handler and notes on the fake table
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { ISSUER, accessToken } from '../../../platform/tests/helpers/tokens.mjs';
import { createHandler } from '../api/handler.mjs';
import { makeNotes } from '../api/memory.mjs';
import { db, store, table } from './helpers/deps.mjs';

const HTML = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8').replace('<script src="family-auth.js"></script>', '');
const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const API = 'https://fn.test';
const LUKE = 'luke-sub', AMBER = 'amber-sub';
const notes = makeNotes({ db, table: 'lukes-assistant' });
const handle = createHandler({ auth: { issuer: ISSUER, clientId: 'assistant-client', group: 'family_assistant' }, store, notes });
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
