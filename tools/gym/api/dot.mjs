// Gym for Dot: the manifest (platform/api/dot-manifest.mjs) and the shapes Dot reads.
// Dot calls these with a token for the person asking, so it only ever sees and logs their own
// workouts, exactly as their page does. It can add (log a session, a body weight) but never change
// or delete what's there: every other write refuses a via-Dot token (api.mjs, writeRoutes).
// Answers are words and short numbers ("135 × 8"), not ids, so Claude reads them easily.
import { validateManifest } from './dot-manifest.mjs';

const closed = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const DATE_IN = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD' };

export const MANIFEST = validateManifest({
  name: 'gym',
  title: 'Gym',
  description: 'This person’s own workout log: saved workouts, their plan (which workout is next, which days), sessions logged set by set, body weight, and how sore spots (e.g. shoulders, lower back) felt after each session, 0–10.',
  operations: [
    {
      name: 'summary',
      description: 'Where they are: this week’s sessions against their weekly goal, the next workout and day in their plan, any session still open, their last few sessions, latest body weight, and recent soreness ratings. Start here.',
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
              items: closed({ weight: { type: 'number' }, reps: { type: 'integer' }, seconds: { type: 'number' }, meters: { type: 'number' } }),
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
const dayNum = (s) => new Date(`${s}T00:00:00Z`).getUTCDay();
const plusDays = (s, n) => new Date(Date.parse(`${s}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const done = (e) => e.sets.filter((s) => s.done);
export function fmtSet(s, measure) {
  const w = s.w ?? null;
  if (measure === 'time') return `${s.t ?? '–'} s${w !== null ? ` @ ${w}` : ''}`;
  if (measure === 'distance') return `${s.d ?? '–'} m${w !== null ? ` @ ${w}` : ''}`;
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
  };
}

export function sessions(all, { from, to, limit }) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 30);
  return all.sessions.filter((s) => (!from || s.date >= from) && (!to || s.date <= to)).slice(-n).reverse().map(sessionOut);
}

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
    const sets = (Array.isArray(e?.sets) ? e.sets : []).map((s) => ({ w: s?.weight, r: s?.reps, t: s?.seconds, d: s?.meters, done: true }));
    const measure = match?.measure ?? (sets.some((s) => s.t != null) ? 'time' : sets.some((s) => s.d != null) ? 'distance' : 'reps');
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
