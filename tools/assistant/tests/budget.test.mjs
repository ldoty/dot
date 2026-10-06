// Dot reading the budget with the asker's own access
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBudget } from '../api/budget.mjs';
import { makeTools } from '../api/tools.mjs';

const ALL = {
  docs: { shared: { state: { split: 50, categories: [] }, rev: 3 }, Luke: { state: { income: [] }, rev: 1 }, Amber: { state: { income: [] }, rev: 1 } },
  versions: { shared: [{ id: 'v1', name: 'Starting point', savedAt: Date.UTC(2026, 9, 1), state: { split: 40 } }], Luke: [], Amber: [] },
  tags: { shared: [{ name: 'default', versionId: 'v1' }], Luke: [], Amber: [] },
  plans: [{ id: 'p1', name: 'Pay HELOC', rev: 2, plan: {
    start: '2026-11', months: 24, balance: 5000,
    steps: [{ from: '2026-11', tag: 'default' }, { from: '2027-03', tag: 'gone' }],
    oneOffs: [{ id: 'o1', month: '2026-12', label: 'Check', amount: 200000 }],
  } }, { id: 'p2', name: 'With accounts', rev: 1, plan: {
    start: '2026-11', months: 12, balance: 0, steps: [{ from: '2026-11', tag: 'default' }],
    accounts: [{ id: 'm', name: 'Marcus', balance: 200000, rate: 3.5, savings: true }, { id: 'h', name: 'HELOC', balance: -223000, rate: 8.74, paidBy: 'HELOC' }],
    oneOffs: [{ id: 'o1', month: '2026-11', label: 'Pay down', amount: 200000, account: 'm', to: 'h' }],
  } }],
};

function setup({ tokenFor, status = 200 } = {}) {
  const audits = [], borrowed = [], fetched = [];
  const budget = makeBudget({
    apiUrl: 'https://budget.api', clientId: 'budget-dot', user: { sub: 'amber-sub', username: 'amber-sub' },
    tokenFor: tokenFor || (async (who) => { borrowed.push(who); return 'amber-budget-token'; }),
    audit: async (e) => audits.push(e),
    fetch: async (url, o) => { fetched.push({ url, auth: o.headers.authorization }); return { ok: status < 300, status, json: async () => ALL }; },
  });
  return { budget, audits, borrowed, fetched };
}

test('reads with a token borrowed for the asker, and logs it', async () => {
  const { budget, audits, borrowed, fetched } = setup();
  const r = await budget.read({ doc: 'shared' });
  assert.deepEqual(borrowed, [{ clientId: 'budget-dot', sub: 'amber-sub', username: 'amber-sub', channel: 'web' }]);
  assert.deepEqual(fetched, [{ url: 'https://budget.api/all', auth: 'Bearer amber-budget-token' }]);
  assert.deepEqual(r.working_copy, { split: 50, categories: [] });
  assert.deepEqual(r.versions, [{ name: 'Starting point', saved_at: '2026-10-01T00:00:00.000Z', tags: ['default'] }]);
  assert.deepEqual(audits, [{ tool: 'family_budget', action: 'GET /all', outcome: 'ok' }]);
});

test('a saved version by name or by tag', async () => {
  const { budget } = setup();
  assert.deepEqual((await budget.read({ version: 'default' })).state, { split: 40 });
  assert.deepEqual((await budget.read({ version: 'Starting point' })).state, { split: 40 });
  await assert.rejects(budget.read({ version: 'nope' }), /No saved version or tag "nope".*Starting point/);
});

test('someone outside family_budget gets a plain refusal, and it is logged', async () => {
  const denied = Object.assign(new Error("You don't have access to family_budget."), { denied: true });
  const { budget, audits, fetched } = setup({ tokenFor: async () => { throw denied; } });
  await assert.rejects(budget.read({}), /doesn’t have access to the budget/);
  assert.equal(fetched.length, 0, 'the budget is never called');
  assert.equal(audits[0].outcome, 'denied');
});

test('the budget refusing the token is a refusal too', async () => {
  const { budget, audits } = setup({ status: 403 });
  await assert.rejects(budget.read({}), /doesn’t have access/);
  assert.equal(audits[0].outcome, 'denied');
});

test('tools: no calendars means no calendar tools; read_budget checks which budget', async () => {
  const { budget } = setup();
  const tools = makeTools({ budget });
  assert.deepEqual(tools.definitions.map((d) => d.name), ['read_budget']);
  const bad = await tools.run({ id: 't1', name: 'read_budget', input: { doc: 'Tempi' } });
  assert.equal(bad.is_error, true);
  const cal = await tools.run({ id: 't2', name: 'list_events', input: { calendar: 'luke', start: '2026-10-05', end: '2026-10-06' } });
  assert.match(cal.content, /Unknown tool/);
  const ok = await tools.run({ id: 't3', name: 'read_budget', input: { doc: 'Amber' } });
  assert.equal(JSON.parse(ok.content).budget, 'Amber');
});

test('the shared budget comes with the plans, steps named by the version their tag points to', async () => {
  const { budget } = setup();
  assert.deepEqual((await budget.read({ doc: 'shared' })).plans, [{
    name: 'Pay HELOC', start: '2026-11', months: 24,
    accounts: [{ name: 'Shared accounts', balance: 5000, rate: 0, savings: true }], // an older plan's one starting balance
    steps: [{ from: '2026-11', tag: 'default', version: 'Starting point' }, { from: '2027-03', tag: 'gone', version: null }],
    one_offs: [{ month: '2026-12', label: 'Check', amount: 200000, account: 'Shared accounts' }],
  }, {
    name: 'With accounts', start: '2026-11', months: 12,
    accounts: [{ name: 'Marcus', balance: 200000, rate: 3.5, savings: true }, { name: 'HELOC', balance: -223000, rate: 8.74, paid_by: 'HELOC' }],
    steps: [{ from: '2026-11', tag: 'default', version: 'Starting point' }],
    one_offs: [{ month: '2026-11', label: 'Pay down', amount: 200000, account: 'Marcus', moved_to: 'HELOC' }],
  }]);
  assert.equal((await budget.read({ doc: 'Luke' })).plans, undefined);
  assert.equal((await budget.read({ version: 'default' })).plans, undefined);
});
