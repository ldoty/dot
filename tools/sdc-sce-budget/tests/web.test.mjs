import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PK, businessDoc, call, seed, table } from './helpers/budget-api.mjs';
import { openBudget, saved, wait } from './helpers/page.mjs';

const working = () => JSON.parse(table.get(PK, 'DOC#Business#STATE').state);
const tag = (n) => table.get(PK, `TAG#Business#${n}`)?.versionId;
const versionKeys = () => table.keys().filter((k) => k.startsWith('DOC#Business#VERSION#'));
beforeEach(() => seed());

test('the page holds no figures until it loads them, then shows the month', async () => {
  const p = await openBudget();
  assert.deepEqual(p.requests, ['GET /all']);
  assert.equal(p.text('k-inc'), '$10,000');
  assert.equal(p.text('k-out'), '$6,000');
  assert.equal(p.text('k-save'), '$1,000'); // $12,000 a year
  assert.equal(p.text('k-net'), '$3,000');
  assert.match(p.text('v-cur'), /Working from Plan/);
  p.close();
});

test('an edit saves the working copy with its rev and marks the version edited', async () => {
  const p = await openBudget();
  p.type('#a-r1', '2500'); await saved();
  assert.equal(working().categories[0].items[0].amount, 2500);
  assert.equal(table.get(PK, 'DOC#Business#STATE').rev, 2);
  assert.equal(p.text('k-net'), '$2,500');
  assert.match(p.text('v-cur'), /with unsaved changes/);
  p.close();
});

test('someone else’s save wins: a stale rev loads their copy instead', async () => {
  const p = await openBudget();
  await call('PUT', '/docs/Business/state', { state: businessDoc(9000), rev: 1 });
  p.type('#a-w1', '1'); await saved();
  assert.equal(working().categories[0].items[0].amount, 9000);
  assert.equal(p.el('#a-r1').value, '9000');
  assert.match(p.text('status'), /changed somewhere else/);
  p.close();
});

test('save + tag makes a version, moves the tag, and Load brings it back', async () => {
  const p = await openBudget();
  p.type('#a-r1', '1000'); await saved();
  p.type('#v-name', 'Lean'); p.type('#v-tag', 'lean'); p.click('#v-save'); await wait(50);
  const lean = versionKeys().find((k) => k !== 'DOC#Business#VERSION#v1').split('#')[3];
  assert.equal(tag('lean'), lean);
  assert.equal(JSON.parse(table.get(PK, `DOC#Business#VERSION#${lean}`).state).categories[0].items[0].amount, 1000);
  assert.match(p.text('v-cur'), /Working from Lean$/);
  p.click('[data-vload="v1"]'); await saved();
  assert.equal(p.text('k-net'), '$3,000');
  assert.equal(working().categories[0].items[0].amount, 2000);
  p.close();
});

test('a tagged version can’t be deleted; an untagged one takes two clicks', async () => {
  const p = await openBudget();
  p.click('[data-vdel="v1"]'); await wait(20);
  assert.match(p.text('status'), /tagged default/);
  assert.ok(table.get(PK, 'DOC#Business#VERSION#v1'));
  p.type('#v-name', 'Spare'); p.click('#v-save'); await wait(50);
  const spare = versionKeys().find((k) => k !== 'DOC#Business#VERSION#v1').split('#')[3];
  p.click(`[data-vdel="${spare}"]`);
  assert.ok(table.get(PK, `DOC#Business#VERSION#${spare}`), 'first click only arms it');
  p.click(`[data-vdel="${spare}"]`); await wait(50);
  assert.equal(table.get(PK, `DOC#Business#VERSION#${spare}`), undefined);
  p.close();
});

test('unsaved work isn’t thrown away for the default version', async () => {
  seed({ working: businessDoc(5000) });
  const p = await openBudget();
  assert.ok(p.d.querySelector('.resume'), 'shows the unsaved-changes banner');
  assert.equal(p.el('#a-r1').value, '5000');
  p.click('#resume-default'); p.click('#resume-default'); await saved();
  assert.equal(p.el('#a-r1').value, '2000');
  assert.equal(p.d.querySelector('.resume'), null);
  p.close();
});

test('a new budget starts empty and its first save creates it', async () => {
  table.clear();
  const p = await openBudget();
  assert.equal(p.text('k-inc'), '$0');
  p.click('[data-add="inc"]'); await saved();
  assert.equal(working().income.length, 1);
  assert.equal(table.get(PK, 'DOC#Business#STATE').rev, 1);
  p.click('#add-cat'); await saved();
  assert.equal(working().categories.length, 1);
  p.close();
});

test('categories can be set aside, renamed, reordered and deleted', async () => {
  const p = await openBudget();
  p.click('[data-ckind="c1"]'); await saved();
  assert.equal(working().categories[0].kind, 'save');
  assert.equal(p.text('k-save'), '$7,000');
  p.type('#cn-c2', 'Tax reserve'); await saved();
  assert.equal(working().categories[1].name, 'Tax reserve');
  p.click('[data-cmove="c2"][data-dir="-1"]'); await saved();
  assert.deepEqual(working().categories.map((c) => c.id), ['c2', 'c1']);
  p.click('[data-cdel="c1"]'); p.click('[data-cdel="c1"]'); await saved();
  assert.deepEqual(working().categories.map((c) => c.id), ['c2']);
  p.close();
});

test('an item moves between sections with the arrow keys', async () => {
  const p = await openBudget();
  const grip = p.el('[data-grip="r1"]');
  grip.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); await saved();
  assert.deepEqual(working().income.map((i) => i.id), ['i1', 'r1']);
  p.close();
});
