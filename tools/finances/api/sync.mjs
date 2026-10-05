// The nightly sync (and "Sync now"): accounts and transactions in, budget → lines, then filing.
//
// 1–2. In: a personal tool (mode 'personal') pulls from SimpleFIN (ingestSimplefin); Shared
//      Finances (mode 'shared') pulls each person's shared accounts from their tool and
//      de-duplicates them (ingestShared).
//   3. Read the budget as the owner (a read-only token from Budget's delegated client, signed with
//      this tool's own key) and resolve the lines of the tag in SETTINGS.
//   4. Transfers: a matched pair (the same amount out of one account and into another) is filed
//      as Transfers, over rules and Claude but never over your own hand-filing. Between your own
//      accounts (or two shared ones) both sides are; from yours into a shared account only the
//      shared side is: your side is your contribution, filed under your budget like spending.
//      Accounts that are off take no part.
//   5. File unfiled transactions: rules first, then Claude. Claude is asked about a transaction
//      once per budget version, so a "don't know" isn't re-asked nightly. Claude's pick for a
//      merchant becomes that merchant's rule (unless it has one), so a merchant costs one
//      question; your correction replaces it (api.mjs).
import { claim, fetchAccounts, secretKind } from './simplefin.mjs';
import { CONTRIBUTION, MONEY_IN, resolveLines, resolveSharedLines, withContributionLines } from './budget-lines.mjs';
import { classify, merchantKey } from './categorize.mjs';
import { hash, lineFits, ownerOf } from './store.mjs';
import { TRANSFER } from './budget-lines.mjs';
import { matchTransfers } from './transfers.mjs';

const DAY = 86_400_000;
// Bumped when what Claude is offered changes (2: each category's General line), so transactions
// it couldn't file before are asked about once more
const ASK = 2;
export const ymd = (ms, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

/** GET /all from Budget with a read-only token borrowed for `user`; each read is audited */
export async function readBudget({ tokenFor, budgetApp, user, channel, audit, fetch = globalThis.fetch }) {
  const record = (outcome, detail) => audit({ tool: 'family_budget', action: 'GET /all', channel, user: user.username, outcome, ...(detail ? { detail } : {}) });
  if (!budgetApp) throw new Error('Budget isn’t connected (no /family/delegation/family_budget).');
  let token;
  try {
    token = await tokenFor({ clientId: budgetApp.client_id, sub: user.sub, username: user.username, channel });
  } catch (e) {
    await record(e.denied ? 'denied' : 'error', e.message);
    throw new Error(e.denied ? 'Budget refused: this account isn’t in family_budget.' : `Couldn’t sign in to Budget: ${e.message}`);
  }
  const res = await fetch(`${budgetApp.api_url}/all`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) { await record(res.status === 403 ? 'denied' : 'error', `budget ${res.status}`); throw new Error(`Couldn’t read the budget (${res.status}).`); }
  await record('ok');
  return res.json();
}

/** Reads the budget as `user` and stores the resolved lines for `tag`; returns the BUDGET row */
export async function refreshBudget(deps, { user, channel, tag }) {
  const all = await readBudget({ ...deps, user, channel, audit: deps.store.audit });
  const resolved = deps.mode === 'shared' ? resolveSharedLines(all, { tag }) : resolveLines(all, { person: deps.person, tag });
  const row = { sk: 'BUDGET', ...resolved, fetchedAt: new Date(deps.now()).toISOString() };
  await deps.store.put(row);
  return row;
}

export async function runSync(deps) {
  const { store, secret, now = () => Date.now(), timeZone, owner, log = () => {} } = deps;
  const startedAt = new Date(now()).toISOString();
  const prev = (await store.sync()) || {};
  await store.put({ ...prev, sk: 'SYNC', startedAt, running: true });
  const finish = async (fields) => {
    const row = { sk: 'SYNC', startedAt, at: new Date(now()).toISOString(), running: false, ...fields };
    await store.put(row);
    return row;
  };

  const existing = new Map((await store.txns()).map((t) => [t.sk, t]));
  const accounts = new Map((await store.accounts()).map((a) => [a.sk, a]));
  const counts = { accounts: 0, added: 0, updated: 0, transfer: 0, rule: 0, claude: 0 };
  const ingest = deps.mode === 'shared' ? ingestShared : ingestSimplefin;
  const got = await ingest(deps, { existing, accounts, counts });
  if (got.stop) return finish({ ok: false, message: got.stop });
  const feed = got.feed ? { feed: got.feed } : {};
  // Whose transactions this view files: the person's own accounts, or the household's shared ones
  const view = deps.mode === 'shared' ? 'shared' : 'mine';

  // 3. The budget, as the owner
  const errors = [...got.errors];
  let budget = await store.budget();
  try {
    budget = await refreshBudget(deps, { user: owner, channel: 'sync', tag: (await store.settings()).tag });
  } catch (e) {
    errors.push(`Budget: ${e.message}`);
  }

  // 4. Transfers between your own accounts
  const rules = new Map((await store.rules()).map((r) => [r.sk.slice(5), r]));
  const ownerOfTxn = (t) => ownerOf(accounts.get(t.account));
  const sides = [];
  const contributions = new Set(); // the shared side of money from my account into a shared one
  const gave = new Map(); // my side of it -> the shared account it went to
  for (const [o, i] of matchTransfers([...existing.values()].filter((t) => ownerOfTxn(t) !== 'off'))) {
    if (ownerOfTxn(o) === ownerOfTxn(i)) sides.push(o, i);
    else {
      sides.push(ownerOfTxn(o) === 'shared' ? o : i);
      if (ownerOfTxn(i) === 'shared') { contributions.add(i.sk); gave.set(o.sk, i.account); }
    }
  }
  // A transfer matched earlier that no longer qualifies (e.g. the other account was since made
  // shared: Luke's side is now his contribution) goes back to be filed like spending
  const keep = new Set(sides.map((x) => x.sk));
  for (const t of [...existing.values()]) {
    if (t.source !== 'transfer' || keep.has(t.sk)) continue;
    const { asked, contribution, ...rest } = t;
    const row = { ...rest, line: null, source: null };
    existing.set(t.sk, row);
    await store.put(row);
    counts.released = (counts.released || 0) + 1;
  }
  for (const side of sides) {
    const t = existing.get(side.sk);
    const contribution = contributions.has(t.sk);
    // Shared Finances files a contribution under who it came from (GET /shared/{from} says so)
    if (!!t.contribution !== contribution) {
      const row = { ...t, contribution };
      existing.set(t.sk, row);
      await store.put(row);
    }
    if (t.source === 'you' || t.line === TRANSFER) continue;
    const row = { ...existing.get(t.sk), line: TRANSFER, source: 'transfer' };
    existing.set(t.sk, row);
    await store.put(row);
    counts.transfer++;
    // A rule Claude made for this merchant was wrong: it's a transfer
    const r = t.merchant && rules.get(t.merchant);
    if (r?.by === 'claude' && r.line !== TRANSFER) { rules.delete(t.merchant); await store.putRule(t.merchant, null); }
  }

  // 4a. A person's contribution: their side of money into a shared account goes under "To <account>",
  // over rules and Claude but never over their own filing. One that's no longer matched is released.
  if (deps.mode !== 'shared') {
    for (const t of [...existing.values()]) {
      const to = gave.get(t.sk), line = to && `${CONTRIBUTION}.${to.slice(5)}`;
      if (t.source === 'contribution' && !line) {
        const { asked, ...rest } = t;
        const row = { ...rest, line: null, source: null };
        existing.set(t.sk, row); await store.put(row);
        counts.released = (counts.released || 0) + 1;
      } else if (line && t.source !== 'you' && t.line !== line) {
        const row = { ...t, line, source: 'contribution' };
        existing.set(t.sk, row); await store.put(row);
        counts.contribution = (counts.contribution || 0) + 1;
      }
    }
  }

  // 4b. Shared Finances: a contribution (money one of them moved in from their own account) goes
  // under "From <name>", over rules and Claude but never over your own filing
  if (deps.mode === 'shared' && budget) {
    const ids = new Set(budget.lines.map((l) => l.id));
    for (const t of [...existing.values()]) {
      const line = t.from && `${MONEY_IN}.${t.from}`;
      if (!line || !ids.has(line) || t.source === 'you' || t.line === line) continue;
      const row = { ...t, line, source: 'contribution' };
      existing.set(t.sk, row);
      await store.put(row);
      counts.contribution = (counts.contribution || 0) + 1;
    }
  }

  // 5. File what's unfiled
  if (budget) {
    if (deps.mode !== 'shared') budget = { ...budget, lines: withContributionLines(budget.lines, [...accounts.values()], deps.person) };
    const lineById = new Map(budget.lines.map((l) => [l.id, l]));
    const fits = (t, id) => lineById.has(id) && lineFits(ownerOfTxn(t), lineById.get(id));
    // A personal tool never files under Shared lines, nor Shared Finances under personal ones: such
    // filings (from before that rule, even by hand) and rules are cleared, to be filed again
    const foreign = (id) => (deps.mode === 'shared' ? /^(L|LC)\./ : /^(S|SC)\./).test(id || '');
    for (const [m, r] of rules) if (foreign(r.line)) { rules.delete(m); await store.putRule(m, null); }
    // Filed under a line its account can't take (e.g. the account was just made shared): file again.
    // Your own hand-filing is left alone, unless it's the other budget's.
    for (const t of [...existing.values()]) {
      if (!t.line) continue;
      if (!foreign(t.line) && (t.source === 'you' || !lineById.has(t.line) || fits(t, t.line))) continue;
      const { asked, ...rest } = t;
      const row = { ...rest, line: null, source: null };
      existing.set(t.sk, row);
      await store.put(row);
      counts.refiled = (counts.refiled || 0) + 1;
    }
    const unfiled = [...existing.values()].filter((t) => !t.line && ownerOfTxn(t) !== 'off');
    const ask = [];
    for (const t of unfiled) {
      const rule = t.merchant && rules.get(t.merchant);
      if (rule && fits(t, rule.line)) {
        await store.put({ ...t, line: rule.line, source: rule.by === 'claude' ? 'claude' : 'rule' });
        counts.rule++;
      } else if (ownerOfTxn(t) === view && t.asked !== `${budget.version.id}#${ASK}`) {
        ask.push(t);
      }
    }
    if (ask.length && deps.client) {
      try {
        // Only this view's accounts: a personal tool leaves its shared accounts to Shared Finances,
        // and a shared account's transactions are offered only the Shared lines (and Transfers)
        const picks = new Map();
        for (const kind of [view]) {
          const these = ask.filter((t) => ownerOfTxn(t) === kind);
          if (!these.length) continue;
          const got = await classify({
            client: deps.client, model: deps.model, log,
            lines: budget.lines.filter((l) => lineFits(kind, l) && !l.auto),
            txns: these.map((t) => ({ id: t.sk, date: t.date, amount: t.amount, description: t.description, account: accounts.get(t.account)?.name || '' })),
          });
          for (const [k, v] of got) picks.set(k, v);
        }
        for (const t of ask) {
          const line = picks.get(t.sk) || null;
          await store.put({ ...t, line, source: line ? 'claude' : null, asked: `${budget.version.id}#${ASK}` });
          if (!line) continue;
          counts.claude++;
          if (t.merchant && !rules.has(t.merchant)) {
            rules.set(t.merchant, { line, by: 'claude' });
            await store.putRule(t.merchant, line, 'claude');
          }
        }
      } catch (e) {
        errors.push(`Claude: ${e.status === 403 ? 'not enabled for this AWS account yet (Bedrock model access)' : e.message}`);
      }
    }
  }

  return finish({ ok: true, message: errors.length ? 'Synced, with problems' : 'Synced', counts, errors, ...feed });
}

/** A personal tool's accounts and transactions, from its SimpleFIN Bridge connection */
async function ingestSimplefin(deps, { existing, accounts, counts }) {
  const { store, secret, now = () => Date.now(), timeZone, log = () => {} } = deps;
  // 1. The secret
  let access = await secret.get();
  const kind = secretKind(access);
  if (kind === 'missing') return { stop: 'Waiting for a SimpleFIN setup token (paste it into the SSM parameter).' };
  if (kind === 'setup') {
    try {
      access = await claim(access, deps);
    } catch (e) {
      return { stop: e.message };
    }
    await secret.put(access);
    log({ simplefin: 'claimed setup token' });
  }

  // 2. SimpleFIN
  const newest = [...existing.values()].reduce((d, t) => (t.date > d ? t.date : d), '');
  // SimpleFIN caps a request at 90 days, end date included
  const start = newest ? new Date(Date.parse(newest) - 7 * DAY) : new Date(now() - 89 * DAY);
  let set;
  try {
    set = await fetchAccounts(access, { start, end: new Date(now() + DAY), fetch: deps.fetch });
  } catch (e) {
    return { stop: e.message };
  }
  // An account added at the Bridge since the last sync came with only the last week: fetch its
  // full history once (89 days, SimpleFIN's limit with the end date)
  const fresh = newest ? set.accounts.filter((a) => !accounts.has(`ACCT#${hash(a.id)}`)).map((a) => a.id) : [];
  if (fresh.length) {
    try {
      const back = await fetchAccounts(access, { start: new Date(now() - 89 * DAY), end: new Date(now() + DAY), accounts: fresh, fetch: deps.fetch });
      const full = new Map(back.accounts.map((a) => [a.id, a]));
      set = { ...set, accounts: set.accounts.map((a) => full.get(a.id) || a) };
      counts.backfilled = fresh.length;
    } catch (e) {
      set = { ...set, errors: [...set.errors, `New account history: ${e.message}`] };
    }
  }

  for (const a of set.accounts) {
    const sk = `ACCT#${hash(a.id)}`;
    const old = accounts.get(sk);
    const row = {
      sk, simplefinId: a.id, name: a.name || 'Account', org: a.org?.name || a.org?.domain || '',
      currency: a.currency || 'USD', balance: Number(a.balance) || 0,
      available: a['available-balance'] === undefined ? null : Number(a['available-balance']),
      balanceDate: a['balance-date'] ? new Date(a['balance-date'] * 1000).toISOString() : null,
      owner: ownerOf(old),
    };
    accounts.set(sk, row);
    await store.put(row);
    counts.accounts++;
    for (const t of a.transactions || []) {
      if (t.pending) continue;
      const date = ymd((t.posted || t.transacted_at) * 1000, timeZone);
      const sk2 = `TXN#${date}#${hash(a.id, t.id)}`;
      const description = String(t.payee || t.description || t.memo || '').trim().slice(0, 200);
      const fields = {
        sk: sk2, date, account: sk, amount: Number(t.amount) || 0, description,
        memo: String(t.memo || '').slice(0, 200), merchant: merchantKey(description),
      };
      const old2 = existing.get(sk2);
      if (old2 && old2.amount === fields.amount && old2.description === fields.description) continue;
      const row2 = { line: null, source: null, ...old2, ...fields };
      existing.set(sk2, row2);
      await store.put(row2);
      counts[old2 ? 'updated' : 'added']++;
    }
  }

  return { errors: set.errors };
}

// Shared Finances: the accounts each person marked shared in their own tool, read from it as them
// (read-only: GET /shared/{from}). A joint account both of them connected arrives twice, with
// different ids, and often different names ("Shared (7892)" for one, "PREMIER PLUS CKG (7892)" for
// the other): accounts are matched by bank + the last 4 in the name (else the whole name), and
// transactions by date + amount + description, counting repeats, so two real identical charges both stay.
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
export // Bumped when what the personal tools send changes (2: who a contribution came from), so the next
// shared sync reads everything again instead of only the last week
const FEED = 2;
export const sharedKey = (a) => {
  const last4 = /\((\d{4})\)\s*$/.exec(String(a.name || ''));
  return `${norm(a.org)}|${last4 ? `#${last4[1]}` : norm(a.name)}`;
};

async function ingestShared(deps, { existing, accounts, counts }) {
  const { store, tokenFor, sources = [], fetch = globalThis.fetch } = deps;
  const newest = [...existing.values()].reduce((d, t) => (t.date > d ? t.date : d), '');
  const full = ((await store.sync()) || {}).feed !== FEED;
  const from = newest && !full ? new Date(Date.parse(newest) - 7 * DAY).toISOString().slice(0, 10) : '2000-01-01';
  const errors = [];
  const merged = new Map(); // account key -> { row, perSource: [Map fp -> [txn]] }
  for (const src of sources) {
    let body;
    try {
      const token = await tokenFor({ clientId: src.client_id, sub: src.sub, username: src.username, channel: 'sync' });
      const res = await fetch(`${src.api_url}/shared/${from}`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`answered ${res.status}`);
      body = await res.json();
    } catch (e) {
      errors.push(`${src.name}’s finances: ${e.message}`);
      continue;
    }
    const byId = new Map();
    for (const a of body.accounts || []) {
      const key = sharedKey(a);
      const m = merged.get(key) || { row: null, sources: [], perSource: [] };
      // The newest balance wins; every source is remembered
      if (!m.row || (a.balanceDate || '') > (m.row.balanceDate || '')) {
        m.row = { sk: `ACCT#${hash('shared', key)}`, name: a.name, org: a.org, currency: a.currency || 'USD', balance: a.balance, available: a.available ?? null, balanceDate: a.balanceDate || null, owner: 'shared' };
      }
      if (!m.sources.includes(src.name)) m.sources.push(src.name);
      const fps = new Map();
      m.perSource.push(fps);
      merged.set(key, m);
      byId.set(a.id, { key, fps });
    }
    for (const t of body.txns || []) {
      const at = byId.get(t.account);
      if (!at) continue;
      const fp = `${t.date}|${Math.round(t.amount * 100)}|${norm(t.description)}`;
      if (!at.fps.has(fp)) at.fps.set(fp, []);
      at.fps.get(fp).push({ ...t, from: t.contribution ? src.name : null });
    }
  }
  if (!merged.size && errors.length) return { stop: errors.join(' ') };

  for (const [key, m] of merged) {
    const row = { ...m.row, sources: m.sources };
    accounts.set(row.sk, row);
    await store.put(row);
    counts.accounts++;
    const all = new Set(m.perSource.flatMap((f) => [...f.keys()]));
    for (const fp of all) {
      const copies = Math.max(...m.perSource.map((f) => f.get(fp)?.length || 0));
      const t = m.perSource.map((f) => f.get(fp)?.[0]).find(Boolean);
      // Whoever's tool saw it leave their own account (only theirs can tell)
      const from = m.perSource.map((f) => f.get(fp)?.find((x) => x.from)?.from).find(Boolean) || null;
      for (let n = 1; n <= copies; n++) {
        const sk = `TXN#${t.date}#${hash('shared', key, fp, n)}`;
        const fields = {
          sk, date: t.date, account: row.sk, amount: t.amount, description: t.description,
          memo: t.memo || '', merchant: t.merchant || merchantKey(t.description), from,
        };
        const old = existing.get(sk);
        if (old) {
          // The fingerprint is the key, so only who it came from can change
          if ((old.from || null) !== from) { const r = { ...old, from }; existing.set(sk, r); await store.put(r); counts.updated++; }
          continue;
        }
        const r = { line: null, source: null, ...fields };
        existing.set(sk, r);
        await store.put(r);
        counts.added++;
      }
    }
  }
  return { errors, feed: FEED };
}
