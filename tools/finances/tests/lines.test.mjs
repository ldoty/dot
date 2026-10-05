// Budget lines, month-to-date math, merchant keys and the SimpleFIN client
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLines } from '../api/budget-lines.mjs';
import { elapsedShare, summarize } from '../api/summary.mjs';
import { merchantKey, classify } from '../api/categorize.mjs';
import { claim, fetchAccounts, secretKind, PLACEHOLDER } from '../api/simplefin.mjs';
import { budgetAll, fakeNet, fakeClaude, SETUP_TOKEN, ACCESS_URL } from './helpers/fixtures.mjs';

const line = (r, id) => r.lines.find((l) => l.id === id);

test('follows the chain: Luke’s tag → that version → the Shared tag it follows', () => {
  const r = resolveLines(budgetAll(), { person: 'Luke', tag: 'default' });
  assert.deepEqual([r.version.name, r.sharedTag, r.sharedVersion.name], ['October plan', 'default', 'Starting point']);
  assert.deepEqual(r.tags, ['default', 'lean']);
  const lean = resolveLines(budgetAll(), { person: 'Luke', tag: 'lean' });
  assert.deepEqual([lean.version.name, lean.sharedTag, lean.sharedVersion.name], ['Lean', 'lean', 'No mortgage']);
});

test('Luke’s lines: income, spending, savings, and his share of Shared, monthly', () => {
  const r = resolveLines(budgetAll(), { tag: 'default' });
  assert.deepEqual(line(r, 'L.i1'), { id: 'L.i1', group: 'Luke', category: 'Income', name: 'Paycheck', kind: 'income', target: 6000 });
  assert.equal(line(r, 'L.f1').target, 600);
  assert.equal(line(r, 'L.v1').kind, 'save');
  assert.equal(line(r, 'L.v1').target, 500); // 6000 a year
  // Mortgage on $400k at 6% for 30 years is $2,398.20; half of it plus half of Electric, plus his car insurance
  assert.equal(line(r, 'L.h1').target, 1399.1);
});

test('a personal budget has only the person’s own lines and Transfers; Shared sets their share', () => {
  const r = resolveLines(budgetAll(), { tag: 'default' });
  assert.deepEqual([...new Set(r.lines.map((l) => l.group))], ['Luke', 'Transfers']);
  assert.ok(!r.lines.some((l) => /^(S|SC)\./.test(l.id)), 'no Shared lines: those are Shared Finances’');
  assert.equal(line(r, 'L.h1').target, 1399.1, 'the share of Shared still follows the Shared version');
  const lean = resolveLines(budgetAll(), { tag: 'lean' });
  assert.equal(line(lean, 'L.h1').target, 100 + 200 * 0.6, 'no mortgage, 60/40');
});

test('the working copy: live edits, no saved version needed, and its id moves with each edit', () => {
  const r = resolveLines(budgetAll(), { tag: '@working' });
  assert.equal(r.version.name, 'Working copy');
  assert.equal(r.version.id, 'working@7.3');
  assert.equal(line(r, 'L.p1').category, 'Pets', 'the new category is there');
  assert.equal(line(r, 'L.h1').target, 1918.74, 'and Shared’s working copy (70/30) sets the share');
  assert.equal(r.sharedTag, 'working copy');
});

test('every category has a General line: no budget of its own, counted toward the category', () => {
  const r = resolveLines(budgetAll(), { tag: 'default' });
  assert.deepEqual(line(r, 'LC.c1'), { id: 'LC.c1', group: 'Luke', category: 'Food', name: 'General', kind: 'spend', target: 0, general: true });
  assert.equal(line(r, 'LC.c3').kind, 'save', 'a savings category’s General is savings');
  const food = r.lines.filter((l) => l.category === 'Food' && l.group === 'Luke').map((l) => l.id);
  assert.deepEqual(food, ['L.f1', 'L.f2', 'LC.c1'], 'after the category’s own lines, so their colors don’t move');
  const s = summarize({ month: '2026-10', today: '2026-10-15', lines: r.lines, txns: [{ line: 'LC.c1', amount: -40 }, { line: 'L.f1', amount: -10 }] });
  assert.equal(s.totals.spend.spent, 50);
  assert.equal(s.totals.spend.target, 600 + 60 + 1399.1, 'General adds nothing to the budget');
});

test('a missing tag is a clear error', () => {
  assert.throws(() => resolveLines(budgetAll(), { tag: 'nope' }), (e) => e.status === 409 && /no tag “nope”/.test(e.message));
});

test('month pace and totals', () => {
  assert.equal(elapsedShare('2026-10', '2026-10-04'), 4 / 31);
  assert.equal(elapsedShare('2026-09', '2026-10-04'), 1);
  assert.equal(elapsedShare('2026-11', '2026-10-04'), 0);
  const lines = resolveLines(budgetAll(), { tag: 'default' }).lines;
  const s = summarize({
    month: '2026-10', today: '2026-10-15', lines, txns: [
      { line: 'L.f1', amount: -142.37 }, { line: 'L.f1', amount: 20 }, // a refund lowers spending
      { line: 'L.i1', amount: 6000 },
      { line: 'X.transfer', amount: -500 }, { line: null, amount: -75 }, { line: 'L.gone', amount: -5 },
    ],
  });
  const g = s.lines.find((l) => l.id === 'L.f1');
  assert.deepEqual([g.spent, g.count, g.expected], [122.37, 2, 290.32]);
  assert.deepEqual(s.unassigned, { out: 80, in: 0, count: 2 }, 'a line no longer in the budget counts as unassigned');
  assert.equal(s.totals.income.spent, 6000);
  assert.equal(s.totals.spend.spent, 122.37);
  assert.equal(s.totals.spend.target, 600 + 60 + 1399.1);
});

test('merchant keys ignore store numbers and places', () => {
  assert.equal(merchantKey('SQ *BLUE BOTTLE COFFEE 0042'), 'SQ BLUE BOTTLE COFFEE');
  assert.equal(merchantKey('SQ *BLUE BOTTLE COFFEE 0077'), merchantKey('SQ *BLUE BOTTLE COFFEE 0042'));
  assert.equal(merchantKey('Whole Foods'), 'WHOLE FOODS');
});

test('Claude’s picks are kept only for real transactions and real lines', async () => {
  const lines = resolveLines(budgetAll(), { tag: 'default' }).lines;
  const claude = fakeClaude((t) => (t.id === 'a' ? 'L.f2' : t.id === 'b' ? 'L.made-up' : 'L.f1'));
  claude.messages.create = ((orig) => async (req) => {
    const m = await orig(req);
    m.content[0].input.assignments.push({ id: 'zzz', line: 'L.f1' }); // not asked about
    return m;
  })(claude.messages.create);
  const picks = await classify({ client: claude, model: 'm', lines, txns: [{ id: 'a', description: 'x' }, { id: 'b', description: 'y' }] });
  assert.deepEqual([...picks], [['a', 'L.f2']]);
  const req = claude.requests[0];
  assert.equal(req.tool_choice.type, 'auto', 'forced tool_choice is refused by newer models');
  assert.equal(req.tools[0].strict, true);
});

test('SimpleFIN: tells setup tokens from access URLs and the placeholder', () => {
  assert.equal(secretKind(PLACEHOLDER), 'missing');
  assert.equal(secretKind(''), 'missing');
  assert.equal(secretKind(SETUP_TOKEN), 'setup');
  assert.equal(secretKind(ACCESS_URL), 'access');
  assert.equal(secretKind('hello'), 'missing');
});

test('SimpleFIN: claims a setup token, and a spent one says so', async () => {
  const net = fakeNet();
  assert.equal(await claim(SETUP_TOKEN, net), ACCESS_URL);
  assert.equal(net.calls[0].method, 'POST');
  await assert.rejects(claim(SETUP_TOKEN, fakeNet({ claimStatus: 403 })), /already used/);
});

test('SimpleFIN: credentials go in a Basic header, never the URL', async () => {
  const net = fakeNet({ accounts: { errlist: [{ code: 'con.auth', msg: 'First Bank needs you to sign in again' }], accounts: [] } });
  const r = await fetchAccounts(ACCESS_URL, { start: new Date(Date.UTC(2026, 8, 1)), fetch: net.fetch });
  const c = net.calls[0];
  assert.equal(c.url, `https://bridge.example/simplefin/accounts?start-date=${Date.UTC(2026, 8, 1) / 1000}`);
  assert.equal(c.auth, `Basic ${Buffer.from('u1:p@2').toString('base64')}`);
  assert.deepEqual(r.errors, ['First Bank needs you to sign in again']);
});
