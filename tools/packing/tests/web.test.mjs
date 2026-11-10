import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { call, member, table } from './helpers/packing-api.mjs';

const HTML = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8').replace('<script src="family-auth.js"></script>', '');
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const API = 'https://api.test';
const LIST = {
  categories: [{ id: 'cat1', name: 'Shelter' }, { id: 'cat2', name: 'Kitchen' }],
  items: [
    { id: 'i1', text: 'Tent', categoryId: 'cat1', status: '' },
    { id: 'i2', text: 'Fuel', categoryId: 'cat2', status: 'b' },
    { id: 'i3', text: 'Stove', categoryId: 'cat2', status: '' },
  ],
};

async function open() {
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: 'https://packing.dot-y.co/', pretendToBeVisual: true,
    beforeParse(w) {
      w.scrollBy = () => {};   // jsdom has no layout
      w.FamilyAuth = { init: async () => ({ email: 't' }), accessToken: async () => member(), autoLogin: () => false, login() {}, logout() {} };
      w.fetch = async (url, o = {}) => {
        const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
        if (url === 'config.json') return json(200, { apiUrl: API });
        const r = await call(o.method || 'GET', url.slice(API.length), o.body ? JSON.parse(o.body) : undefined);
        return json(r.status, r.body);
      };
    },
  });
  await wait(80);
  const w = dom.window, d = w.document;
  const texts = (sel) => [...d.querySelectorAll(sel)].map((n) => n.textContent);
  const mark = async (id, v) => {
    const m = d.querySelector(`li[data-id="${id}"] .mark`);
    m.value = v;
    m.dispatchEvent(new w.Event('input', { bubbles: true }));
    await wait(400);   // past the save delay
  };
  const enter = async (input, v) => {
    input.value = v;
    input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await wait(400);
  };
  return { w, d, texts, mark, enter, tab: async (k) => { d.querySelector(`[data-tab="${k}"]`).click(); await wait(); }, close: () => w.close() };
}

beforeEach(async () => {
  table.clear();
  await call('PUT', '/list', { ...LIST, rev: 0 });
});

test('shows categories with their items; b items wait on the shopping list', async () => {
  const p = await open();
  assert.deepEqual(p.texts('.cat-head h2'), ['Shelter', 'Kitchen']);
  assert.deepEqual(p.texts('#main .text'), ['Tent', 'Stove']);
  assert.equal(p.d.getElementById('progress').textContent, '0 of 3 packed');
  assert.deepEqual([...p.d.querySelectorAll('#tabs button')].map((b) => b.dataset.tab), ['pack', 'verify', 'shop', 'check']);
  await p.tab('shop');
  assert.deepEqual(p.texts('#main .text'), ['Fuel']);
  p.close();
});

test('typing a letter saves the whole list with its rev', async () => {
  const p = await open();
  await p.mark('i1', 'x');
  await p.mark('i3', 'c');
  const { body } = await call('GET', '/list');
  assert.equal(body.rev, 3);
  assert.deepEqual(body.items.map((i) => i.status), ['x', 'b', 'c']);
  assert.equal(p.d.getElementById('save').textContent, 'Saved');
  assert.equal(p.d.getElementById('progress').textContent, '1 of 3 packed');
  p.close();
});

test('letters other than b, c and x are ignored', async () => {
  const p = await open();
  await p.mark('i1', 'q');
  assert.equal((await call('GET', '/list')).body.rev, 1);
  p.close();
});

test('add an item and a category', async () => {
  const p = await open();
  await p.enter(p.d.querySelector('.add[data-cat="cat1"]'), 'Stakes');
  await p.enter(p.d.querySelector('.add-cat'), 'Water');
  const { body } = await call('GET', '/list');
  assert.deepEqual(body.items.filter((i) => i.categoryId === 'cat1').map((i) => i.text), ['Tent', 'Stakes']);
  assert.deepEqual(body.categories.map((c) => c.name), ['Shelter', 'Kitchen', 'Water']);
  p.close();
});

test('if another device saved first, the page shows theirs instead of overwriting it', async () => {
  const p = await open();
  await call('PUT', '/list', { ...LIST, items: LIST.items.slice(0, 1), rev: 1 });   // the phone
  await p.mark('i3', 'x');
  const { body } = await call('GET', '/list');
  assert.equal(body.rev, 2);
  assert.equal(body.items.length, 1, 'the phone’s save stands');
  assert.deepEqual(p.texts('#main .text'), ['Tent']);
  assert.match(p.d.getElementById('save').textContent, /another device/);
  p.close();
});

test('v puts an item on the verify list, and a chip brings it back to the packing list', async () => {
  const p = await open();
  await p.mark('i1', 'v');
  assert.equal((await call('GET', '/list')).body.items[0].status, 'v');
  assert.deepEqual(p.texts('#main .text'), ['Stove']);
  assert.match(p.d.querySelector('[data-tab="verify"]').textContent, /Verify list\s*1/);
  await p.tab('verify');
  assert.deepEqual(p.texts('#main .text'), ['Tent']);
  await p.tab('pack');
  p.d.querySelector('.chip.s-v').click();
  await p.tab('pack');
  assert.deepEqual(p.texts('#main .text'), ['Tent', 'Stove']);
  p.close();
});
