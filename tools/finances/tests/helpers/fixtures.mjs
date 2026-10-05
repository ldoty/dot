// A small household budget (Budget's GET /all) and a fake SimpleFIN, Budget and Claude.

const shared = (over = {}) => ({
  split: 50,
  mortgage: { price: 500000, downItems: [{ id: 'dp1', name: 'Savings', amount: 100000 }], rate: 6, years: 30 },
  categories: [{
    id: 'sc1', name: 'Utilities', items: [
      { id: 's1', name: 'Electric', amount: 200, freq: 'mo', who: 'Shared' },
      { id: 's2', name: 'Car insurance', amount: 1200, freq: 'yr', who: 'Split', luke: 1200 },
    ],
  }],
  ...over,
});

const luke = (over = {}) => ({
  follows: 'default',
  income: [{ id: 'i1', name: 'Paycheck', amount: 6000, freq: 'mo' }],
  categories: [
    { id: 'c1', name: 'Food', items: [{ id: 'f1', name: 'Groceries', amount: 600, freq: 'mo' }, { id: 'f2', name: 'Coffee', amount: 60, freq: 'mo' }] },
    { id: 'c2', name: 'Household', items: [{ id: 'h1', name: 'Share of Shared', calc: 'share', person: 'Luke' }] },
    { id: 'c3', name: 'Savings', kind: 'save', items: [{ id: 'v1', name: 'Roth IRA', amount: 6000, freq: 'yr' }] },
  ],
  ...over,
});

export function budgetAll() {
  // Working copies: Luke has added a Pets category and not saved a version yet
  const working = luke();
  working.categories = [...working.categories, { id: 'c4', name: 'Pets', items: [{ id: 'p1', name: 'Vet', amount: 80, freq: 'mo' }] }];
  return {
    docs: { Luke: { state: working, rev: 7 }, shared: { state: shared({ split: 70 }), rev: 3 } },
    versions: {
      shared: [
        { id: 'sv1', name: 'Starting point', savedAt: 1, state: shared() },
        { id: 'sv2', name: 'No mortgage', savedAt: 2, state: shared({ mortgage: { price: 0, downItems: [] }, split: 60 }) },
      ],
      Luke: [
        { id: 'lv1', name: 'October plan', savedAt: 3, state: luke() },
        { id: 'lv2', name: 'Lean', savedAt: 4, state: luke({ follows: 'lean' }) },
      ],
      Amber: [{ id: 'av1', name: 'Amber’s', savedAt: 5, state: luke() }],
    },
    tags: {
      shared: [{ name: 'default', versionId: 'sv1' }, { name: 'lean', versionId: 'sv2' }],
      Luke: [{ name: 'default', versionId: 'lv1' }, { name: 'lean', versionId: 'lv2' }],
      Amber: [{ name: 'default', versionId: 'av1' }],
    },
  };
}

const at = (iso) => Math.floor(Date.parse(`${iso}T16:00:00Z`) / 1000);

/** SimpleFIN accounts payload */
export function accountSet({ errlist = [] } = {}) {
  return {
    errlist,
    accounts: [
      {
        id: 'ACT-checking', name: 'Checking', currency: 'USD', balance: '2500.10', 'available-balance': '2400.00',
        'balance-date': at('2026-10-04'), org: { name: 'First Bank', domain: 'firstbank.example' },
        transactions: [
          { id: 'T1', posted: at('2026-10-01'), amount: '6000.00', description: 'ACME CORP PAYROLL' },
          { id: 'T2', posted: at('2026-10-02'), amount: '-142.37', description: 'WHOLE FOODS MKT #123 OAKLAND CA', payee: 'Whole Foods' },
          { id: 'T3', posted: at('2026-10-03'), amount: '-500.00', description: 'PAYMENT TO CARD 1234' },
          { id: 'T4', posted: at('2026-10-03'), amount: '-9.99', description: 'PENDING THING', pending: true },
        ],
      },
      {
        id: 'ACT-card', name: 'Rewards Card', currency: 'USD', balance: '-321.00', 'balance-date': at('2026-10-04'), org: { name: 'Card Co' },
        transactions: [
          { id: 'C1', posted: at('2026-10-02'), amount: '-6.50', description: 'SQ *BLUE BOTTLE COFFEE 0042' },
          { id: 'C2', posted: at('2026-09-28'), amount: '-6.50', description: 'SQ *BLUE BOTTLE COFFEE 0042' },
          { id: 'C3', posted: at('2026-10-03'), amount: '-75.00', description: 'MYSTERY MERCHANT' },
        ],
      },
    ],
  };
}

/** A fetch that answers SimpleFIN (claim + accounts) and Budget's /all */
export function fakeNet({ accounts = accountSet(), budget = budgetAll(), claimStatus = 200, accountsStatus = 200, budgetStatus = 200 } = {}) {
  const calls = [];
  const fetch = async (url, o = {}) => {
    calls.push({ url, method: o.method || 'GET', auth: o.headers?.authorization });
    const res = (status, body, text) => ({ ok: status < 300, status, json: async () => body, text: async () => text ?? JSON.stringify(body) });
    if (url === 'https://bridge.example/claim/abc') return res(claimStatus, null, 'https://u1:p%402@bridge.example/simplefin');
    if (url.startsWith('https://bridge.example/simplefin/accounts')) return res(accountsStatus, accounts);
    if (url === 'https://budget.api/all') return res(budgetStatus, budget);
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetch, calls };
}

export const SETUP_TOKEN = Buffer.from('https://bridge.example/claim/abc').toString('base64');
export const ACCESS_URL = 'https://u1:p%402@bridge.example/simplefin';

/** A Claude stand-in: files by keyword, records what it was asked */
export function fakeClaude(pick = (t) => (/COFFEE/.test(t.description) ? 'L.f2' : /PAYROLL/.test(t.description) ? 'L.i1' : '')) {
  const requests = [];
  return {
    requests,
    messages: {
      create: async (req) => {
        requests.push(req);
        const rows = req.messages[0].content.split('Transactions (id, date, amount, account, description):\n')[1].split('\n');
        const assignments = rows.map((r) => { const [id, date, amount, account, description] = r.split('\t'); return { id, line: pick({ id, date, amount, account, description }) }; });
        return { model: 'fake', stop_reason: 'tool_use', usage: {}, content: [{ type: 'tool_use', name: 'assign', input: { assignments } }] };
      },
    },
  };
}
