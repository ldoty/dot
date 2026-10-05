// Turns the budget (GET /all from Budget) into the lines transactions are filed under, for one
// person. Finance follows one of the person's tags; that version names the Shared tag it follows,
// so the chain is: finance → Luke's tag → Luke's version → its Shared tag → the Shared version.
// WORKING ('@working') follows the live working copies instead, Luke's and Shared's: edits show
// up without saving a version or moving a tag.
//
//   resolveLines(all, { person: 'Luke', tag: 'default' }) ->
//     { tag, version: {id, name, savedAt}, sharedTag, sharedVersion, tags: [...], lines: [...] }
//
// Each line: { id, group: 'Luke' | 'Shared' | 'Other', category, name, kind, target }
//   kind:   'income' | 'spend' | 'save' | 'skip' (Transfers: money moving between your own
//           accounts, card payments; never counted against any budget line or total)
//   target: the person's monthly amount. A personal tool has only the person's own lines (and
//           Transfers); the Shared lines are Shared Finances' alone (resolveSharedLines), at the
//           household's amounts.
// Ids are budget item ids (stable across versions): 'L.<id>' personal, 'S.<id>' shared (Shared Finances).
// Each category also has a General line ('LC.<category id>', 'SC.<…>'; general: true, no budget
// of its own): for spending that's clearly that category when no one line fits. It counts toward
// the category, not toward any line.
// The math mirrors tools/budget/web/index.html (sharedSummary, personSummary).

export const TRANSFER = 'X.transfer';
// A person's contributions to the household: one automatic line per shared account, "To <account>",
// under "Shared contributions". Money moved from one of their own accounts into a shared one is
// filed there by the sync (matched like a transfer, but it is the person's spending).
export const CONTRIBUTION = 'X.to';
// Budget's fixed Shared contributions section (tools/budget: category "contrib", line "contrib-share").
// When the person's budget has it, contributions go there and the "To <account>" lines aren't needed.
export const CONTRIB_LINE = 'L.contrib-share';
export function withContributionLines(lines, accounts, person) {
  if (lines.some((l) => l.id === CONTRIB_LINE)) return lines;
  const shared = (accounts || []).filter((a) => a.owner === 'shared');
  return [
    ...lines,
    ...shared.map((a) => ({ id: `${CONTRIBUTION}.${a.sk.slice(5)}`, group: person, category: 'Shared contributions', name: `To ${a.name}`, kind: 'spend', target: 0, auto: true })),
  ];
}
export const WORKING = '@working';
// A saved version followed directly, by id ('@v:<id>'), instead of through a tag
export const VERSION = '@v:';
/** The version a tag or '@v:<id>' names in one doc's versions, or throws a clear 409 */
function versionFor(all, doc, tag, label) {
  const versions = all.versions?.[doc] || [];
  if (tag.startsWith(VERSION)) {
    const v = find(versions, (x) => x.id === tag.slice(VERSION.length));
    if (!v) throw Object.assign(new Error(`That saved version of ${label} no longer exists.`), { status: 409 });
    return v;
  }
  const t = find(all.tags?.[doc], (x) => x.name === tag);
  if (!t) throw Object.assign(new Error(`${label} has no tag “${tag}”.`), { status: 409 });
  const v = find(versions, (x) => x.id === t.versionId);
  if (!v) throw Object.assign(new Error(`Tag “${tag}” points at a version that no longer exists.`), { status: 409 });
  return v;
}
/** What can be followed in one doc: its tags (and the version each points at) and its saved versions */
function choicesFor(all, doc) {
  const versions = all.versions?.[doc] || [];
  return {
    tags: (all.tags?.[doc] || []).map((x) => x.name).sort(),
    tagVersions: Object.fromEntries((all.tags?.[doc] || []).map((x) => [x.name, find(versions, (v) => v.id === x.versionId)?.name || null])),
    versions: versions.map((v) => ({ id: v.id, name: v.name, savedAt: v.savedAt })),
  };
}
export const SKIP_LINES = [
  { id: TRANSFER, group: 'Transfers', category: 'Transfers', name: 'Transfer (between my accounts, card payment)', kind: 'skip', target: 0 },
];

const num = (v) => Number(v) || 0;
const cents = (v) => Math.round(v * 100) / 100;

function payment(loan, rate, years) {
  const n = years * 12, r = rate / 1200;
  if (!loan || !n) return 0;
  if (!r) return loan / n;
  return loan * r / (1 - (1 + r) ** -n);
}

function sharedMath(st) {
  const m = st.mortgage || {};
  const price = num(m.price);
  const down = Array.isArray(m.downItems) ? m.downItems.reduce((t, it) => t + num(it.amount), 0) : num(m.down);
  const mort = payment(Math.max(0, price - down), m.rate ?? 6.25, m.years ?? 30);
  const split = typeof st.split === 'number' ? st.split : 50;
  const monthlyOf = (it) => {
    if (it.calc === 'pctHome') return price * num(it.rate) / 100 / 12;
    const a = num(it.amount);
    return it.freq === 'yr' ? a / 12 : a;
  };
  // The person's part of a Split item, per month, never more than the item itself
  const lukeOf = (it, v) => {
    if (typeof it.luke !== 'number') return v * split / 100;
    return Math.min(v, Math.max(0, it.luke) / (it.freq === 'yr' ? 12 : 1));
  };
  const by = { Shared: mort, Luke: 0, Amber: 0 };
  const items = [];
  for (const c of st.categories || []) {
    for (const it of c.items || []) {
      const v = monthlyOf(it);
      if (it.who === 'Split') {
        const lk = lukeOf(it, v);
        by.Luke += lk; by.Amber += v - lk;
        items.push({ c, it, whole: v, part: { Luke: lk, Amber: v - lk } });
      } else {
        by.Shared += v;
        items.push({ c, it, whole: v, part: { Luke: v * split / 100, Amber: v * (100 - split) / 100 } });
      }
    }
  }
  const lp = split / 100;
  return {
    mort, split, items,
    shares: { Luke: by.Luke + by.Shared * lp, Amber: by.Amber + by.Shared * (1 - lp) },
    mortPart: { Luke: mort * lp, Amber: mort * (1 - lp) },
  };
}

const find = (list, pred) => (list || []).find(pred) || null;

// The household's lines (Shared Finances): the Shared budget alone, whole amounts, by a Shared tag
// (or '@working' for its working copy). Money coming into the shared accounts (contributions,
// refunds) has its own income line.
export const MONEY_IN = 'X.in';
const PEOPLE = ['Luke', 'Amber']; // the budget's people (Budget's docs)
export function resolveSharedLines(all, { tag = 'default' } = {}) {
  const sharedTags = all.tags?.shared || [];
  let sv;
  if (tag === WORKING) {
    const sh = all.docs?.shared;
    if (!sh?.state) throw Object.assign(new Error('The Shared budget has no working copy yet.'), { status: 409 });
    sv = { id: `working@${sh.rev ?? 0}`, name: 'Working copy', savedAt: null, state: sh.state };
  } else {
    sv = versionFor(all, 'shared', tag, 'The Shared budget');
  }
  const shared = sharedMath(sv.state || {});
  // Money in: each person's contribution, expected at their share of the split, and anything else
  const lines = [
    ...PEOPLE.map((p) => ({ id: `${MONEY_IN}.${p}`, group: 'Shared', category: 'Money in', name: `From ${p}`, kind: 'income', target: cents(shared.shares[p] || 0) })),
    { id: MONEY_IN, group: 'Shared', category: 'Money in', name: 'Other money in (refunds…)', kind: 'income', target: 0 },
  ];
  if (shared.mort > 0) lines.push({ id: 'S.mortgage', group: 'Shared', category: 'Home', name: 'Mortgage', kind: 'spend', target: cents(shared.mort) });
  for (const { c, it, whole } of shared.items) {
    lines.push({ id: `S.${it.id}`, group: 'Shared', category: c.name || 'Shared', name: it.name || 'Item', kind: 'spend', target: cents(whole) });
  }
  for (const c of sv.state?.categories || []) {
    if (c.id) lines.push({ id: `SC.${c.id}`, group: 'Shared', category: c.name || 'Shared', name: 'General', kind: 'spend', target: 0, general: true });
  }
  lines.push(...SKIP_LINES);
  return {
    tag, version: { id: sv.id, name: sv.name, savedAt: sv.savedAt }, sharedTag: tag === WORKING ? 'working copy' : tag,
    sharedVersion: { id: sv.id, name: sv.name, savedAt: sv.savedAt }, ...choicesFor(all, 'shared'), lines,
  };
}

export function resolveLines(all, { person = 'Luke', tag = 'default' } = {}) {
  const myTags = all.tags?.[person] || [];
  let v, st2, sv;
  if (tag === WORKING) {
    const mine = all.docs?.[person], sh = all.docs?.shared;
    if (!mine?.state) throw Object.assign(new Error(`${person}’s budget has no working copy yet.`), { status: 409 });
    // The id changes with every saved edit, so Claude looks again at what it couldn't file
    v = { id: `working@${mine.rev ?? 0}.${sh?.rev ?? 0}`, name: 'Working copy', savedAt: null, state: mine.state };
    st2 = sh?.state ? { name: 'working copy' } : null;
    sv = sh?.state ? { id: `working@${sh.rev ?? 0}`, name: 'Working copy', savedAt: null, state: sh.state } : null;
  } else {
    v = versionFor(all, person, tag, `${person}’s budget`);
    const follows = (v.state || {}).follows || 'default';
    st2 = find(all.tags?.shared, (x) => x.name === follows) || find(all.tags?.shared, (x) => x.name === 'default');
    sv = st2 && find(all.versions?.shared, (x) => x.id === st2.versionId);
  }
  const st = v.state || {};
  const shared = sv ? sharedMath(sv.state || {}) : null;

  const personalMonthly = (it) => {
    if (it.calc === 'share') return shared ? shared.shares[it.person || person] || 0 : 0;
    const a = num(it.amount);
    return it.freq === 'yr' ? a / 12 : a;
  };

  const lines = [];
  for (const it of st.income || []) {
    lines.push({ id: `L.${it.id}`, group: person, category: 'Income', name: it.name || 'Income', kind: 'income', target: cents(personalMonthly(it)) });
  }
  const general = (prefix, group, c, kind) => (c.id ? [{ id: `${prefix}.${c.id}`, group, category: c.name || 'Uncategorized', name: 'General', kind, target: 0, general: true }] : []);
  for (const c of st.categories || []) {
    const kind = c.kind === 'save' ? 'save' : 'spend';
    for (const it of c.items || []) {
      lines.push({
        id: `L.${it.id}`, group: person, category: c.name || 'Uncategorized', name: it.name || 'Item',
        kind, target: cents(personalMonthly(it)),
      });
    }
    lines.push(...general('LC', person, c, kind));
  }
  // Only the person's own lines (and Transfers): Shared lines belong to Shared Finances alone. The
  // Shared version still matters here: it sets the person's "share of Shared" line.
  lines.push(...SKIP_LINES);

  return {
    tag,
    version: { id: v.id, name: v.name, savedAt: v.savedAt },
    sharedTag: st2 ? st2.name : null,
    sharedVersion: sv ? { id: sv.id, name: sv.name, savedAt: sv.savedAt } : null,
    ...choicesFor(all, person),
    lines,
  };
}
