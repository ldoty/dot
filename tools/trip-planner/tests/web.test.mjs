import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { call, member, table, trip } from './helpers/trips-api.mjs';

const HTML = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8').replace('<script src="family-auth.js"></script>', '');
const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const API = 'https://api.test';
// Dates in the current month, so the calendar opens on them whenever the tests run.
const now = new Date();
const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
const D = (d) => `${ym}-${String(d).padStart(2, '0')}`;

async function open(hash = '') {
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: `https://trip-planner.dot-y.co/${hash}`, pretendToBeVisual: true,
    beforeParse(w) {
      w.scrollBy = w.scrollTo = () => {};   // jsdom has no layout
      w.confirm = () => true;
      w.FamilyAuth = { init: async () => ({ email: 't' }), accessToken: async () => member(), autoLogin: () => false, login() {}, logout() {} };
      w.fetch = async (url, o = {}) => {
        const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
        if (url === 'config.json') return json(200, { apiUrl: API });
        const r = await call(o.method || 'GET', url.slice(API.length), o.body ? JSON.parse(o.body) : undefined);
        return json(r.status, r.body);
      };
    },
  });
  await wait(100);
  const w = dom.window, d = w.document;
  const $ = (sel) => { const e = d.querySelector(sel); if (!e) throw new Error(`missing ${sel}`); return e; };
  const texts = (sel) => [...d.querySelectorAll(sel)].map((n) => n.textContent);
  const fire = (node, type, init) => node.dispatchEvent(new (type === 'keydown' ? w.KeyboardEvent : w.Event)(type, { bubbles: true, cancelable: true, ...init }));
  return {
    w, d, $, texts,
    click: async (sel, ms) => { $(sel).click(); await wait(ms); },
    go: async (h) => { w.location.hash = h; await wait(150); },
    fill: (sel, v) => { $(sel).value = v; fire($(sel), 'input'); fire($(sel), 'change'); },
    submit: async (sel) => { fire($(sel), 'submit'); await wait(150); },
    mark: async (id, v) => { const m = $(`li[data-id="${id}"] .mark`); m.value = v; fire(m, 'input'); await wait(500); },
    enter: async (input, v) => { input.value = v; fire(input, 'keydown', { key: 'Enter' }); await wait(500); },
    close: () => w.close(),
  };
}

beforeEach(async () => {
  table.clear();
  await call('PUT', '/trips/t1', { ...trip({ start: D(14), end: D(15) }), rev: 0 });
});

test('the calendar shows each trip across its days, named where it starts', async () => {
  const p = await open();
  assert.equal(p.d.querySelector('h1').textContent, 'Trip planner');
  const bars = (day) => [...p.d.querySelectorAll(`[data-day="${day}"] .bar`)];
  assert.equal(bars(D(14))[0].textContent, 'Ridge loop');
  assert.equal(bars(D(14))[0].getAttribute('href'), '#/trip/t1');
  assert.equal(bars(D(15)).length, 1);
  assert.equal(bars(D(16)).length, 0);
  assert.match(p.texts('.trips li')[0], /Ridge loop.*Backpacking.*Site 3.*1\/3 packed/);
  assert.doesNotMatch(p.$('#app').textContent, /null/);
  p.close();
});

test('book a trip from a day on the calendar, copying an earlier packing list with its marks cleared', async () => {
  const p = await open();
  await p.click(`[data-day="${D(21)}"]`);
  assert.equal(p.$('#book [name="start"]').value, D(21));
  assert.equal(p.$('#book [name="end"]').value, D(22));
  assert.equal(p.$('#book [name="from"]').value, 't1', 'the latest earlier list is offered');
  p.fill('#b-name', 'Second trip');
  p.fill('#book [name="where"]', 'Lake camp');
  await p.submit('#book');
  const id = p.w.location.hash.split('/')[2];
  const { body } = await call('GET', `/trips/${id}`);
  assert.equal(body.name, 'Second trip');
  assert.equal(body.where, 'Lake camp');
  assert.deepEqual([body.start, body.end, body.type], [D(21), D(22), 'backpacking']);
  assert.deepEqual(body.items.map((i) => i.text), ['Tent', 'Fuel', 'Stove']);
  assert.deepEqual(body.items.map((i) => i.status), ['', '', '']);
  assert.equal(body.notes, '', 'notes are the trip’s own');
  assert.equal(p.$('#trip-name').textContent, 'Second trip');
  assert.equal((await call('GET', '/trips/t1')).body.items[2].status, 'x', 'the original keeps its marks');
  p.close();
});

test('booking with an empty list, and refusing an end before the start', async () => {
  const p = await open();
  await p.click('#book-btn');
  p.fill('#b-name', 'Day hike');
  p.$('#book [name="from"]').value = '';
  p.$('#book [name="end"]').value = '2000-01-01';
  await p.submit('#book');
  assert.match(p.$('#b-status').textContent, /end on or after/);
  p.$('#book [name="end"]').value = p.$('#book [name="start"]').value;
  await p.submit('#book');
  const id = p.w.location.hash.split('/')[2];
  assert.deepEqual((await call('GET', `/trips/${id}`)).body.items, []);
  // An empty list offers to start from another trip's.
  await wait(100);
  await p.click('#copy-btn', 600);
  assert.equal((await call('GET', `/trips/${id}`)).body.items.length, 3);
  p.close();
});

test('a trip shows its details, notes, itinerary and packing list; notes save as you type', async () => {
  const p = await open('#/trip/t1');
  assert.equal(p.$('#trip-name').textContent, 'Ridge loop');
  assert.match(p.$('.eyebrow').textContent, /Backpacking · \w{3} 14 – 15, \d{4}/);
  assert.equal(p.$('#notes').value, 'Permit in the glovebox');
  assert.equal(p.$('#itinerary').value, 'Sat: hike in\nSun: hike out');
  assert.deepEqual(p.texts('#pack .text'), ['Tent', 'Stove']);
  assert.deepEqual([...p.d.querySelectorAll('#tabs button')].map((b) => b.dataset.tab), ['pack', 'verify', 'packed', 'shop', 'check']);
  p.fill('#notes', 'Permit in the glovebox\nCampsite 14');
  p.fill('#itinerary', 'Fri night: drive up');
  await wait(600);
  const { body } = await call('GET', '/trips/t1');
  assert.equal(body.notes, 'Permit in the glovebox\nCampsite 14');
  assert.equal(body.itinerary, 'Fri night: drive up');
  assert.equal(p.$('#save').textContent, 'Saved');
  p.close();
});

test('the packing list still works: letters, tabs and adding', async () => {
  const p = await open('#/trip/t1');
  await p.mark('i1', 'v');
  assert.equal((await call('GET', '/trips/t1')).body.items[0].status, 'v');
  assert.deepEqual(p.texts('#pack .text'), ['Stove']);
  await p.click('[data-tab="verify"]');
  assert.deepEqual(p.texts('#pack .text'), ['Tent']);
  await p.mark('i1', 'p');
  assert.equal((await call('GET', '/trips/t1')).body.items[0].status, 'p');
  assert.deepEqual(p.texts('#pack .text'), [], 'it leaves the verify list');
  await p.click('[data-tab="packed"]');
  assert.deepEqual(p.texts('#pack .text'), ['Tent']);
  await p.click('[data-tab="pack"]');
  assert.deepEqual(p.texts('#pack .text'), ['Stove'], 'hidden from the packing list');
  await p.click('.chip.s-p');
  assert.deepEqual(p.texts('#pack .text'), ['Tent', 'Stove'], 'until shown');
  await p.click('.chip.s-p');
  await p.mark('i3', 'q');
  assert.equal((await call('GET', '/trips/t1')).body.rev, 3, 'other letters are ignored');
  await p.enter(p.$('.add[data-cat="cat1"]'), 'Stakes');
  assert.deepEqual((await call('GET', '/trips/t1')).body.items.map((i) => i.text), ['Tent', 'Fuel', 'Stove', 'Stakes']);
  p.close();
});

test('leaving a trip right after typing still saves it', async () => {
  const p = await open('#/trip/t1');
  p.fill('#notes', 'last-second note');
  await p.go('#/');
  assert.equal((await call('GET', '/trips/t1')).body.notes, 'last-second note');
  assert.ok(p.d.querySelector('.cal'));
  p.close();
});

test('edit a trip’s details, and delete it', async () => {
  const p = await open('#/trip/t1');
  await p.click('#edit-btn');
  p.fill('#details [name="name"]', 'Ridge loop, take two');
  p.fill('#details [name="end"]', D(16));
  await p.submit('#details');
  await wait(500);
  const { body } = await call('GET', '/trips/t1');
  assert.equal(body.name, 'Ridge loop, take two');
  assert.equal(body.end, D(16));
  assert.equal(p.$('#trip-name').textContent, 'Ridge loop, take two');
  await p.click('#edit-btn');
  await p.click('#delete-trip', 200);
  assert.equal((await call('GET', '/trips/t1')).status, 404);
  assert.equal(p.w.location.hash, '#/');
  p.close();
});

test('if another device saved first, the page shows theirs instead of overwriting it', async () => {
  const p = await open('#/trip/t1');
  await call('PUT', '/trips/t1', { ...trip({ start: D(14), end: D(15), notes: 'from the phone' }), rev: 1 });
  p.fill('#notes', 'from the laptop');
  await wait(600);
  const { body } = await call('GET', '/trips/t1');
  assert.equal(body.notes, 'from the phone');
  assert.equal(p.$('#notes').value, 'from the phone');
  assert.match(p.$('#save').textContent, /another device/);
  p.close();
});
