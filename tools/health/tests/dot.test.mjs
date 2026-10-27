import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { accessToken } from '../../../platform/tests/helpers/tokens.mjs';
import { validateManifest, writeRoutes, requestPath, requestBody } from '../../../platform/api/dot-manifest.mjs';
import { ROUTES, call, dotToken, table } from './helpers/health-api.mjs';
import { MANIFEST, localDay } from '../api/dot.mjs';

beforeEach(() => table.clear());
const op = (name) => MANIFEST.operations.find((o) => o.name === name);
// Calls an operation the way Dot's discovery does: path and query from requestPath, a write's body from requestBody
const dot = (name, input = {}, token = dotToken()) => {
  const o = op(name);
  return call(o.method ?? 'GET', requestPath(o, input), (o.method ?? 'GET') === 'GET' ? undefined : requestBody(o, input), token);
};
const ymd = (n = 0) => localDay(new Date(Date.now() - n * 86_400_000), 'America/New_York');

test('Dot reads a valid manifest, and every operation is a real route', async () => {
  const r = await call('GET', '/dot', undefined, dotToken());
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, MANIFEST);
  validateManifest(r.body);
  for (const o of MANIFEST.operations) {
    assert.ok(ROUTES.includes(`${o.method ?? 'GET'} ${o.path}`), `${o.name}: ${o.path}`);
  }
  assert.deepEqual(writeRoutes(MANIFEST).sort(), ['POST /dot/dose', 'POST /dot/food', 'POST /dot/journal', 'POST /dot/log', 'PUT /weights/{date}']);
});

test('from Dot: reads and the two declared writes; every other change is refused', async () => {
  await call('PUT', '/sessions/s1', { date: ymd(), name: 'A' });
  for (const [m, p, b] of [
    ['PUT', '/sessions/s1', { date: ymd(), name: 'changed', rev: 1 }], ['DELETE', '/sessions/s1'], ['POST', '/starter'],
    ['PUT', '/settings', { unit: 'kg' }], ['PUT', '/plan', {}], ['PUT', '/exercises/x', { name: 'X' }], ['DELETE', '/exercises/x'],
    ['PUT', '/workouts/w', { name: 'W' }], ['DELETE', '/workouts/w'], ['DELETE', '/weights/2026-10-26'],
    ['PUT', '/journal/2026-10-26', { text: 'from Dot' }], ['PUT', '/food/f1', { date: '2026-10-26', what: 'x' }], ['DELETE', '/food/f1'],
    ['PUT', '/meds/m1', { name: 'X' }], ['DELETE', '/meds/m1'], ['PUT', '/doses/2026-10-26/m1-na1', { med: 'm1', at: '08:00' }], ['DELETE', '/doses/2026-10-26/m1-0800'],
  ]) {
    const r = await call(m, p, b, dotToken());
    assert.deepEqual([r.status, r.body.error], [403, 'read-only'], `${m} ${p}`);
  }
  assert.equal((await call('GET', '/all')).body.sessions[0].name, 'A', 'untouched');
  assert.equal((await dot('log_weight', { date: ymd(), weight: 181 })).status, 200);
  assert.equal((await dot('log', { workout: 'A' })).status, 200);
  // The page's own token is still the only way to change things; a via-Dot claim on it counts too
  assert.equal((await call('DELETE', '/sessions/s1', undefined, accessToken({ clientId: 'health-client', group: 'family_health', username: 'luke-sub', via: 'dot' }))).status, 403);
});

test('Dot only ever sees and logs the asker’s own workouts', async () => {
  await call('POST', '/starter');
  await dot('log', { workout: 'Session A', exercises: [{ name: 'trap bar', sets: [{ weight: 135, reps: 8 }] }] });
  const amber = dotToken('amber-sub');
  assert.deepEqual((await dot('sessions', {}, amber)).body, []);
  assert.deepEqual((await dot('workouts', {}, amber)).body, { workouts: [], plan: null });
  assert.equal((await dot('summary', {}, amber)).body.last_sessions.length, 0);
  assert.match((await dot('exercise', { name: 'trap bar' }, amber)).body.error, /no exercise/);
  await dot('log', { workout: 'Mine' }, amber);
  assert.equal((await call('GET', '/all')).body.sessions.length, 1, 'Amber’s log went to Amber');
  assert.equal(table.dump().filter(([k]) => k.startsWith('P#amber-sub|')).length, 1);
});

test('the summary: this week against the goal, what’s next, recent sessions and soreness', async () => {
  const { body } = await call('POST', '/starter');
  const a = body.workouts.find((w) => w.name === 'Session A');
  await call('PUT', '/sessions/s1', { date: ymd(), workoutId: a.id, name: 'Session A', finishedAt: new Date().toISOString(), discomfort: { Shoulders: 2 },
    entries: [{ name: 'Trap bar deadlift', sets: [{ w: 135, r: 8, done: true }, { w: 135, r: 8, done: false }] }] });
  await call('PUT', `/weights/${ymd()}`, { weight: 181 });
  const s = (await dot('summary')).body;
  assert.equal(s.this_week.sessions, 1);
  assert.equal(s.this_week.goal, 3);
  assert.equal(s.next.workout, 'Session B');
  assert.match(s.next.day, /^(Monday|Wednesday|Friday) \d{4}-\d{2}-\d{2}/);
  assert.deepEqual(s.last_sessions[0], { date: ymd(), workout: 'Session A', sets_done: 1, discomfort: { Shoulders: 2 } });
  assert.deepEqual(s.body_weight, { date: ymd(), weight: 181 });
  assert.deepEqual(s.rated_areas, ['Shoulders', 'Lower back']);
  assert.equal(s.unit, 'lb');
});

test('one exercise’s history by part of its name; an unclear name lists the candidates', async () => {
  const { body } = await call('POST', '/starter');
  const tb = body.exercises.find((x) => x.name === 'Trap bar deadlift');
  for (const [i, w] of [[3, 125], [1, 135]].entries()) {
    await call('PUT', `/sessions/s${i}`, { date: ymd(w[0]), name: 'A', finishedAt: new Date().toISOString(),
      entries: [{ exerciseId: tb.id, name: tb.name, sets: [{ w: w[1], r: 8, done: true }, { w: w[1], r: 7, done: true }] }] });
  }
  const r = (await dot('exercise', { name: 'TRAP BAR' })).body;
  assert.equal(r.exercise, 'Trap bar deadlift');
  assert.deepEqual(r.history.map((h) => h.sets), ['135 × 8, 135 × 7', '125 × 8, 125 × 7'], 'newest first');
  assert.match(r.cues, /High handles/);
  const unclear = (await dot('exercise', { name: 'row' })).body;
  assert.match(unclear.error, /more than one/);
  assert.ok(unclear.candidates.includes('Chest-supported row') && unclear.candidates.includes('Single-arm cable row'));
});

test('logging from Dot links to their workout and exercises, so it counts in the plan and progress', async () => {
  await call('POST', '/starter');
  const r = await dot('log', {
    date: ymd(1), workout: 'session a', note: 'From the car', discomfort: { 'Lower back': 1 },
    exercises: [
      { name: 'trap bar deadlift', sets: [{ weight: 135, reps: 8 }, { weight: 135, reps: 8 }] },
      { name: 'suitcase', sets: [{ weight: 50, meters: 30 }] },
      { name: 'Farmer walk', sets: [{ weight: 60, meters: 40 }] },
    ],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.logged.exercises.map((e) => [e.logged_as, e.matched]),
    [['Trap bar deadlift', true], ['Suitcase carry', true], ['Farmer walk', false]]);
  assert.ok(r.body.unmatched_note);
  const all = (await call('GET', '/all')).body, [s] = all.sessions;
  assert.equal(s.workoutId, all.workouts.find((w) => w.name === 'Session A').id);
  assert.equal(s.date, ymd(1));
  assert.ok(s.finishedAt);
  assert.deepEqual(s.entries[0].sets[0], { w: 135, r: 8, t: null, d: null, b: null, done: true });
  assert.equal(s.entries[1].measure, 'distance');
  assert.equal(s.entries[2].exerciseId, null);
  assert.equal(s.entries[2].measure, 'distance', 'an unknown exercise’s measure comes from what was logged');
  assert.equal((await dot('summary')).body.next.workout, 'Session B');
  assert.equal((await dot('exercise', { name: 'trap bar' })).body.history[0].sets, '135 × 8, 135 × 8');
});

test('a hold Dot logs is counted in breaths', async () => {
  await call('POST', '/starter');
  await dot('log', { workout: 'Mobility', exercises: [{ name: 'couch stretch', sets: [{ breaths: 12 }] }, { name: 'Pigeon', sets: [{ breaths: 8 }] }] });
  const [s] = (await call('GET', '/all')).body.sessions;
  assert.deepEqual(s.entries.map((e) => [e.measure, e.sets[0].b]), [['breaths', 12], ['breaths', 8]], 'a saved hold, and an unknown one by what was said');
  assert.equal((await dot('exercise', { name: 'couch' })).body.history[0].sets, '12 breaths');
});

test('the journal: Dot reads their days, newest first, and never anyone else’s', async () => {
  await call('PUT', `/journal/${ymd(3)}`, { text: 'Knee ached on stairs.' });
  await call('PUT', `/journal/${ymd(2)}`, { text: '' });
  await call('PUT', `/journal/${ymd(1)}`, { text: 'Shoulders loose. '.repeat(30) });
  await call('PUT', `/journal/${ymd(0)}`, { text: 'Tired, slept 5 hours.' });
  const all = (await dot('journal')).body;
  assert.deepEqual(all.map((j) => j.date.slice(-10)), [ymd(0), ymd(1), ymd(3)], 'newest first; an empty day is left out');
  assert.match(all[0].date, /^\w+day /);
  assert.deepEqual((await dot('journal', { from: ymd(3), to: ymd(2) })).body.map((j) => j.text), ['Knee ached on stairs.']);
  assert.equal((await dot('journal', { limit: 1 })).body.length, 1);
  const sum = (await dot('summary')).body.journal;
  assert.equal(sum.length, 3);
  assert.ok(sum[1].text.length <= 301 && sum[1].text.endsWith('…'), 'the summary keeps it short');
  assert.deepEqual((await dot('journal', {}, dotToken('amber-sub'))).body, []);
});

test('Dot logs food: today and now unless they said, marked as Dot’s, and only theirs', async () => {
  const r = await dot('log_food', { what: 'Grilled chicken thigh, about a cup of rice, broccoli', meal: 'dinner', calories: 650, protein_g: 42 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.logged, { time: r.body.logged.time, meal: 'dinner', what: 'Grilled chicken thigh, about a cup of rice, broccoli', calories: 650, protein_g: 42, logged_by: 'Dot' });
  assert.match(r.body.logged.time, /^\d\d:\d\d$/);
  assert.equal(r.body.date, ymd());
  await dot('log_food', { what: 'Yogurt', date: ymd(1), time: '08:05', calories: 150 });
  await dot('log_food', { what: 'Banana', date: ymd(1), time: '15:00' });
  const [f] = (await call('GET', '/all')).body.food.filter((x) => x.date === ymd());
  assert.deepEqual([f.source, f.kcal, f.protein], ['dot', 650, 42]);
  const days = (await dot('food')).body;
  assert.deepEqual(days.map((d) => d.date.slice(-10)), [ymd(), ymd(1)], 'newest first');
  assert.deepEqual([days[1].calories, days[1].protein_g, days[1].without_calories, days[1].entries.map((e) => e.what)], [150, 0, 1, ['Yogurt', 'Banana']]);
  assert.equal((await dot('summary')).body.food_today.calories, 650);
  assert.equal((await dot('log_food', { what: '' })).status, 400);
  assert.equal((await dot('log_food', { what: 'x', time: '7pm' })).status, 400);
  assert.deepEqual((await dot('food', {}, dotToken('amber-sub'))).body, []);
  // Fixed on the page, it's theirs: no longer marked as Dot's
  await call('PUT', `/food/${f.id}`, { date: f.date, what: 'Chicken, rice, broccoli', kcal: 600, rev: f.rev });
  assert.equal((await call('GET', '/all')).body.food.find((x) => x.id === f.id).source, undefined);
});

test('Dot adds to the journal after what’s there, never over it', async () => {
  await call('PUT', `/journal/${ymd()}`, { text: 'Back stiff this morning.' });
  const r = await dot('add_to_journal', { text: 'Knee sore after the stairs.' });
  assert.deepEqual(r.body, { added_to: ymd(), text: 'Back stiff this morning.\n\nKnee sore after the stairs.' });
  await dot('add_to_journal', { text: 'Slept badly.', date: ymd(1) });
  const j = (await call('GET', '/all')).body.journal;
  assert.deepEqual(j.map((x) => [x.date, x.text, x.rev]), [[ymd(1), 'Slept badly.', 1], [ymd(), 'Back stiff this morning.\n\nKnee sore after the stairs.', 2]]);
  assert.equal((await dot('add_to_journal', { text: ' ' })).status, 400);
  await call('PUT', `/journal/${ymd(2)}`, { text: 'x'.repeat(4990) });
  assert.equal((await dot('add_to_journal', { text: 'one more line', date: ymd(2) })).status, 400, 'full: refused, not cut off');
  assert.equal((await call('GET', '/all')).body.journal[0].text.length, 4990);
  await dot('add_to_journal', { text: 'mine' }, dotToken('amber-sub'));
  assert.match((await call('GET', '/all')).body.journal.at(-1).text, /^Back stiff/, 'Amber’s note went to Amber');
});

test('meds from Dot: what’s due and taken, and ticking off the next dose', async () => {
  await call('PUT', '/meds/vitd', { name: 'Vitamin D', dose: '2000 IU', times: ['08:00', '20:00'] });
  await call('PUT', '/meds/mag', { name: 'Magnesium glycinate', times: ['21:00'] });
  await call('PUT', '/meds/ibu', { name: 'Ibuprofen', kind: 'medication', dose: '200 mg' });
  await call('PUT', '/meds/old', { name: 'Old pill', times: ['09:00'], stopped: true });
  await call('PUT', `/doses/${ymd(1)}/vitd-0800`, { med: 'vitd', slot: '08:00', at: '08:05' });
  assert.match(MANIFEST.description, /Never advise starting, stopping or changing a medication/);
  let m = (await dot('meds')).body;
  assert.deepEqual(m.medications.map((x) => x.name), ['Ibuprofen'], 'medications apart');
  assert.deepEqual(m.supplements.map((x) => x.name), ['Magnesium glycinate', 'Vitamin D'], 'not what they stopped');
  assert.deepEqual(m.stopped, ['Old pill']);
  assert.deepEqual(m.supplements[1].today, [{ due: '08:00', taken_at: null }, { due: '20:00', taken_at: null }]);
  assert.equal(m.supplements[1].last_7_days, '1 of 14 doses');
  assert.equal(m.medications[0].when, 'as needed');

  let r = await dot('log_dose', { name: 'vitamin d', time: '08:30' });
  assert.deepEqual(r.body.logged, { name: 'Vitamin D', dose: '2000 IU', date: ymd(), due: '08:00', taken_at: '08:30' });
  r = await dot('log_dose', { name: 'vitamin d' });
  assert.equal(r.body.logged.due, '20:00', 'the next one due');
  assert.match((await dot('log_dose', { name: 'vitamin d' })).body.error, /already ticked off/);
  assert.equal((await dot('log_dose', { name: 'ibuprofen' })).body.logged.due, 'as needed');
  assert.equal((await dot('log_dose', { name: 'ibuprofen' })).status, 200, 'as needed, as often as taken');
  const unknown = (await dot('log_dose', { name: 'fish oil' })).body;
  assert.deepEqual([unknown.error, unknown.candidates.length], ['nothing they take by that name', 3]);
  assert.equal((await dot('log_dose', { name: 'old pill' })).status, 400, 'nothing stopped');
  m = (await dot('meds')).body;
  assert.equal(m.medications[0].today.length, 2);
  assert.deepEqual((await dot('summary')).body.meds_today, { doses_due: 3, taken: 2, not_yet: ['Magnesium glycinate 21:00'] });
  assert.equal((await dot('meds', {}, dotToken('amber-sub'))).body.supplements.length, 0);
  assert.equal((await dot('log_dose', { name: 'vitamin d' }, dotToken('amber-sub'))).status, 400, 'only their own');
});

test('each log is a new session; bad input is refused', async () => {
  await dot('log', { workout: 'Walk' });
  await dot('log', { workout: 'Walk' });
  assert.equal((await call('GET', '/all')).body.sessions.length, 2);
  assert.equal((await dot('log', { date: '2026-13-01' })).status, 400);
  assert.equal((await dot('log', { exercises: [{ name: 'X', sets: [{ weight: -1 }] }] })).status, 400);
  assert.equal((await dot('log_weight', { date: ymd(), weight: 2 })).status, 400);
});

test('sessions: newest first, between dates, at most 30', async () => {
  for (let i = 0; i < 35; i++) await call('PUT', `/sessions/s${String(i).padStart(2, '0')}`, { date: ymd(40 - i), name: `S${i}`, finishedAt: new Date().toISOString() });
  const all = (await dot('sessions', { limit: 30 })).body;
  assert.equal(all.length, 30);
  assert.equal(all[0].workout, 'S34');
  assert.equal((await dot('sessions')).body.length, 10);
  assert.deepEqual((await dot('sessions', { from: ymd(10), to: ymd(8) })).body.map((s) => s.workout), ['S32', 'S31', 'S30']);
});

test('“today” is the day at home, not in UTC', () => {
  assert.equal(localDay(new Date('2026-10-26T02:30:00Z'), 'America/New_York'), '2026-10-25');
  assert.equal(localDay(new Date('2026-10-26T13:00:00Z'), 'America/New_York'), '2026-10-26');
});
