import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ISSUER, accessToken, forgedToken } from '../../../platform/tests/helpers/tokens.mjs';
import { fakeTable } from '../../../platform/tests/helpers/fake-table.mjs';
import { caller } from '../../../platform/tests/helpers/http.mjs';
import { NEW_PER_DAY, createApi } from '../api/api.mjs';
import { ROUTES } from './helpers/routes.mjs';
import { drill } from './helpers/drills.mjs';

const table = fakeTable({ pageSize: 7 });
let clock = new Date('2026-11-24T15:00:00Z');
const handler = createApi({
  db: DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' })), table: 'family-go', group: 'lukes_go', issuer: ISSUER,
  clientIds: ['go-client'], now: () => clock, timeZone: 'America/New_York',
});
const callApi = caller(handler, ROUTES);
const token = () => accessToken({ clientId: 'go-client', group: 'lukes_go', sub: 'luke', username: 'luke' });
const call = (m, p, b, t = token()) => callApi(m, p, b, t);
const DAY = 86_400_000;
beforeEach(() => { table.clear(); clock = new Date('2026-11-24T15:00:00Z'); });

test('the routes here are the routes in infra/api.tf', () => {
  const tf = readFileSync(new URL('../infra/api.tf', import.meta.url), 'utf8');
  const listed = [...tf.match(/routes = \[([\s\S]*?)\]/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...listed].sort(), [...ROUTES].sort());
});

test('refuses missing, forged, wrong-group and other-tool tokens', async () => {
  assert.equal((await call('GET', '/summary', undefined, null)).status, 401);
  assert.equal((await call('GET', '/summary', undefined, forgedToken({ clientId: 'go-client', group: 'lukes_go' }))).status, 401);
  assert.equal((await call('GET', '/summary', undefined, accessToken({ clientId: 'go-client', group: 'someone_else' }))).status, 403);
  assert.equal((await call('GET', '/summary', undefined, accessToken({ clientId: 'other-tool', group: 'lukes_go' }))).status, 401);
});

test('study: due ones first, then new ones, his own and the costliest first', async () => {
  const theirs = drill('fix', { loss: 12 });
  const small = drill('fix', { mine: true, loss: 4 });
  const big = drill('fix', { mine: true, loss: 9 });
  const due = drill('fix', { sched: { due: '2026-11-24T10:00:00.000Z', interval: 1, ease: 2.5, reps: 1, lapses: 0, seen: '2026-11-23T10:00:00.000Z' } });
  const later = drill('fix', { sched: { due: '2026-11-30T10:00:00.000Z', interval: 6, ease: 2.5, reps: 2, lapses: 0, seen: '2026-11-20T10:00:00.000Z' } });
  for (const d of [theirs, small, big, due, later]) table.put(d);
  const r = await call('GET', '/study?kind=fix');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.due.map((d) => d.id), [due.sk]);
  assert.deepEqual(r.body.new.map((d) => d.id), [big.sk, small.sk, theirs.sk]);
  assert.equal(r.body.new[0].pk, undefined, 'rows go out without their keys');
});

test('study: by theme, and only his own', async () => {
  const a = drill('fix', { theme: 'ignored_threat', mine: true });
  const b = drill('fix', { theme: 'ignored_threat' });
  const c = drill('fix', { theme: 'endgame', mine: true });
  for (const d of [a, b, c]) table.put(d);
  assert.deepEqual((await call('GET', '/study?kind=fix&theme=ignored_threat')).body.new.map((d) => d.id).sort(), [a.sk, b.sk].sort());
  assert.deepEqual((await call('GET', '/study?kind=fix&theme=ignored_threat&mine=1')).body.new.map((d) => d.id), [a.sk]);
  assert.equal((await call('GET', '/study?kind=nope')).status, 400);
  assert.equal((await call('GET', '/study?kind=fix&theme=Bad%20Theme')).status, 400);
});

test('new ones are limited a day, across every kind', async () => {
  const seen = { due: '2026-11-26T10:00:00.000Z', interval: 1, ease: 2.5, reps: 1, lapses: 0, seen: '2026-11-24T14:00:00.000Z' };
  for (let i = 0; i < NEW_PER_DAY - 2; i++) table.put(drill('count', { sched: seen }));
  for (let i = 0; i < 5; i++) table.put(drill('threat'));
  const r = await call('GET', '/study?kind=threat');
  assert.equal(r.body.newLeft, 2);
  assert.equal(r.body.new.length, 2);
});

test('a review moves the drill on and counts toward the day: misses, time and counting error', async () => {
  const c = drill('count');
  const f = drill('fix', { theme: 'lost_stones' });
  table.put(c); table.put(f);
  let r = await call('POST', `/drills/count/${c.sk}/review`, { grade: 'hard', ms: 12000, err: 2.5 });
  assert.equal(r.status, 200);
  assert.equal(r.body.schedule.reps, 1);
  assert.equal(table.get('DRILL#count', c.sk).rev, 2);
  r = await call('POST', `/drills/fix/${f.sk}/review`, { grade: 'again', ms: 30000 });
  assert.equal(r.body.schedule.due, new Date(clock.getTime() + 10 * 60_000).toISOString());
  const s = (await call('GET', '/summary')).body;
  assert.deepEqual(s.today, { n: 2, miss: 1, minutes: 1 });
  assert.deepEqual(s.week.kinds.count, { n: 1, miss: 0, err: 2.5 });
  assert.deepEqual(s.week.themes.lost_stones, { n: 1, miss: 1 });
  assert.equal(s.streak, 1);
  // Unknown drills, kinds and grades
  assert.equal((await call('POST', '/drills/count/nope1/review', { grade: 'good' })).status, 404);
  assert.equal((await call('POST', `/drills/nope/${c.sk}/review`, { grade: 'good' })).status, 404);
  assert.equal((await call('POST', `/drills/count/${c.sk}/review`, { grade: 'great' })).status, 400);
});

test('summary: what is due by kind and theme, the error database, and the streak', async () => {
  table.put(drill('fix', { theme: 'ignored_threat', mine: true }));
  table.put(drill('fix', { theme: 'ignored_threat' }));
  table.put(drill('threat'));
  table.put({ pk: 'PROFILE', sk: 'mistakes', games: 10, moves: 250, byKind: { ignored_threat: { n: 12, points: 80 } }, at: '2026-11-24T12:00:00Z' });
  // Drilled yesterday and the day before: a streak of 2 until today's first drill
  table.put({ pk: 'STAT', sk: '2026-11-23', n: 3, miss: 1, ms: 60000, kinds: {}, themes: {}, rev: 1 });
  table.put({ pk: 'STAT', sk: '2026-11-22', n: 3, miss: 1, ms: 60000, kinds: {}, themes: {}, rev: 1 });
  table.put({ pk: 'STAT', sk: '2026-11-19', n: 3, miss: 1, ms: 60000, kinds: {}, themes: {}, rev: 1 });
  const s = (await call('GET', '/summary')).body;
  assert.deepEqual(s.kinds.fix, { total: 2, due: 0, new: 2, mine: 1 });
  assert.deepEqual(s.kinds.threat, { total: 1, due: 0, new: 1, mine: 0 });
  assert.deepEqual(s.kinds.count, { total: 0, due: 0, new: 0, mine: 0 });
  assert.deepEqual(s.themes.ignored_threat, { total: 2, due: 0, new: 2, mine: 1 });
  assert.equal(s.profile.byKind.ignored_threat.points, 80);
  assert.equal(s.streak, 2);
  clock = new Date(clock.getTime() + 2 * DAY);
  assert.equal((await call('GET', '/summary')).body.streak, 0);
});
