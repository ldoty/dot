import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { accessToken } from '../../../platform/tests/helpers/tokens.mjs';
import { CLIENT_ID, call, cfgRecord, clock, memberToken, post, reading, table } from './helpers/chamber.mjs';

const HTML = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8').replace('<script src="family-auth.js"></script>', '');
const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const API = 'https://api.test';

// Closes itself when the test ends, pass or fail: the page's polling timers would keep node alive
async function open(t, { token = memberToken } = {}) {
  const requests = [];
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: 'https://chamber.dot-y.co/', pretendToBeVisual: true,
    beforeParse(w) {
      w.FamilyAuth = { init: async () => ({ email: 't' }), accessToken: async () => token(), autoLogin: () => false, login() {}, logout() {} };
      w.fetch = async (url, o = {}) => {
        const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
        if (url === 'config.json') return json(200, { apiUrl: API });
        const path = url.slice(API.length);
        requests.push(`${o.method || 'GET'} ${path.split('?')[0]}`);
        const r = await call(o.method || 'GET', path, o.body ? JSON.parse(o.body) : undefined, token());
        return json(r.status, r.body);
      };
    },
  });
  t.after(() => dom.window.close());
  await wait(120);
  const d = dom.window.document;
  const el = (sel) => { const e = d.querySelector(sel); if (!e) throw new Error(`missing ${sel}`); return e; };
  return { d, el, w: dom.window, requests };
}

beforeEach(() => table.clear());

// The board posting a reading a few seconds ago, optionally with its settings
async function boardSays(fields = {}, cfg) {
  clock.now = new Date(Date.now() - 5000);
  await post(cfg ? `${reading(fields)}\n${cfgRecord(cfg)}` : reading(fields));
}

test('shows the latest reading as tiles, with charts', async (t) => {
  clock.now = new Date(Date.now() - 15000);
  await post(reading({ rh_pct: 84.2, mist_bursts: 3 }));
  await boardSays({ rh_pct: 86.4, temp_c: 23.9, mist_state: 4, mist_bursts: 4, dewpoint_c: 21.5, fan_rpm: 340, light_duty_pct: 25 });
  const p = await open(t);
  const tiles = [...p.d.querySelectorAll('.tile')].map((t) => t.textContent);
  assert.ok(tiles.includes('RH86.4% in band'), tiles.join(' | '));
  assert.ok(tiles.includes('Temp23.9°C'));
  assert.ok(tiles.includes('Statemist settle'));
  assert.match(p.el('#status').textContent, /^last reading \d+ s ago/);
  assert.equal(p.d.querySelectorAll('.panel svg').length, 6, 'state lanes + one chart per measure');
  assert.equal(p.d.querySelectorAll('#table tr').length, 3, 'header + two readings, newest first');
});

test('water: shows the count, takes a refill once confirmed, and says when the board has it', async (t) => {
  await boardSays({ mist_ml: 288.01, mist_budget_ml: 750, refill_id: 0 });
  const p = await open(t);
  assert.match(p.el('#water').textContent, /about 288 of 750 mL/);
  p.w.confirm = () => false;
  p.el('#refill').click();
  await wait();
  assert.ok(!p.requests.includes('POST /refill'), 'nothing without confirming');
  p.w.confirm = () => true;
  p.el('#refill').click();
  await wait();
  assert.equal(table.get('STATE', 'REFILL').id, 1);
  assert.match(p.el('#water').textContent, /^Refill noted/);
  assert.equal(p.d.querySelector('#refill'), null);
});

test('water: says why misting stopped, and stays quiet for firmware without the count', async (t) => {
  await boardSays({ mist_ml: 750.5, mist_budget_ml: 750, refill_id: 3, mist_block: 1 });
  let p = await open(t);
  assert.match(p.el('#water').textContent, /^Misting stopped: the water count reached 750 mL/);
  assert.ok(p.el('#water').classList.contains('bad'));
  table.clear();
  await boardSays({ mist_ml: 100 });
  p = await open(t);
  assert.ok(p.el('#water').hidden);
});

test('says so when there are no readings, and flags stale ones', async (t) => {
  let p = await open(t);
  assert.match(p.el('#status').textContent, /No readings/);
  assert.match(p.el('#charts').textContent, /Waiting for the first reading/);
  clock.now = new Date(Date.now() - 10 * 60e3);
  await post(reading());
  p = await open(t);
  assert.match(p.el('#status').textContent, /^Stale: last reading 10 min ago/);
  assert.ok(p.el('#status').classList.contains('stale'));
});

test('settings: shows what the board runs, saves an edit, and shows it pending', async (t) => {
  await boardSays({}, { version: 0 });
  const p = await open(t);
  assert.equal(p.el('#cfgBadge').textContent, 'Running firmware defaults');
  assert.equal(p.el('#cfg_mist_burst_s').value, '20');
  assert.ok(p.el('#cfgSave').disabled);

  const input = p.el('#cfg_mist_burst_s');
  input.value = '30';
  input.dispatchEvent(new p.w.Event('input', { bubbles: true }));
  assert.equal(p.el('#cfgSave').textContent, 'Apply 1 change to chamber');
  p.el('#cfgForm').dispatchEvent(new p.w.Event('submit', { bubbles: true, cancelable: true }));
  await wait();
  assert.equal(table.get('STATE', 'DESIRED').values.mist_burst_s, 30);
  assert.match(p.el('#cfgMsg').textContent, /^Saved as v1\./);
  assert.match(p.el('#cfgBadge').textContent, /^v1 pending/);
  assert.ok(p.el('#cfgSave').disabled, 'edits cleared');
});

test('settings: a refused value shows the reason and keeps the edit', async (t) => {
  await boardSays({}, { version: 0 });
  const p = await open(t);
  const input = p.el('#cfg_mist_burst_s');
  input.value = '90';
  input.dispatchEvent(new p.w.Event('input', { bubbles: true }));
  p.el('#cfgForm').dispatchEvent(new p.w.Event('submit', { bubbles: true, cancelable: true }));
  await wait();
  assert.match(p.el('#cfgMsg').textContent, /Mist burst \(max\): must be 5–60 s/);
  assert.ok(p.el('#cfgMsg').classList.contains('bad'));
  assert.equal(table.get('STATE', 'DESIRED'), undefined);
  assert.equal(p.el('#cfgSave').disabled, false);
});

test('settings: shows when the board refused a version', async (t) => {
  await call('PUT', '/settings', { values: { rh_on: 86 } });
  await boardSays({}, { version: 0, rejected: 1 });
  const p = await open(t);
  assert.equal(p.el('#cfgBadge').textContent, 'The board refused v1, still running v0');
});

test('someone outside lukes_chamber is told so, and nothing else loads', async (t) => {
  const p = await open(t, { token: () => accessToken({ clientId: CLIENT_ID, group: 'family_budget' }) });
  assert.match(p.el('#main').textContent, /doesn’t have access to Chamber/);
  assert.deepEqual(p.requests, ['GET /settings']);
});
