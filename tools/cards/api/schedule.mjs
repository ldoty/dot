// When a card comes back: SM-2, the scheduler most flashcard apps grew from, kept small. Each way of studying
// a card (its modes: a word's meaning, recall and spelling are learned separately) has its own schedule
//   { due (ISO), interval (days), ease (≥ 1.3), reps (good answers in a row), lapses, seen (ISO, first study) }
// and a grade moves it on:
//   again  forgotten: back in 10 minutes, the run starts over, a little harder from now on
//   hard   remembered with effort: a little longer than last time, a little harder
//   good   remembered: 1 day, then 3, then the interval times its ease
//   easy   too easy: further still, and easier from now on
// A schedule never seen is new: it's due at once, but only so many new ones are introduced a day (api.mjs).

export const GRADES = ['again', 'hard', 'good', 'easy'];
const DAY = 86_400_000;
const RELEARN_MS = 10 * 60_000;
const START_EASE = 2.5;
const MIN_EASE = 1.3;
const MAX_INTERVAL = 3650;
// A day's cards are due a few hours early, so studying a bit earlier tomorrow still finds them
const EARLY_MS = 4 * 3600_000;

export const fresh = () => ({ due: null, interval: 0, ease: START_EASE, reps: 0, lapses: 0, seen: null });

/** The schedule after one grade, at `now` (a Date) */
export function review(s, grade, now) {
  if (!GRADES.includes(grade)) throw new Error(`grade: ${GRADES.join(', ')}`);
  const cur = { ...fresh(), ...s };
  const t = now.getTime();
  const seen = cur.seen ?? now.toISOString();
  if (grade === 'again') {
    return { ...cur, seen, reps: 0, lapses: cur.lapses + (cur.reps > 0 ? 1 : 0), interval: 0, ease: Math.max(MIN_EASE, round2(cur.ease - 0.2)), due: new Date(t + RELEARN_MS).toISOString() };
  }
  let interval, ease = cur.ease;
  if (grade === 'hard') {
    interval = cur.reps === 0 ? 1 : Math.max(cur.interval + 1, Math.round(cur.interval * 1.2));
    ease = Math.max(MIN_EASE, round2(ease - 0.15));
  } else if (grade === 'good') {
    interval = cur.reps === 0 ? 1 : cur.reps === 1 ? 3 : Math.max(cur.interval + 1, Math.round(cur.interval * ease));
  } else {
    interval = cur.reps === 0 ? 4 : Math.max(cur.interval + 2, Math.round(cur.interval * ease * 1.3));
    ease = round2(ease + 0.15);
  }
  interval = Math.min(MAX_INTERVAL, interval);
  return { ...cur, seen, reps: cur.reps + 1, interval, ease, due: new Date(t + interval * DAY - EARLY_MS).toISOString() };
}

const round2 = (x) => Math.round(x * 100) / 100;

/** Is this schedule due at `nowIso`? A new one (never seen) counts as new, not due */
export const isDue = (s, nowIso) => !!s?.seen && s.due <= nowIso;
export const isNew = (s) => !s?.seen;
