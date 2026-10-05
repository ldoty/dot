import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeTable } from '../../../platform/tests/helpers/fake-table.mjs';
import { runSync } from '../api/sync.mjs';
import { PLACEHOLDER } from '../api/simplefin.mjs';
import { accountSet, fakeNet, fakeClaude, SETUP_TOKEN, ACCESS_URL } from './helpers/fixtures.mjs';
import { testDeps, LUKE } from './helpers/deps.mjs';

const table = fakeTable();
beforeEach(() => table.clear());
const rows = (prefix) => table.dump().map(([, v]) => v).filter((r) => r.sk.startsWith(prefix));
const txn = (desc) => rows('TXN#').find((t) => t.description.startsWith(desc));

test('stops politely until the secret is pasted in', async () => {
  const { deps, net } = testDeps({ secret: PLACEHOLDER });
  const r = await runSync(deps);
  assert.equal(r.ok, false);
  assert.match(r.message, /Waiting for a SimpleFIN setup token/);
  assert.equal(net.calls.length, 0);
});

test('claims a setup token once and stores the access URL in its place', async () => {
  const t = testDeps({ secret: SETUP_TOKEN });
  assert.equal((await runSync(t.deps)).ok, true);
  assert.deepEqual(t.secrets.puts, [ACCESS_URL]);
  await runSync(t.deps);
  assert.equal(t.net.calls.filter((c) => c.method === 'POST').length, 1, 'the token is spent: never claimed twice');
});

test('a spent setup token is reported, not retried as an access URL', async () => {
  const t = testDeps({ secret: SETUP_TOKEN, net: fakeNet({ claimStatus: 403 }) });
  const r = await runSync(t.deps);
  assert.deepEqual([r.ok, t.secrets.puts], [false, []]);
  assert.match(r.message, /already used/);
});

test('stores accounts and posted transactions (dated in New York), skipping pending ones', async () => {
  const { deps } = testDeps();
  const r = await runSync(deps);
  assert.deepEqual(r.counts, { accounts: 2, added: 6, updated: 0, transfer: 0, rule: 0, claude: 3 });
  assert.equal(rows('TXN#').length, 6);
  assert.equal(txn('PENDING'), undefined);
  assert.deepEqual([txn('Whole Foods').date, txn('Whole Foods').amount, txn('Whole Foods').merchant], ['2026-10-02', -142.37, 'WHOLE FOODS']);
  const checking = rows('ACCT#').find((a) => a.name === 'Checking');
  assert.deepEqual([checking.org, checking.balance, checking.available, checking.owner], ['First Bank', 2500.1, 2400, 'mine']);
});

test('the first sync asks for 90 days (89 + tomorrow, SimpleFIN’s limit); later ones from a week before the newest transaction', async () => {
  const { deps, net } = testDeps();
  await runSync(deps);
  await runSync(deps);
  const starts = net.calls.filter((c) => c.url.includes('/accounts')).map((c) => Number(new URL(c.url).searchParams.get('start-date')) * 1000);
  assert.equal(new Date(starts[0]).toISOString().slice(0, 10), '2026-07-07');
  assert.equal(new Date(starts[1]).toISOString().slice(0, 10), '2026-09-26');
});

test('reads the budget as Luke with a borrowed token, and logs the read', async () => {
  const { deps, borrowed, net } = testDeps();
  await runSync(deps);
  assert.deepEqual(borrowed, [{ clientId: 'budget-dot', ...LUKE, channel: 'sync' }]);
  assert.equal(net.calls.find((c) => c.url === 'https://budget.api/all').auth, 'Bearer budget-token');
  assert.deepEqual(rows('AUDIT#').map((a) => [a.channel, a.outcome]), [['sync', 'ok']]);
  assert.equal(rows('BUDGET')[0].version.name, 'October plan');
});

test('Claude files new transactions once per budget version; its “don’t know” isn’t re-asked', async () => {
  const claude = fakeClaude();
  const { deps } = testDeps({ client: claude });
  await runSync(deps);
  assert.equal(txn('SQ *BLUE').line, 'L.f2');
  assert.equal(txn('SQ *BLUE').source, 'claude');
  assert.equal(txn('ACME').line, 'L.i1');
  assert.equal(txn('MYSTERY').line, null);
  assert.equal(txn('MYSTERY').asked, 'lv1#2');
  const asked = claude.requests.length;
  await runSync(deps);
  assert.equal(claude.requests.length, asked, 'nothing new to ask about');
});

test('your corrections (rules) win over Claude, and skip excluded accounts', async () => {
  const claude = fakeClaude();
  const { deps } = testDeps({ client: claude });
  table.put({ pk: 'LUKE', sk: 'RULE#WHOLE FOODS', line: 'L.f1' });
  table.put({ pk: 'LUKE', sk: 'RULE#PAYMENT TO CARD', line: 'X.transfer' });
  await runSync(deps);
  assert.deepEqual([txn('Whole Foods').line, txn('Whole Foods').source], ['L.f1', 'rule']);
  assert.equal(txn('PAYMENT').line, 'X.transfer');
  const askedAbout = claude.requests.flatMap((r) => r.messages[0].content.split('\n').filter((l) => l.startsWith('TXN#')));
  assert.ok(!askedAbout.some((l) => l.includes('Whole Foods')), 'Claude isn’t asked about what a rule filed');
});

test('a budget or Claude failure still syncs the bank, and says what went wrong', async () => {
  const claude = { messages: { create: async () => { throw Object.assign(new Error('nope'), { status: 403 }); } } };
  const { deps } = testDeps({ client: claude, net: fakeNet({ budgetStatus: 500 }) });
  const r = await runSync(deps);
  assert.equal(r.ok, true);
  assert.equal(rows('TXN#').length, 6);
  assert.deepEqual(r.errors, ['Budget: Couldn’t read the budget (500).'], 'no budget yet: nothing to file, so Claude isn’t called');
  table.clear();
  const ok = testDeps({ client: claude });
  const r2 = await runSync(ok.deps);
  assert.deepEqual(r2.errors, ['Claude: not enabled for this AWS account yet (Bedrock model access)']);
});

test('the bank’s own problems (e.g. sign in again) are passed along', async () => {
  const { deps } = testDeps({ net: fakeNet({ accounts: { errlist: [{ code: 'con.auth', msg: 'First Bank needs you to sign in again' }], accounts: [] } }) });
  const r = await runSync(deps);
  assert.deepEqual(r.errors, ['First Bank needs you to sign in again']);
});

test('Claude’s pick becomes the merchant’s rule, so a merchant costs one question', async () => {
  const accounts = accountSet(), claude = fakeClaude();
  const { deps } = testDeps({ client: claude, net: fakeNet({ accounts }) });
  await runSync(deps);
  assert.deepEqual([table.get('LUKE', 'RULE#SQ BLUE BOTTLE COFFEE').line, table.get('LUKE', 'RULE#SQ BLUE BOTTLE COFFEE').by], ['L.f2', 'claude']);
  assert.equal(table.get('LUKE', 'RULE#MYSTERY MERCHANT'), undefined, 'no pick, no rule');
  // A new visit next week: filed by the rule, Claude isn't asked
  accounts.accounts[1].transactions.push({ id: 'C9', posted: Date.parse('2026-10-04T16:00:00Z') / 1000, amount: '-7.25', description: 'SQ *BLUE BOTTLE COFFEE 0099' });
  const asked = claude.requests.length;
  const r = await runSync(deps);
  assert.equal(claude.requests.length, asked);
  assert.equal(r.counts.rule, 1);
  const c9 = rows('TXN#2026-10-04')[0];
  assert.deepEqual([c9.line, c9.source], ['L.f2', 'claude'], 'still shown as Claude’s choice');
});

test('Claude never overwrites a rule you made', async () => {
  table.put({ pk: 'LUKE', sk: 'RULE#ACME CORP PAYROLL', line: 'L.f1', by: 'luke-sub' });
  table.put({ pk: 'LUKE', sk: 'RULE#SQ BLUE BOTTLE COFFEE', line: 'L.gone', by: 'luke-sub' }); // a line no longer in the budget
  const { deps } = testDeps();
  await runSync(deps);
  assert.equal(table.get('LUKE', 'RULE#ACME CORP PAYROLL').line, 'L.f1');
  assert.equal(txn('SQ *BLUE').line, 'L.f2', 'Claude files it when the rule’s line is gone…');
  assert.deepEqual([table.get('LUKE', 'RULE#SQ BLUE BOTTLE COFFEE').line, table.get('LUKE', 'RULE#SQ BLUE BOTTLE COFFEE').by], ['L.gone', 'luke-sub'], '…but leaves your rule for you to fix');
});

test('an account added since the last sync gets its full history once', async () => {
  const accounts = accountSet();
  const card = accounts.accounts.pop(); // the card isn't connected yet
  const net = fakeNet({ accounts });
  const { deps } = testDeps({ net, client: fakeClaude(() => '') });
  await runSync(deps);
  accounts.accounts.push(card); // now it is
  const r = await runSync(deps);
  const pulls = net.calls.filter((c) => c.url.includes('/accounts')).map((c) => new URL(c.url).searchParams);
  assert.equal(pulls.length, 3, 'the usual sync, then one for the new account');
  assert.deepEqual(pulls[2].getAll('account'), ['ACT-card']);
  assert.equal(new Date(Number(pulls[2].get('start-date')) * 1000).toISOString().slice(0, 10), '2026-07-07', '89 days back');
  assert.equal(r.counts.backfilled, 1);
  await runSync(deps);
  assert.equal(net.calls.filter((c) => c.url.includes('/accounts')).length, 4, 'only once');
});
