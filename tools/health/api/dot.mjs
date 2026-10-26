// Health for Dot: the manifest (platform/api/dot-manifest.mjs) and the shapes Dot reads.
// Dot calls these with a token for the person asking, so it only ever sees and logs their own
// workouts, exactly as their page does. It can add (log a session, a body weight, food, a journal paragraph) but never change
// or delete what's there: every other write refuses a via-Dot token (api.mjs, writeRoutes).
// Answers are words and short numbers ("135 × 8"), not ids, so Claude reads them easily.
import { validateManifest } from './dot-manifest.mjs';

const closed = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const DATE_IN = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD' };

export const MANIFEST = validateManifest({
  name: 'health',
  title: 'Health',
  description: 'This person’s own health log: saved workouts, their plan (which workout is next, which days), sessions logged set by set (holds are counted in breaths, not seconds), body weight, how sore spots (e.g. shoulders, lower back) felt after each session, 0–10, a daily journal of how they felt physically, and a food log of what they ate.',
  operations: [
    {
      name: 'summary',
      description: 'Where they are: this week’s sessions against their weekly goal, the next workout and day in their plan, any session still open, their last few sessions, latest body weight, recent soreness ratings, their last few journal days, and what they’ve eaten today. Start here.',
      path: '/dot/summary',
      input: closed({}),
    },
    {
      name: 'sessions',
      description: 'Logged sessions with every exercise and set, newest first. Optionally between two dates (inclusive); up to 30.',
      path: '/dot/sessions',
      input: closed({ from: DATE_IN, to: DATE_IN, limit: { type: 'integer', minimum: 1, maximum: 30 } }),
    },
    {
      name: 'exercise',
      description: 'One exercise’s history (“what did I lift on trap bar last time?”): each session’s sets and best, newest first. Matches part of the name.',
      path: '/dot/exercise',
      input: closed({ name: { type: 'string', minLength: 2, maxLength: 80 } }, ['name']),
    },
    {
      name: 'workouts',
      description: 'Their saved workouts (exercises in order, sets × target, pairs) and their plan’s rotation and days.',
      path: '/dot/workouts',
      input: closed({}),
    },
    {
      name: 'journal',
      description: 'Their daily journal: how they felt physically each day, in their own words, newest first. Optionally between two dates (inclusive); up to 60 days.',
      path: '/dot/journal',
      input: closed({ from: DATE_IN, to: DATE_IN, limit: { type: 'integer', minimum: 1, maximum: 60 } }),
    },
    {
      name: 'food',
      description: 'What they ate, by day (newest first): each entry’s time, meal, what it was, and calories and protein where known, with the day’s totals. Optionally between two dates (inclusive); up to 60 days.',
      path: '/dot/food',
      input: closed({ from: DATE_IN, to: DATE_IN, limit: { type: 'integer', minimum: 1, maximum: 60 } }),
    },
    {
      name: 'log_food',
      method: 'POST',
      description: 'Add something they ate or are about to eat to their food log. Adds a new entry; never changes one. '
        + 'When they send a photo of their food, that is the request: say plainly what it is with rough amounts (“grilled chicken thigh, about a cup of rice, broccoli”), '
        + 'estimate calories and protein, log it, and tell them what you logged and that the numbers are estimates they can fix on Health’s Food tab. '
        + 'Only log food they’re eating; if a photo isn’t clearly their meal, ask.',
      path: '/dot/food',
      input: closed({
        what: { type: 'string', minLength: 1, maxLength: 300, description: 'What it was, with rough amounts' },
        meal: { type: 'string', enum: ['breakfast', 'lunch', 'dinner', 'snack'] },
        date: { ...DATE_IN, description: 'YYYY-MM-DD; today if left out' },
        time: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$', description: 'HH:MM, 24-hour, their time; now if left out' },
        calories: { type: 'integer', minimum: 0, maximum: 10000, description: 'An estimate is fine' },
        protein_g: { type: 'integer', minimum: 0, maximum: 1000, description: 'Grams; an estimate is fine' },
        note: { type: 'string', maxLength: 500 },
      }, ['what']),
    },
    {
      name: 'add_to_journal',
      method: 'POST',
      description: 'Add to their daily journal how they say they feel physically (“knee’s sore today”, “slept badly, low energy”), in their words, first person. '
        + 'Goes after what’s already there that day; never replaces it. Only what they asked you to note, or plainly told you about how they feel.',
      path: '/dot/journal',
      input: closed({
        text: { type: 'string', minLength: 1, maxLength: 2000 },
        date: { ...DATE_IN, description: 'YYYY-MM-DD; today if left out' },
      }, ['text']),
    },
    {
      name: 'log',
      method: 'POST',
      description: 'Log a finished session they tell you about (“did session A, deadlift 135 for 3×8, shoulders a 2”). Adds a new session; never changes one. '
        + 'Use their saved workout’s and exercises’ names when they match (see workouts). Only log what they said they did.',
      path: '/dot/log',
      input: closed({
        date: { ...DATE_IN, description: 'YYYY-MM-DD; today if left out' },
        workout: { type: 'string', maxLength: 60, description: 'The saved workout’s name, if it was one' },
        note: { type: 'string', maxLength: 2000 },
        discomfort: { type: 'object', description: 'Area name -> 0 (nothing) to 10 (had to stop), for the areas they rate', additionalProperties: { type: 'integer', minimum: 0, maximum: 10 } },
        exercises: {
          type: 'array', maxItems: 40,
          items: closed({
            name: { type: 'string', maxLength: 80 },
            note: { type: 'string', maxLength: 500 },
            sets: {
              type: 'array', maxItems: 20,
              items: closed({ weight: { type: 'number' }, reps: { type: 'integer' }, seconds: { type: 'number' }, meters: { type: 'number' }, breaths: { type: 'integer', description: 'For a hold: how many breaths they held it' } }),
            },
          }, ['name']),
        },
      }),
    },
    {
      name: 'log_weight',
      method: 'PUT',
      description: 'Log their body weight for a day (in their unit, see summary). Replaces that day’s if there was one.',
      path: '/weights/{date}',
      input: closed({ date: DATE_IN, weight: { type: 'number', minimum: 20, maximum: 1000 } }, ['date', 'weight']),
    },
  ],
});

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The calendar day (YYYY-MM-DD) it is for them: they train in their own time zone, not UTC */
export const localDay = (now, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
/** HH:MM, 24-hour, in their time zone */
export const localTime = (now, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
const dayNum = (s) => new Date(`${s}T00:00:00Z`).getUTCDay();
const plusDays = (s, n) => new Date(Date.parse(`${s}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const done = (e) => e.sets.filter((s) => s.done);
export function fmtSet(s, measure) {
  const w = s.w ?? null;
  if (measure === 'time') return `${s.t ?? '–'} s${w !== null ? ` @ ${w}` : ''}`;
  if (measure === 'distance') return `${s.d ?? '–'} m${w !== null ? ` @ ${w}` : ''}`;
  if (measure === 'breaths') return `${s.b ?? '–'} breaths${w !== null ? ` @ ${w}` : ''}`;
  return `${w !== null ? `${w} × ` : ''}${s.r ?? '–'}`;
}
const fmtSets = (e) => done(e).map((s) => fmtSet(s, e.measure)).join(', ');

function sessionOut(s) {
  return {
    date: s.date, workout: s.name, finished: !!s.finishedAt, note: s.note || undefined,
    discomfort: Object.keys(s.discomfort).length ? s.discomfort : undefined,
    exercises: s.entries.filter((e) => done(e).length).map((e) => ({ name: e.name, sets: fmtSets(e), ...(e.note ? { note: e.note } : {}) })),
  };
}

const rotationOf = (all) => (all.plan?.rotation ?? []).map((id) => all.workouts.find((w) => w.id === id)).filter(Boolean);
/** The workout after the last finished one from the rotation, the same rule the page uses */
function nextWorkout(all) {
  const rot = rotationOf(all), fin = all.sessions.filter((s) => s.finishedAt);
  if (!rot.length) return null;
  for (let i = fin.length - 1; i >= 0; i--) {
    const k = rot.findIndex((w) => w.id === fin[i].workoutId);
    if (k >= 0) return rot[(k + 1) % rot.length];
  }
  return rot[0];
}
function nextDay(all, today) {
  const p = all.plan;
  if (!p?.days.length) return null;
  for (let i = 0; i < 14; i++) {
    const d = plusDays(today, i);
    if (p.days.includes(dayNum(d)) && (!p.from || d >= p.from) && (!p.to || d <= p.to)) return d;
  }
  return null;
}

export function summary(all, today) {
  const monday = plusDays(today, -((dayNum(today) + 6) % 7));
  const fin = all.sessions.filter((s) => s.finishedAt);
  const open = all.sessions.filter((s) => !s.finishedAt).pop();
  const next = nextWorkout(all), day = nextDay(all, today);
  const weight = all.weights.at(-1);
  return {
    today: `${DAYS[dayNum(today)]} ${today}`,
    unit: all.settings.unit,
    this_week: { sessions: fin.filter((s) => s.date >= monday && s.date <= today).length, goal: all.plan?.perWeek ?? null },
    next: next ? { workout: next.name, day: day ? `${DAYS[dayNum(day)]} ${day}${day === today ? ' (today)' : ''}` : null } : null,
    open_session: open ? { workout: open.name, date: open.date } : null,
    last_sessions: fin.slice(-5).reverse().map((s) => ({ date: s.date, workout: s.name, sets_done: s.entries.reduce((n, e) => n + done(e).length, 0), discomfort: s.discomfort, note: s.note || undefined })),
    body_weight: weight ? { date: weight.date, weight: weight.weight } : null,
    rated_areas: all.settings.areas,
    food_today: foodDay(all, today),
    journal: journal(all, { limit: 3 }).map((j) => ({ ...j, text: j.text.length > 300 ? `${j.text.slice(0, 300)}…` : j.text })),
  };
}

export function sessions(all, { from, to, limit }) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 30);
  return all.sessions.filter((s) => (!from || s.date >= from) && (!to || s.date <= to)).slice(-n).reverse().map(sessionOut);
}

/** Their journal days with something written, newest first */
export function journal(all, { from, to, limit }) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 14, 1), 60);
  return all.journal.filter((j) => j.text && (!from || j.date >= from) && (!to || j.date <= to)).slice(-n).reverse()
    .map((j) => ({ date: `${DAYS[dayNum(j.date)]} ${j.date}`, text: j.text }));
}

/** A food entry in words: only what's known */
export const foodOut = (f) => ({
  ...(f.time ? { time: f.time } : {}), ...(f.meal ? { meal: f.meal } : {}), what: f.what,
  ...(f.kcal != null ? { calories: f.kcal } : {}), ...(f.protein != null ? { protein_g: f.protein } : {}),
  ...(f.note ? { note: f.note } : {}), ...(f.source === 'dot' ? { logged_by: 'Dot' } : {}),
});
// Totals count only entries that have a number, and say how many don't
function foodDay(all, day) {
  const list = all.food.filter((f) => f.date === day);
  const sum = (k) => list.reduce((n, f) => n + (f[k] ?? 0), 0);
  return {
    entries: list.map(foodOut), calories: sum('kcal'), protein_g: sum('protein'),
    ...(list.some((f) => f.kcal == null) ? { without_calories: list.filter((f) => f.kcal == null).length } : {}),
  };
}
export function food(all, { from, to, limit }) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 7, 1), 60);
  const days = [...new Set(all.food.map((f) => f.date))].filter((d) => (!from || d >= from) && (!to || d <= to)).slice(-n).reverse();
  return days.map((d) => ({ date: `${DAYS[dayNum(d)]} ${d}`, ...foodDay(all, d) }));
}
/** The entry Dot logs, in the page's shape: today and now unless they said */
export const foodEntry = (b, today, now) => ({
  date: b.date || today, time: b.time || now, meal: b.meal, what: b.what, kcal: b.calories, protein: b.protein_g, note: b.note,
});

/** The exercise they mean: exact name first, else the only one containing what they said */
function findExercise(list, name) {
  const q = String(name || '').trim().toLowerCase();
  if (!q) return { matches: [] };
  const exact = list.filter((x) => x.name.toLowerCase() === q);
  if (exact.length) return { match: exact[0] };
  const part = list.filter((x) => x.name.toLowerCase().includes(q));
  return part.length === 1 ? { match: part[0] } : { matches: part };
}

export function exercise(all, name) {
  const { match, matches } = findExercise(all.exercises, name);
  if (!match) return { error: matches.length ? 'more than one exercise matches' : 'no exercise by that name', candidates: (matches.length ? matches : all.exercises).map((x) => x.name) };
  const history = all.sessions.slice().reverse().flatMap((s) => s.entries.filter((e) => e.exerciseId === match.id && done(e).length)
    .map((e) => ({ date: s.date, sets: fmtSets(e), ...(e.note ? { note: e.note } : {}) })));
  return { exercise: match.name, measure: match.measure, per_side: match.perSide, cues: match.note || undefined, history: history.slice(0, 20) };
}

export function workouts(all) {
  const ex = (id) => all.exercises.find((x) => x.id === id)?.name ?? '(deleted exercise)';
  return {
    workouts: all.workouts.map((w) => ({
      name: w.name, note: w.note || undefined,
      exercises: w.items.map((i) => `${ex(i.exerciseId)}: ${i.sets} × ${i.target || '?'}${i.pair ? ` (pair ${i.pair})` : ''}`),
    })),
    plan: all.plan ? {
      rotation: rotationOf(all).map((w) => w.name), days: all.plan.days.map((d) => DAYS[d]),
      goal_per_week: all.plan.perWeek, from: all.plan.from, until: all.plan.to,
    } : null,
  };
}

/** A logged session from what they told Dot, linked to their own workout and exercises where the names match */
export function logToSession(b, all, today, now) {
  const wo = typeof b.workout === 'string' ? all.workouts.find((w) => w.name.toLowerCase() === b.workout.trim().toLowerCase()) : null;
  const named = [];
  const entries = (Array.isArray(b.exercises) ? b.exercises : []).map((e) => {
    const { match } = findExercise(all.exercises, e?.name);
    const sets = (Array.isArray(e?.sets) ? e.sets : []).map((s) => ({ w: s?.weight, r: s?.reps, t: s?.seconds, d: s?.meters, b: s?.breaths, done: true }));
    const measure = match?.measure ?? (sets.some((s) => s.b != null) ? 'breaths' : sets.some((s) => s.t != null) ? 'time' : sets.some((s) => s.d != null) ? 'distance' : 'reps');
    named.push({ said: e?.name, logged_as: match?.name ?? e?.name, matched: !!match });
    return { exerciseId: match?.id ?? null, name: match?.name ?? e?.name, measure, perSide: !!match?.perSide, note: e?.note, sets };
  });
  return {
    session: {
      date: b.date || today, workoutId: wo?.id ?? null, name: wo?.name || (typeof b.workout === 'string' ? b.workout : ''),
      startedAt: now, finishedAt: now, note: b.note, discomfort: b.discomfort ?? {}, entries,
    },
    named,
  };
}
