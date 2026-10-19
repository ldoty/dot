import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { KID, audit, call, relay, seed, table, token } from './helpers/house.mjs';

const HTML = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8').replace('<script src="family-auth.js"></script>', '');
const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const API = 'https://api.test';
const opened = []; // closed after every test, pass or fail, so a failure can't leave timers running

async function open({ groups = ['family_house', 'family_house:admin'], sub = KID, confirm = true } = {}) {
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: 'https://house.dot-y.co/', pretendToBeVisual: true,
    beforeParse(w) {
      const tok = token({ sub, groups });
      w.FamilyAuth = { init: async () => ({ email: 't' }), accessToken: async () => tok, autoLogin: () => false, login() {}, logout() {} };
      w.confirm = (q) => { w.asked = q; return confirm; };
      w.fetch = async (url, o = {}) => {
        const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
        if (url === 'config.json') return json(200, { apiUrl: API });
        const r = await call(o.method || 'GET', url.slice(API.length), o.body ? JSON.parse(o.body) : undefined, tok);
        return json(r.status, r.body);
      };
    },
  });
  opened.push(dom.window);
  await wait(80);
  const d = dom.window.document;
  const li = (id) => d.querySelector(`li[data-id="${id}"]`);
  return {
    w: dom.window, d, li,
    text: (sel) => [...d.querySelectorAll(sel)].map((e) => e.textContent.trim()),
    toggle: async (id, ms = 120) => { li(id).querySelector('[data-toggle]').click(); await wait(ms); },
    close: () => dom.window.close(),
  };
}

afterEach(() => { while (opened.length) opened.pop().close(); });

beforeEach(() => {
  seed();
  table.put({ ...table.get('ENTITY', 'light.kitchen_island_pendants'), name: '<b>Island</b>', state: 'unavailable' });
});

test('shows each room with switches, a dimmer’s brightness, and what isn’t responding', async () => {
  const p = await open();
  assert.deepEqual(p.text('.room h2'), ['Dining Room', 'Kitchen', 'Master Bedroom', 'Other']);
  assert.equal(p.li('light.kitchen_main').querySelector('[data-toggle]').getAttribute('aria-checked'), 'true');
  assert.equal(p.li('light.kitchen_main').querySelector('[data-dim]').value, '60');
  assert.equal(p.li('light.dining_room_main').querySelector('[data-dim]'), null, 'no slider while off');
  assert.equal(p.li('light.kitchen_island_pendants').querySelector('.state').textContent, 'Not responding');
  assert.equal(p.d.querySelectorAll('.room b').length, 0, 'names are escaped');
  assert.equal(p.text('.status')[0], 'Live from the house.');
  p.close();
});

test('a switch turns a light off through the house', async () => {
  const p = await open();
  await p.toggle('light.kitchen_main');
  assert.deepEqual(relay.sent.map((c) => [c.entity_id, c.action]), [['light.kitchen_main', 'turn_off']]);
  assert.equal(p.li('light.kitchen_main').querySelector('[data-toggle]').getAttribute('aria-checked'), 'false');
  p.close();
});

test('the slider sets brightness', async () => {
  const p = await open();
  const s = p.li('light.kitchen_main').querySelector('[data-dim]');
  s.value = '35';
  s.dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await wait(120);
  assert.deepEqual(relay.sent.map((c) => c.data), [{ brightness_pct: 35 }]);
  p.close();
});

test('read-only devices show their state, without controls', async () => {
  table.put({ pk: 'GRANT', sk: 'g1', who: `sub:${KID}`, where: 'area:kitchen', level: 'control' });
  table.put({ pk: 'GRANT', sk: 'g2', who: `sub:${KID}`, where: 'area:master_bedroom', level: 'read' });
  const p = await open({ groups: ['family_house'] });
  assert.deepEqual(p.text('.room h2'), ['Kitchen', 'Master Bedroom']);
  assert.ok(p.li('light.kitchen_main').querySelector('[data-toggle]'));
  assert.equal(p.li('light.master_bedroom_main').querySelector('[data-toggle]'), null);
  assert.equal(p.li('light.master_bedroom_main').querySelector('.state').textContent, 'On');
  p.close();
});

test('a confirm grant asks first; saying no sends nothing', async () => {
  table.put({ pk: 'GRANT', sk: 'g1', who: `sub:${KID}`, where: 'area:kitchen', level: 'confirm' });
  let p = await open({ groups: ['family_house'], confirm: false });
  await p.toggle('light.kitchen_main');
  assert.equal(p.w.asked, 'Turn off kitchen main?');
  assert.deepEqual(relay.sent, []);
  p.close();
  p = await open({ groups: ['family_house'], confirm: true });
  await p.toggle('light.kitchen_main');
  assert.deepEqual(relay.sent.map((c) => c.action), ['turn_off']);
  p.close();
});

test('says why a command didn’t work', async () => {
  relay.mode = 'silent';
  const p = await open();
  await p.toggle('light.kitchen_main', 600); // the API waits out the house first
  assert.equal(p.li('light.kitchen_main').querySelector('.err').textContent, 'The house didn’t answer. Try again.');
  assert.equal(p.li('light.kitchen_main').querySelector('[data-toggle]').getAttribute('aria-checked'), 'true', 'unchanged');
  assert.equal(audit()[0].outcome, 'timeout');
  p.close();
});

test('says so when nothing is shared, or the house is quiet', async () => {
  let p = await open({ groups: ['family_house'] });
  assert.match(p.text('.status').join(' '), /Nothing here is shared with you yet/);
  p.close();
  table.put({ pk: 'RELAY', sk: 'CONN', connectionId: null, lastSync: new Date(Date.now() - 20 * 60_000).toISOString() });
  p = await open();
  assert.match(p.text('.status.warn')[0], /last reported 20 minutes ago/);
  p.close();
});
