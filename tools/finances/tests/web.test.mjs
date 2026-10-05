// The real page, against the real handler on an in-memory table (after a sync of the fixtures)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { accessToken } from '../../../platform/tests/helpers/tokens.mjs';
import { fakeTable } from '../../../platform/tests/helpers/fake-table.mjs';
import { caller } from '../../../platform/tests/helpers/http.mjs';
import { createApi } from '../api/api.mjs';
import { runSync } from '../api/sync.mjs';
import { PLACEHOLDER } from '../api/simplefin.mjs';
import { testDeps, ROUTES } from './helpers/deps.mjs';

const HTML = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8').replace('<script src="family-auth.js"></script>', '');
const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const API = 'https://api.test';
const table = fakeTable();
const token = () => accessToken({ clientId: 'fin-client', group: 'luke_finances', sub: 'luke-sub', username: 'luke-sub' });

let t, call;
async function setup(opts) {
  table.clear();
  t = testDeps(opts);
  await runSync(t.deps);
  const api = caller(createApi(t.deps), ROUTES);
  call = (m, p, b) => api(m, p, b, token());
}
beforeEach(() => setup());

async function open(hash = '#2026-10') {
  const requests = [];
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously', url: `https://luke-finances.dot-y.co/${hash}`, pretendToBeVisual: true,
    beforeParse(w) {
      w.FamilyAuth = { init: async () => ({ email: 't' }), accessToken: async () => token(), autoLogin: () => false, login() {}, logout() {} };
      w.fetch = async (url, o = {}) => {
        const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
        if (url === 'config.json') return json(200, { apiUrl: API, title: 'Luke’s Finances', tool: 'luke-finances' });
        const path = url.slice(API.length);
        requests.push(`${o.method || 'GET'} ${path}`);
        const r = await call(o.method || 'GET', path, o.body ? JSON.parse(o.body) : undefined);
        return json(r.status, r.body);
      };
    },
  });
  await wait(120);
  const d = dom.window.document;
  const el = (sel) => { const e = d.querySelector(sel); if (!e) throw new Error(`missing ${sel}`); return e; };
  const change = async (sel, v) => { const e = el(sel); if (typeof v === 'boolean') e.checked = v; else e.value = v; e.dispatchEvent(new dom.window.Event('change', { bubbles: true })); await wait(80); };
  return { d, el, change, requests, click: async (sel) => { el(sel).click(); await wait(80); }, close: () => dom.window.close() };
}

test('balances first, then the month with its summary tiles', async () => {
  const p = await open();
  assert.equal(p.d.title, 'Luke’s Finances');
  assert.equal(p.el('#title').innerHTML, 'Luke’s <em>Finances</em>', 'named by its deployment');
  const cards = [...p.d.querySelectorAll('.acct-card')];
  assert.deepEqual(cards.map((c) => c.querySelector('.an').textContent), ['Checking', 'Rewards Card'], 'cash first, then cards');
  assert.equal(cards[0].querySelector('.ab').textContent, '$2,500.10');
  assert.equal(cards[0].querySelector('.aa').textContent, '$2,400.00 available');
  assert.equal(cards[1].querySelector('.aa').textContent, 'owed');
  assert.match(p.el('.bal-sum').textContent, /Cash \$2,500 · Cards owed \$321 · Net \$2,179/);
  assert.ok(p.el('#h-bal').compareDocumentPosition(p.el('#h-month')) & 4, 'balances above the month');
  assert.equal(p.el('.month h2').textContent, 'October 2026');
  assert.match(p.el('#status').textContent, /Last synced .* · 13% of the month gone · 3 to file/);
  const stats = [...p.d.querySelectorAll('.stat')].map((s) => s.textContent);
  assert.match(stats[0], /^Income\$6,000of \$6,000/);
  p.close();
});

test('MTD by category: one stacked column per category, segments are its lines, on the budget', async () => {
  const p = await open();
  const food = p.el('.col[data-cat="Luke›Food"]');
  assert.equal(food.querySelector('.clabel').textContent, 'Foodof $660');
  assert.equal(food.querySelector('.cval').textContent, '$7');
  const segs = [...food.querySelectorAll('.seg')];
  assert.deepEqual(segs.map((x) => x.dataset.tl), ['Coffee · Food'], 'only lines with spending');
  assert.equal(segs[0].style.background, 'var(--s1)', 'colors go to the lines with spending, not to empty ones');
  assert.equal(food.querySelector('.ctrack').style.height, '44%', '$660 budget on a $1.5k scale (Share of Shared is $1,399)');
  assert.ok(food.querySelector('.ctick:not(.pace)'), 'the top of the budget');
  assert.ok(food.querySelector('.ctick.pace'), 'an even pace by today');
  assert.match(food.getAttribute('aria-label'), /^Food: \$7 of \$660, \$654 left\. Coffee \$7/);
  const axis = [...food.closest('.colchart').querySelectorAll('.axis span')].map((x) => x.textContent);
  assert.deepEqual(axis, ['$0', '$500', '$1k', '$1.5k'], 'clean gridlines');
  const groups = [...p.d.querySelectorAll('.chart h3')].map((h) => h.textContent);
  assert.deepEqual(groups, ['My budget'], 'no Shared household in my view');
  assert.equal(p.d.querySelector('.col[data-cat^="Shared"]'), null);
  assert.ok(![...p.d.querySelectorAll('.stat .eyebrow')].some((e) => /Shared/i.test(e.textContent)));
  assert.equal(p.d.querySelector('[data-cat="Luke›Income"]'), null, 'income isn’t a spending column');
  // The readout names a column's pieces on hover or focus
  food.dispatchEvent(new p.d.defaultView.Event('focusin', { bubbles: true }));
  assert.match(food.closest('.chart').querySelector('.readout').textContent, /Food · \$7 of \$660 · \$654 left.*Coffee \$7/);
  assert.match(p.el('details.table-view').textContent, /Food\$7\$660/);
  p.close();
});

test('over budget is said in words, not only by height', async () => {
  const pay = table.keys().find((k) => k.startsWith('TXN#2026-10-03') && table.get('LUKE', k).description.startsWith('PAYMENT'));
  table.put({ ...table.get('LUKE', pay), line: 'L.f2', source: 'you' }); // $500 more on Coffee ($60 budget)
  const p = await open();
  await p.click('[data-cat="Luke›Food"]');
  const coffee = [...p.el('#h-cat').closest('section').querySelectorAll('.chart .col')].find((c) => c.querySelector('.clabel').firstChild.textContent === 'Coffee');
  assert.ok(coffee.querySelector('.cval').classList.contains('over'));
  coffee.dispatchEvent(new p.d.defaultView.Event('focusin', { bubbles: true }));
  assert.match(coffee.closest('.chart').querySelector('.readout').textContent, /Coffee · \$507 of \$60 · \$447 over/);
  p.close();
});

test('a shared account: in the Accounts & budget list, nowhere else (not even the balances)', async () => {
  const p = await open();
  const card = [...p.d.querySelectorAll('[data-owner]')].find((c) => c.closest('.acct-row').textContent.includes('Rewards Card'));
  await p.change(`[data-owner="${card.dataset.owner}"]`, 'shared');
  assert.match(p.el('.bal-sum').textContent, /^Cash \$2,500 · Cards owed \$0 · Net \$2,500 · as of/);
  assert.deepEqual([...p.d.querySelectorAll('.acct-card .an')].map((x) => x.textContent), ['Checking']);
  assert.ok(p.el('.settings').textContent.includes('Rewards Card'), 'still in the account list, to change it back');
  const rest = p.d.getElementById('main').textContent.replace(p.el('.settings').textContent, '');
  assert.doesNotMatch(rest, /Rewards Card|MYSTERY|BLUE BOTTLE/);
  p.close();
});

test('the filing picker: search, then pick a category (the whole category) or one of its lines', async () => {
  const p = await open();
  const btn = [...p.d.querySelectorAll('#to-file [data-pick]')].find((x) => x.getAttribute('aria-label').includes('Whole Foods'));
  assert.equal(btn.querySelector('.pick-v').textContent, 'Not filed');
  await p.click(`#to-file [data-pick="${btn.dataset.pick}"]`);
  const items = () => [...p.d.querySelectorAll('.pick-list li')].map((li) => li.textContent);
  assert.deepEqual(items().slice(0, 4), ['Not filed', 'Income', 'Paycheck', 'Food'], 'categories are headers you can pick');
  assert.ok(!items().some((x) => /General/.test(x)), 'no separate “whole category” rows');
  assert.ok(!items().some((x) => /Electric|Utilities/.test(x)), 'no Shared lines in a personal tool');
  // Search
  const q = p.el('.pick-q');
  q.value = 'cof';
  q.dispatchEvent(new p.d.defaultView.Event('input', { bubbles: true }));
  assert.deepEqual(items(), ['Food', 'Coffee'], 'a matching line, under its category');
  q.value = 'food';
  q.dispatchEvent(new p.d.defaultView.Event('input', { bubbles: true }));
  assert.deepEqual(items(), ['Food', 'Groceries', 'Coffee'], 'a matching category, with all its lines');
  // Pick the category itself: the whole of Food
  const food = [...p.d.querySelectorAll('.pick-list li')].find((li) => li.textContent === 'Food');
  await p.click(`.pick-list li[data-choice="${food.dataset.choice}"]`);
  assert.equal(p.el('.col[data-cat="Luke›Food"] .cval').textContent, '$149', 'counted toward Food');
  await p.click('[data-cat="Luke›Food"]');
  const cols = [...p.el('#h-cat').closest('section').querySelectorAll('.chart .col')];
  const general = cols.find((c) => c.querySelector('.clabel').firstChild.textContent === 'General');
  assert.equal(general.querySelector('.cval').textContent, '$142');
  const filed = [...p.d.querySelectorAll('.card [data-pick]')].find((x) => x.getAttribute('aria-label').includes('Whole Foods'));
  assert.equal(filed.querySelector('.pick-v').textContent, 'Food', 'shown as the category');
  p.close();
});

test('the filing picker by keyboard: type, arrows, Enter; Escape closes', async () => {
  const p = await open();
  const btn = [...p.d.querySelectorAll('#to-file [data-pick]')].find((x) => x.getAttribute('aria-label').includes('Whole Foods'));
  await p.click(`#to-file [data-pick="${btn.dataset.pick}"]`);
  const q = p.el('.pick-q');
  const key = (k) => q.dispatchEvent(new p.d.defaultView.KeyboardEvent('keydown', { key: k, bubbles: true }));
  key('Escape');
  assert.equal(p.d.querySelector('.pick-panel'), null);
  await p.click(`#to-file [data-pick="${btn.dataset.pick}"]`);
  const q2 = p.el('.pick-q');
  q2.value = 'groc';
  q2.dispatchEvent(new p.d.defaultView.Event('input', { bubbles: true }));
  assert.equal(p.el('.pick-list li.active').textContent, 'Food', 'the first match is ready');
  q2.dispatchEvent(new p.d.defaultView.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.equal(p.el('.pick-list li.active').textContent, 'Groceries');
  q2.dispatchEvent(new p.d.defaultView.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(p.requests.includes(`PUT /transactions/${btn.dataset.pick}`));
  assert.equal(table.get('LUKE', `TXN#${btn.dataset.pick.replace('.', '#')}`).line, 'L.f1');
  p.close();
});

test('a category with many lines: its biggest five get colors, only the rest fold into Other', async () => {
  const p = await open();
  // Seven lines with spending in Food: Groceries, Coffee, and five more made up here
  const lines = table.get('LUKE', 'BUDGET').lines;
  const extra = [1, 2, 3, 4, 5].map((n) => ({ id: `L.x${n}`, group: 'Luke', category: 'Food', name: `Extra ${n}`, kind: 'spend', target: 10 }));
  table.put({ ...table.get('LUKE', 'BUDGET'), lines: [...lines.slice(0, 3), ...extra, ...lines.slice(3)] });
  const keys = table.keys().filter((k) => k.startsWith('TXN#2026-10'));
  const amounts = { 'L.x1': -50, 'L.x2': -40, 'L.x3': -30, 'L.x4': -20, 'L.x5': -1 };
  Object.entries(amounts).forEach(([line, amount], i) => table.put({ ...table.get('LUKE', keys[i]), line, amount, source: 'you' }));
  // and Groceries and Coffee too
  const base = table.get('LUKE', keys[0]);
  table.put({ ...base, sk: 'TXN#2026-10-02#aaaaaaaaaaaaaaaa', description: 'G', line: 'L.f1', amount: -5 });
  table.put({ ...base, sk: 'TXN#2026-10-02#bbbbbbbbbbbbbbbb', description: 'C', line: 'L.f2', amount: -3 });
  p.close();
  const q = await open();
  const segs = [...q.el('.col[data-cat="Luke›Food"]').querySelectorAll('.seg')];
  assert.equal(segs.length, 6, 'five colored lines and one Other');
  assert.equal(segs.filter((x) => x.style.background === 'var(--other)').length, 1);
  assert.ok(segs.some((x) => /^Other lines \(\d\)/.test(x.dataset.tl)));
  q.close();
});

test('a category opens to its lines, each stacked by merchant, with its transactions', async () => {
  const p = await open();
  await p.click('[data-cat="Luke›Food"]');
  assert.match(p.el('.drill-head h3').textContent, /^Food$/);
  const cols = [...p.el('#h-cat').closest('section').querySelectorAll('.chart .col')];
  assert.deepEqual(cols.map((r) => r.querySelector('.clabel').firstChild.textContent), ['Groceries', 'Coffee']);
  assert.deepEqual([...cols[1].querySelectorAll('.seg')].map((x) => x.dataset.tl), ['Sq Blue Bottle Coffee · Coffee']);
  assert.match(p.el('.card h3').textContent, /Food transactions \(1\)/);
  await p.click('#undrill');
  assert.ok(p.el('[data-cat="Luke›Food"]'));
  p.close();
});

test('tooltips show the value first, as text', async () => {
  const p = await open();
  const seg = p.el('.col[data-cat="Luke›Food"] .seg');
  seg.dispatchEvent(new p.d.defaultView.MouseEvent('pointermove', { bubbles: true, clientX: 10, clientY: 10 }));
  const tip = p.el('#tip');
  assert.equal(tip.hidden, false);
  assert.deepEqual([tip.children[0].textContent, tip.children[1].textContent], ['$6.50', 'Coffee · Food']);
  p.close();
});

test('three months: one stacked column per month, stacks are my categories; hover shows a category across months', async () => {
  const p = await open();
  const chart = p.el('#trend-chart');
  const cols = [...chart.querySelectorAll('.col')];
  assert.deepEqual(cols.map((c) => c.querySelector('.clabel').firstChild.textContent), ['Aug', 'Sep', 'Oct (to date)']);
  assert.deepEqual(cols.map((c) => c.querySelector('.cval').textContent), ['$0', '$7', '$7']);
  const seg = cols[2].querySelector('.seg');
  assert.equal(seg.dataset.tl, 'Food');
  assert.equal(seg.dataset.tv, 'Aug $0 · Sep $7 · Oct $7');
  assert.equal(cols[1].querySelector('.seg').style.background, seg.style.background, 'a category keeps its color in every month');
  assert.ok(cols[2].querySelector('.ctrack'), 'the month’s total budget behind it');
  const legend = [...p.el('#h-trend').closest('section').querySelectorAll('.legend-row .k')].map((k) => k.textContent);
  assert.deepEqual(legend, ['Food']);
  assert.ok(!/Shared/.test(p.el('#h-trend').closest('section').textContent.replace('Shared household', '')), 'no Shared categories');
  assert.match(p.el('#h-trend').closest('section').querySelector('table').textContent, /Food\$0\$7\$7\$660/);
  p.close();
});

test('to file: pick a line, and the merchant’s other transactions follow', async () => {
  const p = await open();
  assert.match(p.el('#to-file h3').textContent, /To file \(3\)/);
  const btn = [...p.d.querySelectorAll('#to-file [data-pick]')].find((x) => x.getAttribute('aria-label').includes('Whole Foods'));
  await p.click(`#to-file [data-pick="${btn.dataset.pick}"]`);
  const groceries = [...p.d.querySelectorAll('.pick-list li')].find((li) => li.textContent === 'Groceries');
  await p.click(`.pick-list li[data-choice="${groceries.dataset.choice}"]`);
  assert.ok(p.requests.includes(`PUT /transactions/${btn.dataset.pick}`));
  assert.equal(p.el('.col[data-cat="Luke›Food"] .cval').textContent, '$149');
  assert.match(p.el('#to-file h3').textContent, /To file \(2\)/);
  assert.equal(table.get('LUKE', 'RULE#WHOLE FOODS').line, 'L.f1', 'remembered by default');
  p.close();
});

test('moving a transaction to the next month from the page', async () => {
  const p = await open('#2026-09');
  const sel = p.el('[data-month]');
  assert.deepEqual([...sel.options].map((o) => o.textContent), ['Aug', 'Sep (posted)', 'Oct']);
  await p.change(`[data-month="${sel.dataset.month}"]`, '2026-10');
  assert.ok(p.requests.includes(`PUT /transactions/${sel.dataset.month}`));
  assert.match(p.el('#status').textContent, /Now counts in October 2026/);
  assert.equal(p.d.querySelectorAll('[data-month]').length, 0, 'gone from September');
  await p.click('#next');
  assert.match(p.el('.moved').textContent, /counts in Oct/);
  p.close();
});

test('clicking a month in the trend opens that month', async () => {
  const p = await open();
  const sep = [...p.el('#trend-chart').querySelectorAll('.col')].find((c) => c.dataset.go === '2026-09');
  assert.equal(sep.getAttribute('role'), 'button');
  await p.click('#trend-chart .col[data-go="2026-09"]');
  assert.ok(p.requests.includes('GET /month/2026-09'));
  assert.equal(p.el('.month h2').textContent, 'September 2026');
  assert.match(p.el('#trend-chart').closest('section').querySelector('.readout').textContent, /click it to open that month/);
  p.close();
});

test('clicking an account shows its transactions for the month; again (or All accounts) clears it', async () => {
  const p = await open();
  const card = [...p.d.querySelectorAll('[data-acct]')].find((c) => c.textContent.includes('Rewards Card'));
  await p.click(`[data-acct="${card.dataset.acct}"]`);
  assert.equal(p.el(`[data-acct="${card.dataset.acct}"]`).getAttribute('aria-pressed'), 'true');
  const box = p.el('#acct-txns');
  assert.match(box.querySelector('h3').textContent, /^Rewards Card · October 2026 \(2\)$/);
  assert.deepEqual([...box.querySelectorAll('.desc')].map((x) => x.textContent).sort(), ['MYSTERY MERCHANT', 'SQ *BLUE BOTTLE COFFEE 0042']);
  assert.ok(box.querySelector('[data-pick]'), 'filable right there');
  // It follows you to another month
  await p.click('#prev');
  assert.match(p.el('#acct-txns h3').textContent, /^Rewards Card · September 2026 \(1\)$/);
  await p.click('#all-accts');
  assert.equal(p.d.querySelector('#acct-txns'), null);
  await p.click(`[data-acct="${card.dataset.acct}"]`);
  await p.click(`[data-acct="${card.dataset.acct}"]`);
  assert.equal(p.d.querySelector('#acct-txns'), null, 'clicking it again clears it');
  p.close();
});

test('Refresh budget re-reads it now, as the person signed in', async () => {
  const p = await open();
  t.borrowed.length = 0;
  table.put({ ...table.get('LUKE', 'BUDGET'), lines: table.get('LUKE', 'BUDGET').lines.filter((l) => l.id !== 'L.f2') });
  await p.click('#refresh-budget');
  assert.ok(p.requests.includes('PUT /settings'));
  assert.deepEqual(t.borrowed.map((b) => b.channel), ['web']);
  assert.match(p.el('#status').textContent, /Budget refreshed: “October plan”/);
  assert.ok(table.get('LUKE', 'BUDGET').lines.some((l) => l.id === 'L.f2'), 'the fresh lines are stored');
  p.close();
});

test('months: back to September, and no further than this month', async () => {
  const p = await open();
  assert.equal(p.el('#next').disabled, true);
  await p.click('#prev');
  assert.equal(p.el('.month h2').textContent, 'September 2026');
  assert.ok(p.requests.includes('GET /month/2026-09'));
  assert.equal(p.d.defaultView.location.hash, '#2026-09');
  p.close();
});

test('following another tag, and leaving an account out', async () => {
  const p = await open();
  await p.change('#tag', 'lean');
  assert.equal(table.get('LUKE', 'SETTINGS').tag, 'lean');
  assert.equal(p.el('.col[data-cat="Luke›Food"] .clabel small').textContent, 'of $660');
  assert.match(p.el('.settings .status').textContent, /lean → my “Lean” → Shared lean “No mortgage”/);
  const card = [...p.d.querySelectorAll('[data-owner]')].find((c) => c.closest('.acct-row').textContent.includes('Rewards Card'));
  await p.change(`[data-owner="${card.dataset.owner}"]`, 'off');
  assert.equal(p.el('.col[data-cat="Luke›Food"] .cval').textContent, '$0');
  p.close();
});

test('before setup: says where the SimpleFIN token goes', async () => {
  await setup({ secret: PLACEHOLDER });
  const p = await open();
  assert.match(p.el('.note.bad').textContent, /Waiting for a SimpleFIN setup token/);
  p.close();
});

test('sync now', async () => {
  table.put({ ...table.get('LUKE', 'SYNC'), startedAt: new Date(t.deps.now() - 10 * 60_000).toISOString() });
  const p = await open();
  await p.click('#sync');
  assert.ok(p.requests.includes('POST /sync'));
  assert.equal(t.syncs.length, 1);
  p.close();
});
