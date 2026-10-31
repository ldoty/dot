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

const LUKE = '44f8c468-4011-70b8-76aa-ec2b68b0b004';
const table = fakeTable();
const handler = createApi({
  db: DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' })), table: 'family-otto', group: 'lukes_otto', issuer: ISSUER,
  clientIds: ['otto-client', 'otto-dot'], dotClientId: 'otto-dot', now: () => new Date(), timeZone: 'America/New_York',
});
const call = caller(handler, [
  'GET /dot', 'GET /status', 'GET /commands', 'POST /commands', 'POST /commands/{id}/approve', 'DELETE /commands/{id}',
  'GET /schedules', 'POST /schedules', 'PATCH /schedules/{id}', 'DELETE /schedules/{id}', 'GET /sent',
]);
const page = () => accessToken({ clientId: 'otto-client', group: 'lukes_otto', sub: LUKE, username: LUKE });
const delegated = () => accessToken({ clientId: 'otto-dot', group: 'lukes_otto', sub: LUKE, username: LUKE, via: 'dot' });

const HTML = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8').replace('<script src="family-auth.js"></script>', '');
const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const API = 'https://api.test';

async function open() {
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: 'https://otto.dot-y.co/', pretendToBeVisual: true,
    beforeParse(w) {
      w.FamilyAuth = { init: async () => ({ email: 't' }), accessToken: async () => page(), autoLogin: () => false, login() {}, logout() {} };
      w.confirm = () => true;
      w.fetch = async (url, o = {}) => {
        const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
        if (url === 'config.json') return json(200, { apiUrl: API });
        const r = await call(o.method || 'GET', url.slice(API.length), o.body ? JSON.parse(o.body) : undefined, page());
        return json(r.status, r.body);
      };
    },
  });
  await wait(100);
  const d = dom.window.document;
  const el = (sel) => { const e = d.querySelector(sel); if (!e) throw new Error(`missing ${sel}`); return e; };
  const submit = async (sel) => { el(sel).dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); await wait(); };
  return { d, el, submit, click: async (sel) => { el(sel).click(); await wait(); }, close: () => dom.window.close() };
}

beforeEach(() => table.clear());

test('queue a command from the page', async () => {
  const p = await open();
  assert.match(p.el('.meta').textContent, /hasn’t checked in yet/);
  p.el('#prompt').value = 'Archive the Houzz mail';
  await p.submit('#stage');
  const { body } = await call('GET', '/commands', undefined, page());
  assert.deepEqual(body.map((c) => [c.prompt, c.status]), [['Archive the Houzz mail', 'queued']]);
  assert.match(p.el('li .chip').textContent, /Queued/);
  p.close();
});

test('a command staged through Dot or Claude Code waits here for Approve', async () => {
  const staged = await call('POST', '/commands', { prompt: 'Brief me now' }, delegated());
  const p = await open();
  assert.match(p.d.body.textContent, /Waiting for your OK/);
  await p.click(`[data-approve="${staged.body.command_id}"]`);
  assert.equal(table.get('CMD', staged.body.command_id).status, 'queued');
  p.close();
});

test('add, pause and delete a schedule', async () => {
  const p = await open();
  const f = p.el('#sched').elements;
  f.name.value = 'Daily brief';
  f.time.value = '06:00';
  f.rule.value = 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
  f.prompt.value = 'Brief me on the inbox';
  await p.submit('#sched');
  let [s] = (await call('GET', '/schedules', undefined, page())).body;
  assert.deepEqual([s.name, s.time, s.repeat.rule, s.status], ['Daily brief', '06:00', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'on']);
  await p.click(`[data-pause="${s.id}"]`);
  [s] = (await call('GET', '/schedules', undefined, page())).body;
  assert.equal(s.status, 'paused');
  await p.click(`[data-delsched="${s.id}"]`);
  assert.deepEqual((await call('GET', '/schedules', undefined, page())).body, []);
  p.close();
});

test('a result shows what Otto said, as text', async () => {
  table.put({ pk: 'CMD', sk: 'c00000001aaaaaaaa', prompt: 'Brief', source: 'schedule', status: 'done', createdAt: new Date().toISOString(), result: '<img src=x onerror=alert(1)> 3 things', rev: 2 });
  const p = await open();
  assert.equal(p.el('details pre').textContent, '<img src=x onerror=alert(1)> 3 things');
  assert.equal(p.d.querySelector('details pre img'), null);
  p.close();
});
