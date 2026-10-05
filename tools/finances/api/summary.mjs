// Month-to-date: how each budget line is tracking this month.
//
//   summarize({ month: '2026-10', today: '2026-10-04', lines, txns }) ->
//     { month, elapsed, lines: [{ ...line, spent, count, expected }], unassigned, totals }
//
// Money out counts as spending on spend/save lines; money in counts on income lines (a refund
// on a spend line lowers its spending). `expected` is where the line would be at an even pace:
// target × the share of the month gone by. Transfers (the skip line) are never in a budget
// total; they're totalled on their own (totals.transfers: { out, in, count }).

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
    ['income', (l) => l.kind === 'income'],
    ['spend', (l) => l.kind === 'spend' && l.group !== 'Shared'],
    ['shared', (l) => l.kind === 'spend' && l.group === 'Shared'],
    ['save', (l) => l.kind === 'save'],
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
