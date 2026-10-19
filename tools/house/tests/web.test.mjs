import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { KID, LUKE, audit, call, familyGroup, relay, seed, table, token } from './helpers/house.mjs';

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

// ---- People & access ----

const admin = (p) => p.d.getElementById('admin');
const submit = async (p, id) => { p.d.getElementById(id).dispatchEvent(new p.w.Event('submit', { bubbles: true, cancelable: true })); await wait(120); };

test('only admins see People & access', async () => {
  table.put({ pk: 'GRANT', sk: 'g1', who: `sub:${KID}`, where: 'area:kitchen', level: 'control' });
  const p = await open({ groups: ['family_house'] });
  assert.equal(admin(p).hidden, true);
  assert.equal(admin(p).innerHTML, '');
  p.close();
});

test('an admin gives someone a room: it’s listed by name and takes effect', async () => {
  const p = await open();
  assert.equal(admin(p).querySelector('h2').textContent, 'People & access');
  p.d.getElementById('g-who').value = `sub:${KID}`;
  p.d.getElementById('g-where').value = 'area:kitchen';
  p.d.getElementById('g-level').value = 'control';
  await submit(p, 'add-grant');
  const [row] = [...admin(p).querySelectorAll('[data-grant]')];
  assert.equal(row.querySelector('span').textContent, 'kid@x.test · Kitchen · Can control');
  const [g] = table.dump().filter(([k]) => k.startsWith('GRANT')).map(([, v]) => v);
  assert.deepEqual([g.who, g.where, g.level], [`sub:${KID}`, 'area:kitchen', 'control']);
  row.querySelector('[data-del-grant]').click();
  await wait(120);
  assert.equal(admin(p).querySelectorAll('[data-grant]').length, 0);
  assert.equal(table.dump().filter(([k]) => k.startsWith('GRANT')).length, 0);
  p.close();
});

test('groups come from dot-y.co/family: grant one by name, see it listed', async () => {
  familyGroup('gkids00001', 'Kids', [KID]);
  const p = await open();
  assert.ok(admin(p).querySelector('a[href="https://dot-y.co/family"]'));
  p.d.getElementById('g-who').value = 'group:gkids00001';
  p.d.getElementById('g-where').value = 'area:kitchen';
  await submit(p, 'add-grant');
  assert.equal(admin(p).querySelector('[data-grant] span').textContent, 'Group “Kids” · Kitchen · Can see');
  assert.equal(table.dump().filter(([k]) => k.startsWith('GRANT')).map(([, v]) => v.who)[0], 'group:gkids00001');
  p.close();
});

test('recent activity says who did what, and what wasn’t allowed', async () => {
  table.put({ pk: 'GRANT', sk: 'g1', who: `sub:${KID}`, where: 'area:kitchen', level: 'control' });
  await call('POST', '/commands', { entity_id: 'light.kitchen_main', action: 'turn_off' }, token({ sub: KID }));
  await call('POST', '/commands', { entity_id: 'light.master_bedroom_main', action: 'turn_off' }, token({ sub: KID, clientId: 'house-via-dot', via: 'dot' }));
  const p = await open();
  const items = [...admin(p).querySelectorAll('.log li')];
  assert.deepEqual(items.map((li) => li.querySelector('.what').textContent), ['kid@x.test turned off master bedroom main — not allowed', 'kid@x.test turned off kitchen main']);
  assert.match(items[0].querySelector('small').textContent, /through Dot/);
  p.close();
});

// ---- automations ----

const auto = (sk, over = {}) => table.put({
  pk: 'AUTO', sk, name: 'Kitchen mornings', when: { at: '06:00' }, days: ['mon', 'tue', 'wed', 'thu', 'fri'],
  actions: [{ entity_id: 'light.kitchen_main', action: 'turn_on', data: { brightness_pct: 80 } }], enabled: true, owner: LUKE, rev: 1, ...over,
});

test('automations: what each does, whether it runs, pause and delete', async () => {
  auto('auto000001');
  auto('auto000002', { name: '<b>Porch</b>', when: { sun: 'sunset', offset: -15 }, enabled: false });
  const p = await open({ sub: LUKE });
  assert.deepEqual(p.text('.autos strong'), ['<b>Porch</b>', 'Kitchen mornings'], 'escaped, by name');
  assert.deepEqual(p.text('.autos .says'), ['Every weekday 15 minutes before sunset: turn on kitchen main (80%)', 'Every weekday at 6:00 AM: turn on kitchen main (80%)']);
  assert.deepEqual(p.text('.autos small'), ['Paused', 'On · hasn’t run yet']);
  p.d.querySelector('li[data-auto="auto000001"] [data-pause]').click();
  await wait(120);
  assert.equal(table.get('AUTO', 'auto000001').enabled, false);
  assert.deepEqual(p.text('.autos small'), ['Paused', 'Paused']);
  assert.equal(p.d.querySelector('li[data-auto="auto000001"] [data-pause]').textContent, 'Resume');
  p.d.querySelector('li[data-auto="auto000002"] [data-del-auto]').click();
  await wait(120);
  assert.equal(p.w.asked, 'Delete “<b>Porch</b>”? It stops running.');
  assert.equal(table.get('AUTO', 'auto000002'), undefined);
  assert.deepEqual(p.text('.autos strong'), ['Kitchen mornings']);
});

test('automations: someone else’s shows whose it is and can’t be changed; one that can’t run says why', async () => {
  // The kid's own, made when they could control the kitchen; now they can only see it. Luke sees it, not as an admin
  table.put({ pk: 'GRANT', sk: 'grant1', who: `sub:${KID}`, where: 'area:kitchen', level: 'read' });
  table.put({ pk: 'GRANT', sk: 'grant2', who: `sub:${LUKE}`, where: 'area:kitchen', level: 'read' });
  auto('auto000001', { owner: KID });
  const p = await open({ sub: LUKE, groups: ['family_house'] });
  assert.deepEqual(p.text('.autos small'), ['Not running: kid@x.test can’t control kitchen main anymore · kid@x.test’s']);
  assert.equal(p.d.querySelector('.autos [data-pause]'), null);
  assert.equal(p.d.querySelector('.autos [data-del-auto]'), null);
});

test('automations: none yet says how to make one; their runs show in the activity log', async () => {
  let p = await open();
  assert.deepEqual(p.text('.autos small'), ['Nothing runs by itself yet.']);
  assert.match(p.d.getElementById('autos').textContent, /ask Dot: “Turn on the kitchen lights every weekday at 6.”/);
  p.close();
  auto('auto000001');
  table.put({ pk: 'RAN', sk: 'auto000001', at: new Date().toISOString(), ok: true, results: [] });
  const at = new Date().toISOString();
  table.put({ pk: `CMD#${at.slice(0, 10)}`, sk: `${at}#auto0000010`, who: LUKE, via: 'automation', automationName: 'Kitchen mornings', entity_id: 'light.kitchen_main', name: 'kitchen main', action: 'turn_on', data: { brightness_pct: 80 }, outcome: 'done' });
  p = await open({ sub: LUKE });
  assert.match(p.text('.autos small')[0], /^On · last ran /);
  assert.match(p.text('.log li')[0], /turned on kitchen main at 80%.*automation “Kitchen mornings”/);
});
