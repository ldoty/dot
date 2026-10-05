// A finances tool's API (one deployment per person, and Shared). Routes (all need this tool's token):
//   GET  /month/{month}             -> { month, today, budget, summary, trend, txns, accounts, sync, settings }
//                                    trend: that month and the two before, spent per line
//                                    The budget is re-read when the stored copy is over 5 minutes old
//   PUT  /transactions/{id}         { line?, remember?, month? } -> { updated }
//                                    month: the budget month it counts in, the month before or after
//                                    the one it posted in (null = where it posted); remember = also file this
//                                    merchant's other transactions there, now and in future syncs;
//                                    without it, a rule Claude made for the merchant is dropped
//   PUT  /accounts/{id}             { owner: mine | shared | off }   a shared (joint) account files
//                                    to Shared lines only; off leaves it out of the numbers
//   PUT  /settings                  { tag } -> { budget }   follow another of the person's budget tags, or
//                                    '@working' for the live working copies
//   POST /sync                      start a sync now (at most every 5 minutes)
//   GET  /export/{month}            CSV of that month's transactions ("all" for everything)
//   GET  /dot                       this tool's description for Dot (platform/api/dot-manifest.mjs)
//   GET  /shared/{from}             personal tools: the accounts marked shared and their transactions
//                                    from that date (YYYY-MM-DD), for Shared Finances to read as this person
// Dot reads for the person asking with a token from the delegated client: GET only, everything else is refused.
// The token is re-verified here (signature, issuer, client, expiry, group); API Gateway's
// authorizer is not trusted on its own.
import { verifyAccessToken } from './verify-token.mjs';
import { summarize } from './summary.mjs';
import { refreshBudget, ymd } from './sync.mjs';
import { WORKING } from './budget-lines.mjs';
import { OWNERS, lineFits, ownerOf, txnId, txnKey } from './store.mjs';
import { validateManifest } from './dot-manifest.mjs';

const json = (statusCode, body) => ({
  statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
/** The budget month a transaction counts in: where it posted, unless moved */
const monthOf = (t) => t.month || t.date.slice(0, 7);
const monthBefore = (m, n) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 - n, 1)).toISOString().slice(0, 7);
const SYNC_GAP_MS = 5 * 60_000;
// Shared Finances, for Dot: the household's joint accounts against the Shared budget
const SHARED_MANIFEST = validateManifest({
  name: 'household',
  title: 'Shared Finances',
  description: 'The household’s joint accounts (the ones marked shared in Luke’s and Amber’s finances, combined), each transaction filed under a line of the Shared budget, with how each line is tracking.',
  operations: [{
    name: 'month',
    description: 'One month (YYYY-MM; this month is month to date): totals, every Shared budget line with its budget, spending so far and an even pace (summary.lines), '
      + 'spending per line for the two months before (trend), the joint accounts’ balances, and that month’s transactions with the line each is filed under (null = not filed yet). '
      + 'Amounts are dollars; negative transaction amounts are money out.',
    path: '/month/{month}',
    input: { type: 'object', properties: { month: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$', description: 'YYYY-MM' } }, required: ['month'], additionalProperties: false },
  }],
});

// What Dot sees of this tool (read-only; Dot calls these with the asker's own access)
export const makeManifest = ({ title = 'Luke’s Finances', person = 'Luke' } = {}) => validateManifest({
  name: 'finances',
  title,
  description: `${person}’s own bank and card accounts (from SimpleFIN, synced nightly), each transaction filed under a line of their budget, with how each line is tracking. Joint accounts are left out.`,
  operations: [{
    name: 'month',
    description: 'One month (YYYY-MM; this month is month to date): totals (income, spending, saved, transfers), every budget line with its budget, '
      + `spending so far and where an even pace would be (summary.lines; kind income/spend/save, group ${person} or Shared), spending per line for the two months before (trend), `
      + 'account balances, and that month’s transactions with the line each is filed under (null = not filed yet). Transfers between their own accounts are never spending. '
      + 'Amounts are dollars; negative transaction amounts are money out.',
    path: '/month/{month}',
    input: {
      type: 'object',
      properties: { month: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$', description: 'YYYY-MM' } },
      required: ['month'],
      additionalProperties: false,
    },
  }],
});
// The page re-reads the budget (as the person signed in) when its copy is older than this
const BUDGET_FRESH_MS = 5 * 60_000;

const txnOut = (t) => ({
  id: txnId(t.sk), date: t.date, month: monthOf(t), moved: !!t.month && t.month !== t.date.slice(0, 7), account: t.account.slice(5), amount: t.amount, merchant: t.merchant || '',
  description: t.description, memo: t.memo || '', line: t.line || null, source: t.source || null,
});
const accountOut = (a) => ({
  id: a.sk.slice(5), name: a.name, org: a.org, balance: a.balance, available: a.available,
  balanceDate: a.balanceDate, owner: ownerOf(a), include: ownerOf(a) !== 'off', ...(a.sources ? { sources: a.sources } : {}),
});

function csv(rows) {
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+@\t\r]/.test(s)) s = `'${s}`; // a bank description must never run as a spreadsheet formula
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\n') + '\n';
}

export function createApi(depsOrFactory) {
  let deps = typeof depsOrFactory === 'function' ? null : depsOrFactory;
  return async (event) => {
    deps ??= depsOrFactory();
    const { store } = deps;
    let claims;
    try {
      claims = await verifyAccessToken(event.headers, deps.auth);
    } catch (e) {
      if (!e.status) throw e;
      console.warn('denied', e.message);
      return json(e.status, { error: e.status === 403 ? 'forbidden' : 'unauthorized' });
    }
    const viaDot = claims.via === 'dot' || (deps.dotClientId && claims.client_id === deps.dotClientId);
    if (viaDot && !event.routeKey?.startsWith('GET ')) {
      console.warn('denied: Dot is read-only', event.routeKey, claims.username);
      return json(403, { error: 'read-only' });
    }

    let body = {};
    if (event.body) {
      try {
        body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body);
      } catch {
        return json(400, { error: 'bad json' });
      }
    }
    const p = event.pathParameters ?? {};
    const user = { sub: claims.sub, username: claims.username };

    switch (event.routeKey) {
      case 'GET /month/{month}': {
        if (!MONTH.test(p.month)) return json(400, { error: 'bad month' });
        // Three months of trend, plus a month either side for transactions moved into them
        const earlier = [monthBefore(p.month, 2), monthBefore(p.month, 1)];
        const span = [monthBefore(p.month, 3), ...earlier, p.month, monthBefore(p.month, -1)];
        const [cached, accounts, sync, settings, ...posted] = await Promise.all([
          store.budget(), store.accounts(), store.sync(), store.settings(),
          ...span.map((m) => store.txns(`${m}-`)),
        ]);
        const all = posted.flat();
        const inMonth = (m) => all.filter((t) => monthOf(t) === m);
        const txns = inMonth(p.month), before = earlier.map(inMonth);
        // Live budget: re-read it if the copy is stale; if Budget can't be reached, use the copy
        let budget = cached, budgetError = null;
        if (!cached || deps.now() - Date.parse(cached.fetchedAt) > BUDGET_FRESH_MS) {
          try {
            budget = await refreshBudget(deps, { user, channel: 'web', tag: settings.tag });
          } catch (e) {
            budgetError = `Showing the budget as read ${cached?.fetchedAt ? 'earlier' : 'never'}: ${e.message}`;
          }
        }
        // A person's view: their own accounts only (shared and off ones are in the account list, nowhere
        // else; the shared ones are Shared Finances'). Shared Finances: its (shared) accounts.
        const view = deps.mode === 'shared' ? 'shared' : 'mine';
        const included = new Set(accounts.filter((a) => ownerOf(a) === view).map((a) => a.sk));
        const counted = txns.filter((t) => included.has(t.account));
        const today = ymd(deps.now(), deps.timeZone);
        const lines = budget?.lines || [];
        const brief = (s) => ({ month: s.month, elapsed: s.elapsed, spent: Object.fromEntries(s.lines.filter((l) => l.count).map((l) => [l.id, l.spent])), unassigned: s.unassigned.out });
        const summary = summarize({ month: p.month, today, lines, txns: counted });
        const trend = [
          ...earlier.map((m, i) => brief(summarize({ month: m, today, lines, txns: before[i].filter((t) => included.has(t.account)) }))),
          brief(summary),
        ];
        return json(200, {
          month: p.month, today,
          budget: budget && { tag: budget.tag, version: budget.version, sharedTag: budget.sharedTag, sharedVersion: budget.sharedVersion, tags: budget.tags, fetchedAt: budget.fetchedAt },
          budgetError,
          summary, trend,
          txns: counted.map(txnOut).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
          accounts: accounts.map(accountOut),
          sync: sync && { startedAt: sync.startedAt, at: sync.at, ok: sync.ok, running: !!sync.running, message: sync.message, counts: sync.counts, errors: sync.errors || [] },
          settings: { tag: settings.tag },
        });
      }

      case 'PUT /transactions/{id}': {
        const sk = txnKey(p.id);
        if (!sk) return json(400, { error: 'bad id' });
        const t = await store.get(sk);
        if (!t) return json(404, { error: 'not found' });
        let row = { ...t };
        // Which month it counts in: the month it posted in, or the one before or after
        if ('month' in body) {
          const own = t.date.slice(0, 7), m = body.month || own;
          if (!MONTH.test(m) || ![monthBefore(own, 1), own, monthBefore(own, -1)].includes(m)) return json(400, { error: 'it can count in the month before or after it posted, no further' });
          if (m === own) delete row.month; else row.month = m;
        }
        if (!('line' in body)) {
          await store.put(row);
          return json(200, { updated: 1 });
        }
        const line = body.line === null || body.line === '' ? null : body.line;
        if (line !== null && typeof line !== 'string') return json(400, { error: 'bad line' });
        const budget = await store.budget();
        const target = line && budget?.lines.find((l) => l.id === line);
        if (line && !target) return json(400, { error: 'no such budget line' });
        if (target && !lineFits(ownerOf(await store.get(t.account)), target)) return json(400, { error: 'a shared account’s transactions go under Shared lines or Transfers' });
        await store.put({ ...row, line, source: line ? 'you' : null });
        let updated = 1;
        // Just this one: Claude's rule for the merchant was wrong here, so it goes
        if (!body.remember && t.merchant && (await store.rule(t.merchant))?.by === 'claude') await store.putRule(t.merchant, null);
        if (body.remember && t.merchant) {
          await store.putRule(t.merchant, line, claims.username);
          // Same merchant, not filed by hand: follow the correction
          for (const o of await store.txns()) {
            if (o.sk === sk || o.merchant !== t.merchant || o.source === 'you') continue;
            await store.put({ ...o, line, source: line ? 'rule' : null });
            updated++;
          }
        }
        return json(200, { updated });
      }

      case 'PUT /accounts/{id}': {
        const owner = typeof body.include === 'boolean' ? (body.include ? 'mine' : 'off') : body.owner;
        if (!/^[0-9a-f]{16}$/.test(p.id ?? '') || !OWNERS.includes(owner)) return json(400, { error: 'bad request' });
        const a = await store.get(`ACCT#${p.id}`);
        if (!a) return json(404, { error: 'not found' });
        const { include, ...rest } = a;
        await store.put({ ...rest, owner });
        return json(200, { id: p.id, owner });
      }

      case 'PUT /settings': {
        const tag = typeof body.tag === 'string' ? body.tag : '';
        if (tag !== WORKING && !/^[a-z0-9][a-z0-9_-]{0,29}$/.test(tag)) return json(400, { error: 'bad tag' });
        let budget;
        try {
          budget = await refreshBudget(deps, { user, channel: 'web', tag });
        } catch (e) {
          return json(e.status || 502, { error: e.message });
        }
        await store.put({ sk: 'SETTINGS', tag, updatedAt: new Date(deps.now()).toISOString(), updatedBy: claims.username });
        return json(200, { budget: { tag: budget.tag, version: budget.version, sharedTag: budget.sharedTag, sharedVersion: budget.sharedVersion } });
      }

      case 'POST /sync': {
        const s = await store.sync();
        if (s?.startedAt && deps.now() - Date.parse(s.startedAt) < SYNC_GAP_MS) return json(429, { error: 'A sync ran in the last 5 minutes. Try again shortly.' });
        await deps.startSync();
        return json(202, { started: true });
      }

      case 'GET /export/{month}': {
        if (p.month !== 'all' && !MONTH.test(p.month)) return json(400, { error: 'bad month' });
        const [budget, accounts, ...posted] = await Promise.all([
          store.budget(), store.accounts(),
          ...(p.month === 'all' ? [store.txns()] : [monthBefore(p.month, 1), p.month, monthBefore(p.month, -1)].map((m) => store.txns(`${m}-`))),
        ]);
        const mine = new Set(accounts.filter((a) => ownerOf(a) === (deps.mode === 'shared' ? 'shared' : 'mine')).map((a) => a.sk));
        const txns = posted.flat().filter((t) => mine.has(t.account) && (p.month === 'all' || monthOf(t) === p.month));
        const lines = new Map((budget?.lines || []).map((l) => [l.id, l]));
        const names = new Map(accounts.map((a) => [a.sk, a]));
        const rows = [['date', 'counts_in', 'account', 'institution', 'owner', 'description', 'amount', 'group', 'category', 'line', 'filed_by', 'included']];
        for (const t of txns) {
          const a = names.get(t.account), l = t.line && lines.get(t.line);
          rows.push([t.date, monthOf(t), a?.name, a?.org, ownerOf(a), t.description, t.amount.toFixed(2), l?.group, l?.category, l?.name, t.source, ownerOf(a) === 'off' ? 'no' : 'yes']);
        }
        return {
          statusCode: 200,
          headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${deps.tool || 'finances'}-${p.month}.csv"` },
          body: csv(rows),
        };
      }

      case 'GET /shared/{from}': {
        if (deps.mode === 'shared') return json(404, { error: 'no route' });
        if (!/^\d{4}-\d{2}-\d{2}$/.test(p.from ?? '')) return json(400, { error: 'bad date' });
        const [accounts, txns] = await Promise.all([store.accounts(), store.txns()]);
        const shared = accounts.filter((a) => ownerOf(a) === 'shared');
        const ids = new Set(shared.map((a) => a.sk));
        return json(200, {
          accounts: shared.map((a) => ({ id: a.sk.slice(5), name: a.name, org: a.org, currency: a.currency, balance: a.balance, available: a.available, balanceDate: a.balanceDate })),
          txns: txns.filter((t) => ids.has(t.account) && t.date >= p.from)
            // contribution: this person moved it in from their own account (their tool matched both sides)
            .map((t) => ({ account: t.account.slice(5), date: t.date, amount: t.amount, description: t.description, memo: t.memo || '', merchant: t.merchant || '', contribution: !!t.contribution })),
        });
      }

      case 'GET /dot':
        return json(200, deps.mode === 'shared' ? SHARED_MANIFEST : makeManifest({ title: deps.title, person: deps.person }));

      default:
        return json(404, { error: 'no route' });
    }
  };
}
