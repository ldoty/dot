import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PK, personDoc, seed, sharedDoc, table } from './helpers/budget-api.mjs';
import { openBudget, saved, wait } from './helpers/page.mjs';

const doc = (d) => JSON.parse(table.get(PK, `DOC#${d}#STATE`).state);
const tag = (n) => table.get(PK, `TAG#${n}`)?.versionId;
beforeEach(() => seed());

test('the page holds no budget figures until it loads them from the API', async () => {
  const p = await openBudget('#shared');
  assert.ok(p.requests.includes('GET /all'));
  assert.equal(p.text('k-total'), '$2,000');
  p.close();
});

// --- Per-tab budgets, versions and tags --------------------------------------------

test('personal share comes from the tagged Shared version, not the working copy', async () => {
  const p = await openBudget('#luke');
  assert.equal(p.text('ro-Lukes'), '$500'); // 50% of the tagged $1,000, not the working $2,000
  assert.match(p.text('p-follow'), /default → “Starting point”/);
  p.close();
});

test('editing Shared saves only Shared and leaves personal tabs alone until tagged', async () => {
  const p = await openBudget('#shared');
  p.type('#split-r', '70');
  await saved();
  assert.equal(doc('shared').split, 70);
  assert.ok(p.requests.includes('PUT /docs/shared/state'));
  assert.ok(!p.requests.some((r) => /docs\/(Luke|Amber)/.test(r)));
  await p.tab('Luke');
  assert.equal(p.text('ro-Lukes'), '$500');
  p.close();
});

test('save + tag default moves the tag, and personal tabs follow it', async () => {
  const p = await openBudget('#shared');
  p.type('#split-r', '70'); await saved();
  p.type('#v-name', 'Plan B'); p.type('#v-tag', 'default'); p.click('#v-save'); await wait(50);
  const planB = JSON.parse(JSON.stringify(table.keys())).find((k) => k.startsWith('DOC#shared#VERSION#') && k !== 'DOC#shared#VERSION#v1').split('#')[3];
  assert.equal(tag('default'), planB);
  assert.match(p.d.querySelector('.v-item .v-tags').textContent, /default/);
  await p.tab('Luke');
  assert.equal(p.text('ro-Lukes'), '$1,400'); // 70% of $2,000
  p.close();
});

test('new tags are cleaned up, followable, and deletable (followers fall back to default)', async () => {
  const p = await openBudget('#shared');
  p.type('#v-name', 'Lean'); p.type('#v-tag', 'Stretch Goal'); p.click('#v-save'); await wait(50);
  assert.ok(tag('stretch-goal'));
  assert.equal(tag('default'), 'v1');

  await p.tab('Amber');
  p.type('#follow', 'stretch-goal', 'change'); await saved();
  assert.equal(doc('Amber').follows, 'stretch-goal');
  assert.equal(doc('Luke').follows, 'default');
  assert.equal(p.text('ro-Ambers'), '$1,000'); // 50% of the $2,000 working copy saved as Lean

  await p.tab('shared');
  p.click('[data-tagdel="stretch-goal"]'); p.click('[data-tagdel="stretch-goal"]'); await saved();
  assert.equal(tag('stretch-goal'), undefined);
  assert.equal(doc('Amber').follows, 'default');
  p.close();
});

test('moving a tag from the Tags panel', async () => {
  const p = await openBudget('#shared');
  p.type('#v-name', 'Plan B'); p.type('#v-tag', 'default'); p.click('#v-save'); await wait(50);
  p.type('[data-tagsel="default"]', 'v1', 'change'); await wait(50);
  assert.equal(tag('default'), 'v1');
  await p.tab('Luke');
  assert.equal(p.text('ro-Lukes'), '$500');
  p.close();
});

test('a tagged version can’t be deleted', async () => {
  const p = await openBudget('#shared');
  p.click('[data-vdel="v1"]'); await wait(50);
  assert.ok(table.get(PK, 'DOC#shared#VERSION#v1'));
  assert.match(p.text('status'), /tagged default/);
  p.close();
});

test('personal versions belong to that tab only', async () => {
  const p = await openBudget('#luke');
  assert.equal(p.d.getElementById('v-tag'), null);
  p.type('#v-name', 'Luke lean'); p.click('#v-save'); await wait(50);
  assert.equal(table.keys().filter((k) => k.startsWith('DOC#Luke#VERSION#')).length, 1);
  await p.tab('Amber');
  assert.equal(p.d.getElementById('v-list').hidden, true);
  p.close();
});

test('a stale save reloads the other person’s copy instead of overwriting it', async () => {
  const p = await openBudget('#luke');
  table.put({ pk: PK, sk: 'DOC#Luke#STATE', state: JSON.stringify({ ...personDoc('Luke'), income: [] }), rev: 7 });
  p.type('#n-Lukei', 'Salary'); await saved(); await wait(50);
  assert.equal(doc('Luke').income.length, 0);
  assert.match(p.text('status'), /changed somewhere else/);
  p.close();
});

// --- Category headers ----------------------------------------------------------------

test('categories: rename, add, reorder, delete with items', async () => {
  seed({ working: { ...sharedDoc(), categories: [...sharedDoc().categories, { id: 'c2', name: 'Food', kind: 'spend', items: [] }] } });
  const p = await openBudget('#shared');
  assert.deepEqual(p.names(), ['Home', 'Food']);
  assert.ok(p.el('[data-cmove="c1"][data-dir="-1"]').disabled);

  p.type('#cn-c2', 'Groceries & food'); await saved();
  assert.equal(doc('shared').categories[1].name, 'Groceries & food');

  p.click('#add-cat'); await wait();
  assert.ok(p.d.activeElement.classList.contains('cat-name'));
  p.type(p.d.activeElement, 'Kids'); await saved();
  assert.deepEqual(doc('shared').categories.map((c) => c.name), ['Home', 'Groceries & food', 'Kids']);

  p.click('[data-cmove="c1"][data-dir="1"]'); await saved();
  assert.deepEqual(doc('shared').categories.map((c) => c.name), ['Groceries & food', 'Home', 'Kids']);

  p.click('[data-cdel="c1"]');
  assert.equal(p.el('[data-cdel="c1"]').textContent, 'Delete with 1 item?');
  p.click('[data-cdel="c1"]'); await saved();
  assert.ok(!doc('shared').categories.some((c) => c.id === 'c1'));
  p.close();
});

test('categories: spending/savings toggle exists only on personal tabs, and empty savings categories survive reload', async () => {
  const p = await openBudget('#luke');
  assert.equal(p.d.querySelectorAll('[data-ckind]').length, 1);
  p.click('[data-ckind="Lukec"]'); await saved();
  assert.equal(doc('Luke').categories[0].kind, 'save');
  p.click('#add-cat'); await wait(); p.click(`[data-ckind="${p.d.activeElement.dataset.cname}"]`); await saved();
  p.close();
  const again = await openBudget('#luke');
  assert.equal(again.d.querySelectorAll('.cat-name').length, 2);
  again.close();
  const shared = await openBudget('#shared');
  assert.equal(shared.d.querySelectorAll('[data-ckind]').length, 0);
  shared.close();
});

// --- Home value and property tax ---------------------------------------------------------

test('property tax and insurance follow the home value; flat items don’t', async () => {
  const working = {
    categories: [{ id: 'c1', name: 'Home & property', kind: 'spend', items: [
      { id: 'a1', name: 'Homeowners insurance', calc: 'pctHome', rate: 0.5, freq: 'yr', who: 'Shared', note: '' },
      { id: 'a2', name: 'Property tax', amount: 3000, freq: 'yr', who: 'Shared', note: '' },
      { id: 'a3', name: 'Maintenance', amount: 6000, freq: 'yr', who: 'Shared', note: '' }] }],
    mortgage: { price: 600000, down: 400000, rate: 6.9, years: 30 }, split: 50,
  };
  seed({ working });
  const p = await openBudget('#shared');
  assert.equal(p.text('m-a2'), '$250'); // flat $3,000/yr converts to 0.5% of $600k: unchanged
  assert.equal(p.el('#a-a2').value, '0.5');
  assert.equal(p.el('label[for="m-price"]').textContent, 'Home value');
  assert.match(p.text('nt-a2'), /from the \$600,000 home value/);
  p.type('#m-price', '700000');
  assert.equal(p.text('m-a2'), '$292');
  assert.equal(p.text('m-a1'), '$292');
  assert.equal(p.text('m-a3'), '$500');
  await saved();
  const tax = doc('shared').categories[0].items[1];
  assert.deepEqual([tax.calc, tax.rate, 'amount' in tax], ['pctHome', 0.5, false]);
  p.close();
});

// --- Editing saved versions --------------------------------------------------------------

const version = (d, id) => { const r = table.get(PK, `DOC#${d}#VERSION#${id}`); return r && { ...r, state: JSON.parse(r.state) }; };

test('rename a version; its tags stay, and the working copy follows the new name', async () => {
  const p = await openBudget('#shared');
  p.click('[data-vload="v1"]'); await saved();
  p.click('[data-vedit="v1"]');
  assert.equal(p.d.activeElement.id, 've-name');
  p.type('#ve-name', 'Baseline'); p.click('[data-vrename="v1"]'); await saved();
  assert.equal(version('shared', 'v1').name, 'Baseline');
  assert.equal(tag('default'), 'v1');
  assert.equal(doc('shared').version, 'Baseline');
  assert.equal(p.d.querySelector('[data-veditor]'), null, 'editor closes');
  p.close();
});

test('renaming to another version’s name is refused', async () => {
  const p = await openBudget('#shared');
  p.type('#v-name', 'Plan B'); p.click('#v-save'); await wait(50);
  p.click('[data-vedit="v1"]'); p.type('#ve-name', 'plan b'); p.click('[data-vrename="v1"]'); await wait(50);
  assert.equal(version('shared', 'v1').name, 'Starting point');
  assert.match(p.text('status'), /already called/);
  p.close();
});

test('add and remove tags from the editor; default can’t be removed', async () => {
  const p = await openBudget('#shared');
  p.click('[data-vedit="v1"]');
  assert.equal(p.d.querySelector('[data-vuntag="default"]'), null);
  p.type('#ve-tag', 'All Cash'); p.click('[data-vaddtag="v1"]'); await wait(50);
  assert.equal(tag('all-cash'), 'v1');
  assert.ok(p.d.querySelector('[data-vuntag="all-cash"]'), 'editor stays open showing the new tag');
  p.click('[data-vuntag="all-cash"]'); await wait(50);
  assert.equal(tag('all-cash'), undefined);
  p.close();
});

test('replace with current numbers: two clicks, warns who follows it, and they get the new numbers', async () => {
  const p = await openBudget('#shared');
  p.type('#split-r', '70'); await saved();
  p.click('[data-vedit="v1"]');
  p.click('[data-vreplace="v1"]');
  assert.match(p.el('[data-vreplace="v1"]').textContent, /Luke & Amber follow it/);
  assert.equal(version('shared', 'v1').state.split, 50, 'first click changes nothing');
  p.click('[data-vreplace="v1"]'); await saved();
  assert.equal(version('shared', 'v1').state.split, 70);
  assert.equal(version('shared', 'v1').name, 'Starting point');
  assert.equal(doc('shared').version, 'Starting point');
  await p.tab('Luke');
  assert.equal(p.text('ro-Lukes'), '$1,400');
  p.close();
});

test('load, change, then Update: the button appears only with unsaved changes and saves into that version', async () => {
  const p = await openBudget('#shared');
  p.click('[data-vload="v1"]'); await saved();
  assert.equal(p.d.getElementById('v-update'), null);
  p.type('#split-r', '60'); await wait();
  assert.equal(p.el('#v-update').textContent, 'Update “Starting point”');
  p.click('#v-update'); await saved();
  assert.equal(version('shared', 'v1').state.split, 60);
  assert.equal(p.d.getElementById('v-update'), null);
  assert.equal(doc('shared').edited, false);
  p.close();
});

test('personal versions can be renamed and updated, with no tag controls', async () => {
  const p = await openBudget('#luke');
  p.type('#v-name', 'Lean'); p.click('#v-save'); await wait(50);
  const id = table.keys().find((k) => k.startsWith('DOC#Luke#VERSION#')).split('#')[3];
  p.click(`[data-vedit="${id}"]`);
  assert.equal(p.d.getElementById('ve-tag'), null);
  p.type('#ve-name', 'Lean month'); p.click(`[data-vrename="${id}"]`); await saved();
  assert.equal(version('Luke', id).name, 'Lean month');
  p.type('#a-Lukei', '3500'); await wait();
  p.click('#v-update'); await saved();
  assert.equal(version('Luke', id).state.income[0].amount, 3500);
  p.close();
});
