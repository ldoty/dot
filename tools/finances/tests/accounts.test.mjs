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
  assert.deepEqual([txn('PAYMENT TO CARD').line, txn('PAYMENT TO CARD').source], ['L.h1', 'rule'], 'filed like spending, here by his rule');
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
