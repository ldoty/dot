import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PK, personDoc, seed, sharedDoc, table } from './helpers/budget-api.mjs';
import { openBudget, saved, wait } from './helpers/page.mjs';

const doc = (d) => JSON.parse(table.get(PK, `DOC#${d}#STATE`).state);
const tag = (n, d = 'shared') => table.get(PK, `TAG#${d}#${n}`)?.versionId;
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
  assert.match(p.text('v-cur'), /follows default → “Starting point”/);
  assert.match(p.text('nt-Lukes'), /From Shared \(default\): 50% of \$1,000/);
  assert.equal(p.d.getElementById('follow'), null, 'no separate follow panel');
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
  p.type('#v-name', 'Mine'); p.click('#v-save'); await wait(50);
  const av = table.keys().find((k) => k.startsWith('DOC#Amber#VERSION#')).split('#')[3];
  p.click(`[data-vedit="${av}"]`); p.type('#ve-follow', 'stretch-goal', 'change'); p.click(`[data-vsave="${av}"]`); await saved();
  assert.equal(doc('Amber').follows, 'stretch-goal', 'editing the loaded version applies its tag');
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
  p.type('#ve-name', 'Baseline'); p.click('[data-vsave="v1"]'); await saved();
  assert.equal(version('shared', 'v1').name, 'Baseline');
  assert.equal(tag('default'), 'v1');
  assert.equal(doc('shared').version, 'Baseline');
  assert.equal(p.d.querySelector('[data-veditor]'), null, 'editor closes');
  p.close();
});

test('renaming to another version’s name is refused', async () => {
  const p = await openBudget('#shared');
  p.type('#v-name', 'Plan B'); p.click('#v-save'); await wait(50);
  p.click('[data-vedit="v1"]'); p.type('#ve-name', 'plan b'); p.click('[data-vsave="v1"]'); await wait(50);
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

test('personal versions can be renamed and updated', async () => {
  const p = await openBudget('#luke');
  p.type('#v-name', 'Lean'); p.click('#v-save'); await wait(50);
  const id = table.keys().find((k) => k.startsWith('DOC#Luke#VERSION#')).split('#')[3];
  p.click(`[data-vedit="${id}"]`);
  p.type('#ve-name', 'Lean month'); p.click(`[data-vsave="${id}"]`); await saved();
  assert.equal(version('Luke', id).name, 'Lean month');
  p.type('#a-Lukei', '3500'); await wait();
  p.click('#v-update'); await saved();
  assert.equal(version('Luke', id).state.income[0].amount, 3500);
  p.close();
});

test('a personal version’s tag is set in its editor and takes effect when it’s the loaded version', async () => {
  const p = await openBudget('#shared');
  p.type('#v-name', 'Plan B'); p.type('#v-tag', 'stretch'); p.click('#v-save'); await wait(50);
  await p.tab('Luke');
  p.type('#v-name', 'Lean'); p.click('#v-save'); await wait(50);
  const id = table.keys().find((k) => k.startsWith('DOC#Luke#VERSION#')).split('#')[3];

  p.click(`[data-vedit="${id}"]`);
  assert.equal(p.el('#ve-follow').value, 'default');
  assert.match(p.text('ve-follow-hint'), /“Starting point”/);
  p.type('#ve-follow', 'stretch', 'change');
  assert.match(p.text('ve-follow-hint'), /“Plan B”/, 'hint updates before saving');
  p.click(`[data-vsave="${id}"]`); await saved();
  assert.equal(version('Luke', id).state.follows, 'stretch');
  assert.equal(doc('Luke').follows, 'stretch', 'it’s the loaded version, so the tab follows stretch right away');
  assert.match(p.text('v-cur'), /follows stretch → “Plan B”/);
  assert.match(p.d.querySelector('.v-item .v-meta').textContent, /follows stretch/);
  p.close();
});

test('the editor has a tag picker only on personal tabs and tag chips only on Shared', async () => {
  const p = await openBudget('#shared');
  p.click('[data-vedit="v1"]');
  assert.ok(p.d.getElementById('ve-tag'));
  assert.equal(p.d.getElementById('ve-follow'), null);
  p.click('[data-vdone]');
  assert.equal(p.d.querySelector('[data-veditor]'), null, 'Cancel closes it');
  p.close();
});

// --- Personal tags and opening on each tab's default ---------------------------------------

const putVersion = (d, id, name, state) => table.put({ pk: PK, sk: `DOC#${d}#VERSION#${id}`, name, savedAt: 2, state: JSON.stringify(state) });
const putDoc = (d, state, rev = 1) => table.put({ pk: PK, sk: `DOC#${d}#STATE`, state: JSON.stringify(state), rev });
const putTag = (d, n, id) => table.put({ pk: PK, sk: `TAG#${d}#${n}`, versionId: id });

test('personal tabs have their own tags: save + tag default, chips, and a Tags panel', async () => {
  const p = await openBudget('#luke');
  p.type('#v-name', 'Lean'); p.type('#v-tag', 'default'); p.click('#v-save'); await wait(50);
  const id = table.keys().find((k) => k.startsWith('DOC#Luke#VERSION#')).split('#')[3];
  assert.equal(tag('default', 'Luke'), id);
  assert.equal(tag('default', 'shared'), 'v1', 'Shared default untouched');
  assert.match(p.d.querySelector('.v-item .v-tags').textContent, /default/);
  assert.ok(p.d.querySelector('[data-tagsel="default"]'), 'Tags panel lists Luke’s default');
  assert.match(p.d.getElementById('t-list').textContent, /Opens on load/);
  await p.tab('Amber');
  assert.equal(p.d.querySelector('[data-tagsel]'), null, 'Amber has no tags yet');
  p.close();
});

test('on open, a tab showing some other saved version switches to its default', async () => {
  const shared = sharedDoc(1000);
  putVersion('shared', 'v2', 'Plan B', sharedDoc(3000));
  putDoc('shared', { ...sharedDoc(3000), version: 'Plan B', edited: false });
  const p = await openBudget('#shared');
  assert.equal(p.text('k-total'), '$1,000', 'opens on default (Starting point), not Plan B');
  assert.equal(p.d.querySelector('.resume'), null);
  await saved();
  assert.equal(doc('shared').version, 'Starting point');
  void shared;
  p.close();
});

test('on open, unsaved work stays put with a banner; Keep editing hides it', async () => {
  const p = await openBudget('#shared'); // seed: working $2,000, not saved anywhere
  assert.equal(p.text('k-total'), '$2,000');
  assert.match(p.el('.resume').textContent, /unsaved changes/);
  p.click('#resume-keep'); await wait();
  assert.equal(p.d.querySelector('.resume'), null);
  assert.equal(p.text('k-total'), '$2,000');
  p.close();
});

test('Discard and load default takes two clicks, then loads the default', async () => {
  const p = await openBudget('#shared');
  p.click('#resume-default');
  assert.equal(p.el('#resume-default').textContent, 'Click again to discard');
  assert.equal(p.text('k-total'), '$2,000', 'first click changes nothing');
  p.click('#resume-default'); await saved();
  assert.equal(p.text('k-total'), '$1,000');
  assert.equal(doc('shared').version, 'Starting point');
  assert.equal(p.d.querySelector('.resume'), null);
  p.close();
});

test('saving the unsaved work as a version clears the banner', async () => {
  const p = await openBudget('#shared');
  p.type('#v-name', 'Big plan'); p.click('#v-save'); await wait(50);
  assert.equal(p.d.querySelector('.resume'), null);
  p.close();
});

test('on open, a working copy identical to the default is just marked as it (no banner, no change)', async () => {
  putDoc('shared', sharedDoc(1000)); // same numbers as Starting point, no version marker
  const p = await openBudget('#shared');
  assert.equal(p.d.querySelector('.resume'), null);
  await saved();
  assert.equal(doc('shared').version, 'Starting point');
  p.close();
});

test('on open, each personal tab loads its own default', async () => {
  putVersion('Luke', 'lv1', 'Lean', { ...personDoc('Luke'), income: [{ id: 'Lukei', name: 'Pay', amount: 4000, freq: 'mo' }] });
  putTag('Luke', 'default', 'lv1');
  putVersion('Luke', 'lv2', 'Splurge', personDoc('Luke'));
  putDoc('Luke', { ...personDoc('Luke'), version: 'Splurge', edited: false });
  const p = await openBudget('#luke');
  assert.equal(p.text('k-inc'), '$4,000');
  assert.equal(p.d.querySelector('.resume'), null);
  await p.tab('Amber');
  assert.equal(p.text('k-inc'), '$3,000', 'Amber has no default: her working copy shows');
  p.close();
});

test('tagging another version default takes it off the old one, on Shared and on personal tabs', async () => {
  const p = await openBudget('#shared');
  p.type('#v-name', 'Plan B'); p.click('#v-save'); await wait(50);
  const planB = table.keys().find((k) => k.startsWith('DOC#shared#VERSION#') && !k.endsWith('#v1')).split('#')[3];
  p.click(`[data-vedit="${planB}"]`); p.type('#ve-tag', 'default'); p.click(`[data-vaddtag="${planB}"]`); await wait(50);
  assert.equal(tag('default'), planB);
  const chips = (id) => [...p.d.querySelectorAll('.v-item')].find((li) => li.querySelector(`[data-vedit="${id}"]`))?.querySelector('.v-tags')?.textContent ?? '';
  p.click('[data-vdone]');
  assert.match(chips(planB), /default/);
  assert.doesNotMatch(chips('v1'), /default/, 'old version loses the chip');

  await p.tab('Luke');
  p.type('#v-name', 'A'); p.type('#v-tag', 'default'); p.click('#v-save'); await wait(50);
  p.type('#v-name', 'B'); p.type('#v-tag', 'default'); p.click('#v-save'); await wait(50);
  const ids = table.keys().filter((k) => k.startsWith('DOC#Luke#VERSION#')).map((k) => k.split('#')[3]);
  const b = ids.find((id) => JSON.parse(JSON.stringify(table.get(PK, `DOC#Luke#VERSION#${id}`))).name === 'B');
  assert.equal(tag('default', 'Luke'), b);
  assert.equal(table.keys().filter((k) => k.startsWith('TAG#Luke#')).length, 1, 'one default row, not two');
  assert.equal(p.d.querySelectorAll('.v-item .v-tags').length, 1, 'only one version shows the default chip');
  p.close();
});

test('editing the tag of a version that isn’t loaded leaves the screen alone until it’s loaded', async () => {
  const p = await openBudget('#shared');
  p.type('#v-name', 'Plan B'); p.type('#v-tag', 'stretch'); p.click('#v-save'); await wait(50);
  await p.tab('Luke');
  p.type('#v-name', 'Other'); p.click('#v-save'); await wait(50);
  p.type('#v-name', 'Current'); p.click('#v-save'); await wait(50);
  const other = table.keys().map((k) => k.split('#')).filter((k) => k[1] === 'Luke' && k[2] === 'VERSION')
    .map((k) => k[3]).find((id) => version('Luke', id).name === 'Other');
  p.click(`[data-vedit="${other}"]`); p.type('#ve-follow', 'stretch', 'change'); p.click(`[data-vsave="${other}"]`); await saved();
  assert.equal(doc('Luke').follows, 'default');
  assert.equal(p.text('ro-Lukes'), '$500');
  p.click(`[data-vload="${other}"]`); await saved();
  assert.equal(doc('Luke').follows, 'stretch');
  assert.equal(p.text('ro-Lukes'), '$1,000'); // 50% of Plan B's $2,000
  p.close();
});

test('savings and left over show yearly totals', async () => {
  const p = await openBudget('#luke'); // $3,000/mo pay, $500/mo to shared
  assert.equal(p.text('k-left'), '$2,500');
  assert.equal(p.text('k-left-yr'), '$30,000 / yr to spare');
  p.click('[data-ckind="Lukec"]'); await wait(); // count "Needs" ($500) as saving instead
  assert.equal(p.text('k-save-yr'), '$6,000 / yr · 17% of income');
  p.type('#a-Lukei', '200'); await wait(); // income below costs
  assert.equal(p.text('k-left-yr'), 'Over by $3,600 / yr');
  p.close();
});

// --- Down payment sources ------------------------------------------------------------------

const house = (mortgage) => ({ categories: [], mortgage: { price: 600000, rate: 6, years: 30, ...mortgage }, split: 50 });

test('an old single down payment becomes one source, with the same loan', async () => {
  seed({ working: house({ down: 400000 }) });
  const p = await openBudget('#shared');
  assert.equal(p.text('m-down'), '$400,000');
  assert.equal(p.text('m-loan'), '$200,000');
  assert.equal(p.d.querySelectorAll('.dp-row').length, 1);
  assert.equal(p.el('.dp-row [data-dpf="name"]').value, 'Down payment');
  assert.equal(p.d.getElementById('m-down-r'), null, 'no slider');
  p.type('.dp-row [data-dpf="name"]', 'Sale of current home'); await saved();
  assert.deepEqual(doc('shared').mortgage.downItems.map((i) => [i.name, i.amount]), [['Sale of current home', 400000]]);
  p.close();
});

test('down payment is the sum of its sources: add, edit, remove', async () => {
  seed({ working: house({ down: 0 }) });
  const p = await openBudget('#shared');
  assert.equal(p.text('m-loan'), '$600,000');
  assert.ok(p.d.querySelector('.dp-empty'));

  p.click('#dp-add'); await wait();
  assert.equal(p.d.activeElement.dataset.dpf, 'name', 'new source is focused');
  p.type(p.d.activeElement, 'Savings');
  p.type('.dp-row:last-of-type [data-dpf="amount"]', '150,000');
  p.click('#dp-add'); await wait();
  p.type(p.d.activeElement, 'Gift from parents');
  p.type([...p.d.querySelectorAll('.dp-row [data-dpf="amount"]')].at(-1), '50000');
  assert.equal(p.text('m-down'), '$200,000');
  assert.equal(p.text('m-loan'), '$400,000');
  assert.equal(p.text('m-down-pct'), '(33%)');
  await saved();
  const m = doc('shared').mortgage;
  assert.equal(m.down, 200000);
  assert.deepEqual(m.downItems.map((i) => i.name), ['Savings', 'Gift from parents']);

  p.click(`[data-dpdel="${m.downItems[0].id}"]`); await saved();
  assert.equal(p.text('m-down'), '$50,000');
  assert.equal(doc('shared').mortgage.down, 50000);
  p.close();
});

test('sources above the home value mean no loan, and the leftover is noted', async () => {
  seed({ working: house({ downItems: [{ id: 's1', name: 'Sale', amount: 650000 }] }) });
  const p = await openBudget('#shared');
  assert.equal(p.text('m-loan'), '$0');
  assert.equal(p.text('t-mort'), '$0');
  assert.match(p.text('m-fine'), /\$50,000 of the down payment left over/);
  p.close();
});

test('an older saved version (single down payment) still loads and shows the same loan', async () => {
  seed({ working: house({ downItems: [{ id: 's1', name: 'Sale', amount: 100000 }] }) });
  table.put({ pk: PK, sk: 'DOC#shared#VERSION#old', name: 'Old plan', savedAt: 3, state: JSON.stringify(house({ down: 300000 })) });
  const p = await openBudget('#shared');
  assert.match(p.d.querySelector('[data-vload="old"]').closest('.v-item').textContent, /borrow \$300,000/);
  p.click('[data-vload="old"]'); await saved();
  assert.equal(p.text('m-loan'), '$300,000');
  assert.equal(p.el('.dp-row [data-dpf="name"]').value, 'Down payment');
  p.close();
});
