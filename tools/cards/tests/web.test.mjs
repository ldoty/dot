import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ISSUER, accessToken } from '../../../platform/tests/helpers/tokens.mjs';
import { fakeTable } from '../../../platform/tests/helpers/fake-table.mjs';
import { caller } from '../../../platform/tests/helpers/http.mjs';
import { createApi } from '../api/api.mjs';
import { ROUTES } from './helpers/routes.mjs';

const table = fakeTable();
const handler = createApi({
  db: DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' })), table: 'family-cards', group: 'lukes_cards', issuer: ISSUER,
  clientIds: ['cards-client'], now: () => new Date(), timeZone: 'America/New_York',
});
const call = caller(handler, ROUTES);
const token = () => accessToken({ clientId: 'cards-client', group: 'lukes_cards', sub: 'luke', username: 'luke' });

const HTML = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8').replace('<script src="family-auth.js"></script>', '');
const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const API = 'https://api.test';

async function open() {
  const spoken = [];
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: 'https://cards.dot-y.co/', pretendToBeVisual: true,
    beforeParse(w) {
      w.FamilyAuth = { init: async () => ({ email: 't' }), accessToken: async () => token(), autoLogin: () => false, login() {}, logout() {} };
      w.confirm = () => true;
      w.SpeechSynthesisUtterance = function (t) { this.text = t; };
      w.speechSynthesis = { speak: (u) => spoken.push(u.text), cancel() {} };
      w.fetch = async (url, o = {}) => {
        const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
        if (url === 'config.json') return json(200, { apiUrl: API });
        const r = await call(o.method || 'GET', url.slice(API.length), o.body ? JSON.parse(o.body) : undefined, token());
        return json(r.status, r.body);
      };
    },
  });
  await wait(100);
  const d = dom.window.document;
  const el = (sel) => { const e = d.querySelector(sel); if (!e) throw new Error(`missing ${sel}`); return e; };
  const submit = async (sel) => { el(sel).dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); await wait(); };
  const key = async (k) => { d.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true })); await wait(); };
  return { d, el, submit, key, spoken, click: async (sel) => { el(sel).click(); await wait(); }, close: () => dom.window.close() };
}

beforeEach(() => table.clear());

test('make a word deck, add a word, then spell it from hearing it', async () => {
  const p = await open();
  p.el('#newdeck').elements.name.value = 'Words';
  p.el('#newdeck').elements.kind.value = 'word';
  await p.submit('#newdeck');
  const f = p.el('#addcard').elements;
  f.word.value = 'pellucid';
  f.definition.value = 'clear; easy to understand';
  f.example.value = 'Her pellucid prose won praise.';
  await p.submit('#addcard');
  assert.match(p.d.body.textContent, /1 card/);

  await p.click('[data-study]');
  for (const box of p.d.querySelectorAll('#setup [name=mode]')) box.checked = box.value === 'spell';
  await p.submit('#setup');
  assert.deepEqual(p.spoken, ['pellucid'], 'it says the word');
  assert.match(p.el('.card .ex').textContent, /Her _____ prose/, 'the example doesn’t give it away');
  p.el('#typed').value = 'Pellucid ';
  await p.key('Enter');
  assert.equal(p.el('.right').textContent, 'Right');
  assert.ok(p.el('[data-grade="good"]').classList.contains('pick'));
  await p.key('3');
  assert.match(p.el('section h2').textContent, /Done/);
  const [c] = (await call('GET', `/decks/${(await call('GET', '/decks', undefined, token())).body[0].id}/cards`, undefined, token())).body;
  assert.equal(c.sched.spell.reps, 1);
  assert.equal(c.sched.meaning.seen, null, 'only the way studied');
  p.close();
});

test('a misspelling suggests Again, and the card comes back in the same session', async () => {
  const { body: d } = await call('POST', '/decks', { name: 'Words', kind: 'word' }, token());
  await call('POST', `/decks/${d.id}/cards`, { word: 'accommodate', definition: 'to make room for' }, token());
  const p = await open();
  await p.click(`[data-study="${d.id}"]`);
  for (const box of p.d.querySelectorAll('#setup [name=mode]')) box.checked = box.value === 'spell';
  await p.submit('#setup');
  p.el('#typed').value = 'acommodate';
  await p.click('[data-reveal]');
  assert.match(p.el('.wrong').textContent, /acommodate/);
  assert.ok(p.el('[data-grade="again"]').classList.contains('pick'));
  await p.key('Enter');
  assert.ok(p.d.querySelector('#typed'), 'again, straight away');
  assert.match(p.d.body.textContent, /1 card left/);
  p.close();
});

test('a basic card: show the answer, grade it', async () => {
  const { body: d } = await call('POST', '/decks', { name: 'Capitals' }, token());
  await call('POST', `/decks/${d.id}/cards`, { front: 'Capital of Peru?', back: 'Lima' }, token());
  const p = await open();
  await p.click(`[data-study="${d.id}"]`);
  await p.submit('#setup');
  assert.match(p.el('.card').textContent, /Capital of Peru\?/);
  assert.doesNotMatch(p.el('.card').textContent, /Lima/);
  await p.key(' ');
  assert.match(p.el('.card').textContent, /Lima/);
  await p.click('[data-grade="easy"]');
  assert.match(p.d.body.textContent, /1 review/);
  p.close();
});

test('card text is shown as text', async () => {
  const { body: d } = await call('POST', '/decks', { name: '<b>x</b>' }, token());
  await call('POST', `/decks/${d.id}/cards`, { front: '<img src=x onerror=alert(1)>', back: 'a' }, token());
  const p = await open();
  assert.equal(p.d.querySelector('li img'), null);
  await p.click(`[data-deck="${d.id}"]`);
  assert.equal(p.d.querySelector('li img'), null);
  assert.match(p.el('li strong').textContent, /<img/);
  p.close();
});
