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
  assert.equal(p.text('ro-contrib-share'), '$500'); // 50% of the tagged $1,000, not the working $2,000
  assert.match(p.text('v-cur'), /follows default → “Starting point”/);
  assert.match(p.text('nt-contrib-share'), /From Shared \(default\): 50% of \$1,000/);
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
  assert.equal(p.text('ro-contrib-share'), '$500');
  p.close();
});

test('the split moves one percent at a time', async () => {
  const p = await openBudget('#shared');
  const r = p.el('#split-r');
  r.stepUp(); // one press of the arrow key
  p.type(r, r.value);
  await saved();
  assert.equal(doc('shared').split, 51);
  p.close();
});

test('typing what one person pays sets the split, and the slider follows', async () => {
  const p = await openBudget('#shared'); // a $2,000 shared pool, no items with their own split
  p.el('#s-luke').focus();
  p.type('#s-luke', '1,350'); await saved();
  assert.equal(doc('shared').split, 67.5); // not rounded, so $1,350 stays $1,350
  assert.equal(p.text('s-luke-pct'), 'Luke 67.5%');
  assert.equal(p.el('#s-amber').value, '650');
  assert.equal(p.el('#split-r').value, '68');
  p.el('#s-amber').focus();
  p.type('#s-amber', ''); // cleared to type a new number: nothing changes yet
  assert.equal(doc('shared').split, 67.5);
  p.type('#s-amber', '500'); await saved();
  assert.equal(doc('shared').split, 75);
  p.type('#s-amber', '3000'); await saved();
  p.type('#s-amber', '3000', 'change');
  assert.equal(doc('shared').split, 0);
  assert.equal(p.el('#s-amber').value, '2,000');
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
  assert.equal(p.text('ro-contrib-share'), '$1,400'); // 70% of $2,000
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
  assert.equal(p.text('ro-contrib-share'), '$1,000'); // 50% of the $2,000 working copy saved as Lean

  await p.tab('shared');
  p.click('[data-tagdel="stretch-goal"]'); p.click('[data-tagdel="stretch-goal"]'); await saved();
  assert.equal(tag('stretch-goal'), undefined);
  assert.equal(doc('Amber').follows, 'default');
  p.close();
});

test('a personal version can follow a saved Shared version directly, without a tag', async () => {
  const p = await openBudget('#shared');
  p.type('#v-name', 'Untagged plan'); p.click('#v-save'); await wait(50); // saved, not tagged
  const sv = table.keys().find((k) => k.startsWith('DOC#shared#VERSION#') && k !== 'DOC#shared#VERSION#v1').split('#')[3];
  await p.tab('Luke');
  p.type('#v-name', 'Mine'); p.click('#v-save'); await wait(50);
  const lv = table.keys().find((k) => k.startsWith('DOC#Luke#VERSION#')).split('#')[3];
  p.click(`[data-vedit="${lv}"]`);
  const sel = p.el('#ve-follow');
  assert.deepEqual([...sel.querySelectorAll('optgroup')].map((g) => g.label), ['Shared tags', 'Saved Shared versions']);
  assert.ok([...sel.options].some((o) => o.value === `@v:${sv}` && o.textContent === 'Untagged plan'));
  p.type('#ve-follow', `@v:${sv}`, 'change');
  assert.match(p.text('ve-follow-hint'), /Uses the Shared version “Untagged plan”, even if tags move/);
  p.click(`[data-vsave="${lv}"]`); await saved();
  assert.equal(doc('Luke').follows, `@v:${sv}`);
  assert.equal(p.text('ro-contrib-share'), '$1,000', 'half of its $2,000');
  assert.match(p.text('nt-contrib-share'), /From Shared \(“Untagged plan”\)/);
  assert.match(p.text('v-cur'), /follows “Untagged plan”/);
  p.close();
});

test('moving a tag from the Tags panel', async () => {
  const p = await openBudget('#shared');
  p.type('#v-name', 'Plan B'); p.type('#v-tag', 'default'); p.click('#v-save'); await wait(50);
  p.type('[data-tagsel="default"]', 'v1', 'change'); await wait(50);
  assert.equal(tag('default'), 'v1');
  await p.tab('Luke');
  assert.equal(p.text('ro-contrib-share'), '$500');
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

test('categories: spending/savings toggle on every tab but the fixed section, and empty savings categories survive reload', async () => {
  const p = await openBudget('#luke');
  assert.equal(p.d.querySelectorAll('[data-ckind]').length, 1, 'Needs (the fixed section has none)');
  p.click('[data-ckind="Lukec"]'); await saved();
  assert.equal(doc('Luke').categories.find((c) => c.id === 'Lukec').kind, 'save');
  p.click('#add-cat'); await wait(); p.click(`[data-ckind="${p.d.activeElement.dataset.cname}"]`); await saved();
  p.close();
  const again = await openBudget('#luke');
  assert.equal(again.d.querySelectorAll('.cat-name').length, 2);
  again.close();
  const shared = await openBudget('#shared');
  shared.click('#resume-keep'); await wait();
  shared.click('[data-ckind="c1"]'); await saved();
  assert.equal(doc('shared').categories.find((c) => c.id === 'c1').kind, 'save', 'Shared categories can be Savings too (they count as saved on Planning)');
  assert.match(shared.d.querySelector('[data-cat="c1"] .chip').textContent, /Savings/);
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
  assert.equal(p.text('ro-contrib-share'), '$1,400');
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
  assert.equal(p.text('ro-contrib-share'), '$500');
  p.click(`[data-vload="${other}"]`); await saved();
  assert.equal(doc('Luke').follows, 'stretch');
  assert.equal(p.text('ro-contrib-share'), '$1,000'); // 50% of Plan B's $2,000
  p.close();
});

test('every personal budget has a fixed Shared contributions section, first, from the split', async () => {
  for (const tab of ['#luke', '#amber']) {
    const p = await openBudget(tab);
    const first = p.d.querySelector('section.cat:not([data-cat^="inc-"])'); // first after Income
    assert.equal(first.dataset.cat, 'contrib');
    assert.match(first.querySelector('h2').textContent, /^Shared contributions/);
    assert.equal(first.querySelector('.cat-name, [data-cdel], [data-cmove], [data-ckind], [data-add], [data-del], .grip, input'), null, 'nothing to rename, move, delete, add or edit');
    assert.equal(p.text('ro-contrib-share'), '$500', 'its line is the share from the split');
    p.close();
  }
  // It replaces the old share line; the category that held it keeps its other lines
  const p = await openBudget('#luke');
  assert.deepEqual(doc('Luke').categories.map((c) => c.id), ['Lukec'], 'stored as it was until saved');
  p.type('#a-Lukep', '10'); await saved();
  const stored = doc('Luke');
  assert.deepEqual(stored.categories.map((c) => c.id), ['contrib', 'Lukec']);
  assert.deepEqual(stored.categories[0].items.map((i) => [i.id, i.calc, i.person]), [['contrib-share', 'share', 'Luke'], ['contrib-travel', 'travel', 'Luke']]);
  assert.ok(!stored.categories[1].items.some((i) => i.calc === 'share'));
  // The next category can't move above it
  assert.ok(p.el('[data-cmove="Lukec"][data-dir="-1"]').disabled);
  p.close();
});

test('the fixed Travel line is each person’s part of the Shared travel fund; Share of shared costs is the rest', async () => {
  const v1 = JSON.parse(table.get(PK, 'DOC#shared#VERSION#v1').state);
  v1.categories.push({ id: 'c9', name: 'Travel & trips', kind: 'spend', items: [
    { id: 't1', name: 'Trips', amount: 400, freq: 'mo', who: 'Shared' },
    { id: 't2', name: 'Flights', amount: 100, freq: 'mo', who: 'Split', luke: 100 },
  ] });
  table.put({ ...table.get(PK, 'DOC#shared#VERSION#v1'), state: JSON.stringify(v1) });
  const p = await openBudget('#luke');
  // Luke: half of $1,400 shared ($700) + the $100 flights he alone pays = $800, of which travel is $200 + $100
  assert.equal(p.text('ro-contrib-travel'), '$300');
  assert.equal(p.text('ro-contrib-share'), '$500');
  assert.match(p.text('nt-contrib-travel'), /Your part of Travel & trips/);
  assert.equal(p.d.querySelector('[data-del="contrib-travel"]'), null, 'fixed');
  p.close();
  const a = await openBudget('#amber');
  assert.equal(a.text('ro-contrib-travel'), '$200');
  assert.equal(a.text('ro-contrib-share'), '$500');
  a.close();
});

test('a category named for travel shows it counts by name until one is marked', async () => {
  seed({ working: { ...sharedDoc(1000), categories: [...sharedDoc(1000).categories, { id: 'c9', name: 'Travel, gifts & giving', kind: 'spend', items: [] }] } });
  const p = await openBudget('#shared');
  assert.equal(p.el('[data-cfund="c9"]').textContent, '✓ Travel fund (by name)');
  assert.equal(p.el('[data-cfund="c1"]').textContent, '☐ Travel fund');
  p.click('[data-cfund="c1"]'); await saved(); // marking one by hand: the name rule stops applying
  assert.equal(p.el('[data-cfund="c1"]').textContent, '✓ Travel fund');
  assert.equal(p.el('[data-cfund="c9"]').textContent, '☐ Travel fund');
  p.close();
});

test('on the Shared tab, a category can be marked as the travel fund', async () => {
  const p = await openBudget('#shared');
  const btn = p.el('[data-cfund="c1"]');
  assert.equal(btn.textContent, '☐ Travel fund');
  assert.match(btn.title, /Not part of the travel fund/);
  p.click('[data-cfund="c1"]'); await saved();
  assert.equal(doc('shared').categories[0].fund, 'travel');
  assert.equal(p.el('[data-cfund="c1"]').getAttribute('aria-pressed'), 'true');
  assert.equal(p.el('[data-cfund="c1"]').textContent, '✓ Travel fund');
  p.close();
});

test('savings and left over show yearly totals', async () => {
  const p = await openBudget('#luke'); // $3,000/mo pay, $500/mo to shared
  assert.equal(p.text('k-left'), '$2,500');
  assert.equal(p.text('k-left-yr'), '$30,000 / yr to spare');
  p.type('#a-Lukep', '500'); await wait(); // $500/mo in Needs…
  p.click('[data-ckind="Lukec"]'); await wait(); // …counted as saving instead
  assert.equal(p.text('k-save-yr'), '$6,000 / yr · 17% of income');
  p.type('#a-Lukei', '200'); await wait(); // income below costs ($500 shared + $500 saved)
  assert.equal(p.text('k-left-yr'), 'Over by $9,600 / yr');
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

// --- Paid by: Shared (global split) or Split (Luke pays $X, Amber the rest) ------------------

const bills = (items, split = 50) => ({
  categories: [{ id: 'c1', name: 'Bills', kind: 'spend', items }],
  mortgage: { price: 0, rate: 6, years: 30 }, split,
});
const item = (id, amount, extra) => ({ id, name: id, amount, freq: 'mo', ...extra });

test('old "Luke"/"Amber" items become Split with Luke paying all / none, same shares', async () => {
  seed({ working: bills([item('a', 1000, { who: 'Shared' }), item('b', 300, { who: 'Luke' }), item('c', 200, { who: 'Amber' })]) });
  const p = await openBudget('#shared');
  assert.deepEqual([...p.el('#w-b').options].map((o) => o.value), ['Shared', 'Split']);
  assert.equal(p.el('#w-b').value, 'Split');
  assert.equal(p.el('#sp-b').value, '300');
  assert.equal(p.text('sr-b'), 'Amber $0/mo');
  assert.equal(p.el('#sp-c').value, '0');
  assert.equal(p.text('sr-c'), 'Amber $200/mo');
  assert.equal(p.d.getElementById('sp-a'), null, 'Shared items have no Luke $ field');
  assert.equal(p.text('k-luke'), '$800'); // 50% of 1,000 + 300
  assert.equal(p.text('k-amber'), '$700'); // 50% of 1,000 + 200
  p.close();
});

test('the global split divides Shared items; Split items use Luke’s dollar amount', async () => {
  seed({ working: bills([item('a', 1000, { who: 'Shared' }), item('car', 500, { who: 'Shared' })]) });
  const p = await openBudget('#shared');
  p.type('#w-car', 'Split'); await wait();
  assert.equal(p.el('#sp-car').value, '250', 'starts at the global split, in dollars');
  assert.equal(p.d.activeElement.id, 'sp-car', 'focus moves to Luke’s amount');
  p.type('#sp-car', '$350');
  assert.equal(p.text('sr-car'), 'Amber $150/mo');
  assert.equal(p.text('k-luke'), '$850'); // 50% of 1,000 + 350
  assert.equal(p.text('k-amber'), '$650'); // 50% of 1,000 + 150
  assert.equal(p.text('k-luke-yr'), '50% of shared + $350 split');
  assert.equal(p.text('k-amber-yr'), '50% of shared + $150 split');
  p.type('#split-r', '80');
  assert.equal(p.text('k-luke'), '$1,150'); // 80% of 1,000 + 350; the car doesn’t move
  assert.equal(p.text('k-amber'), '$350');
  assert.match(p.text('s-foot'), /\$1,000\/mo of shared costs/);
  await saved();
  const car = doc('shared').categories[0].items[1];
  assert.deepEqual([car.who, car.luke], ['Split', 350]);
  p.close();
});

test('a yearly Split item: Luke’s dollars are per year too', async () => {
  seed({ working: bills([item('ins', 1200, { freq: 'yr', who: 'Split', luke: 900 })]) });
  const p = await openBudget('#shared');
  assert.equal(p.text('sr-ins'), 'Amber $300/yr');
  assert.equal(p.text('k-luke'), '$75'); // 900 / 12
  assert.equal(p.text('k-amber'), '$25');
  p.close();
});

test('Luke’s part above the item is capped: Amber pays $0', async () => {
  seed({ working: bills([item('car', 500, { who: 'Split', luke: 800 })]) });
  const p = await openBudget('#shared');
  assert.equal(p.text('sr-car'), 'More than the item: Amber $0');
  assert.equal(p.text('k-luke'), '$500');
  assert.equal(p.text('k-amber'), '$0');
  p.close();
});

test('switching back to Shared drops Luke’s amount', async () => {
  seed({ working: bills([item('car', 500, { who: 'Split', luke: 350 })]) });
  const p = await openBudget('#shared');
  p.type('#w-car', 'Shared'); await saved();
  assert.equal(p.d.getElementById('sp-car'), null);
  assert.equal(doc('shared').categories[0].items[0].luke, undefined);
  assert.equal(p.text('k-luke'), '$250');
  p.close();
});

test('personal share notes the Split items', async () => {
  seed({ working: bills([]) });
  table.put({ pk: PK, sk: 'DOC#shared#VERSION#v1', name: 'Starting point', savedAt: 1,
    state: JSON.stringify(bills([item('a', 1000, { who: 'Shared' }), item('car', 500, { who: 'Split', luke: 350 })])) });
  const p = await openBudget('#luke');
  assert.equal(p.text('ro-contrib-share'), '$850');
  assert.match(p.text('nt-contrib-share'), /50% of \$1,000 shared costs plus \$350 from items with their own split/);
  p.close();
});

test('a Split amount saved per month converts back to the item’s own period', async () => {
  // Umbrella liability: $450/yr, saved for a few minutes as Luke $18.75/mo
  seed({ working: bills([item('umb', 450, { freq: 'yr', who: 'Split', lukeMonthly: 18.75 })]) });
  const p = await openBudget('#shared');
  assert.equal(p.el('#sp-umb').value, '225');
  assert.equal(p.text('sr-umb'), 'Amber $225/yr');
  p.type('#sp-umb', '225'); await saved();
  const umb = doc('shared').categories[0].items[0];
  assert.deepEqual([umb.luke, umb.lukeMonthly], [225, undefined]);
  p.close();
});

test('switching a yearly item to Split starts Luke at the global split of the yearly amount', async () => {
  seed({ working: bills([item('ins', 1200, { freq: 'yr', who: 'Shared' })]) });
  const p = await openBudget('#shared');
  p.type('#w-ins', 'Split'); await wait();
  assert.equal(p.el('#sp-ins').value, '600');
  assert.equal(p.text('sr-ins'), 'Amber $600/yr');
  p.close();
});

// --- Planning -------------------------------------------------------------------------

// Two Shared versions: "Starting point" (v1, $1,000 bills, tagged default) and "Bigger" (v2: $1,500 bills
// plus $300 in a Savings category, tagged stretch). A plan "Pay HELOC" (p1): 12 months from Jan 2027,
// default for three months, then stretch, with a $10,000 check in February and a starting balance of $2,000.
const PLAN1 = {
  start: '2027-01', months: 12, balance: 2000,
  steps: [{ from: '2027-01', tag: 'default' }, { from: '2027-04', tag: 'stretch' }],
  oneOffs: [{ id: 'o1', month: '2027-02', label: 'Check', amount: 10000 }],
};
function seedPlan(over = {}) {
  const bigger = sharedDoc(1500);
  bigger.categories.push({ id: 'c2', name: 'Savings', kind: 'save', items: [{ id: 'a8', name: 'College', amount: 300, freq: 'mo', who: 'Shared' }] });
  table.put({ pk: PK, sk: 'DOC#shared#VERSION#v2', name: 'Bigger', savedAt: 2, state: JSON.stringify(bigger) });
  table.put({ pk: PK, sk: 'TAG#shared#stretch', versionId: 'v2' });
  table.put({ pk: PK, sk: 'PLAN#p1', name: 'Pay HELOC', rev: 1, plan: JSON.stringify({ ...PLAN1, ...over }) });
}
const planRows = (p) => [...p.d.querySelectorAll('#p-rows tr')].map((tr) => [...tr.children].map((td) => td.textContent));
const planKeys = () => table.keys().filter((k) => k.startsWith('PLAN#'));
const savedPlan = (id = 'p1') => JSON.parse(table.get(PK, `PLAN#${id}`).plan);
const BAL = '[data-p="acct-balance"][data-id="shared"]';
const pick = (p) => [...p.d.querySelectorAll('#p-pick option')].map((o) => o.textContent);

test('Planning: each month uses its step’s tag; savings and one-offs build the running total', async () => {
  seedPlan();
  const p = await openBudget('#plan');
  assert.equal(p.el('[data-tab="plan"]').getAttribute('aria-selected'), 'true');
  const rows = planRows(p);
  assert.equal(rows.length, 12);
  assert.deepEqual(rows[0], ['Jan 2027', 'default → Starting point', '$1,000', '$0', '$0', '', '$2,000']);
  assert.deepEqual(rows[1], ['Feb 2027', 'default → Starting point', '$1,000', '$0', '$0', '$10,000', '$12,000']);
  assert.deepEqual(rows[3], ['Apr 2027', 'stretch → Bigger', '$1,500', '$300', '$0', '', '$12,300']);
  assert.equal(rows[11][6], '$14,700'); // 12,000 + 9 × 300
  assert.equal(p.text('pk-end'), '$14,700');
  assert.equal(p.text('pk-saved'), '$2,700');
  assert.equal(p.d.querySelectorAll('#p-chart g[data-month]').length, 12);
  assert.match(p.d.querySelector('#p-chart .mark').textContent, /stretch/, 'the switch is marked on the chart');
  assert.equal(p.el('#p-warn').hidden, true);
  assert.equal(p.el('#p-name').value, 'Pay HELOC');
  p.close();
});

test('Planning: a category named Savings counts until one is marked, less items with Saved cleared', async () => {
  // Like a real budget: the Savings category was never switched from Spending
  const bigger = sharedDoc(1500);
  bigger.categories.push({ id: 'c2', name: 'Savings', kind: 'spend', items: [
    { id: 'a8', name: 'To savings', amount: 300, freq: 'mo', who: 'Shared' },
    { id: 'a7', name: 'Tuition', amount: 50, freq: 'mo', who: 'Shared' },
  ] });
  seed({ working: bigger });
  table.put({ pk: PK, sk: 'DOC#shared#VERSION#v2', name: 'Bigger', savedAt: 2, state: JSON.stringify(bigger) });
  table.put({ pk: PK, sk: 'TAG#shared#stretch', versionId: 'v2' });
  table.put({ pk: PK, sk: 'PLAN#p1', name: 'Pay HELOC', rev: 1, plan: JSON.stringify({ ...PLAN1, balance: 0, oneOffs: [], steps: [{ from: '2027-01', tag: 'stretch' }] }) });
  const p = await openBudget('#plan');
  assert.deepEqual(planRows(p)[0].slice(2, 4), ['$1,500', '$350']);

  await p.tab('shared');
  assert.equal(p.el('[data-ckind="c2"]').textContent, 'Savings (by name)');
  const tuition = p.el('[data-isave="a7"]');
  assert.equal(tuition.checked, true);
  tuition.click(); await saved(); // clear Saved: tuition is paid, not kept
  assert.equal(doc('shared').categories[1].items[1].notSaved, true);
  assert.equal(p.el('[data-isave="a8"]').checked, true);
  assert.equal(p.d.querySelector('[data-cat="c1"] [data-isave]'), null, 'only items in a savings category have the box');
  p.type('#v-name', 'Bigger'); p.click('#v-save'); await wait(50); // save over the tagged version
  await p.tab('plan');
  assert.deepEqual(planRows(p)[0].slice(2, 4), ['$1,550', '$300']);
  p.close();
});

test('Planning follows a tag when it moves', async () => {
  seedPlan();
  const p = await openBudget('#shared');
  p.click('#resume-keep'); await wait();
  p.type('[data-tagsel="stretch"]', 'v1', 'change'); await wait(50);
  await p.tab('plan');
  assert.deepEqual(planRows(p)[3].slice(1, 4), ['stretch → Starting point', '$1,000', '$0']);
  p.close();
});

test('Planning: changes, one-offs and settings save to the plan’s row with its rev', async () => {
  seedPlan();
  const p = await openBudget('#plan');
  p.type('[data-p="step-from"][data-i="1"]', '2027-06', 'change');
  p.type(BAL, '500');
  p.click('[data-pact="once-add"]'); await wait();
  const id = [...p.d.querySelectorAll('[data-p="once-label"]')].pop().dataset.id;
  p.type(`[data-p="once-label"][data-id="${id}"]`, 'Closing');
  p.type(`[data-p="once-amount"][data-id="${id}"]`, '-40000');
  p.type(`[data-p="once-month"][data-id="${id}"]`, '2027-06', 'change');
  await saved();
  const sp = savedPlan();
  assert.equal(table.get(PK, 'PLAN#p1').rev, 2);
  assert.deepEqual(sp.steps, [{ from: '2027-01', tag: 'default' }, { from: '2027-06', tag: 'stretch' }]);
  assert.deepEqual(sp.accounts, [{ id: 'shared', name: 'Shared accounts', balance: 500, rate: 0, savings: true }], 'the old starting balance became an account');
  assert.equal(sp.balance, 0);
  assert.deepEqual(sp.oneOffs[1], { id, month: '2027-06', label: 'Closing', amount: -40000 });
  const jun = planRows(p)[5];
  assert.deepEqual([jun[5], jun[6]], ['-$40,000', '-$29,200']); // 500 + 10,000 − 40,000 + 300
  assert.ok(p.el('#p-rows tr:nth-child(6) td:last-child').classList.contains('neg'));
  assert.equal(p.el('#pk-end').className, 'val neg');
  p.click('[data-pact="step-del"][data-i="1"]'); await saved();
  assert.deepEqual(savedPlan().steps, [{ from: '2027-01', tag: 'default' }]);
  p.close();
});

test('Planning: a new household starts an unsaved plan on this month, saved only once edited', async () => {
  const p = await openBudget('#plan');
  assert.equal(planRows(p).length, 24);
  assert.match(planRows(p)[0][1], /^default → Starting point/);
  assert.deepEqual(planKeys(), []);
  assert.match(p.text('p-warn'), /Nothing in Shared counts as saved/);
  assert.equal(p.el('[data-pact="plan-del"]').disabled, true, 'the only plan can’t be deleted');
  const end12 = p.el('#p-end').options[11].value; // the twelfth month from the start
  p.type('#p-end', end12, 'change'); await saved();
  assert.equal(planKeys().length, 1);
  const row = table.get(PK, planKeys()[0]);
  assert.deepEqual([row.name, row.rev, JSON.parse(row.plan).months], ['Plan', 1, 12]);
  p.close();
});

test('Planning: the plan runs to the month it ends, which stays put when the start moves', async () => {
  seedPlan(); // Jan–Dec 2027
  const p = await openBudget('#plan');
  assert.equal(p.el('#p-end').value, '2027-12');
  p.type('#p-end', '2028-08', 'change'); await saved();
  assert.equal(savedPlan().months, 20);
  assert.equal(planRows(p).pop()[0], 'Aug 2028');
  p.type('#p-start', '2027-03', 'change'); await saved();
  assert.deepEqual([savedPlan().start, savedPlan().months], ['2027-03', 18]);
  assert.equal(p.el('#p-end').value, '2028-08');
  p.type('#p-end', '2027-03', 'change'); await saved(); // a one-month plan
  assert.equal(savedPlan().months, 1);
  assert.equal(planRows(p).length, 1);
  p.close();
});

test('Planning: a step whose tag is gone says so', async () => {
  seedPlan({ steps: [{ from: '2027-01', tag: 'default' }, { from: '2027-04', tag: 'gone' }] });
  const p = await openBudget('#plan');
  assert.match(p.text('p-warn'), /No Shared version is tagged gone/);
  assert.deepEqual(planRows(p)[3].slice(1, 3), ['gone', '$0']);
  p.close();
});

test('Planning: Spending stacks categories; Saved shows savings, or the running total', async () => {
  seedPlan();
  const p = await openBudget('#plan');
  assert.deepEqual([...p.d.querySelectorAll('#p-legend li')].map((l) => l.textContent), ['Home']);
  p.click('[data-pact="view"][data-v="save"]'); await wait();
  assert.match(p.el('#p-legend').textContent, /Saved \(Savings categories\)/);
  assert.equal(p.el('.cum').hidden, false);
  const cum = p.el('[data-p="cum"]'); cum.checked = true; cum.dispatchEvent(new p.w.Event('change', { bubbles: true }));
  assert.match(p.el('#p-chart svg').getAttribute('aria-label'), /Running total/);
  assert.equal(p.requests.filter((r) => r.startsWith('PUT /plans')).length, 0, 'the view is per viewer, not part of the plan');
  p.close();
});

test('Planning: a stale plan save loads the other person’s copy of that plan', async () => {
  seedPlan();
  const p = await openBudget('#plan');
  table.put({ ...table.get(PK, 'PLAN#p1'), rev: 2, plan: JSON.stringify({ ...PLAN1, balance: 999 }) });
  p.type(BAL, '1'); await saved();
  assert.equal(p.el(BAL).value, '999');
  assert.match(p.text('status'), /“Pay HELOC” was just changed somewhere else/);
  p.close();
});

// --- Named plans and comparing them ---

test('Planning: rename, duplicate and new plans; each is its own row', async () => {
  seedPlan();
  const p = await openBudget('#plan');
  p.type('#p-name', 'Pay HELOC now'); await saved();
  assert.equal(table.get(PK, 'PLAN#p1').name, 'Pay HELOC now');
  assert.deepEqual(pick(p), ['Pay HELOC now']);

  p.click('[data-pact="plan-dup"]'); await saved();
  assert.equal(planKeys().length, 2);
  const copy = planKeys().find((k) => k !== 'PLAN#p1');
  assert.equal(table.get(PK, copy).name, 'Pay HELOC now copy');
  assert.deepEqual(JSON.parse(table.get(PK, copy).plan), savedPlan(), 'same timeline');
  assert.equal(p.el('#p-name').value, 'Pay HELOC now copy', 'the copy is open');

  p.type('#p-name', 'Keep cash'); p.type('#p-name', 'Keep cash', 'change'); p.type(BAL, '7000'); await saved();
  assert.equal(savedPlan().accounts[0].balance, 2000, 'the original is untouched');
  assert.equal(JSON.parse(table.get(PK, copy).plan).accounts[0].balance, 7000);
  assert.deepEqual(pick(p), ['Keep cash', 'Pay HELOC now']);

  p.click('[data-pact="plan-new"]'); await saved();
  assert.equal(planKeys().length, 3);
  assert.equal(planRows(p).length, 24, 'a new plan starts fresh');
  p.close();
});

test('Planning: switching plans saves the one being left and opens the other', async () => {
  seedPlan();
  table.put({ pk: PK, sk: 'PLAN#p2', name: 'Keep cash', rev: 1, plan: JSON.stringify({ ...PLAN1, balance: 50000 }) });
  const p = await openBudget('#plan');
  assert.equal(p.el('#p-name').value, 'Keep cash', 'first by name');
  p.type(BAL, '123');
  p.type('#p-pick', 'p1', 'change'); await saved();
  assert.equal(savedPlan('p2').accounts[0].balance, 123, 'the edit went to the plan being left');
  assert.equal(savedPlan('p1').balance, 2000);
  assert.equal(p.el(BAL).value, '2000');
  p.close();
});

test('Planning: delete takes two clicks, removes the row and opens another plan', async () => {
  seedPlan();
  table.put({ pk: PK, sk: 'PLAN#p2', name: 'Keep cash', rev: 1, plan: JSON.stringify(PLAN1) });
  const p = await openBudget('#plan');
  p.click('[data-pact="plan-del"]'); await wait(50);
  assert.ok(table.get(PK, 'PLAN#p2'), 'one click only arms it');
  p.click('[data-pact="plan-del"]'); await wait(50);
  assert.equal(table.get(PK, 'PLAN#p2'), undefined);
  assert.deepEqual(pick(p), ['Pay HELOC']);
  assert.match(p.text('status'), /Deleted “Keep cash”/);
  p.close();
});

test('Planning: comparing draws the other plan’s running total and the difference', async () => {
  seedPlan();
  // Keep cash: the same, but $5,000 less at the start
  table.put({ pk: PK, sk: 'PLAN#p2', name: 'Keep cash', rev: 1, plan: JSON.stringify({ ...PLAN1, balance: -3000 }) });
  const p = await openBudget('#plan');
  p.type('#p-pick', 'p1', 'change'); await wait();
  assert.equal(p.d.querySelector('#p-chart .cmp-line'), null);
  p.type('#p-cmp', 'p2', 'change'); await wait();
  assert.match(p.el('#p-chart svg').getAttribute('aria-label'), /Running total/, 'comparing shows running totals');
  assert.ok(p.d.querySelector('#p-chart .cmp-line'));
  assert.match(p.el('#p-legend').textContent, /“Keep cash”/);
  assert.match(p.text('pk-end-yr'), /\+\$5,000 vs “Keep cash”/);
  assert.match(p.text('pk-spend-yr'), /You’d pay in \$0 less than “Keep cash”/);
  assert.deepEqual(planRows(p)[11].slice(6), ['$14,700', '$9,700']);
  assert.equal(p.d.querySelectorAll('#p-head th').length, 8);
  assert.ok(![...p.d.querySelectorAll('#p-cmp option')].some((o) => o.value === 'p1'), 'a plan isn’t compared with itself');
  assert.equal(p.requests.filter((r) => r.startsWith('PUT /plans')).length, 0, 'comparing changes no plan');
  p.close();
});

test('Planning: a plan deleted elsewhere goes away when it’s next saved', async () => {
  seedPlan();
  table.put({ pk: PK, sk: 'PLAN#p2', name: 'Keep cash', rev: 1, plan: JSON.stringify(PLAN1) });
  const p = await openBudget('#plan');
  table.delete(PK, 'PLAN#p2');
  p.type(BAL, '1'); await saved();
  assert.equal(table.get(PK, 'PLAN#p2'), undefined, 'not recreated');
  assert.deepEqual(pick(p), ['Pay HELOC']);
  assert.match(p.text('status'), /deleted somewhere else/);
  p.close();
});

test('Planning: comparing a cheaper plan shows how much less you’d pay in', async () => {
  seedPlan();
  // Keep cash stays on default (the $1,000 version) all year; Pay HELOC switches to stretch ($1,800 with savings) in April
  table.put({ pk: PK, sk: 'PLAN#p2', name: 'Keep cash', rev: 1, plan: JSON.stringify({ ...PLAN1, steps: [{ from: '2027-01', tag: 'default' }] }) });
  const p = await openBudget('#plan');
  p.type('#p-pick', 'p2', 'change'); await wait();
  p.type('#p-cmp', 'p1', 'change'); await wait();
  assert.match(p.text('pk-spend-yr'), /You’d pay in \$7,200 less than “Pay HELOC”/); // 9 months × $800
  p.close();
});

// --- Accounts and interest ---

// Shared checking (savings land there), Marcus at 12% (1% a month) and a HELOC at 12% paid by the
// Shared line “Bills” ($1,000/mo in Starting point). Starting point all year; no savings in it.
const ACCOUNTS = [
  { id: 'shared', name: 'Shared checking', balance: 0, rate: 0, savings: true },
  { id: 'marcus', name: 'Marcus', balance: 12000, rate: 12 },
  { id: 'heloc', name: 'HELOC', balance: -12000, rate: 12, paidBy: 'Bills' },
];
function seedAccounts(over = {}) {
  table.put({ pk: PK, sk: 'PLAN#p1', name: 'Pay HELOC', rev: 1, plan: JSON.stringify({
    start: '2027-01', months: 12, balance: 0, steps: [{ from: '2027-01', tag: 'default' }],
    oneOffs: [{ id: 'o1', month: '2027-02', label: 'Pay down', amount: 5000, account: 'marcus', to: 'heloc' }],
    accounts: ACCOUNTS, ...over,
  }) });
}

test('Planning: interest compounds monthly, a loan is paid by its Shared line, and transfers move money', async () => {
  seedAccounts();
  const p = await openBudget('#plan');
  const head = [...p.d.querySelectorAll('#p-head th')].map((t) => t.textContent);
  assert.deepEqual(head, ['Month', 'Using', 'Spending', 'Saved', 'Interest', 'One-offs', 'Paid on loans', 'Running total']);
  const [jan, feb] = planRows(p);
  // Jan: Marcus +120 → 12,120; HELOC −120 → −12,120, then +1,000 from Bills → −11,120
  assert.deepEqual(jan.slice(4), ['$0', '', '$1,000', '$1,000']);
  // Feb: Marcus +121.20 → 12,241.20 − 5,000; HELOC −111.20 → −11,231.20 + 1,000 + 5,000
  assert.deepEqual(feb.slice(4), ['$10', 'moved', '$1,000', '$2,010']);
  assert.match(p.text('pa-heloc'), /^Dec 2027: /);
  assert.match(p.text('pk-int-yr'), /^earned \$/);
  p.close();
});

test('Planning: a loan’s payment stops once it’s paid off', async () => {
  seedAccounts({ oneOffs: [], accounts: [ACCOUNTS[0], { id: 'heloc', name: 'HELOC', balance: -500, rate: 12, paidBy: 'Bills' }] });
  const p = await openBudget('#plan');
  const [jan, feb] = planRows(p);
  assert.deepEqual(jan.slice(6), ['$505', '$0']); // −500 − 5 interest, paid off with 505 of the 1,000
  assert.deepEqual(feb.slice(6), ['$0', '$0']);
  p.close();
});

test('Planning: accounts are edited in the panel and saved with the plan', async () => {
  seedAccounts();
  const p = await openBudget('#plan');
  p.click('[data-pact="acct-add"]'); await wait();
  const id = [...p.d.querySelectorAll('[data-p="acct-name"]')].pop().dataset.id;
  p.type(`[data-p="acct-name"][data-id="${id}"]`, 'Car loan');
  p.type(`[data-p="acct-balance"][data-id="${id}"]`, '-9000');
  p.type(`[data-p="acct-rate"][data-id="${id}"]`, '6.5');
  p.type(`[data-p="acct-savings"][data-id="marcus"]`, 'on', 'change');
  p.type('[data-p="acct-paid"][data-id="heloc"]', '', 'change');
  p.type('[data-p="once-to"][data-id="o1"]', '', 'change');
  await saved();
  const sp = savedPlan();
  assert.deepEqual(sp.accounts.find((a) => a.id === id), { id, name: 'Car loan', balance: -9000, rate: 6.5 });
  assert.deepEqual(sp.accounts.filter((a) => a.savings).map((a) => a.id), ['marcus']);
  assert.equal(sp.accounts.find((a) => a.id === 'heloc').paidBy, undefined);
  assert.deepEqual(sp.oneOffs[0], { id: 'o1', month: '2027-02', label: 'Pay down', amount: 5000, account: 'marcus' }, 'no longer moved: it lands in Marcus');
  assert.ok([...p.d.querySelectorAll('[data-p="acct-paid"][data-id="heloc"] option')].some((o) => o.value === 'Bills'), 'Shared lines to pay a loan by');
  p.close();
});

test('Planning: an account one-offs use can’t be deleted', async () => {
  seedAccounts();
  const p = await openBudget('#plan');
  p.click('[data-pact="acct-del"][data-id="heloc"]'); await wait();
  assert.match(p.text('status'), /One-offs use that account/);
  p.type('[data-p="once-to"][data-id="o1"]', '', 'change'); await wait();
  p.click('[data-pact="acct-del"][data-id="heloc"]'); await saved();
  assert.deepEqual(savedPlan().accounts.map((a) => a.id), ['shared', 'marcus']);
  p.close();
});

test('Planning: Running total stacks each account’s balance, with the total as a line', async () => {
  seedAccounts();
  const p = await openBudget('#plan');
  p.click('[data-pact="view"][data-v="save"]'); await wait();
  const cum = p.el('[data-p="cum"]'); cum.checked = true; cum.dispatchEvent(new p.w.Event('change', { bubbles: true }));
  assert.ok(p.d.querySelector('#p-chart .total-line'));
  assert.deepEqual([...p.d.querySelectorAll('#p-legend li')].map((l) => l.textContent).slice(0, 3), ['Shared checking', 'Marcus', 'HELOC']);
  p.close();
});
