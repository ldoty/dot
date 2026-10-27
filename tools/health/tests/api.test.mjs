import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { accessToken, forgedToken } from '../../../platform/tests/helpers/tokens.mjs';
import { CLIENT_ID, ROUTES, call, memberToken, table } from './helpers/health-api.mjs';
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
  assert.equal((await call('GET', '/all', undefined, forgedToken({ clientId: CLIENT_ID, group: 'family_health' }))).status, 401);
  assert.equal((await call('GET', '/all', undefined, accessToken({ clientId: CLIENT_ID, group: 'family_links' }))).status, 403);
  assert.equal((await call('GET', '/all', undefined, accessToken({ clientId: 'other-tool', group: 'family_health' }))).status, 401);
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
    settings: { unit: 'lb', areas: [] }, plan: null, exercises: [], workouts: [], sessions: [], weights: [], journal: [], food: [], meds: [], doses: [], sits: [],
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
  assert.deepEqual(s.entries[0].sets[1], { w: 135, r: 7, t: null, d: null, b: null, done: true });
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

test('a hold is counted in breaths', async () => {
  assert.equal((await call('PUT', '/exercises/cs', { name: 'Couch stretch', measure: 'breaths', perSide: true })).body.measure, 'breaths');
  await call('PUT', '/sessions/s1', { date: '2026-10-26', name: 'Mobility',
    entries: [{ exerciseId: 'cs', name: 'Couch stretch', measure: 'breaths', sets: [{ b: 12, done: true }] }] });
  const [s] = (await call('GET', '/all')).body.sessions;
  assert.deepEqual([s.entries[0].measure, s.entries[0].sets[0].b], ['breaths', 12]);
  assert.equal((await call('PUT', '/sessions/s2', { date: '2026-10-26', entries: [{ name: 'X', measure: 'breaths', sets: [{ b: -1 }] }] })).status, 400);
});

test('the journal: a day’s words, rev-checked, and nobody else’s', async () => {
  const r = await call('PUT', '/journal/2026-10-26', { text: '  Low back stiff after the drive. Slept well.  ' });
  assert.deepEqual(r.body, { date: '2026-10-26', text: 'Low back stiff after the drive. Slept well.', rev: 1 });
  assert.equal((await call('PUT', '/journal/2026-10-26', { text: 'Better by lunch.', rev: 1 })).body.rev, 2);
  const stale = await call('PUT', '/journal/2026-10-26', { text: 'from the other phone', rev: 1 });
  assert.deepEqual([stale.status, stale.body.current.text], [409, 'Better by lunch.']);
  await call('PUT', '/journal/2026-10-24', { text: 'Shoulders fine.' });
  assert.deepEqual((await call('GET', '/all')).body.journal.map((j) => [j.date, j.text]), [['2026-10-24', 'Shoulders fine.'], ['2026-10-26', 'Better by lunch.']]);
  const amber = memberToken('amber-sub');
  assert.deepEqual((await call('GET', '/all', undefined, amber)).body.journal, []);
  assert.equal((await call('PUT', '/journal/2026-10-26', { text: 'mine' }, amber)).status, 200, 'her own day, not Luke’s');
  assert.equal((await call('GET', '/all')).body.journal[1].text, 'Better by lunch.');
  assert.equal((await call('PUT', '/journal/2026-02-30', { text: 'x' })).status, 400);
  assert.equal((await call('PUT', '/journal/2026-10-25', { text: 'x'.repeat(6000) })).body.text.length, 5000);
});

test('food: entries by day and time, rev-checked, checked, and nobody else’s', async () => {
  const r = await call('PUT', '/food/f1', { date: '2026-10-26', time: '12:30', meal: 'lunch', what: ' Turkey sandwich, apple ', kcal: 610, protein: 34.4 });
  assert.deepEqual(r.body, { id: 'f1', date: '2026-10-26', time: '12:30', meal: 'lunch', what: 'Turkey sandwich, apple', kcal: 610, protein: 34, note: '', rev: 1 });
  await call('PUT', '/food/f0', { date: '2026-10-26', time: '07:15', what: 'Oatmeal' });
  await call('PUT', '/food/fy', { date: '2026-10-25', what: 'Pizza' });
  assert.deepEqual((await call('GET', '/all')).body.food.map((f) => f.id), ['fy', 'f0', 'f1'], 'by day, then time');
  assert.equal((await call('PUT', '/food/f1', { date: '2026-10-26', what: 'Turkey sandwich', kcal: 520, rev: 1 })).body.rev, 2);
  assert.equal((await call('PUT', '/food/f1', { date: '2026-10-26', what: 'stale', rev: 1 })).status, 409);
  for (const b of [{ date: '2026-10-26', what: '' }, { what: 'x' }, { date: '2026-10-26', what: 'x', time: '25:00' }, { date: '2026-10-26', what: 'x', meal: 'brunch' }, { date: '2026-10-26', what: 'x', kcal: -5 }]) {
    assert.equal((await call('PUT', '/food/bad', b)).status, 400, JSON.stringify(b));
  }
  const amber = memberToken('amber-sub');
  assert.deepEqual((await call('GET', '/all', undefined, amber)).body.food, []);
  await call('DELETE', '/food/f1', undefined, amber);
  assert.equal((await call('GET', '/all')).body.food.length, 3, 'her delete reached only her own rows');
  await call('DELETE', '/food/f1');
  assert.equal((await call('GET', '/all')).body.food.length, 2);
});

test('meds: a list of what they take, checked, and nobody else’s', async () => {
  const r = await call('PUT', '/meds/vitd', { name: ' Vitamin D ', kind: 'supplement', dose: '2000 IU', times: ['20:00', '08:00', '08:00'] });
  assert.deepEqual(r.body, { id: 'vitd', name: 'Vitamin D', kind: 'supplement', dose: '2000 IU', times: ['08:00', '20:00'], note: '', stopped: false, rev: 1 });
  assert.equal((await call('PUT', '/meds/vitd', { name: 'Vitamin D3', times: ['08:00'], rev: 1 })).body.rev, 2);
  assert.equal((await call('PUT', '/meds/vitd', { name: 'stale', rev: 1 })).status, 409);
  for (const b of [{ name: '' }, { name: 'X', kind: 'candy' }, { name: 'X', times: ['8am'] }, { name: 'X', times: ['25:00'] }, { name: 'X', times: Array(7).fill(0).map((_, i) => `0${i}:00`) }]) {
    assert.equal((await call('PUT', '/meds/bad', b)).status, 400, JSON.stringify(b));
  }
  assert.equal((await call('PUT', '/meds/has-dash', { name: 'X' })).status, 400, 'a med id can’t hold the dose id’s separator');
  assert.deepEqual((await call('GET', '/all', undefined, memberToken('amber-sub'))).body.meds, []);
});

test('doses: once per due time, as-needed as often as taken, and only of their own meds', async () => {
  await call('PUT', '/meds/vitd', { name: 'Vitamin D', times: ['08:00', '20:00'] });
  await call('PUT', '/meds/ibu', { name: 'Ibuprofen', kind: 'medication', dose: '200 mg' });
  const r = await call('PUT', '/doses/2026-10-26/vitd-0800', { med: 'vitd', slot: '08:00', at: '08:14' });
  assert.deepEqual(r.body, { date: '2026-10-26', id: 'vitd-0800', med: 'vitd', slot: '08:00', at: '08:14' });
  await call('PUT', '/doses/2026-10-26/vitd-0800', { med: 'vitd', slot: '08:00', at: '08:20' });
  await call('PUT', '/doses/2026-10-26/ibu-na1', { med: 'ibu', slot: null, at: '13:00' });
  await call('PUT', '/doses/2026-10-26/ibu-na2', { med: 'ibu', slot: null, at: '19:00' });
  assert.deepEqual((await call('GET', '/all')).body.doses.map((d) => [d.id, d.at]), [['vitd-0800', '08:20'], ['ibu-na1', '13:00'], ['ibu-na2', '19:00']], 'the 8:00 dose once, at its latest time');
  for (const [id, b] of [
    ['vitd-0900', { med: 'vitd', slot: '09:00', at: '09:00' }], ['vitd-2000', { med: 'vitd', slot: '08:00', at: '08:00' }],
    ['vitd-na1', { med: 'vitd', slot: '08:00', at: '08:00' }], ['ibu-0800', { med: 'ibu', slot: null, at: '08:00' }],
    ['ibu-na3', { med: 'vitd', slot: null, at: '08:00' }], ['ibu-na3', { med: 'ibu', slot: null, at: 'noon' }], ['nope-na1', { med: 'nope', slot: null, at: '08:00' }],
  ]) assert.equal((await call('PUT', `/doses/2026-10-26/${id}`, b)).status, 400, `${id} ${JSON.stringify(b)}`);
  assert.equal((await call('PUT', '/doses/2026-10-26/ibu-na9', { med: 'ibu', slot: null, at: '08:00' }, memberToken('amber-sub'))).status, 400, 'Luke’s ibuprofen isn’t hers');
  await call('DELETE', '/doses/2026-10-26/ibu-na2');
  assert.equal((await call('GET', '/all')).body.doses.length, 2);
  await call('DELETE', '/meds/ibu');
  assert.deepEqual((await call('GET', '/all')).body.doses.map((d) => d.med), ['vitd'], 'a deleted med takes its doses with it');
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

test('sits: how long and how it went, kept and changed like the rest', async () => {
  assert.equal((await call('PUT', '/sits/z1', { date: '2026-10-20', time: '07:05', seconds: 600, note: 'Busy mind, settled.' })).status, 200);
  assert.equal((await call('PUT', '/sits/z1', { date: '2026-10-20', seconds: 600, rev: 0 })).status, 409, 'rev-checked');
  assert.equal((await call('PUT', '/sits/z1', { date: '2026-10-20', seconds: 900, rev: 1 })).body.seconds, 900);
  for (const bad of [{ seconds: 600 }, { date: '2026-10-20' }, { date: '2026-10-20', seconds: 0 }, { date: '2026-10-20', seconds: 30000 }, { date: '2026-10-20', seconds: 60, time: '7am' }]) {
    assert.equal((await call('PUT', '/sits/z2', bad)).status, 400, JSON.stringify(bad));
  }
  assert.deepEqual((await call('GET', '/all')).body.sits.map((x) => [x.id, x.seconds, x.time]), [['z1', 900, null]]);
  await call('DELETE', '/sits/z1');
  assert.deepEqual((await call('GET', '/all')).body.sits, []);
  assert.deepEqual((await call('GET', '/all', undefined, memberToken('amber-sub'))).body.sits, [], 'nobody else’s');
});
