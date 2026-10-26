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
  assert.deepEqual(writeRoutes(MANIFEST).sort(), ['POST /dot/log', 'PUT /weights/{date}']);
});

test('from Dot: reads and the two declared writes; every other change is refused', async () => {
  await call('PUT', '/sessions/s1', { date: ymd(), name: 'A' });
  for (const [m, p, b] of [
    ['PUT', '/sessions/s1', { date: ymd(), name: 'changed', rev: 1 }], ['DELETE', '/sessions/s1'], ['POST', '/starter'],
    ['PUT', '/settings', { unit: 'kg' }], ['PUT', '/plan', {}], ['PUT', '/exercises/x', { name: 'X' }], ['DELETE', '/exercises/x'],
    ['PUT', '/workouts/w', { name: 'W' }], ['DELETE', '/workouts/w'], ['DELETE', '/weights/2026-10-26'],
    ['PUT', '/journal/2026-10-26', { text: 'from Dot' }],
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
