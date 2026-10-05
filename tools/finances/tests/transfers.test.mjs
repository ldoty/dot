// Transfers: matched in pairs, kept out of every budget number
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeTable } from '../../../platform/tests/helpers/fake-table.mjs';
import { runSync } from '../api/sync.mjs';
import { matchTransfers } from '../api/transfers.mjs';
import { summarize } from '../api/summary.mjs';
import { resolveLines } from '../api/budget-lines.mjs';
import { accountSet, budgetAll, fakeNet, fakeClaude } from './helpers/fixtures.mjs';
import { testDeps } from './helpers/deps.mjs';

const table = fakeTable();
beforeEach(() => table.clear());
const t = (sk, account, date, amount) => ({ sk, account, date, amount });

test('pairs: same amount, opposite signs, different accounts, within 4 days, closest first', () => {
  const m = matchTransfers([
    t('a', 'chk', '2026-10-03', -500), t('b', 'card', '2026-10-05', 500), // a card payment
    t('c', 'chk', '2026-10-01', -40), t('d', 'chk', '2026-10-02', 40), // same account: a refund, not a transfer
    t('e', 'chk', '2026-10-01', -75), t('f', 'sav', '2026-10-09', 75), // 8 days apart
    t('g', 'chk', '2026-10-10', -200), t('h', 'sav', '2026-10-13', 200), t('i', 'sav', '2026-10-11', 200), // closest wins
  ]);
  assert.deepEqual(m.map(([o, i]) => o.sk + i.sk).sort(), ['ab', 'gi']);
});

function withPayment() {
  const accounts = accountSet();
  // The card's side of the $500 payment from checking
  accounts.accounts[1].transactions.push({ id: 'C4', posted: Date.parse('2026-10-04T16:00:00Z') / 1000, amount: '500.00', description: 'PAYMENT THANK YOU' });
  return accounts;
}

test('the sync files both sides of a transfer as Transfers, before rules and Claude', async () => {
  const claude = fakeClaude(() => 'L.i1'); // Claude would call everything income
  table.put({ pk: 'LUKE', sk: 'RULE#PAYMENT TO CARD', line: 'L.f1', by: 'claude' });
  const { deps } = testDeps({ client: claude, net: fakeNet({ accounts: withPayment() }) });
  const r = await runSync(deps);
  const rows = table.dump().map(([, v]) => v).filter((x) => x.sk.startsWith('TXN#'));
  const pay = rows.filter((x) => /PAYMENT/.test(x.description));
  assert.deepEqual(pay.map((x) => [x.line, x.source]), [['X.transfer', 'transfer'], ['X.transfer', 'transfer']]);
  assert.equal(r.counts.transfer, 2);
  assert.equal(table.get('LUKE', 'RULE#PAYMENT TO CARD'), undefined, 'Claude’s wrong rule for it is dropped');
  const asked = claude.requests.flatMap((q) => q.messages[0].content.split('\n')).filter((l) => /PAYMENT/.test(l));
  assert.deepEqual(asked, [], 'Claude isn’t asked about matched transfers');
});

test('your own filing wins over a matched transfer', async () => {
  const { deps } = testDeps({ net: fakeNet({ accounts: withPayment() }) });
  await runSync(deps);
  const sk = table.keys().find((k) => table.get('LUKE', k).description === 'PAYMENT THANK YOU');
  table.put({ ...table.get('LUKE', sk), line: 'L.f1', source: 'you' });
  await runSync(deps);
  assert.equal(table.get('LUKE', sk).line, 'L.f1');
});

test('transfers are in no budget total, and are totalled on their own', () => {
  const lines = resolveLines(budgetAll(), { tag: 'default' }).lines;
  const s = summarize({
    month: '2026-10', today: '2026-10-15', lines,
    txns: [{ line: 'X.transfer', amount: -500 }, { line: 'X.transfer', amount: 500 }, { line: 'L.f1', amount: -100 }],
  });
  assert.deepEqual(s.totals.transfers, { out: 500, in: 500, count: 2 });
  assert.equal(s.totals.income.spent, 0, 'money in from a transfer isn’t income');
  assert.equal(s.totals.spend.spent, 100);
  assert.equal(s.unassigned.count, 0);
  const tr = lines.find((l) => l.id === 'X.transfer');
  assert.deepEqual([tr.group, tr.category, tr.kind, tr.target], ['Transfers', 'Transfers', 'skip', 0]);
});
