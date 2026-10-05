// Shared Finances: the shared accounts from Luke's and Amber's tools, combined and de-duplicated,
// against the Shared budget
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { accessToken } from '../../../platform/tests/helpers/tokens.mjs';
import { fakeTable } from '../../../platform/tests/helpers/fake-table.mjs';
import { caller } from '../../../platform/tests/helpers/http.mjs';
import { createApi } from '../api/api.mjs';
import { runSync, sharedKey } from '../api/sync.mjs';
import { resolveSharedLines } from '../api/budget-lines.mjs';
import { hash } from '../api/store.mjs';
import { budgetAll, fakeNet, fakeClaude } from './helpers/fixtures.mjs';
import { testDeps, ROUTES } from './helpers/deps.mjs';

const table = fakeTable();
beforeEach(() => table.clear());
const LUKE = { app: 'luke_finances', name: 'Luke', sub: 'luke-sub', username: 'luke-sub', api_url: 'https://luke.api', client_id: 'luke-dot' };
const AMBER = { app: 'amber_finances', name: 'Amber', sub: 'amber-sub', username: 'amber-sub', api_url: 'https://amber.api', client_id: 'amber-dot' };
const txn = (account, date, amount, description) => ({ account, date, amount, description, memo: '', merchant: '' });

// The same joint account, connected by both of them, named differently by each connection
const FEEDS = {
  'https://luke.api': {
    accounts: [{ id: 'l1', name: 'Shared (7892)', org: 'Chase Bank', balance: 3000, balanceDate: '2026-10-03T00:00:00Z' }],
    txns: [txn('l1', '2026-10-02', -120, 'PG&E'), txn('l1', '2026-10-03', -4.5, 'Coffee'), txn('l1', '2026-10-03', -4.5, 'Coffee')],
  },
  'https://amber.api': {
    accounts: [
      { id: 'a1', name: 'PREMIER PLUS CKG (7892)', org: 'Chase Bank', balance: 3100, balanceDate: '2026-10-04T00:00:00Z' },
      { id: 'a2', name: 'Chase Freedom Unlimited (0810)', org: 'Chase Bank', balance: -50, balanceDate: '2026-10-04T00:00:00Z' },
    ],
    txns: [txn('a1', '2026-10-02', -120, 'PG&E'), txn('a1', '2026-10-03', -4.5, 'Coffee'), { ...txn('a1', '2026-10-04', 500, 'Online transfer from CHK 5741'), contribution: true }, txn('a2', '2026-10-03', -50, 'Target')],
  },
};

function sharedDeps({ feeds = FEEDS, client = fakeClaude(() => '') } = {}) {
  const net = fakeNet();
  const pulls = [];
  const fetch = async (url, o) => {
    const base = Object.keys(feeds).find((b) => url.startsWith(`${b}/shared/`));
    if (base) {
      pulls.push({ url, auth: o.headers.authorization });
      const f = feeds[base];
      return f instanceof Error ? { ok: false, status: 500, json: async () => ({}) } : { ok: true, status: 200, json: async () => f };
    }
    return net.fetch(url, o);
  };
  const t = testDeps({ client, net: { fetch, calls: net.calls } });
  Object.assign(t.deps, { mode: 'shared', sources: [LUKE, AMBER], fetch, tokenFor: async (who) => `${who.clientId}:${who.sub}` });
  return { ...t, pulls };
}
const rows = (prefix) => table.dump().map(([, v]) => v).filter((r) => r.pk === 'LUKE' && r.sk.startsWith(prefix));

test('accounts match by bank and last 4, whatever each connection calls them', () => {
  assert.equal(sharedKey({ org: 'Chase Bank', name: 'Shared (7892)' }), sharedKey({ org: 'Chase  bank', name: 'PREMIER PLUS CKG (7892)' }));
  assert.notEqual(sharedKey({ org: 'Chase Bank', name: 'Shared (7892)' }), sharedKey({ org: 'Marcus', name: 'Savings (7892)' }));
  assert.equal(sharedKey({ org: 'X', name: 'No digits' }), 'x|no digits');
});

test('reads each person’s tool as them, merges the joint account, and keeps real repeats', async () => {
  const s = sharedDeps();
  const r = await runSync(s.deps);
  assert.deepEqual(s.pulls.map((p) => [p.url, p.auth]), [
    ['https://luke.api/shared/2000-01-01', 'Bearer luke-dot:luke-sub'],
    ['https://amber.api/shared/2000-01-01', 'Bearer amber-dot:amber-sub'],
  ]);
  const accts = rows('ACCT#');
  assert.equal(accts.length, 2, 'the joint checking once, and Amber’s card');
  const joint = accts.find((a) => a.sources.length === 2);
  assert.deepEqual([joint.name, joint.balance, joint.sources, joint.owner], ['PREMIER PLUS CKG (7892)', 3100, ['Luke', 'Amber'], 'shared'], 'the newest balance');
  const t = rows('TXN#');
  assert.equal(t.filter((x) => x.description === 'PG&E').length, 1, 'seen by both: once');
  assert.equal(t.filter((x) => x.description === 'Coffee').length, 2, 'two real coffees (Luke saw both), not three');
  assert.equal(t.length, 5);
  assert.equal(r.counts.added, 5);
  // Again: nothing new, and the next pull starts a week before the newest
  const again = await runSync(s.deps);
  assert.equal(again.counts.added, 0);
  assert.equal(s.pulls.at(-1).url, 'https://amber.api/shared/2026-09-27');
  // A sync from before the feed said who contributions are from reads everything once more
  table.put({ ...table.get('LUKE', 'SYNC'), feed: 1 });
  await runSync(s.deps);
  assert.equal(s.pulls.at(-1).url, 'https://amber.api/shared/2000-01-01');
  await runSync(s.deps);
  assert.equal(s.pulls.at(-1).url, 'https://amber.api/shared/2026-09-27', 'then a week back again');
});

test('if one person’s tool can’t be read, the other’s still syncs, and it says so', async () => {
  const s = sharedDeps({ feeds: { ...FEEDS, 'https://luke.api': new Error('down') } });
  const r = await runSync(s.deps);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, ['Luke’s finances: answered 500']);
  assert.equal(rows('ACCT#').length, 2);
});

test('the Shared budget: whole amounts, General lines, money in, transfers', () => {
  const r = resolveSharedLines(budgetAll(), { tag: 'default' });
  const ids = r.lines.map((l) => l.id);
  assert.deepEqual(ids, ['X.in.Luke', 'X.in.Amber', 'X.in', 'S.mortgage', 'S.s1', 'S.s2', 'SC.sc1', 'X.transfer']);
  const from = (p) => r.lines.find((l) => l.id === `X.in.${p}`);
  assert.deepEqual([from('Luke').name, from('Luke').kind, from('Luke').target], ['From Luke', 'income', 1399.1], 'his share of the split');
  assert.equal(from('Amber').target, 1299.1, 'half of the mortgage and Electric; the car insurance is his');
  assert.equal(r.lines.find((l) => l.id === 'S.s1').target, 200);
  assert.equal(r.version.name, 'Starting point');
  assert.equal(resolveSharedLines(budgetAll(), { tag: '@working' }).lines.find((l) => l.id === 'S.s1').target, 200);
  assert.throws(() => resolveSharedLines(budgetAll(), { tag: 'nope' }), /no tag “nope”/);
});

test('Claude files shared transactions with the Shared lines only', async () => {
  const claude = fakeClaude((x) => (x.description === 'PG&E' ? 'S.s1' : ''));
  const s = sharedDeps({ client: claude });
  await runSync(s.deps);
  const offered = claude.requests[0].messages[0].content.split('Transactions')[0];
  assert.match(offered, /S\.s1/);
  assert.doesNotMatch(offered, /L\.f1/);
  assert.equal(rows('TXN#').find((x) => x.description === 'PG&E').line, 'S.s1');
});

test('the household view: its accounts and transactions, and the Shared budget', async () => {
  const s = sharedDeps();
  await runSync(s.deps);
  const api = caller(createApi(s.deps), ROUTES);
  const m = (await api('GET', '/month/2026-10', undefined, accessToken({ clientId: 'fin-client', group: 'luke_finances', sub: 'amber-sub', username: 'amber-sub' }))).body;
  assert.equal(m.accounts.length, 2);
  assert.equal(m.txns.length, 5);
  assert.ok(m.summary.lines.every((l) => l.group === 'Shared' || l.kind === 'skip'));
  assert.equal(m.summary.unassigned.count, 4, 'Amber’s contribution filed itself');
  const dot = await api('GET', '/dot', undefined, accessToken({ clientId: 'fin-dot', group: 'luke_finances', via: 'dot' }));
  assert.equal(dot.body.name, 'household');
  assert.equal((await api('GET', '/shared/2026-01-01', undefined, accessToken({ clientId: 'fin-client', group: 'luke_finances' }))).status, 404, 'no feed from the shared tool itself');
});

test('a personal tool’s feed: only its shared accounts, from a date, readable by Shared Finances', async () => {
  const t = testDeps();
  await runSync(t.deps);
  const card = `ACCT#${hash('ACT-card')}`;
  table.put({ ...table.get('LUKE', card), owner: 'shared' });
  const api = caller(createApi(t.deps), ROUTES);
  const reader = accessToken({ clientId: 'fin-dot', group: 'luke_finances', sub: 'luke-sub', username: 'luke-sub', via: 'dot' });
  const r = (await api('GET', '/shared/2026-10-01', undefined, reader)).body;
  assert.deepEqual(r.accounts.map((a) => a.name), ['Rewards Card']);
  assert.deepEqual(r.txns.map((x) => x.description).sort(), ['MYSTERY MERCHANT', 'SQ *BLUE BOTTLE COFFEE 0042']);
  assert.ok(r.txns.every((x) => x.date >= '2026-10-01'), 'not September’s');
  assert.equal((await api('GET', '/shared/soon', undefined, reader)).status, 400);
});

test('a contribution is filed under who it came from, from what their own tool saw', async () => {
  const s = sharedDeps();
  const r = await runSync(s.deps);
  const dep = rows('TXN#').find((x) => x.amount === 500);
  assert.deepEqual([dep.from, dep.line, dep.source], ['Amber', 'X.in.Amber', 'contribution']);
  assert.equal(r.counts.contribution, 1);
  // Your own filing wins
  table.put({ ...dep, line: 'X.in', source: 'you' });
  await runSync(s.deps);
  assert.equal(table.get('LUKE', dep.sk).line, 'X.in');
});

test('a personal tool flags the shared side of money it moved in, and says so in its feed', async () => {
  const { accountSet } = await import('./helpers/fixtures.mjs');
  const accounts = accountSet();
  accounts.accounts[1].transactions.push({ id: 'C4', posted: Date.parse('2026-10-04T16:00:00Z') / 1000, amount: '500.00', description: 'TRANSFER FROM CHECKING' });
  const t = testDeps({ net: fakeNet({ accounts }), client: fakeClaude(() => '') });
  table.put({ pk: 'LUKE', sk: `ACCT#${hash('ACT-card')}`, simplefinId: 'ACT-card', name: 'Rewards Card', owner: 'shared' });
  await runSync(t.deps);
  const shared = rows('TXN#').find((x) => x.description === 'TRANSFER FROM CHECKING');
  assert.deepEqual([shared.line, shared.contribution], ['X.transfer', true]);
  const api = caller(createApi(t.deps), ROUTES);
  const feed = (await api('GET', '/shared/2026-10-01', undefined, accessToken({ clientId: 'fin-dot', group: 'luke_finances', sub: 'luke-sub', username: 'luke-sub', via: 'dot' }))).body;
  assert.equal(feed.txns.find((x) => x.description === 'TRANSFER FROM CHECKING').contribution, true);
  assert.equal(feed.txns.find((x) => x.description === 'MYSTERY MERCHANT').contribution, false);
});
