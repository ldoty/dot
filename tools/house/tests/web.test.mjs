import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { ISSUER, accessToken } from '../../../platform/tests/helpers/tokens.mjs';
import { fakeTable } from '../../../platform/tests/helpers/fake-table.mjs';
import { caller } from '../../../platform/tests/helpers/http.mjs';

Object.assign(process.env, { TABLE: 'family-house', GROUP: 'family_house', ISSUER, CLIENT_ID: 'house-client', DOT_CLIENT_ID: 'house-via-dot' });
const table = fakeTable();
const { handler } = await import('../api/api.mjs');
const call = caller(handler, ['GET /home', 'GET /dot']);

const HTML = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8').replace('<script src="family-auth.js"></script>', '');
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const API = 'https://api.test';
const KID = '11111111-1111-1111-1111-111111111111';

async function open(groups = ['family_house', 'family_house:admin'], sub = KID) {
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: 'https://house.dot-y.co/', pretendToBeVisual: true,
    beforeParse(w) {
      const tok = accessToken({ clientId: 'house-client', sub, 'cognito:groups': groups });
      w.FamilyAuth = { init: async () => ({ email: 't' }), accessToken: async () => tok, autoLogin: () => false, login() {}, logout() {} };
      w.fetch = async (url, o = {}) => {
        const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
        if (url === 'config.json') return json(200, { apiUrl: API });
        const r = await call(o.method || 'GET', url.slice(API.length), undefined, tok);
        return json(r.status, r.body);
      };
    },
  });
  await wait(80);
  const d = dom.window.document;
  return { d, text: (sel) => [...d.querySelectorAll(sel)].map((e) => e.textContent.trim()), close: () => dom.window.close() };
}

beforeEach(() => {
  table.clear();
  table.put({ pk: 'AREA', sk: 'kitchen', name: 'Kitchen' });
  table.put({ pk: 'AREA', sk: 'master_bedroom', name: 'Master Bedroom' });
  table.put({ pk: 'ENTITY', sk: 'light.kitchen_main', name: 'Kitchen Main Lights', area: 'kitchen', domain: 'light', state: 'on', attrs: { brightness: 153 }, updated: 'x' });
  table.put({ pk: 'ENTITY', sk: 'light.master_bedroom_main', name: 'Master Bedroom Main Lights', area: 'master_bedroom', domain: 'light', state: 'off', attrs: {}, updated: 'x' });
  table.put({ pk: 'ENTITY', sk: 'light.kitchen_island_pendants', name: '<b>Island</b>', area: 'kitchen', domain: 'light', state: 'unavailable', attrs: {}, updated: 'x' });
  table.put({ pk: 'RELAY', sk: 'CONN', connectionId: 'c1', lastSync: new Date().toISOString() });
});

test('shows each room with its lights and their state', async () => {
  const p = await open();
  assert.deepEqual(p.text('.room h2'), ['Kitchen', 'Master Bedroom']);
  assert.deepEqual(p.text('.room li .state'), ['Not responding', 'On · 60%', 'Off']);
  assert.equal(p.text('.status')[0], 'Live from the house.');
  assert.equal(p.d.querySelectorAll('.room b').length, 0, 'names are escaped');
  p.close();
});

test('a member sees only rooms they’ve been granted', async () => {
  table.put({ pk: 'GRANT', sk: 'g1', who: `sub:${KID}`, where: 'area:kitchen', level: 'read' });
  const p = await open(['family_house']);
  assert.deepEqual(p.text('.room h2'), ['Kitchen']);
  p.close();
});

test('says so when nothing is shared, or the house is quiet', async () => {
  let p = await open(['family_house']);
  assert.match(p.text('.status').join(' '), /Nothing here is shared with you yet/);
  p.close();
  table.put({ pk: 'RELAY', sk: 'CONN', connectionId: null, lastSync: new Date(Date.now() - 20 * 60_000).toISOString() });
  p = await open();
  assert.match(p.text('.status.warn')[0], /last reported 20 minutes ago/);
  p.close();
});
