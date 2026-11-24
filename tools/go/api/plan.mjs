// The training program: one focus at a time (a kind of mistake), in the order they cost him in real games,
// and a daily session built around it. Pure functions; api.mjs reads and writes the rows.
//
// PLAN / current  { order: [kind…], at (index into order), startedAt (this focus), level (life-and-death
//                   rank for new problems), history: [{ focus, startedAt, endedAt, n, right }], rev }

/** What each focus asks him to do in every game, and drills every day */
export const FOCUS = {
  lost_stones: 'Before every move, look at your weakest group: how many liberties, and where can it be cut?',
  local_shape: 'In a fight, read three moves before you play: what do they answer, and what then?',
  wrong_area: 'Before playing locally, look at the whole board: where is the biggest move?',
  needless_answer: 'Before you answer, ask: if I play elsewhere, what do I lose? If it’s small, tenuki.',
  key_point: 'Find the cut or the connection between your stones and theirs: it decides which group is weak.',
  endgame: 'In the endgame, sente moves first, then the biggest gote.',
  ignored_threat: 'Before every move, ask what their last move threatens.',
  missed_kill: 'When their group looks thin, look for the kill before anything else.',
};

/** Today's session: how many of each, at most (a little over 20 minutes) */
export const SESSION = { warmup: 8, focus: 12, count: 3, review: 10 };
/** Ready to move on: this long on the focus, this many focus drills, this share right */
export const READY = { days: 7, drills: 40, right: 0.85 };
const DAY = 86_400_000;

/** The order to work through: his kinds of mistake by points lost a game, the ones that cost something */
export function focusOrder(profile) {
  const by = profile?.byKind ?? {};
  return Object.keys(FOCUS).filter((k) => (by[k]?.points ?? 0) > 0).sort((a, b) => by[b].points - by[a].points);
}

/** A new program: the first focus, and life and death from the easiest problems up */
export function newPlan(profile, now, minRank) {
  const order = focusOrder(profile);
  if (!order.length) return null;
  return { order, at: 0, startedAt: now.toISOString(), level: (minRank ?? 5) + 2, history: [] };
}

/** How the current focus is going, from the days' STAT rows since it started: { days, n, right, ready } */
export function progress(plan, stats, now) {
  const focus = plan.order[plan.at], since = plan.startedAt.slice(0, 10);
  let n = 0, miss = 0;
  for (const s of stats) if (s.sk >= since) { const t = s.themes?.[focus]; if (t) { n += t.n; miss += t.miss; } }
  const days = Math.floor((now.getTime() - Date.parse(plan.startedAt)) / DAY);
  const right = n ? (n - miss) / n : 0;
  return { focus, days, n, right: Math.round(right * 100) / 100, ready: days >= READY.days && n >= READY.drills && right >= READY.right };
}

/**
 * Life and death gets harder as it gets easy: over the last three days' warm-ups, 9 in 10 right moves the
 * level up, fewer than 7 in 10 down. -> the new level
 */
export function nextLevel(level, recent, { min = 0, max = 40 } = {}) {
  let n = 0, miss = 0;
  for (const s of recent) { const t = s.kinds?.tsumego; if (t) { n += t.n; miss += t.miss; } }
  if (n < 15) return level;
  const right = (n - miss) / n;
  if (right >= 0.9) return Math.min(max, level + 1);
  if (right < 0.7) return Math.max(min, level - 1);
  return level;
}

/**
 * Today's session, what's left of it: { warmup, focus, count, review } lists of drills, each as many as
 * SESSION allows less what today's STAT says is done. Due ones first (oldest first), then new ones:
 * focus his own and the costliest first; warm-ups the hardest problems at or below his level first.
 */
export function today({ plan, drills, stat, nowIso, isDue, isNew }) {
  const focus = plan.order[plan.at];
  const done = {
    warmup: stat?.kinds?.tsumego?.n ?? 0,
    focus: stat?.themes?.[focus]?.n ?? 0,
    count: stat?.kinds?.count?.n ?? 0,
    review: Math.max(0, (stat?.n ?? 0) - (stat?.kinds?.tsumego?.n ?? 0) - (stat?.themes?.[focus]?.n ?? 0) - (stat?.kinds?.count?.n ?? 0)),
  };
  const left = (k) => Math.max(0, SESSION[k] - done[k]);
  const due = (ds) => ds.filter((d) => isDue(d.sched, nowIso)).sort((a, b) => (a.sched.due < b.sched.due ? -1 : 1));
  const take = (k, dueOnes, fresh) => [...dueOnes, ...fresh].slice(0, left(k));
  const fix = drills.fix ?? [], tsumego = drills.tsumego ?? [], count = drills.count ?? [], threat = drills.threat ?? [];
  const focusFix = fix.filter((d) => d.theme === focus);
  const atLevel = tsumego.filter((d) => isNew(d.sched) && (d.rank ?? 0) <= plan.level).sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0) || (a.sk < b.sk ? -1 : 1));
  return {
    warmup: take('warmup', due(tsumego), atLevel),
    focus: take('focus', due(focusFix), focusFix.filter((d) => isNew(d.sched)).sort((a, b) => (b.mine ? 1 : 0) - (a.mine ? 1 : 0) || b.loss - a.loss)),
    count: take('count', due(count), count.filter((d) => isNew(d.sched))),
    review: take('review', due([...fix.filter((d) => d.theme !== focus), ...threat]), []),
  };
}

/** Moving on: the focus just finished goes into the history -> the plan for the next one (or null at the end) */
export function advance(plan, prog, now) {
  if (plan.at + 1 >= plan.order.length) return null;
  const t = now.toISOString();
  return {
    ...plan, at: plan.at + 1, startedAt: t,
    history: [...plan.history, { focus: plan.order[plan.at], startedAt: plan.startedAt, endedAt: t, n: prog.n, right: prog.right }],
  };
}
