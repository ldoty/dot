import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { accessToken, forgedToken } from '../../../platform/tests/helpers/tokens.mjs';
import { CLIENT_ID, ROUTES, call, memberToken, table } from './helpers/gym-api.mjs';
import { EXERCISES, WORKOUTS } from '../api/starter.mjs';

beforeEach(() => table.clear());
const amber = memberToken('amber-sub');

test('infra/api.tf routes match the handler', () => {
  const tf = readFileSync(new URL('../infra/api.tf', import.meta.url), 'utf8');
  const routes = JSON.parse(tf.match(/routes\s*=\s*(\[[^\]]*\])/)[1]);
  assert.deepEqual(routes.sort(), [...ROUTES].sort());
  assert.match(tf, /filename = "starter\.mjs"/, 'the starter program is in the zip');
});

test('refuses missing, forged, wrong-group and other-tool tokens', async () => {
  assert.equal((await call('GET', '/all', undefined, null)).status, 401);
  assert.equal((await call('GET', '/all', undefined, forgedToken({ clientId: CLIENT_ID, group: 'family_gym' }))).status, 401);
  assert.equal((await call('GET', '/all', undefined, accessToken({ clientId: CLIENT_ID, group: 'family_links' }))).status, 403);
  assert.equal((await call('GET', '/all', undefined, accessToken({ clientId: 'other-tool', group: 'family_gym' }))).status, 401);
});

test('everyone has their own data: nobody sees or changes anyone else’s', async () => {
  await call('PUT', '/exercises/sq', { name: 'Squat' });
  await call('PUT', '/sessions/s1', { date: '2026-10-26', name: 'A', entries: [] });
  await call('PUT', '/weights/2026-10-26', { weight: 180 });
  const theirs = (await call('GET', '/all', undefined, amber)).body;
  assert.deepEqual([theirs.exercises, theirs.sessions, theirs.weights], [[], [], []]);
  // Same ids from someone else make their own rows, never touch Luke's
  assert.equal((await call('PUT', '/exercises/sq', { name: 'Mine' }, amber)).status, 200);
  assert.equal((await call('DELETE', '/sessions/s1', undefined, amber)).status, 200);
  const mine = (await call('GET', '/all')).body;
  assert.equal(mine.exercises[0].name, 'Squat');
  assert.equal(mine.sessions.length, 1);
  assert.ok(table.keys().every((k) => /^(EX|S|BW)#/.test(k)));
  assert.ok(table.dump().every(([k]) => k.startsWith('P#luke-sub|') || k.startsWith('P#amber-sub|')));
});

test('an empty account gets defaults', async () => {
  assert.deepEqual((await call('GET', '/all')).body, {
    settings: { unit: 'lb', areas: [] }, plan: null, exercises: [], workouts: [], sessions: [], weights: [],
  });
});

test('rev-checked edits: a stale save gets 409 with the newer copy', async () => {
  const first = await call('PUT', '/workouts/w1', { name: 'A', items: [] });
  assert.equal(first.body.rev, 1);
  assert.equal((await call('PUT', '/workouts/w1', { name: 'A2', items: [], rev: 1 })).body.rev, 2);
  const stale = await call('PUT', '/workouts/w1', { name: 'A3', items: [], rev: 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.current.name, 'A2');
  // Creating over an existing row without its rev is a conflict too, not an overwrite
  assert.equal((await call('PUT', '/workouts/w1', { name: 'new', items: [] })).status, 409);
  assert.equal((await call('PUT', '/plan', { rotation: ['w1'], days: [1, 3, 5] })).body.rev, 1);
  assert.equal((await call('PUT', '/plan', { rotation: [], days: [] })).status, 409);
});

test('a logged session keeps its sets, ratings and notes', async () => {
  const body = {
    date: '2026-10-26', workoutId: 'w1', name: 'Session A', startedAt: '2026-10-26T17:00:00Z', finishedAt: '2026-10-26T17:32:00Z',
    note: ' Felt good ', discomfort: { Shoulders: 2, 'Lower back': 0 },
    entries: [{ exerciseId: 'tb', name: 'Trap bar deadlift', measure: 'reps', target: '6–8', pair: 1, rest: 15,
      sets: [{ w: 135, r: 8, done: true }, { w: 135, r: 7, done: true }, { w: null, r: null, done: false }] }],
  };
  assert.equal((await call('PUT', '/sessions/s1', body)).status, 200);
  const [s] = (await call('GET', '/all')).body.sessions;
  assert.equal(s.note, 'Felt good');
  assert.deepEqual(s.discomfort, { Shoulders: 2, 'Lower back': 0 });
  assert.deepEqual(s.entries[0].sets[1], { w: 135, r: 7, t: null, d: null, done: true });
  assert.deepEqual([s.entries[0].target, s.entries[0].pair, s.entries[0].rest], ['6–8', 1, 15]);
  assert.equal(s.finishedAt, '2026-10-26T17:32:00.000Z');
});

test('sessions come back in date order', async () => {
  await call('PUT', '/sessions/zz', { date: '2026-10-20' });
  await call('PUT', '/sessions/aa', { date: '2026-10-24' });
  await call('PUT', '/sessions/mm', { date: '2026-10-22' });
  assert.deepEqual((await call('GET', '/all')).body.sessions.map((s) => s.id), ['zz', 'mm', 'aa']);
});

test('validates input', async () => {
  const bad = [
    ['PUT', '/exercises/x1', { name: '' }],
    ['PUT', '/exercises/x1', { name: 'X', measure: 'vibes' }],
    ['PUT', '/exercises/bad%20id', { name: 'x' }],
    ['PUT', '/workouts/w1', { name: 'W', items: [{ sets: 3 }] }],
    ['PUT', '/workouts/w1', { name: 'W', items: [{ exerciseId: 'a', sets: 50 }] }],
    ['PUT', '/sessions/s1', { name: 'no date' }],
    ['PUT', '/sessions/s1', { date: '2026-02-30' }],
    ['PUT', '/sessions/s1', { date: '2026-10-26', entries: [{ name: 'X', sets: [{ w: -5 }] }] }],
    ['PUT', '/sessions/s1', { date: '2026-10-26', entries: [{ name: 'X', sets: [{ r: '8' }] }] }],
    ['PUT', '/sessions/s1', { date: '2026-10-26', discomfort: { Shoulders: 11 } }],
    ['PUT', '/sessions/s1', { date: '2026-10-26', rev: 'one' }],
    ['PUT', '/plan', { days: [7] }],
    ['PUT', '/plan', { from: '2026-11-01', to: '2026-10-01' }],
    ['PUT', '/settings', { unit: 'stone' }],
    ['PUT', '/weights/2026-10-26', { weight: 5 }],
    ['PUT', '/weights/yesterday', { weight: 180 }],
  ];
  for (const [m, p, b] of bad) assert.equal((await call(m, p, b)).status, 400, `${m} ${p} ${JSON.stringify(b)}`);
  assert.deepEqual(table.keys(), []);
});

test('an exercise in a saved workout can’t be deleted until it’s taken out', async () => {
  await call('PUT', '/exercises/sq', { name: 'Squat' });
  await call('PUT', '/workouts/w1', { name: 'Legs', items: [{ exerciseId: 'sq' }] });
  const r = await call('DELETE', '/exercises/sq');
  assert.equal(r.status, 409);
  assert.deepEqual(r.body.workouts, ['Legs']);
  await call('PUT', '/workouts/w1', { name: 'Legs', items: [], rev: 1 });
  assert.equal((await call('DELETE', '/exercises/sq')).status, 200);
});

test('body weight: one a day, the latest wins', async () => {
  await call('PUT', '/weights/2026-10-26', { weight: 181.4 });
  await call('PUT', '/weights/2026-10-26', { weight: 180.6 });
  assert.deepEqual((await call('GET', '/all')).body.weights, [{ date: '2026-10-26', weight: 180.6 }]);
  await call('DELETE', '/weights/2026-10-26');
  assert.deepEqual((await call('GET', '/all')).body.weights, []);
});

test('the starter program loads once, into an empty account, all linked up', async () => {
  const r = await call('POST', '/starter');
  assert.equal(r.status, 200);
  const all = r.body;
  assert.equal(all.exercises.length, Object.keys(EXERCISES).length);
  assert.deepEqual(all.workouts.map((w) => w.name), WORKOUTS.map((w) => w.name).sort());
  const ids = new Set(all.exercises.map((x) => x.id));
  assert.ok(all.workouts.every((w) => w.items.every((i) => ids.has(i.exerciseId))), 'every item points at a real exercise');
  const byName = Object.fromEntries(all.workouts.map((w) => [w.name, w.id]));
  assert.deepEqual(all.plan.rotation, [byName['Session A'], byName['Session B']]);
  assert.deepEqual(all.plan.days, [1, 3, 5]);
  assert.deepEqual(all.settings.areas, ['Shoulders', 'Lower back']);
  assert.equal((await call('POST', '/starter')).status, 409);
});

test('the starter keeps a plan and settings someone already set', async () => {
  await call('PUT', '/settings', { unit: 'kg', areas: ['Knees'] });
  const all = (await call('POST', '/starter')).body;
  assert.deepEqual([all.settings.unit, all.settings.areas], ['kg', ['Knees']]);
});

test('the starter refuses an account that already has exercises', async () => {
  await call('PUT', '/exercises/sq', { name: 'Squat' });
  assert.equal((await call('POST', '/starter')).status, 409);
  assert.equal((await call('GET', '/all')).body.exercises.length, 1);
});
