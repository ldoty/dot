// Account owners: mine, shared (a joint account: Shared lines only), off
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { accessToken } from '../../../platform/tests/helpers/tokens.mjs';
import { fakeTable } from '../../../platform/tests/helpers/fake-table.mjs';
import { caller } from '../../../platform/tests/helpers/http.mjs';
import { createApi } from '../api/api.mjs';
import { runSync } from '../api/sync.mjs';
import { hash } from '../api/store.mjs';
import { accountSet, fakeNet, fakeClaude } from './helpers/fixtures.mjs';
import { testDeps, ROUTES } from './helpers/deps.mjs';

const table = fakeTable();
beforeEach(() => table.clear());
const CARD = `ACCT#${hash('ACT-card')}`;
const token = () => accessToken({ clientId: 'fin-client', group: 'luke_finances', sub: 'luke-sub', username: 'luke-sub' });
const txn = (desc) => table.dump().map(([, v]) => v).find((r) => r.sk.startsWith('TXN#') && r.description.startsWith(desc));
const sharedCard = () => table.put({ pk: 'LUKE', sk: CARD, simplefinId: 'ACT-card', name: 'Rewards Card', owner: 'shared' });

test('Claude isn’t asked about a shared account’s transactions (hidden until the shared view exists)', async () => {
  sharedCard();
  const claude = fakeClaude(() => '');
  const { deps } = testDeps({ client: claude });
  await runSync(deps);
  assert.equal(table.get('LUKE', CARD).owner, 'shared', 'the sync keeps the owner');
  assert.ok(claude.requests.length > 0, 'his own account’s transactions are still filed');
  assert.ok(!claude.requests.some((r) => /MYSTERY|BLUE BOTTLE/.test(r.messages[0].content)));
  assert.ok(claude.requests.every((r) => !/S\.s1/.test(r.messages[0].content) || /L\.f1/.test(r.messages[0].content)), 'his transactions are offered all the lines');
});

test('rules don’t put a shared account’s transactions under Luke’s own lines', async () => {
  sharedCard();
  table.put({ pk: 'LUKE', sk: 'RULE#SQ BLUE BOTTLE COFFEE', line: 'L.f2', by: 'luke-sub' });
  table.put({ pk: 'LUKE', sk: 'RULE#MYSTERY MERCHANT', line: 'S.s1', by: 'luke-sub' }); // a Shared line: not this budget’s
  const { deps } = testDeps({ client: fakeClaude(() => '') });
  await runSync(deps);
  assert.equal(txn('SQ *BLUE').line, null);
  assert.equal(txn('MYSTERY').line, null, 'a personal tool never files under a Shared line');
  assert.equal(table.get('LUKE', 'RULE#MYSTERY MERCHANT'), undefined, 'and the rule that would is gone');
});

test('money from my account into a shared one: the shared side is a transfer, mine is my contribution', async () => {
  sharedCard();
  const accounts = accountSet();
  accounts.accounts[1].transactions.push({ id: 'C4', posted: Date.parse('2026-10-04T16:00:00Z') / 1000, amount: '500.00', description: 'TRANSFER FROM CHECKING' });
  const { deps } = testDeps({ net: fakeNet({ accounts }), client: fakeClaude(() => '') });
  await runSync(deps);
  assert.equal(txn('TRANSFER FROM').line, 'X.transfer');
  assert.notEqual(txn('PAYMENT TO CARD').line, 'X.transfer', 'filed like spending, under his budget');
});

test('accounts that are off take no part in transfers or filing', async () => {
  table.put({ pk: 'LUKE', sk: CARD, simplefinId: 'ACT-card', name: 'Rewards Card', owner: 'off' });
  const claude = fakeClaude();
  const { deps } = testDeps({ client: claude });
  await runSync(deps);
  assert.ok(!claude.requests.some((r) => r.messages[0].content.includes('MYSTERY')));
  assert.equal(txn('MYSTERY').line, null);
});

test('API: set an account’s owner; a shared account is in the account list only', async () => {
  const t = testDeps();
  await runSync(t.deps);
  const api = caller(createApi(t.deps), ROUTES);
  const call = (m, p, b) => api(m, p, b, token());
  const card = CARD.slice(5);
  const before = (await call('GET', '/month/2026-10')).body;
  assert.deepEqual((await call('PUT', `/accounts/${card}`, { owner: 'shared' })).body, { id: card, owner: 'shared' });
  assert.equal((await call('PUT', `/accounts/${card}`, { owner: 'amber' })).status, 400);
  const m = (await call('GET', '/month/2026-10')).body;
  assert.equal(m.accounts.find((a) => a.id === card).owner, 'shared', 'in the account list');
  assert.ok(!m.txns.some((x) => x.account === card), 'its transactions aren’t shown');
  assert.equal(m.summary.lines.find((l) => l.id === 'L.f2').spent, 0, 'or counted');
  assert.ok(before.summary.lines.find((l) => l.id === 'L.f2').spent > 0);
  assert.ok(!m.trend.some((x) => x.spent['L.f2']), 'or in the trend');
  const csv = await createApi(t.deps)({ routeKey: 'GET /export/{month}', pathParameters: { month: 'all' }, headers: { authorization: `Bearer ${token()}` } });
  assert.doesNotMatch(csv.body, /Rewards Card/, 'or in the CSV');
  // Filing one directly is still checked: Shared lines or Transfers only
  const id = table.keys().find((k) => k.startsWith('TXN#') && table.get('LUKE', k).description === 'MYSTERY MERCHANT').slice(4).replace('#', '.');
  assert.equal((await call('PUT', `/transactions/${id}`, { line: 'L.f1' })).status, 400);
  assert.equal((await call('PUT', `/transactions/${id}`, { line: 'S.s1' })).status, 400, 'Shared lines are Shared Finances’');
  // The old on/off switch still works
  assert.deepEqual((await call('PUT', `/accounts/${card}`, { include: false })).body, { id: card, owner: 'off' });
});

test('making an account shared re-files what Claude put under Luke’s own lines; hand-filed stays', async () => {
  const claude = fakeClaude((t) => (t.description.includes('MYSTERY') ? 'L.f1' : ''));
  const { deps } = testDeps({ client: claude });
  await runSync(deps);
  assert.equal(txn('MYSTERY').line, 'L.f1');
  const blue = txn('SQ *BLUE');
  table.put({ ...blue, line: 'L.f2', source: 'you' });
  table.put({ ...table.get('LUKE', CARD), owner: 'shared' });
  claude.requests.length = 0;
  const r = await runSync(deps);
  assert.equal(txn('MYSTERY').line, null, 'unfiled, to be filed in the shared view');
  assert.ok(!claude.requests.some((q) => q.messages[0].content.includes('MYSTERY')));
  assert.equal(table.get('LUKE', blue.sk).line, 'L.f2');
  assert.equal(r.counts.refiled, 1);
});

test('making an account shared releases my side of transfers matched before: it’s my contribution, to file', async () => {
  const accounts = accountSet();
  accounts.accounts[1].transactions.push({ id: 'C4', posted: Date.parse('2026-10-04T16:00:00Z') / 1000, amount: '500.00', description: 'TRANSFER FROM CHECKING' });
  table.put({ pk: 'LUKE', sk: 'RULE#PAYMENT TO CARD', line: 'L.h1', by: 'luke-sub' });
  const { deps } = testDeps({ net: fakeNet({ accounts }), client: fakeClaude(() => '') });
  await runSync(deps);
  assert.equal(txn('PAYMENT TO CARD').line, 'X.transfer', 'both were mine: a transfer');
  table.put({ ...table.get('LUKE', CARD), owner: 'shared' });
  const r = await runSync(deps);
  assert.equal(r.counts.released, 1);
  assert.deepEqual([txn('PAYMENT TO CARD').line, txn('PAYMENT TO CARD').source], [`X.to.${CARD.slice(5)}`, 'contribution'], 'his contribution, to that account, over his rule');
  assert.equal(txn('TRANSFER FROM').line, 'X.transfer', 'the shared side stays a transfer');
});

test('each deployment keeps its rows under its own partition', async () => {
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb');
  const { makeStore } = await import('../api/store.mjs');
  const amber = makeStore({ db: DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' })), table: 't', pk: 'AMBER' });
  await amber.put({ sk: 'SETTINGS', tag: 'mine' });
  assert.equal(table.get('AMBER', 'SETTINGS').tag, 'mine');
  assert.equal((await amber.settings()).tag, 'mine');
  assert.equal(table.get('LUKE', 'SETTINGS'), undefined);
});

test('filings and rules under the other budget’s lines are cleared, even hand-filed, and filed again', async () => {
  const { deps } = testDeps({ client: fakeClaude(() => '') });
  await runSync(deps);
  const blue = txn('SQ *BLUE');
  table.put({ ...blue, line: 'S.s1', source: 'you' });
  table.put({ pk: 'LUKE', sk: 'RULE#ACME CORP PAYROLL', line: 'SC.sc1', by: 'claude' });
  await runSync(deps);
  assert.equal(table.get('LUKE', blue.sk).line, null);
  assert.equal(table.get('LUKE', 'RULE#ACME CORP PAYROLL'), undefined);
});

test('contributions: an automatic “To <shared account>” line, counted as his spending; hand-filing wins; undone if the account isn’t shared', async () => {
  table.put({ pk: 'LUKE', sk: CARD, simplefinId: 'ACT-card', name: 'Rewards Card', owner: 'shared' });
  const accounts = accountSet();
  accounts.accounts[1].transactions.push({ id: 'C4', posted: Date.parse('2026-10-04T16:00:00Z') / 1000, amount: '500.00', description: 'TRANSFER FROM CHECKING' });
  const t = testDeps({ net: fakeNet({ accounts }), client: fakeClaude(() => '') });
  await runSync(t.deps);
  const line = `X.to.${CARD.slice(5)}`;
  assert.deepEqual([txn('PAYMENT TO CARD').line, txn('PAYMENT TO CARD').source], [line, 'contribution']);
  const api = caller(createApi(t.deps), ROUTES);
  const call = (m, p, b) => api(m, p, b, token());
  const m = (await call('GET', '/month/2026-10')).body;
  const l = m.summary.lines.find((x) => x.id === line);
  assert.deepEqual([l.category, l.name, l.kind, l.spent], ['Shared contributions', 'To Rewards Card', 'spend', 500]);
  assert.equal(m.summary.totals.spend.spent, 500, 'his spending includes it (the coffee is on the shared card now)');
  // Hand-filing wins, and survives a sync
  const id = m.txns.find((x) => x.description === 'PAYMENT TO CARD 1234').id;
  assert.equal((await call('PUT', `/transactions/${id}`, { line: 'L.h1' })).status, 200);
  await runSync(t.deps);
  assert.equal(txn('PAYMENT TO CARD').line, 'L.h1');
  assert.equal((await call('PUT', `/transactions/${id}`, { line })).status, 200, 'and it can be chosen by hand');
  // The account isn't shared any more: no contribution line, and an automatic filing is undone
  table.put({ ...txn('PAYMENT TO CARD'), source: 'contribution' });
  table.put({ ...table.get('LUKE', CARD), owner: 'mine' });
  const r = await runSync(t.deps);
  assert.equal(txn('PAYMENT TO CARD').line, 'X.transfer', 'now a transfer between his own accounts');
  assert.ok(!(await call('GET', '/month/2026-10')).body.summary.lines.some((x) => x.id === line));
});

test('with Budget’s fixed Shared contributions section, contributions go there instead of “To <account>”', async () => {
  const { budgetAll } = await import('./helpers/fixtures.mjs');
  const budget = budgetAll();
  const luke = budget.versions.Luke[0].state;
  luke.categories = [{ id: 'contrib', name: 'Shared contributions', kind: 'spend', locked: true, items: [{ id: 'contrib-share', name: 'Share of shared costs', calc: 'share', person: 'Luke', locked: true }] },
    ...luke.categories.filter((c) => c.id !== 'c2')];
  table.put({ pk: 'LUKE', sk: CARD, simplefinId: 'ACT-card', name: 'Rewards Card', owner: 'shared' });
  const accounts = accountSet();
  accounts.accounts[1].transactions.push({ id: 'C4', posted: Date.parse('2026-10-04T16:00:00Z') / 1000, amount: '500.00', description: 'TRANSFER FROM CHECKING' });
  const claude = fakeClaude(() => '');
  const t = testDeps({ net: fakeNet({ accounts, budget }), client: claude });
  await runSync(t.deps);
  assert.deepEqual([txn('PAYMENT TO CARD').line, txn('PAYMENT TO CARD').source], ['L.contrib-share', 'contribution']);
  const api = caller(createApi(t.deps), ROUTES);
  const m = (await api('GET', '/month/2026-10', undefined, token())).body;
  assert.ok(!m.summary.lines.some((l) => l.id.startsWith('X.to.')), 'no separate “To <account>” lines');
  const l = m.summary.lines.find((x) => x.id === 'L.contrib-share');
  assert.deepEqual([l.category, l.spent, l.target], ['Shared contributions', 500, 1399.1], 'counted against the share from the split');
  assert.ok(!claude.requests.some((r) => r.messages[0].content.includes('L.contrib-share')), 'Claude never guesses into it');
});

test('travel: the fixed Travel line is the person’s part of the travel fund, and the travel account’s contributions go there', async () => {
  const { budgetAll } = await import('./helpers/fixtures.mjs');
  const budget = budgetAll();
  budget.versions.shared[0].state.categories.push({ id: 'tc', name: 'Travel & trips', items: [{ id: 'tr1', name: 'Trips', amount: 300, freq: 'mo', who: 'Shared' }] });
  const luke = budget.versions.Luke[0].state;
  luke.categories = [{ id: 'contrib', name: 'Shared contributions', kind: 'spend', locked: true, items: [
    { id: 'contrib-share', name: 'Share of shared costs', calc: 'share', person: 'Luke', locked: true },
    { id: 'contrib-travel', name: 'Travel', calc: 'travel', person: 'Luke', locked: true },
  ] }, ...luke.categories.filter((c) => c.id !== 'c2')];
  table.put({ pk: 'LUKE', sk: CARD, simplefinId: 'ACT-card', name: 'Rewards Card', owner: 'shared', fund: 'travel' });
  const accounts = accountSet();
  accounts.accounts[1].transactions.push({ id: 'C4', posted: Date.parse('2026-10-04T16:00:00Z') / 1000, amount: '500.00', description: 'TRANSFER FROM CHECKING' });
  const t = testDeps({ net: fakeNet({ accounts, budget }), client: fakeClaude(() => '') });
  await runSync(t.deps);
  assert.equal(table.get('LUKE', CARD).fund, 'travel', 'the sync keeps the fund');
  assert.equal(txn('PAYMENT TO CARD').line, 'L.contrib-travel');
  const api = caller(createApi(t.deps), ROUTES);
  const call = (m, p, b) => api(m, p, b, token());
  const m = (await call('GET', '/month/2026-10')).body;
  const line = (id) => m.summary.lines.find((l) => l.id === id);
  assert.equal(line('L.contrib-travel').target, 150, 'half of $300 of trips');
  assert.equal(line('L.contrib-share').target, 1399.1, 'the rest of his share ($1,549.10 less travel)');
  assert.equal(m.accounts.find((a) => a.id === CARD.slice(5)).fund, 'travel');
  // Back to household costs: the next sync moves it
  assert.deepEqual((await call('PUT', `/accounts/${CARD.slice(5)}`, { fund: 'household' })).body, { id: CARD.slice(5), fund: 'household' });
  assert.equal((await call('PUT', `/accounts/${CARD.slice(5)}`, { fund: 'fun' })).status, 400);
  await runSync(t.deps);
  assert.equal(txn('PAYMENT TO CARD').line, 'L.contrib-share');
});
