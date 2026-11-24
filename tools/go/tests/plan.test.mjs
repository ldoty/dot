import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ISSUER, accessToken } from '../../../platform/tests/helpers/tokens.mjs';
import { fakeTable } from '../../../platform/tests/helpers/fake-table.mjs';
import { caller } from '../../../platform/tests/helpers/http.mjs';
import { createApi } from '../api/api.mjs';
import { SESSION, focusOrder, nextLevel, progress } from '../api/plan.mjs';
import { ROUTES } from './helpers/routes.mjs';
import { drill } from './helpers/drills.mjs';

const table = fakeTable();
let clock = new Date('2026-11-24T15:00:00Z');
const handler = createApi({
  db: DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' })), table: 'family-go', group: 'lukes_go', issuer: ISSUER,
  clientIds: ['go-client'], now: () => clock, timeZone: 'America/New_York',
});
const callApi = caller(handler, ROUTES);
const call = (m, p, b) => callApi(m, p, b, accessToken({ clientId: 'go-client', group: 'lukes_go', sub: 'luke', username: 'luke' }));
const DAY = 86_400_000;
const PROFILE = { pk: 'PROFILE', sk: 'mistakes', games: 10, moves: 300, byKind: { lost_stones: { n: 10, points: 190 }, wrong_area: { n: 12, points: 90 }, missed_kill: { n: 0, points: 0 }, endgame: { n: 3, points: 12 } }, at: 'x' };
beforeEach(() => { table.clear(); clock = new Date('2026-11-24T15:00:00Z'); });

test('the focus order is what costs him most in real games; kinds he never makes are left out', () => {
  assert.deepEqual(focusOrder(PROFILE), ['lost_stones', 'wrong_area', 'endgame']);
  assert.deepEqual(focusOrder(null), []);
});

test('life and death moves up when the warm-ups are easy, down when they’re hard, not on too few', () => {
  const days = (n, miss) => [{ kinds: { tsumego: { n, miss } } }];
  assert.equal(nextLevel(10, days(20, 1)), 11);
  assert.equal(nextLevel(10, days(20, 8)), 9);
  assert.equal(nextLevel(10, days(20, 4)), 10);
  assert.equal(nextLevel(10, days(10, 0)), 10, 'too few to tell');
  assert.equal(nextLevel(40, days(20, 0), { max: 40 }), 40);
});

test('ready to move on after a week, enough focus drills, and 85% right', () => {
  const plan = { order: ['lost_stones'], at: 0, startedAt: '2026-11-10T15:00:00.000Z' };
  const stats = [{ sk: '2026-11-12', themes: { lost_stones: { n: 30, miss: 3 } } }, { sk: '2026-11-20', themes: { lost_stones: { n: 20, miss: 3 } } }, { sk: '2026-11-01', themes: { lost_stones: { n: 50, miss: 40 } } }];
  assert.deepEqual(progress(plan, stats, clock), { focus: 'lost_stones', days: 14, n: 50, right: 0.88, ready: true });
  assert.equal(progress({ ...plan, startedAt: '2026-11-20T15:00:00.000Z' }, stats, clock).ready, false, 'not a week yet');
});

test('start the program, then today’s session: warm-up at his level, the focus, counting, what’s due', async () => {
  table.put(PROFILE);
  for (const rank of [5, 6, 7, 12]) table.put(drill('tsumego', { rank }));
  const mine = drill('fix', { theme: 'lost_stones', mine: true, loss: 6 });
  const theirs = drill('fix', { theme: 'lost_stones', loss: 20 });
  const due = drill('threat', { sched: { due: '2026-11-24T10:00:00.000Z', interval: 1, ease: 2.5, reps: 1, lapses: 0, seen: '2026-11-23T10:00:00.000Z' } });
  table.put(mine); table.put(theirs); table.put(due); table.put(drill('fix', { theme: 'endgame' })); table.put(drill('count'));
  assert.deepEqual((await call('GET', '/today')).body, { plan: null });
  const started = await call('POST', '/plan', { action: 'start' });
  assert.equal(started.status, 201);
  assert.equal(started.body.plan.focus, 'lost_stones');
  assert.match(started.body.plan.heuristic, /weakest group/);
  assert.equal(started.body.plan.level, 7, 'the easiest problems and a little above');
  assert.equal((await call('POST', '/plan', { action: 'start' })).status, 409);
  const t = (await call('GET', '/today')).body;
  assert.deepEqual(t.sections.warmup.map((d) => d.rank), [7, 6, 5], 'at or below his level, hardest first');
  assert.deepEqual(t.sections.focus.map((d) => d.id), [mine.sk, theirs.sk], 'his own first');
  assert.equal(t.sections.count.length, 1);
  assert.deepEqual(t.sections.review.map((d) => d.id), [due.sk], 'only what’s due, nothing new');
  assert.equal(t.left, 7);
});

test('what’s done today comes off the session', async () => {
  table.put(PROFILE);
  for (let i = 0; i < 20; i++) table.put(drill('fix', { theme: 'lost_stones' }));
  await call('POST', '/plan', { action: 'start' });
  table.put({ pk: 'STAT', sk: '2026-11-24', n: 5, miss: 0, ms: 1, kinds: {}, themes: { lost_stones: { n: 5, miss: 0 } }, rev: 1 });
  assert.equal((await call('GET', '/today')).body.sections.focus.length, SESSION.focus - 5);
});

test('warm-ups that went well raise the level, once a day', async () => {
  table.put(PROFILE);
  for (const rank of [5, 6, 7, 8, 12]) table.put(drill('tsumego', { rank }));
  await call('POST', '/plan', { action: 'start' });
  table.put({ pk: 'STAT', sk: '2026-11-23', n: 20, miss: 0, ms: 1, kinds: { tsumego: { n: 20, miss: 0 } }, themes: {}, rev: 1 });
  assert.equal((await call('GET', '/today')).body.plan.level, 8);
  assert.equal((await call('GET', '/today')).body.plan.level, 8, 'not again the same day');
});

test('moving on: the next focus, the last one kept in the history; rev-checked', async () => {
  table.put(PROFILE);
  const p = (await call('POST', '/plan', { action: 'start' })).body.plan;
  clock = new Date(clock.getTime() + 8 * DAY);
  assert.equal((await call('POST', '/plan', { action: 'next', rev: 99 })).status, 409);
  const r = await call('POST', '/plan', { action: 'next', rev: p.rev });
  assert.equal(r.status, 200);
  assert.equal(r.body.plan.focus, 'wrong_area');
  assert.deepEqual(r.body.plan.history.map((h) => h.focus), ['lost_stones']);
  assert.equal((await call('POST', '/plan', { action: 'nope' })).status, 400);
});

test('summary carries the program and his real games week by week', async () => {
  table.put(PROFILE);
  table.put({ pk: 'WEEK', sk: '2026-11-16', games: 12, moves: 300, byKind: { lost_stones: { n: 12, points: 200 } } });
  await call('POST', '/plan', { action: 'start' });
  const s = (await call('GET', '/summary')).body;
  assert.deepEqual(s.weeks, [{ week: '2026-11-16', games: 12, byKind: { lost_stones: { n: 12, points: 200 } } }]);
  assert.equal(s.plan.focus, 'lost_stones');
});
