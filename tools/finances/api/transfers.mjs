// Transfers between Luke's own accounts show up twice: money out of one account and the same
// amount into another a day or few later (a card payment: out of checking, into the card).
// Matching the pairs finds them without asking anyone.
//
//   matchTransfers(txns) -> [[out, in], ...] matched pairs
// Pairs: same amount, opposite signs, different accounts, posted within MAX_DAYS. Each
// transaction joins at most one pair, the closest in date.

export const MAX_DAYS = 4;
const DAY = 86_400_000;

export function matchTransfers(txns) {
  const byAmount = new Map();
  for (const t of txns) {
    if (!t.amount) continue;
    const k = Math.round(Math.abs(t.amount) * 100);
    if (!byAmount.has(k)) byAmount.set(k, []);
    byAmount.get(k).push(t);
  }
  const matched = new Set(), pairs = [];
  for (const group of byAmount.values()) {
    const outs = group.filter((t) => t.amount < 0).sort((a, b) => (a.date < b.date ? -1 : 1));
    const ins = group.filter((t) => t.amount > 0);
    for (const o of outs) {
      let best = null, bestGap = Infinity;
      for (const i of ins) {
        if (matched.has(i.sk) || i.account === o.account) continue;
        const gap = Math.abs(Date.parse(i.date) - Date.parse(o.date)) / DAY;
        if (gap <= MAX_DAYS && gap < bestGap) { best = i; bestGap = gap; }
      }
      if (best) { matched.add(o.sk); matched.add(best.sk); pairs.push([o, best]); }
    }
  }
  return pairs;
}
