import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { accessToken, forgedToken } from '../../../platform/tests/helpers/tokens.mjs';
import { fakeTable } from '../../../platform/tests/helpers/fake-table.mjs';
import { caller } from '../../../platform/tests/helpers/http.mjs';
import { createApi } from '../api/api.mjs';
import { runSync } from '../api/sync.mjs';
import { fakeNet } from './helpers/fixtures.mjs';
import { testDeps, ROUTES } from './helpers/deps.mjs';

const table = fakeTable();
const member = () => accessToken({ clientId: 'fin-client', group: 'luke_finances', sub: 'luke-sub', username: 'luke-sub' });

let t, call;
beforeEach(async () => {
  table.clear();
  t = testDeps();
  await runSync(t.deps);
  const api = caller(createApi(t.deps), ROUTES);
  call = (m, p, b, tok = member()) => api(m, p, b, tok);
});
const month = async () => (await call('GET', '/month/2026-10')).body;
const idOf = async (desc) => (await month()).txns.find((x) => x.description.startsWith(desc)).id;

test('refuses missing, forged, wrong-group and other-tool tokens', async () => {
  assert.equal((await call('GET', '/month/2026-10', undefined, null)).status, 401);
  assert.equal((await call('GET', '/month/2026-10', undefined, forgedToken({ clientId: 'fin-client', group: 'luke_finances' }))).status, 401);
  assert.equal((await call('GET', '/month/2026-10', undefined, accessToken({ clientId: 'fin-client', group: 'family_budget' }))).status, 403);
  assert.equal((await call('GET', '/month/2026-10', undefined, accessToken({ clientId: 'budget-client', group: 'luke_finances' }))).status, 401);
});

test('the month: budget, MTD by line, transactions, accounts and the last sync', async () => {
  const m = await month();
  assert.equal(m.today, '2026-10-04');
  assert.deepEqual([m.budget.tag, m.budget.version.name, m.budget.sharedTag], ['default', 'October plan', 'default']);
  const coffee = m.summary.lines.find((l) => l.id === 'L.f2');
  assert.deepEqual([coffee.spent, coffee.count, coffee.target], [6.5, 1, 60], 'September’s coffee isn’t in October');
  assert.equal(m.summary.totals.income.spent, 6000);
  assert.equal(m.summary.unassigned.count, 3); // groceries, the card payment and the mystery merchant
  assert.equal(m.txns.length, 5);
  assert.equal(m.txns[0].date, '2026-10-03', 'newest first');
  assert.deepEqual(m.accounts.map((a) => a.name).sort(), ['Checking', 'Rewards Card']);
  assert.deepEqual([m.sync.ok, m.sync.counts.added], [true, 6]);
  assert.equal((await call('GET', '/month/2026-13')).status, 400);
});

test('the trend: this month and the two before, spent per line, same accounts', async () => {
  const m = await month();
  assert.deepEqual(m.trend.map((x) => x.month), ['2026-08', '2026-09', '2026-10']);
  assert.deepEqual(m.trend[1].spent, { 'L.f2': 6.5 }, 'September’s coffee');
  assert.equal(m.trend[1].elapsed, 1);
  assert.equal(m.trend[2].spent['L.i1'], 6000);
  assert.equal(m.trend[2].unassigned, m.summary.unassigned.out);
  assert.equal(m.txns.find((x) => x.description.startsWith('SQ')).merchant, 'SQ BLUE BOTTLE COFFEE');
  const jan = (await call('GET', '/month/2026-01')).body;
  assert.deepEqual(jan.trend.map((x) => x.month), ['2025-11', '2025-12', '2026-01'], 'across the year');
});

test('filing a transaction by hand, and remembering the merchant for the rest', async () => {
  const id = await idOf('SQ *BLUE');
  const r = await call('PUT', `/transactions/${id}`, { line: 'L.f1', remember: true });
  assert.deepEqual(r.body, { updated: 2 }, 'September’s visit follows the correction');
  assert.equal(table.get('LUKE', 'RULE#SQ BLUE BOTTLE COFFEE').line, 'L.f1');
  const m = await month();
  assert.equal(m.txns.find((x) => x.id === id).source, 'you');
  assert.equal(m.summary.lines.find((l) => l.id === 'L.f1').spent, 6.5);

  // Without remember: just this one
  const g = await idOf('Whole Foods');
  assert.deepEqual((await call('PUT', `/transactions/${g}`, { line: 'L.f1' })).body, { updated: 1 });
  assert.equal(table.get('LUKE', 'RULE#WHOLE FOODS'), undefined);
  // Unfiling
  assert.equal((await call('PUT', `/transactions/${g}`, { line: null })).status, 200);
  assert.equal((await month()).txns.find((x) => x.id === g).line, null);
});

test('a hand-filed transaction isn’t moved by a later rule', async () => {
  const sept = table.keys().find((k) => k.startsWith('TXN#2026-09-28'));
  table.put({ ...table.get('LUKE', sept), line: 'L.f1', source: 'you' });
  const id = await idOf('SQ *BLUE');
  assert.deepEqual((await call('PUT', `/transactions/${id}`, { line: 'L.f2', remember: true })).body, { updated: 1 });
  assert.equal(table.get('LUKE', sept).line, 'L.f1');
});

test('correcting Claude: with “same merchant” your rule replaces Claude’s; without, Claude’s is dropped', async () => {
  assert.equal(table.get('LUKE', 'RULE#SQ BLUE BOTTLE COFFEE').by, 'claude');
  const id = await idOf('SQ *BLUE');
  await call('PUT', `/transactions/${id}`, { line: 'L.f1', remember: true });
  assert.deepEqual([table.get('LUKE', 'RULE#SQ BLUE BOTTLE COFFEE').line, table.get('LUKE', 'RULE#SQ BLUE BOTTLE COFFEE').by], ['L.f1', 'luke-sub']);

  const pay = await idOf('ACME');
  assert.equal(table.get('LUKE', 'RULE#ACME CORP PAYROLL').by, 'claude');
  await call('PUT', `/transactions/${pay}`, { line: 'L.f1' });
  assert.equal(table.get('LUKE', 'RULE#ACME CORP PAYROLL'), undefined);
  // …but just this one doesn't touch a rule you made
  await call('PUT', `/transactions/${id}`, { line: 'L.f2' });
  assert.equal(table.get('LUKE', 'RULE#SQ BLUE BOTTLE COFFEE').line, 'L.f1');
});

test('moving a transaction to the month after (or before) it posted', async () => {
  // September’s coffee counts in October instead
  const sept = (await call('GET', '/month/2026-09')).body;
  const id = sept.txns.find((x) => x.description.startsWith('SQ')).id;
  assert.deepEqual((await call('PUT', `/transactions/${id}`, { month: '2026-10' })).body, { updated: 1 });
  assert.equal((await call('GET', '/month/2026-09')).body.txns.length, 0);
  const oct = await month();
  const moved = oct.txns.find((x) => x.id === id);
  assert.deepEqual([moved.date, moved.month, moved.moved], ['2026-09-28', '2026-10', true]);
  assert.equal(oct.summary.lines.find((l) => l.id === 'L.f2').spent, 13, 'both coffees count in October');
  assert.deepEqual([oct.trend[1].spent['L.f2'], oct.trend[2].spent['L.f2']], [undefined, 13], 'and the trend agrees');
  assert.equal(table.get('LUKE', `TXN#${id.replace('.', '#')}`).line, 'L.f2', 'its filing is unchanged');
  // Only a month either side
  assert.equal((await call('PUT', `/transactions/${id}`, { month: '2026-11' })).status, 400);
  assert.equal((await call('PUT', `/transactions/${id}`, { month: 'soon' })).status, 400);
  // Back where it posted
  await call('PUT', `/transactions/${id}`, { month: null });
  assert.equal((await call('GET', '/month/2026-09')).body.txns[0].moved, false);
  assert.equal(table.get('LUKE', `TXN#${id.replace('.', '#')}`).month, undefined);
});

test('a moved transaction is in its new month’s CSV, and keeps the move through a sync', async () => {
  const sept = (await call('GET', '/month/2026-09')).body;
  const id = sept.txns[0].id;
  await call('PUT', `/transactions/${id}`, { month: '2026-10' });
  const api = createApi(t.deps);
  const csv = (m) => api({ routeKey: 'GET /export/{month}', pathParameters: { month: m }, headers: { authorization: `Bearer ${member()}` } }).then((r) => r.body);
  assert.match(await csv('2026-10'), /2026-09-28,2026-10,Rewards Card/);
  assert.doesNotMatch(await csv('2026-09'), /2026-09-28/);
  await runSync(t.deps);
  assert.equal(table.get('LUKE', `TXN#${id.replace('.', '#')}`).month, '2026-10');
});

test('Dot: describes the tool at GET /dot, reads as Luke, and can’t change anything', async () => {
  const dot = () => accessToken({ clientId: 'fin-dot', group: 'luke_finances', sub: 'luke-sub', username: 'luke-sub', via: 'dot' });
  const m = await call('GET', '/dot', undefined, dot());
  assert.equal(m.status, 200);
  assert.deepEqual(m.body.operations.map((o) => `${m.body.name}_${o.name} ${o.path}`), ['finances_month /month/{month}']);
  assert.equal((await call('GET', '/month/2026-10', undefined, dot())).status, 200);
  const id = (await month()).txns[0].id;
  for (const [method, path, body] of [['PUT', `/transactions/${id}`, { line: 'L.f1' }], ['PUT', '/settings', { tag: 'lean' }], ['POST', '/sync'], ['PUT', `/accounts/${'0'.repeat(16)}`, { owner: 'off' }]]) {
    assert.deepEqual(await call(method, path, body, dot()), { status: 403, body: { error: 'read-only' } }, `${method} ${path}`);
  }
  assert.equal((await call('GET', '/dot', undefined, accessToken({ clientId: 'fin-dot', group: 'family_budget' }))).status, 403, 'still only members');
});

test('rejects lines that aren’t in the budget, and bad ids', async () => {
  const id = await idOf('MYSTERY');
  assert.equal((await call('PUT', `/transactions/${id}`, { line: 'L.nope' })).status, 400);
  assert.equal((await call('PUT', '/transactions/2026-10-03.zzzz', { line: 'L.f1' })).status, 400);
  assert.equal((await call('PUT', '/transactions/2026-10-03.0000000000000000', { line: 'L.f1' })).status, 404);
});

test('leaving an account out of the numbers', async () => {
  const card = (await month()).accounts.find((a) => a.name === 'Rewards Card');
  assert.equal((await call('PUT', `/accounts/${card.id}`, { include: false })).status, 200);
  const m = await month();
  assert.equal(m.summary.lines.find((l) => l.id === 'L.f2').spent, 0);
  assert.equal(m.txns.length, 3, 'its transactions aren’t shown either, only the account itself');
  assert.ok(m.accounts.some((a) => a.id === card.id && a.owner === 'off'));
  assert.equal((await call('PUT', `/accounts/${card.id}`, { include: 'no' })).status, 400);
});

test('following another of Luke’s tags re-reads the budget as the person signed in', async () => {
  t.borrowed.length = 0;
  const r = await call('PUT', '/settings', { tag: 'lean' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.budget.version.name, r.body.budget.sharedTag], ['Lean', 'lean']);
  assert.deepEqual(t.borrowed, [{ clientId: 'budget-dot', sub: 'luke-sub', username: 'luke-sub', channel: 'web' }]);
  const m = await month();
  assert.equal(m.settings.tag, 'lean');
  assert.equal(m.summary.lines.find((l) => l.id === 'S.mortgage'), undefined);
  assert.equal((await call('PUT', '/settings', { tag: 'missing' })).status, 409);
  assert.equal((await month()).settings.tag, 'lean', 'a failed switch changes nothing');
  assert.equal((await call('PUT', '/settings', { tag: '../x' })).status, 400);
});

test('the page re-reads a stale budget as the person signed in; a fresh one is used as is', async () => {
  t.borrowed.length = 0;
  await month();
  assert.equal(t.borrowed.length, 0, 'read by the sync a moment ago');
  table.put({ ...table.get('LUKE', 'BUDGET'), fetchedAt: new Date(t.deps.now() - 6 * 60_000).toISOString(), lines: [] });
  const m = await month();
  assert.deepEqual(t.borrowed, [{ clientId: 'budget-dot', sub: 'luke-sub', username: 'luke-sub', channel: 'web' }]);
  assert.ok(m.summary.lines.some((l) => l.id === 'L.f1'), 'the fresh lines, not the stale copy');
  assert.equal(m.budgetError, null);
});

test('following the working copy: live edits show up', async () => {
  const r = await call('PUT', '/settings', { tag: '@working' });
  assert.equal(r.body.budget.version.name, 'Working copy');
  const m = await month();
  assert.equal(m.settings.tag, '@working');
  assert.ok(m.summary.lines.some((l) => l.id === 'L.p1' && l.category === 'Pets'));
});

test('Budget refusing is passed on, not swallowed', async () => {
  const d = testDeps({ net: fakeNet({ budgetStatus: 403 }) });
  const api = caller(createApi(d.deps), ROUTES);
  const r = await api('PUT', '/settings', { tag: 'default' }, member());
  assert.equal(r.status, 502);
  assert.match(r.body.error, /Couldn’t read the budget \(403\)/);
  // A stale copy that can't be refreshed: the month still loads, from it, and says why
  table.put({ ...table.get('LUKE', 'BUDGET'), fetchedAt: new Date(d.deps.now() - 6 * 60_000).toISOString() });
  const m = await api('GET', '/month/2026-10', undefined, member());
  assert.ok(m.body.summary.lines.some((l) => l.id === 'L.f1'));
  assert.equal(m.status, 200);
  assert.match(m.body.budgetError, /Couldn’t read the budget \(403\)/);
});

test('sync now: starts one, but not twice within five minutes', async () => {
  table.put({ ...table.get('LUKE', 'SYNC'), startedAt: new Date(t.deps.now() - 10 * 60_000).toISOString() });
  assert.equal((await call('POST', '/sync')).status, 202);
  assert.equal(t.syncs.length, 1);
  table.put({ ...table.get('LUKE', 'SYNC'), startedAt: new Date(t.deps.now() - 60_000).toISOString() });
  assert.equal((await call('POST', '/sync')).status, 429);
  assert.equal(t.syncs.length, 1);
});

test('CSV export, with spreadsheet formulas defused', async () => {
  const id = await idOf('MYSTERY');
  table.put({ ...table.get('LUKE', `TXN#${id.replace('.', '#')}`), description: '=HYPERLINK("x")' });
  const api = createApi(t.deps);
  const res = await api({ routeKey: 'GET /export/{month}', pathParameters: { month: '2026-10' }, headers: { authorization: `Bearer ${member()}` } });
  assert.equal(res.headers['content-type'], 'text/csv; charset=utf-8');
  const lines = res.body.trim().split('\n');
  assert.equal(lines[0], 'date,counts_in,account,institution,owner,description,amount,group,category,line,filed_by,included');
  assert.equal(lines.length, 6);
  assert.ok(lines.includes('2026-10-01,2026-10,Checking,First Bank,mine,ACME CORP PAYROLL,6000.00,Luke,Income,Paycheck,claude,yes'));
  assert.ok(lines.some((l) => l.includes(`"'=HYPERLINK(""x"")"`)));
  const all = await api({ routeKey: 'GET /export/{month}', pathParameters: { month: 'all' }, headers: { authorization: `Bearer ${member()}` } });
  assert.equal(all.body.trim().split('\n').length, 7, 'September too');
});

test('API Gateway routes match the ones the handler serves', async () => {
  const { readFile } = await import('node:fs/promises');
  const tf = await readFile(new URL('../infra/api.tf', import.meta.url), 'utf8');
  const block = /routes = \[([\s\S]*?)\]/.exec(tf)[1];
  assert.deepEqual([...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort(), [...ROUTES].sort());
});
