// Health API: each person's own exercises, saved workouts, plan, logged sessions, body weight, a daily journal, what they ate,
// the medications and supplements they take, and their meditation.
// Routes (a family_health token, or Dot's delegated one for the person asking; everything is that person's own):
//   GET    /all              -> { settings, plan, exercises, workouts, sessions, weights, journal, food, meds, doses, sits }
//   PUT    /settings         { unit, areas, rev }
//   PUT    /plan             { rotation: [workoutId], days: [0-6], from, to, perWeek, rev }
//   PUT    /exercises/{id}   { name, measure, perSide, note, rev }
//   DELETE /exercises/{id}   409 { workouts } while a saved workout uses it
//   PUT    /workouts/{id}    { name, note, items: [{ exerciseId, sets, target, pair, rest }], rev }
//   DELETE /workouts/{id}
//   PUT    /sessions/{id}    { date, workoutId, name, startedAt, finishedAt, note, discomfort: { area: 0-10 },
//                               entries: [{ exerciseId, name, measure, perSide, note, target, pair, rest,
//                                           sets: [{ w, r, t, d, b, done }] }], rev }   (b: breaths, for holds)
//   DELETE /sessions/{id}
//   PUT    /weights/{date}   { weight }
//   DELETE /weights/{date}
//   PUT    /journal/{date}   { text, rev }   how they felt that day, in their own words
//   PUT    /food/{id}        { date, time, meal, what, kcal, protein, note, rev }   something they ate
//   DELETE /food/{id}
//   PUT    /meds/{id}        { name, kind, dose, times: [HH:MM], note, stopped, rev }   a medication or supplement; no times = as needed
//   DELETE /meds/{id}        also its logged doses
//   PUT    /doses/{date}/{id}  { med, slot, at }   taken: slot is the HH:MM it was due (id <med>-<HHMM>, so once a day
//                               each), or null for an as-needed one (id <med>-n…); at is when they took it
//   DELETE /doses/{date}/{id}  not taken after all
//   PUT    /sits/{id}        { date, time, seconds, note, rev }   a meditation: how long they sat, and how it went
//   DELETE /sits/{id}
//   POST   /starter          loads the starter program (starter.mjs) into an empty account
//   GET    /dot              this tool's description for Dot (dot.mjs, platform/api/dot-manifest.mjs), and what it
//   GET    /dot/summary, /dot/sessions, /dot/exercise, /dot/workouts, /dot/journal, /dot/food, /dot/meds, /dot/sits   calls: their log in words
//   POST   /dot/log          Dot logging a session they told it about (a new session, never a change)
//   POST   /dot/food         Dot logging something they ate (often from a photo they sent): a new entry
//   POST   /dot/journal      Dot adding to a day's journal: a new paragraph after what's there, never a rewrite
//   POST   /dot/dose         Dot logging a dose they took (the next one due that day, or an as-needed one)
//   POST   /dot/supplement   Dot adding a supplement they've started (never a medication)
//   POST   /dot/sit          Dot logging a meditation they told it about: a new one
//   PUT    /dot/supplement   Dot changing a supplement: 202 { confirm_id, prompt } first; the same request again with
//                            ?confirm_id= (Dot sends it only after their own reply) goes ahead if it's the same change,
//                            to the same version, within CONFIRM_MS, once
// A via-Dot token may read, and use only the writes the manifest declares (POST /dot/log, /dot/food, /dot/journal,
// /dot/dose, /dot/supplement, /dot/sit, PUT /dot/supplement, /weights/{date}): 403 read-only on every other write, so Dot can add
// to someone's log, change a supplement only with their OK, and never delete anything.
// Rows (pk = P#<username>, so nobody can reach anyone else's): SETTINGS, PLAN, EX#<id>, WO#<id>,
// S#<id>, BW#<date>, J#<date>, F#<id>, M#<id>, T#<date>#<dose id>, SIT#<id>. Everything but weights and doses is rev-checked: a PUT sends the rev it was based on
// (none for a new row) and gets 409 { current } if someone (another tab, another phone) got there first.
// The token is re-verified here (signature, issuer, client, expiry, group); API Gateway's
// authorizer is not trusted on its own.
import { randomBytes } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { verifyAccessToken } from './verify-token.mjs';
import { EXERCISES, WORKOUTS, PLAN, SETTINGS } from './starter.mjs';
import { writeRoutes } from './dot-manifest.mjs';
import * as dot from './dot.mjs';

const { TABLE, GROUP, ISSUER, CLIENT_ID, DOT_CLIENT_ID, TZ_HOME = 'America/New_York' } = process.env;
const DOT_WRITES = new Set(writeRoutes(dot.MANIFEST));
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const json = (statusCode, body) => ({
  statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MEASURES = ['reps', 'time', 'distance', 'breaths'];
const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const JOURNAL_MAX = 5000;
const KINDS = ['medication', 'supplement'];
// A dose's id: the medicine's, then the time it was due (so a scheduled dose is logged once a day) or n… (as needed)
const DOSE_ID = /^([A-Za-z0-9_]{1,30})-(\d{4}|n[A-Za-z0-9]{1,12})$/;
const MAX = { exercises: 300, workouts: 100, meds: 60 };
const SIT_MAX = 6 * 3600;
const CONFIRM_MS = 10 * 60_000;

class Bad extends Error {}
const bad = (msg) => { throw new Bad(msg); };
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const list = (v, max, what) => {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > max) bad(`${what}: up to ${max}`);
  return v;
};
/** A number in [min, max] (rounded to 2 places), or null when left empty */
function num(v, min, max, what) {
  if (v == null || v === '') return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) bad(`${what} must be ${min}–${max}`);
  return Math.round(v * 100) / 100;
}
const int = (v, min, max, what, dflt) => {
  const n = num(v, min, max, what);
  return n === null ? dflt : Math.round(n);
};
const optId = (v, what) => {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !ID.test(v)) bad(`bad ${what}`);
  return v;
};
const realDate = (s) => DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const optDate = (v, what) => {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !realDate(v)) bad(`${what} must be a date`);
  return v;
};
const optTime = (v, what) => {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || v.length > 30 || Number.isNaN(Date.parse(v))) bad(`bad ${what}`);
  return new Date(v).toISOString();
};

const clean = {
  settings(b) {
    const unit = b.unit ?? 'lb';
    if (!['lb', 'kg'].includes(unit)) bad('unit is lb or kg');
    const areas = [...new Set(list(b.areas, 8, 'areas').map((a) => text(a, 30)).filter(Boolean))];
    return { unit, areas };
  },
  plan(b) {
    const rotation = list(b.rotation, 14, 'rotation').map((x) => optId(x, 'workout')).filter(Boolean);
    const days = [...new Set(list(b.days, 7, 'days').map((d) => int(d, 0, 6, 'days', null)))].filter((d) => d !== null).sort();
    const from = optDate(b.from, 'from'), to = optDate(b.to, 'to');
    if (from && to && to < from) bad('the plan ends before it starts');
    return { rotation, days, from, to, perWeek: int(b.perWeek, 0, 14, 'per week', days.length) };
  },
  exercise(b) {
    const name = text(b.name, 80);
    if (!name) bad('name required');
    const measure = b.measure ?? 'reps';
    if (!MEASURES.includes(measure)) bad('measure is reps, time, distance or breaths');
    return { name, measure, perSide: b.perSide === true, note: text(b.note, 500) };
  },
  workout(b) {
    const name = text(b.name, 60);
    if (!name) bad('name required');
    const items = list(b.items, 40, 'items').map((i) => {
      if (!i || typeof i !== 'object') bad('bad item');
      const exerciseId = optId(i.exerciseId, 'exercise');
      if (!exerciseId) bad('each item needs an exercise');
      return {
        exerciseId, sets: int(i.sets, 1, 10, 'sets', 3), target: text(i.target, 20),
        pair: int(i.pair, 0, 20, 'pair', 0), rest: int(i.rest, 0, 600, 'rest', 60),
      };
    });
    return { name, note: text(b.note, 500), items };
  },
  session(b) {
    const date = optDate(b.date, 'date');
    if (!date) bad('date required');
    const discomfort = {};
    const d = b.discomfort ?? {};
    if (typeof d !== 'object' || Array.isArray(d) || Object.keys(d).length > 8) bad('bad discomfort');
    for (const [k, v] of Object.entries(d)) {
      const area = text(k, 30), n = int(v, 0, 10, 'discomfort', null);
      if (area && n !== null) discomfort[area] = n;
    }
    const entries = list(b.entries, 40, 'exercises').map((e) => {
      if (!e || typeof e !== 'object') bad('bad exercise');
      const name = text(e.name, 80);
      if (!name) bad('each exercise needs a name');
      const measure = e.measure ?? 'reps';
      if (!MEASURES.includes(measure)) bad('bad measure');
      const sets = list(e.sets, 20, 'sets').map((s) => {
        if (!s || typeof s !== 'object') bad('bad set');
        return {
          w: num(s.w, 0, 2000, 'weight'), r: int(s.r, 0, 1000, 'reps', null),
          t: num(s.t, 0, 36000, 'seconds'), d: num(s.d, 0, 100000, 'distance'), b: int(s.b, 0, 1000, 'breaths', null), done: s.done === true,
        };
      });
      return {
        exerciseId: optId(e.exerciseId, 'exercise'), name, measure, perSide: e.perSide === true, note: text(e.note, 500),
        target: text(e.target, 20), pair: int(e.pair, 0, 20, 'pair', 0), rest: int(e.rest, 0, 600, 'rest', 0), sets,
      };
    });
    return {
      date, workoutId: optId(b.workoutId, 'workout'), name: text(b.name, 60) || 'Session',
      startedAt: optTime(b.startedAt, 'start'), finishedAt: optTime(b.finishedAt, 'finish'),
      note: text(b.note, 2000), discomfort, entries,
    };
  },
  med(b) {
    const name = text(b.name, 80);
    if (!name) bad('name required');
    const kind = b.kind ?? 'supplement';
    if (!KINDS.includes(kind)) bad('kind is medication or supplement');
    const times = [...new Set(list(b.times, 6, 'times').map((t) => {
      if (typeof t !== 'string' || !TIME.test(t)) bad('times are HH:MM');
      return t;
    }))].sort();
    return { name, kind, dose: text(b.dose, 40), times, note: text(b.note, 500), stopped: b.stopped === true };
  },
  food(b) {
    const date = optDate(b.date, 'date');
    if (!date) bad('date required');
    const what = text(b.what, 300);
    if (!what) bad('say what it was');
    const time = b.time == null || b.time === '' ? null : b.time;
    if (time !== null && (typeof time !== 'string' || !TIME.test(time))) bad('time is HH:MM');
    const meal = b.meal == null || b.meal === '' ? null : b.meal;
    if (meal !== null && !MEALS.includes(meal)) bad('meal is breakfast, lunch, dinner or snack');
    return { date, time, meal, what, kcal: int(b.kcal, 0, 10000, 'calories', null), protein: int(b.protein, 0, 1000, 'protein', null), note: text(b.note, 500) };
  },
  sit(b) {
    const date = optDate(b.date, 'date');
    if (!date) bad('date required');
    const time = b.time == null || b.time === '' ? null : b.time;
    if (time !== null && (typeof time !== 'string' || !TIME.test(time))) bad('time is HH:MM');
    const seconds = int(b.seconds, 1, SIT_MAX, 'seconds', null);
    if (seconds === null) bad('say how long');
    return { date, time, seconds, note: text(b.note, JOURNAL_MAX) };
  },
};

// Row shapes the page sees: everything but the keys and bookkeeping
const strip = ({ pk, sk, updatedAt, ...rest }) => rest;
const shape = {
  EX: (i) => ({ id: i.sk.slice(3), ...strip(i) }),
  WO: (i) => ({ id: i.sk.slice(3), ...strip(i) }),
  S: (i) => ({ id: i.sk.slice(2), ...strip(i) }),
  BW: (i) => ({ date: i.sk.slice(3), weight: i.weight }),
  J: (i) => ({ date: i.sk.slice(2), ...strip(i) }),
  F: (i) => ({ id: i.sk.slice(2), ...strip(i) }),
  M: (i) => ({ id: i.sk.slice(2), ...strip(i) }),
  SIT: (i) => ({ id: i.sk.slice(4), ...strip(i) }),
};
const rowShape = (i) => (i.sk === 'SETTINGS' || i.sk === 'PLAN' ? strip(i) : shape[i.sk.split('#')[0]](i));

async function rows(pk) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const r = await db.send(new QueryCommand({
      TableName: TABLE, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': pk }, ExclusiveStartKey,
    }));
    items.push(...r.Items);
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function getAll(pk) {
  const out = { settings: null, plan: null, exercises: [], workouts: [], sessions: [], weights: [], journal: [], food: [], meds: [], doses: [], sits: [] };
  for (const i of await rows(pk)) {
    if (i.sk === 'SETTINGS') out.settings = strip(i);
    else if (i.sk === 'PLAN') out.plan = strip(i);
    else if (i.sk.startsWith('EX#')) out.exercises.push(shape.EX(i));
    else if (i.sk.startsWith('WO#')) out.workouts.push(shape.WO(i));
    else if (i.sk.startsWith('S#')) out.sessions.push(shape.S(i));
    else if (i.sk.startsWith('BW#')) out.weights.push(shape.BW(i));
    else if (i.sk.startsWith('J#')) out.journal.push(shape.J(i));
    else if (i.sk.startsWith('F#')) out.food.push(shape.F(i));
    else if (i.sk.startsWith('M#')) out.meds.push(shape.M(i));
    else if (i.sk.startsWith('SIT#')) out.sits.push(shape.SIT(i));
    else if (i.sk.startsWith('T#')) out.doses.push({ date: i.sk.slice(2, 12), id: i.sk.slice(13), med: i.med, slot: i.slot ?? null, at: i.at });
  }
  out.settings ??= { ...SETTINGS, areas: [] };
  out.exercises.sort((a, b) => a.name.localeCompare(b.name));
  out.workouts.sort((a, b) => a.name.localeCompare(b.name));
  out.journal.sort((a, b) => (a.date < b.date ? -1 : 1));
  out.meds.sort((a, b) => a.name.localeCompare(b.name));
  out.doses.sort((a, b) => (a.date === b.date ? (a.at || '').localeCompare(b.at || '') : a.date < b.date ? -1 : 1));
  out.food.sort((a, b) => (a.date === b.date ? (a.time || '').localeCompare(b.time || '') : a.date < b.date ? -1 : 1));
  out.sits.sort((a, b) => (a.date === b.date ? (a.time || '').localeCompare(b.time || '') : a.date < b.date ? -1 : 1));
  out.sessions.sort((a, b) => (a.date === b.date ? (a.startedAt || '').localeCompare(b.startedAt || '') : a.date < b.date ? -1 : 1));
  return out;
}

/** Put a rev-checked row: rev is what the caller based its edit on (undefined: a new row) */
async function save(pk, sk, data, rev) {
  if (rev !== undefined && rev !== null && !Number.isInteger(rev)) bad('bad rev');
  const isNew = rev === undefined || rev === null;
  const Item = { pk, sk, ...data, rev: isNew ? 1 : rev + 1, updatedAt: new Date().toISOString() };
  try {
    await db.send(new PutCommand({
      TableName: TABLE, Item,
      ConditionExpression: isNew ? 'attribute_not_exists(pk)' : 'rev = :rev',
      ExpressionAttributeValues: isNew ? undefined : { ':rev': rev },
    }));
  } catch (e) {
    if (e.name !== 'ConditionalCheckFailedException') throw e;
    const cur = (await db.send(new GetCommand({ TableName: TABLE, Key: { pk, sk } }))).Item;
    return json(409, { error: 'changed', current: cur ? rowShape(cur) : null });
  }
  return json(200, rowShape(Item));
}

const newId = () => `x${randomBytes(6).toString('hex')}`;

/** Log a dose taken: an id that says which medicine and which of its times (or as needed), checked against it */
async function putDose(pk, date, id, b) {
  const m = DOSE_ID.exec(id ?? '');
  if (!m) bad('bad dose id');
  const med = (await db.send(new GetCommand({ TableName: TABLE, Key: { pk, sk: `M#${m[1]}` } }))).Item;
  if (!med || b.med !== m[1]) bad('no such medication or supplement');
  const slot = b.slot == null || b.slot === '' ? null : b.slot;
  if (slot !== null && (!med.times.includes(slot) || m[2] !== slot.replace(':', ''))) bad('that isn’t one of its times');
  if (slot === null && !m[2].startsWith('n')) bad('an as-needed dose’s id ends in n…');
  if (typeof b.at !== 'string' || !TIME.test(b.at)) bad('at is HH:MM');
  await db.send(new PutCommand({ TableName: TABLE, Item: { pk, sk: `T#${date}#${id}`, med: m[1], slot, at: b.at, updatedAt: new Date().toISOString() } }));
  return { date, id, med: m[1], slot, at: b.at };
}

/**
 * Dot changing a supplement waits for the person's OK. Without a confirm id: keep what was asked (PENDING#<id>) and answer
 * 202. With one: go ahead only if it's the same change to the same version, in time, once; the save is rev-checked too.
 */
async function changeSupplement(pk, body, confirmId, by) {
  const ch = dot.supplementChange(await getAll(pk), body);
  if (ch.error) return json(400, ch);
  const next = clean.med(ch.next), what = JSON.stringify(next), t = Date.now();
  if (!confirmId) {
    // Old asks nobody answered go when a new one comes
    for (const p of (await rows(pk)).filter((i) => i.sk.startsWith('PENDING#') && i.until < t)) {
      await db.send(new DeleteCommand({ TableName: TABLE, Key: { pk, sk: p.sk } }));
    }
    const cid = randomBytes(12).toString('hex');
    await db.send(new PutCommand({ TableName: TABLE, Item: { pk, sk: `PENDING#${cid}`, med: ch.med.id, rev: ch.med.rev, what, until: t + CONFIRM_MS } }));
    return json(202, { confirm_id: cid, prompt: ch.prompt });
  }
  const p = /^[a-f0-9]{24}$/.test(confirmId) ? (await db.send(new GetCommand({ TableName: TABLE, Key: { pk, sk: `PENDING#${confirmId}` } }))).Item : null;
  if (p) await db.send(new DeleteCommand({ TableName: TABLE, Key: { pk, sk: p.sk } }));
  if (!p || p.med !== ch.med.id || p.rev !== ch.med.rev || p.what !== what || p.until < t) {
    return json(400, { error: 'that confirmation doesn’t match or has expired; ask again' });
  }
  const r = await save(pk, `M#${ch.med.id}`, next, ch.med.rev);
  if (r.statusCode !== 200) return r;
  console.log('supplement changed via dot', JSON.stringify({ by, id: ch.med.id }));
  return json(200, { changed: dot.supplementOut(JSON.parse(r.body)) });
}

async function loadStarter(pk) {
  const existing = await rows(pk);
  if (existing.some((i) => i.sk.startsWith('EX#') || i.sk.startsWith('WO#'))) {
    return json(409, { error: 'You already have exercises or workouts; the starter only loads into an empty account.' });
  }
  const now = new Date().toISOString();
  const put = (sk, data) => db.send(new PutCommand({
    TableName: TABLE, Item: { pk, sk, ...data, rev: 1, updatedAt: now }, ConditionExpression: 'attribute_not_exists(pk)',
  }));
  const exIds = {}, woIds = {};
  for (const [key, ex] of Object.entries(EXERCISES)) {
    exIds[key] = newId();
    await put(`EX#${exIds[key]}`, clean.exercise(ex));
  }
  for (const w of WORKOUTS) {
    woIds[w.key] = newId();
    await put(`WO#${woIds[w.key]}`, clean.workout({
      name: w.name, note: w.note, items: w.items.map(({ ex, ...i }) => ({ exerciseId: exIds[ex], ...i })),
    }));
  }
  // The plan and areas only fill in what isn't set yet
  if (!existing.some((i) => i.sk === 'PLAN')) {
    await put('PLAN', clean.plan({ ...PLAN, rotation: PLAN.rotation.map((k) => woIds[k]), from: null, to: null }));
  }
  if (!existing.some((i) => i.sk === 'SETTINGS')) await put('SETTINGS', clean.settings(SETTINGS));
  return json(200, await getAll(pk));
}

export const handler = async (event) => {
  let claims;
  try {
    claims = await verifyAccessToken(event.headers, { issuer: ISSUER, clientId: [CLIENT_ID, DOT_CLIENT_ID].filter(Boolean), group: GROUP });
  } catch (e) {
    if (!e.status) throw e;
    console.warn('denied', e.message);
    return json(e.status, { error: e.status === 403 ? 'forbidden' : 'unauthorized' });
  }
  if (!claims.username || !ID.test(claims.username)) return json(403, { error: 'forbidden' });
  const pk = `P#${claims.username}`;
  const viaDot = claims.via === 'dot' || (!!DOT_CLIENT_ID && claims.client_id === DOT_CLIENT_ID);
  if (viaDot && !event.routeKey.startsWith('GET ') && !DOT_WRITES.has(event.routeKey)) return json(403, { error: 'read-only' });

  let body = {};
  if (event.body) {
    try {
      body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body);
    } catch {
      return json(400, { error: 'bad json' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'bad json' });
  }
  const id = event.pathParameters?.id;
  if (id !== undefined && !ID.test(id)) return json(400, { error: 'bad id' });
  const date = event.pathParameters?.date;
  if (date !== undefined && !realDate(date)) return json(400, { error: 'bad date' });
  const del = async (sk) => { await db.send(new DeleteCommand({ TableName: TABLE, Key: { pk, sk } })); return json(200, {}); };
  const count = async (prefix) => (await rows(pk)).filter((i) => i.sk.startsWith(prefix)).length;
  // A new row (no rev) counts toward the per-person cap
  const capped = async (prefix, what) => (body.rev == null && (await count(prefix)) >= MAX[what]
    ? json(400, { error: `up to ${MAX[what]} ${what}` }) : null);

  try {
    switch (event.routeKey) {
      case 'GET /all':
        return json(200, await getAll(pk));
      case 'PUT /settings':
        return await save(pk, 'SETTINGS', clean.settings(body), body.rev);
      case 'PUT /plan':
        return await save(pk, 'PLAN', clean.plan(body), body.rev);
      case 'PUT /exercises/{id}':
        return (await capped('EX#', 'exercises')) ?? await save(pk, `EX#${id}`, clean.exercise(body), body.rev);
      case 'DELETE /exercises/{id}': {
        // A saved workout pointing at a missing exercise would break; the person picks what to change
        const using = (await rows(pk)).filter((i) => i.sk.startsWith('WO#') && i.items.some((x) => x.exerciseId === id));
        if (using.length) return json(409, { error: 'in use', workouts: using.map((w) => w.name) });
        return await del(`EX#${id}`);
      }
      case 'PUT /workouts/{id}':
        return (await capped('WO#', 'workouts')) ?? await save(pk, `WO#${id}`, clean.workout(body), body.rev);
      case 'DELETE /workouts/{id}':
        return await del(`WO#${id}`);
      case 'PUT /sessions/{id}':
        return await save(pk, `S#${id}`, clean.session(body), body.rev);
      case 'DELETE /sessions/{id}':
        return await del(`S#${id}`);
      case 'PUT /weights/{date}': {
        const weight = num(body.weight, 20, 1000, 'weight');
        if (weight === null) bad('weight required');
        await db.send(new PutCommand({ TableName: TABLE, Item: { pk, sk: `BW#${date}`, weight, updatedAt: new Date().toISOString() } }));
        return json(200, { date, weight });
      }
      case 'DELETE /weights/{date}':
        return await del(`BW#${date}`);
      case 'PUT /journal/{date}':
        return await save(pk, `J#${date}`, { text: text(body.text, JOURNAL_MAX) }, body.rev);
      case 'PUT /food/{id}':
        return await save(pk, `F#${id}`, clean.food(body), body.rev);
      case 'DELETE /food/{id}':
        return await del(`F#${id}`);
      case 'PUT /meds/{id}':
        if (!/^[A-Za-z0-9_]{1,30}$/.test(id)) return json(400, { error: 'bad id' });
        return (await capped('M#', 'meds')) ?? await save(pk, `M#${id}`, clean.med(body), body.rev);
      case 'DELETE /meds/{id}': {
        // Its doses go with it: a dose of nothing would only confuse the history
        for (const t of (await rows(pk)).filter((i) => i.sk.startsWith('T#') && i.med === id)) {
          await db.send(new DeleteCommand({ TableName: TABLE, Key: { pk, sk: t.sk } }));
        }
        return await del(`M#${id}`);
      }
      case 'PUT /doses/{date}/{id}':
        return json(200, await putDose(pk, date, id, body));
      case 'DELETE /doses/{date}/{id}':
        return await del(`T#${date}#${id}`);
      case 'PUT /sits/{id}':
        return await save(pk, `SIT#${id}`, clean.sit(body), body.rev);
      case 'DELETE /sits/{id}':
        return await del(`SIT#${id}`);
      case 'POST /starter':
        return await loadStarter(pk);
      case 'GET /dot':
        return json(200, dot.MANIFEST);
      case 'GET /dot/summary':
        return json(200, dot.summary(await getAll(pk), dot.localDay(new Date(), TZ_HOME)));
      case 'GET /dot/sessions': {
        const q = event.queryStringParameters ?? {};
        return json(200, dot.sessions(await getAll(pk), { from: optDate(q.from, 'from'), to: optDate(q.to, 'to'), limit: q.limit }));
      }
      case 'GET /dot/exercise':
        return json(200, dot.exercise(await getAll(pk), event.queryStringParameters?.name));
      case 'GET /dot/workouts':
        return json(200, dot.workouts(await getAll(pk)));
      case 'GET /dot/journal': {
        const q = event.queryStringParameters ?? {};
        return json(200, dot.journal(await getAll(pk), { from: optDate(q.from, 'from'), to: optDate(q.to, 'to'), limit: q.limit }));
      }
      case 'GET /dot/food': {
        const q = event.queryStringParameters ?? {};
        return json(200, dot.food(await getAll(pk), { from: optDate(q.from, 'from'), to: optDate(q.to, 'to'), limit: q.limit }));
      }
      case 'POST /dot/food': {
        const now = new Date();
        const entry = clean.food(dot.foodEntry(body, dot.localDay(now, TZ_HOME), dot.localTime(now, TZ_HOME)));
        const fid = newId(), r = await save(pk, `F#${fid}`, { ...entry, source: 'dot' }, undefined);
        if (r.statusCode !== 200) return r;
        console.log('food via dot', JSON.stringify({ by: claims.username, id: fid, date: entry.date }));
        return json(200, { logged: dot.foodOut(JSON.parse(r.body)), date: entry.date, note: 'They can fix or delete it on Health’s Food tab.' });
      }
      case 'GET /dot/meds':
        return json(200, dot.meds(await getAll(pk), dot.localDay(new Date(), TZ_HOME)));
      case 'POST /dot/dose': {
        const now = new Date(), day = optDate(body.date, 'date') ?? dot.localDay(now, TZ_HOME);
        const pick = dot.doseFor(await getAll(pk), body.name, day, newId().slice(1, 9));
        if (pick.error) return json(400, pick);
        const d = await putDose(pk, day, pick.id, { med: pick.med.id, slot: pick.slot, at: body.time ?? dot.localTime(now, TZ_HOME) });
        console.log('dose via dot', JSON.stringify({ by: claims.username, med: d.med, date: day }));
        return json(200, { logged: { name: pick.med.name, dose: pick.med.dose || undefined, date: day, due: d.slot ?? 'as needed', taken_at: d.at } });
      }
      case 'POST /dot/supplement': {
        const add = dot.supplementNew(await getAll(pk), body);
        if (add.error) return json(400, add);
        const mid = newId(), r = (await capped('M#', 'meds')) ?? await save(pk, `M#${mid}`, clean.med(add.fields), undefined);
        if (r.statusCode !== 200) return r;
        console.log('supplement via dot', JSON.stringify({ by: claims.username, id: mid }));
        return json(200, { added: dot.supplementOut(JSON.parse(r.body)), note: 'They can change or delete it on Health’s Meds tab.' });
      }
      case 'GET /dot/sits': {
        const q = event.queryStringParameters ?? {};
        return json(200, dot.sits(await getAll(pk), dot.localDay(new Date(), TZ_HOME), { from: optDate(q.from, 'from'), to: optDate(q.to, 'to'), limit: q.limit }));
      }
      case 'POST /dot/sit': {
        const now = new Date();
        const sit = clean.sit(dot.sitEntry(body, dot.localDay(now, TZ_HOME), dot.localTime(now, TZ_HOME)));
        const sid = newId(), r = await save(pk, `SIT#${sid}`, sit, undefined);
        if (r.statusCode !== 200) return r;
        console.log('sit via dot', JSON.stringify({ by: claims.username, id: sid, date: sit.date }));
        return json(200, { logged: dot.sitOut(JSON.parse(r.body)), note: 'They can fix or delete it on Health’s Meditate tab.' });
      }
      case 'PUT /dot/supplement':
        return await changeSupplement(pk, body, event.queryStringParameters?.confirm_id, claims.username);
      case 'POST /dot/journal': {
        // Added after what's there, so nothing they wrote is ever replaced; a race with their page is retried
        const day = optDate(body.date, 'date') ?? dot.localDay(new Date(), TZ_HOME), add = text(body.text, 2000);
        if (!add) bad('text required');
        for (let i = 0; i < 3; i++) {
          const cur = (await db.send(new GetCommand({ TableName: TABLE, Key: { pk, sk: `J#${day}` } }))).Item;
          const all = cur?.text ? `${cur.text}\n\n${add}` : add;
          if (all.length > JOURNAL_MAX) return json(400, { error: 'that day’s journal is full' });
          const r = await save(pk, `J#${day}`, { text: all }, cur?.rev);
          if (r.statusCode !== 409) return r.statusCode === 200 ? json(200, { added_to: day, text: JSON.parse(r.body).text }) : r;
        }
        return json(409, { error: 'the journal kept changing; try again' });
      }
      case 'POST /dot/log': {
        const all = await getAll(pk);
        const { session, named } = dot.logToSession(body, all, dot.localDay(new Date(), TZ_HOME), new Date().toISOString());
        const sid = newId(), r = await save(pk, `S#${sid}`, clean.session(session), undefined);
        if (r.statusCode !== 200) return r;
        const s = JSON.parse(r.body);
        console.log('logged via dot', JSON.stringify({ by: claims.username, id: sid, date: s.date }));
        return json(200, { logged: { date: s.date, workout: s.name, exercises: named }, unmatched_note: named.some((n) => !n.matched)
          ? 'Exercises not matched to a saved one are kept by name but don’t show in that exercise’s progress.' : undefined });
      }
      default:
        return json(404, { error: 'no route' });
    }
  } catch (e) {
    if (e instanceof Bad) return json(400, { error: e.message });
    throw e;
  }
};
