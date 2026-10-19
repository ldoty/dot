import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { AMBER, KID, LUKE, call, familyGroup, newList, reset, table, token } from './helpers/lists.mjs';

const HTML = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8').replace('<script src="family-auth.js"></script>', '');
const API = 'https://api.test';
const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms));
const opened = [];

async function open(sub = LUKE, hash = '') {
  const tok = token(sub);
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: `https://lists.dot-y.co/${hash}`, pretendToBeVisual: true,
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
  await wait(200);
  const d = dom.window.document, w = dom.window;
  const $ = (sel) => { const e = d.querySelector(sel); if (!e) throw new Error(`missing ${sel}`); return e; };
  return {
    d, w, $,
    text: (sel) => [...d.querySelectorAll(sel)].map((e) => e.textContent.trim()),
    submit: async (form) => { form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); await wait(); },
    change: async (el) => { el.dispatchEvent(new w.Event('change', { bubbles: true })); await wait(); },
    go: async (hashTo) => { w.location.hash = hashTo; await wait(250); },
  };
}
afterEach(() => { while (opened.length) opened.pop().close(); });
beforeEach(reset);

const items = (listId) => table.dump().filter(([k]) => k.startsWith(`ITEMS#${listId}|`)).map(([, v]) => v);

test('start a list from home, then add and tick off items', async () => {
  const p = await open();
  assert.match(p.text('.status').join(' '), /No lists yet/);
  p.$('#new-name').value = 'Groceries';
  await p.submit(p.$('#new-list'));
  await wait(150);
  assert.equal(p.$('h1').textContent, 'Groceries');
  for (const t of ['Milk', 'Eggs']) {
    p.$('[data-add] input').value = t;
    await p.submit(p.$('[data-add]'));
  }
  assert.deepEqual(p.text('.items [data-open] span:first-child'), ['Milk', 'Eggs']);
  const box = p.d.querySelector('[data-item] [data-done]');
  box.checked = true;
  await p.change(box);
  assert.deepEqual(p.text('section .items [data-open] span:first-child'), ['Eggs']);
  assert.match(p.$('details summary').textContent, /Done \(1\)/);
});

test('matrix: adding to a quadrant sets urgent and important', async () => {
  const l = await newList('Work', LUKE, { layout: 'matrix' });
  const p = await open(LUKE, `#l=${l.id}`);
  assert.deepEqual(p.text('.quad h3'), ['Do now', 'Schedule', 'Delegate', 'Drop']);
  p.$('[data-add="schedule"] input').value = 'Plan the year';
  await p.submit(p.$('[data-add="schedule"]'));
  const [i] = items(l.id);
  assert.deepEqual([i.urgent, i.important], [false, true]);
  assert.deepEqual(p.text('.quad:nth-child(2) [data-open] span:first-child'), ['Plan the year']);
});

test('board: adding to a column; switching layouts keeps the items', async () => {
  const l = await newList('Garage', LUKE, { layout: 'board' });
  const p = await open(LUKE, `#l=${l.id}`);
  p.$('[data-add="Doing"] input').value = 'Shelves';
  await p.submit(p.$('[data-add="Doing"]'));
  assert.equal(items(l.id)[0].column, 'Doing');
  p.$('[data-layout="checklist"]').click();
  await wait(200);
  assert.equal(table.get('LIST', l.id).layout, 'checklist');
  assert.deepEqual(p.text('[data-open] span:first-child'), ['Shelves']);
});

test('set a reminder on an item: it’s saved for the sweep', async () => {
  const l = await newList('Errands');
  await call('PUT', `/lists/${l.id}/items/i00001`, { text: 'Call the dentist' });
  const p = await open(LUKE, `#l=${l.id}`);
  p.$('[data-open]').click();
  await wait(50);
  p.$('[name="remind"]').value = '2026-10-20T09:00';
  p.$('[name="channel"]').value = 'email';
  await p.submit(p.$('[data-save]'));
  const [i] = items(l.id);
  assert.deepEqual([i.remind.at, i.remind.channel, i.remind.to], [new Date('2026-10-20T09:00').toISOString(), 'email', LUKE]);
  assert.equal(table.dump().filter(([k]) => k.startsWith('REMIND#')).length, 1);
  assert.match(p.$('[data-open] .meta').textContent, /🔔/);
});

test('a list shared to see: no adding, no ticking, no settings', async () => {
  const l = await newList('Plans');
  await call('PUT', `/lists/${l.id}/items/i00001`, { text: 'Paint' });
  await call('PUT', `/lists/${l.id}`, { name: 'Plans', layout: 'checklist', columns: l.columns, share: [{ who: `sub:${AMBER}`, level: 'read' }], rev: 1 });
  const p = await open(AMBER, `#l=${l.id}`);
  assert.equal(p.d.querySelector('[data-add]'), null);
  assert.equal(p.$('[data-done]').disabled, true);
  assert.equal(p.d.getElementById('settings'), null);
  assert.match(p.text('.meta').join(' '), /Shared with you to see/);
});

test('the owner shares with a person or a family group', async () => {
  familyGroup('gkids00001', 'Kids', [KID]);
  const l = await newList('Chores');
  const p = await open(LUKE, `#l=${l.id}`);
  const form = p.$('[data-share]');
  form.querySelector('[name="who"]').value = 'group:gkids00001';
  await p.submit(form);
  assert.deepEqual(table.get('LIST', l.id).share, [{ who: 'group:gkids00001', level: 'edit' }]);
  assert.match(p.text('.shares li').join(' '), /Group “Kids” · can edit/);
  assert.equal((await call('GET', '/lists', undefined, token(KID))).body.length, 1);
});

test('reminder preference on the home page', async () => {
  const p = await open();
  p.$('#pref').value = 'email';
  await p.change(p.$('#pref'));
  assert.equal(table.get('PREF', LUKE).channel, 'email');
});

test('every item has a visible Details button that opens due date and reminder', async () => {
  const l = await newList('Errands');
  await call('PUT', `/lists/${l.id}/items/i00001`, { text: 'Call the dentist' });
  const p = await open(LUKE, `#l=${l.id}`);
  const more = p.$('[data-item] .more');
  assert.equal(more.textContent, 'Details');
  more.click();
  await wait(50);
  assert.equal(p.$('[data-item] .more').getAttribute('aria-expanded'), 'true', 'redrawn open');
  assert.ok(p.$('[data-save] [name="due"]'));
  assert.ok(p.$('[data-save] [name="remind"]'));
});

// ---- repeating ----

async function openDetails(p) { p.$('[data-item] .more').click(); await wait(50); }
const select = async (p, name, value) => { const el = p.$(`[data-save] [name="${name}"]`); el.value = value; el.dispatchEvent(new p.w.Event('change', { bubbles: true })); await wait(20); };

test('repeat every week from the page, with its reminder; shown in words', async () => {
  const l = await newList('Health');
  await call('PUT', `/lists/${l.id}/items/i00001`, { text: 'Pills', remind: { at: '2026-10-20T13:00:00Z' } });
  const p = await open(LUKE, `#l=${l.id}`);
  await openDetails(p);
  assert.equal(p.$('[data-when]').hidden, true, 'no repeat options until a repeat is picked');
  await select(p, 'preset', 'weekly');
  assert.equal(p.$('[data-when]').hidden, false);
  await p.submit(p.$('[data-save]'));
  const [i] = items(l.id);
  assert.deepEqual([i.repeat.rule, i.repeat.mode, i.repeat.start], ['FREQ=WEEKLY', 'when_done', '2026-10-20']);
  assert.match(p.$('[data-open] .meta').textContent, /↻ every week/);
});

test('custom: every other Tuesday, on schedule, ending after 10 times', async () => {
  const l = await newList('House');
  await call('PUT', `/lists/${l.id}/items/i00001`, { text: 'Recycling out', remind: { at: '2026-10-20T23:00:00Z' } });
  const p = await open(LUKE, `#l=${l.id}`);
  await openDetails(p);
  await select(p, 'preset', 'custom');
  p.$('[data-save] [name="interval"]').value = '2';
  await select(p, 'freq', 'WEEKLY');
  p.$('[data-save] [name="day"][value="TU"]').checked = true;
  await select(p, 'mode', 'schedule');
  await select(p, 'ends', 'count');
  assert.equal(p.$('[data-save] [name="count"]').hidden, false);
  p.$('[data-save] [name="count"]').value = '10';
  await p.submit(p.$('[data-save]'));
  const [i] = items(l.id);
  assert.deepEqual([i.repeat.rule, i.repeat.mode], ['FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;COUNT=10', 'schedule']);
  assert.match(p.$('[data-open] .meta').textContent, /↻ every other Tuesday, 10 times/);
});

test('custom monthly: the last Friday; reopening shows what’s set', async () => {
  const l = await newList('Bills');
  await call('PUT', `/lists/${l.id}/items/i00001`, { text: 'Card payment', due: '2026-10-30' });
  let p = await open(LUKE, `#l=${l.id}`);
  await openDetails(p);
  await select(p, 'preset', 'custom');
  await select(p, 'freq', 'MONTHLY');
  await select(p, 'monthly', '-1FR');
  await p.submit(p.$('[data-save]'));
  assert.equal(items(l.id)[0].repeat.rule, 'FREQ=MONTHLY;BYDAY=-1FR');
  p = await open(LUKE, `#l=${l.id}`);
  await openDetails(p);
  assert.deepEqual([p.$('[name="preset"]').value, p.$('[name="freq"]').value, p.$('[name="monthly"]').value], ['custom', 'MONTHLY', '-1FR']);
});

test('ticking off a repeating item on the page moves it to next time', async () => {
  const l = await newList('Bills');
  await call('PUT', `/lists/${l.id}/items/i00001`, { text: 'Rent', due: '2026-11-01', repeat: { rule: 'FREQ=MONTHLY', mode: 'when_done', tz: 'America/New_York' } });
  const p = await open(LUKE, `#l=${l.id}`);
  const box = p.$('[data-item] [data-done]');
  box.checked = true;
  await p.change(box);
  const [i] = items(l.id);
  assert.deepEqual([i.done, i.due], [false, '2026-12-01']);
  assert.match(p.$('[data-open] .meta').textContent, /Due Dec 1/);
});
