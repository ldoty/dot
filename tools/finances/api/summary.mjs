// Month-to-date: how each budget line is tracking this month.
//
//   summarize({ month: '2026-10', today: '2026-10-04', lines, txns }) ->
//     { month, elapsed, lines: [{ ...line, spent, count, expected }], unassigned, totals }
//
// Money out counts as spending on spend/save lines; money in counts on income lines (a refund
// on a spend line lowers its spending). `expected` is where the line would be at an even pace:
// target × the share of the month gone by. Transfers (the skip line) are never in a budget
// total; they're totalled on their own (totals.transfers: { out, in, count }). Annual lines ("/ yr" items:
// taxes, insurance) are in `lines` (so they can be filed to and drilled into) but not in the month's
// totals: a once-a-year payment isn't a month over budget. summarizeYear measures them on the calendar year.

const cents = (v) => Math.round(v * 100) / 100;

/** Share of `month` gone by on `today` (both in the household's time zone): 0..1 */
export function elapsedShare(month, today) {
  const [y, m] = month.split('-').map(Number);
  const tm = today.slice(0, 7);
  if (tm < month) return 0;
  if (tm > month) return 1;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Number(today.slice(8, 10)) / days;
}

export function summarize({ month, today, lines, txns }) {
  const elapsed = elapsedShare(month, today);
  const byId = new Map(lines.map((l) => [l.id, { ...l, spent: 0, count: 0 }]));
  const unassigned = { out: 0, in: 0, count: 0 };
  for (const t of txns) {
    const l = t.line && byId.get(t.line);
    if (!l) {
      unassigned.count++;
      if (t.amount < 0) unassigned.out -= t.amount; else unassigned.in += t.amount;
      continue;
    }
    l.count++;
    l.spent += l.kind === 'income' ? t.amount : -t.amount;
  }
  const out = [...byId.values()].map((l) => ({ ...l, spent: cents(l.spent), expected: cents(l.target * elapsed) }));

  const sum = (pred, f) => cents(out.filter(pred).reduce((s, l) => s + f(l), 0));
  const totals = {};
  for (const [key, pred] of [
    ['income', (l) => l.kind === 'income' && !l.annual],
    ['spend', (l) => l.kind === 'spend' && l.group !== 'Shared' && !l.annual],
    ['shared', (l) => l.kind === 'spend' && l.group === 'Shared' && !l.annual],
    ['save', (l) => l.kind === 'save' && !l.annual],
  ]) {
    totals[key] = { target: sum(pred, (l) => l.target), spent: sum(pred, (l) => l.spent), expected: sum(pred, (l) => l.expected) };
  }
  const tr = { out: 0, in: 0, count: 0 };
  for (const t of txns) {
    if (byId.get(t.line)?.kind !== 'skip') continue;
    tr.count++;
    if (t.amount < 0) tr.out -= t.amount; else tr.in += t.amount;
  }
  totals.transfers = { out: cents(tr.out), in: cents(tr.in), count: tr.count };
  return {
    month, elapsed: Math.round(elapsed * 1000) / 1000,
    lines: out,
    unassigned: { out: cents(unassigned.out), in: cents(unassigned.in), count: unassigned.count },
    totals,
  };
}

/** Share of the calendar year gone by at the end of `through` (YYYY-MM), or at `today` if that's sooner: 0..1 */
export function yearShare(year, through, today) {
  const [y, m] = through.split('-').map(Number);
  const end = `${through}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
  const upTo = today < end ? today : end, start = `${year}-01-01`;
  if (upTo < start) return 0;
  const days = (Date.parse(upTo) - Date.parse(start)) / 86_400_000 + 1;
  return Math.min(1, days / (new Date(Date.UTC(year, 1, 29)).getUTCMonth() === 1 ? 366 : 365));
}

// The year so far for annual lines: each against its yearly amount, with an even pace through the year.
//   summarizeYear({ year: 2026, through: '2026-10', today, lines, txns }) ->
//     { year, through, elapsed, lines: [{ ...line, target: yearly, spent, count, expected }], totals: { income, spend, save } }
// txns: the ones counting in January through `through` (the caller picks them).
export function summarizeYear({ year, through, today, lines, txns }) {
  const elapsed = yearShare(year, through, today);
  const byId = new Map(lines.filter((l) => l.annual).map((l) => [l.id, { ...l, target: l.yearly, spent: 0, count: 0 }]));
  for (const t of txns) {
    const l = byId.get(t.line);
    if (!l) continue;
    l.count++;
    l.spent += l.kind === 'income' ? t.amount : -t.amount;
  }
  const out = [...byId.values()].map((l) => ({ ...l, spent: cents(l.spent), expected: cents(l.target * elapsed) }));
  const totals = {};
  for (const kind of ['income', 'spend', 'save']) {
    const of = out.filter((l) => l.kind === kind), sum = (f) => cents(of.reduce((s, l) => s + f(l), 0));
    totals[kind] = { target: sum((l) => l.target), spent: sum((l) => l.spent), expected: sum((l) => l.expected) };
  }
  return { year, through, elapsed: Math.round(elapsed * 1000) / 1000, lines: out, totals };
}
