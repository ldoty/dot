import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ISSUER, accessToken, forgedToken } from '../../../platform/tests/helpers/tokens.mjs';
import { fakeTable } from '../../../platform/tests/helpers/fake-table.mjs';
import { caller } from '../../../platform/tests/helpers/http.mjs';
import { validateManifest, writeRoutes } from '../../../platform/api/dot-manifest.mjs';
import { MANIFEST, NEW_PER_DAY, createApi } from '../api/api.mjs';
import { review, fresh } from '../api/schedule.mjs';
import { parseImport } from '../api/model.mjs';
import { ROUTES } from './helpers/routes.mjs';

const table = fakeTable();
let clock = new Date('2026-11-02T15:00:00Z');
const handler = createApi({
  db: DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' })), table: 'family-cards', group: 'lukes_cards', issuer: ISSUER,
  clientIds: ['cards-client', 'cards-dot'], dotClientId: 'cards-dot', now: () => clock, timeZone: 'America/New_York',
});
const callApi = caller(handler, ROUTES);
const page = () => accessToken({ clientId: 'cards-client', group: 'lukes_cards', sub: 'luke', username: 'luke' });
const delegated = () => accessToken({ clientId: 'cards-dot', group: 'lukes_cards', sub: 'luke', username: 'luke', via: 'dot' });
const call = (m, p, b, t = page()) => callApi(m, p, b, t);
const later = (ms) => { clock = new Date(clock.getTime() + ms); };
const DAY = 86_400_000;
beforeEach(() => { table.clear(); clock = new Date('2026-11-02T15:00:00Z'); });

const wordDeck = async () => (await call('POST', '/decks', { name: 'Words', kind: 'word' })).body;

test('the routes here are the routes in infra/api.tf, and the manifest is valid', () => {
  const tf = readFileSync(new URL('../infra/api.tf', import.meta.url), 'utf8');
  const listed = [...tf.match(/routes = \[([\s\S]*?)\]/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(listed.sort(), [...ROUTES].sort());
  validateManifest(MANIFEST);
  assert.deepEqual(writeRoutes(MANIFEST).sort(), ['POST /decks', 'POST /decks/{deck}/cards'], 'Dot and Claude Code only add');
});

test('refuses missing, forged, wrong-group and other-tool tokens', async () => {
  assert.equal((await call('GET', '/decks', undefined, null)).status, 401);
  assert.equal((await call('GET', '/decks', undefined, forgedToken({ clientId: 'cards-client', group: 'lukes_cards' }))).status, 401);
  assert.equal((await call('GET', '/decks', undefined, accessToken({ clientId: 'cards-client', group: 'family_lists' }))).status, 403);
  assert.equal((await call('GET', '/decks', undefined, accessToken({ clientId: 'lists-client', group: 'lukes_cards' }))).status, 401);
});

test('the scheduler: again soon, good spreads out, easy further, ease has a floor', () => {
  const now = new Date('2026-11-02T15:00:00Z');
  let s = review(fresh(), 'good', now);
  assert.equal(s.interval, 1);
  s = review(s, 'good', now);
  assert.equal(s.interval, 3);
  s = review(s, 'good', now);
  assert.equal(s.interval, 8, '3 × 2.5, rounded');
  const missed = review(s, 'again', now);
  assert.deepEqual([missed.reps, missed.interval, missed.lapses, missed.ease], [0, 0, 1, 2.3]);
  assert.equal(Date.parse(missed.due) - now.getTime(), 10 * 60_000);
  assert.ok(review(fresh(), 'easy', now).interval > review(fresh(), 'good', now).interval);
  let hard = fresh();
  for (let i = 0; i < 20; i++) hard = review(hard, 'again', now);
  assert.equal(hard.ease, 1.3);
  assert.throws(() => review(fresh(), 'meh', now));
});

test('decks and word cards: each word is studied three ways', async () => {
  const d = await wordDeck();
  assert.equal((await call('POST', '/decks', { name: 'words' })).status, 409, 'names are unique, any case');
  const c = await call('POST', `/decks/${d.id}/cards`, { word: 'pellucid', definition: 'clear; easy to understand', example: 'Her pellucid prose.' });
  assert.equal(c.status, 201);
  assert.deepEqual(c.body.modes, ['meaning', 'recall', 'spell']);
  assert.equal((await call('POST', `/decks/${d.id}/cards`, { word: 'x' })).status, 400, 'a word needs its meaning');
  assert.equal((await call('POST', `/decks/${d.id}/cards`, { front: 'Q', back: 'A' })).status, 400, 'a word deck takes word cards');
  const [deck] = (await call('GET', '/decks')).body;
  assert.deepEqual([deck.cards, deck.new, deck.due], [1, 3, 0]);
});

test('study: new cards first time, then due when their time comes; the day’s new ones are limited', async () => {
  const d = await wordDeck();
  const { body: card } = await call('POST', `/decks/${d.id}/cards`, { word: 'pellucid', definition: 'clear' });
  let s = (await call('GET', '/study')).body;
  assert.deepEqual([s.due.length, s.new.map((x) => x.mode)], [0, ['meaning', 'recall', 'spell']]);
  assert.equal((await call('GET', '/study?modes=spell')).body.new.length, 1, 'just one way');

  assert.equal((await call('POST', `/decks/${d.id}/cards/${card.id}/review`, { mode: 'spell', grade: 'again', ms: 4000 })).status, 200);
  later(11 * 60_000);
  s = (await call('GET', '/study')).body;
  assert.deepEqual(s.due.map((x) => x.mode), ['spell'], 'a miss is due again in 10 minutes');
  assert.equal(s.newLeft, NEW_PER_DAY - 1);

  await call('POST', `/decks/${d.id}/cards/${card.id}/review`, { mode: 'spell', grade: 'good' });
  assert.deepEqual((await call('GET', '/study')).body.due, [], 'not due until tomorrow');
  later(DAY);
  assert.equal((await call('GET', '/study')).body.due.length, 1);
  assert.equal((await call('POST', `/decks/${d.id}/cards/${card.id}/review`, { mode: 'forward', grade: 'good' })).status, 400, 'a mode the card has');
});

test('only so many new cards a day', async () => {
  const d = await wordDeck();
  const text = Array.from({ length: NEW_PER_DAY + 5 }, (_, i) => `w${i}\tmeaning ${i}`).join('\n');
  assert.equal((await call('POST', `/decks/${d.id}/import`, { text })).body.added, NEW_PER_DAY + 5);
  assert.equal((await call('GET', '/study?modes=meaning')).body.new.length, NEW_PER_DAY);
});

test('import: tabs or a dash, skipped lines named', () => {
  const r = parseImport('ebullient\tfull of energy\tShe was ebullient.\nlaconic - using few words\nnothing here\n\n', 'word');
  assert.deepEqual(r.cards.map((c) => [c.word, c.definition, c.example]), [['ebullient', 'full of energy', 'She was ebullient.'], ['laconic', 'using few words', null]]);
  assert.deepEqual(r.skipped, [3]);
  assert.deepEqual(parseImport('Capital of Peru: Lima', 'basic').cards.map((c) => [c.front, c.back]), [['Capital of Peru', 'Lima']]);
});

test('editing a card keeps the schedules of the ways it’s still studied', async () => {
  const { body: d } = await call('POST', '/decks', { name: 'Capitals' });
  const { body: c } = await call('POST', `/decks/${d.id}/cards`, { front: 'Peru', back: 'Lima' });
  await call('POST', `/decks/${d.id}/cards/${c.id}/review`, { mode: 'forward', grade: 'good' });
  const [now] = (await call('GET', `/decks/${d.id}/cards`)).body;
  const r = await call('PUT', `/decks/${d.id}/cards/${c.id}`, { front: 'Peru', back: 'Lima', reverse: true, rev: now.rev });
  assert.equal(r.status, 200);
  assert.equal(r.body.sched.forward.reps, 1, 'kept');
  assert.equal(r.body.sched.reverse.seen, null, 'new way, new schedule');
  assert.equal((await call('PUT', `/decks/${d.id}/cards/${c.id}`, { front: 'x', back: 'y', rev: now.rev })).status, 409);
});

test('Dot and Claude Code can make decks and add cards, nothing else', async () => {
  const { body: d } = await call('POST', '/decks', { name: 'Words', kind: 'word' }, delegated());
  const { body: c } = await call('POST', `/decks/${d.id}/cards`, { word: 'sesquipedalian', definition: 'given to long words' }, delegated());
  assert.equal(c.createdVia, 'delegated');
  for (const [m, p, b] of [['DELETE', `/decks/${d.id}`], ['DELETE', `/decks/${d.id}/cards/${c.id}`], ['PUT', `/decks/${d.id}`, { name: 'x', rev: 1 }],
    ['POST', `/decks/${d.id}/import`, { text: 'a\tb' }], ['POST', `/decks/${d.id}/cards/${c.id}/review`, { mode: 'spell', grade: 'easy' }]]) {
    assert.equal((await call(m, p, b, delegated())).status, 403, `${m} ${p}`);
  }
  assert.equal((await call('GET', '/summary', undefined, delegated())).status, 200);
});

test('summary: today, the streak and what’s due', async () => {
  const d = await wordDeck();
  const { body: c } = await call('POST', `/decks/${d.id}/cards`, { word: 'pellucid', definition: 'clear' });
  for (let day = 0; day < 3; day++) {
    await call('POST', `/decks/${d.id}/cards/${c.id}/review`, { mode: 'meaning', grade: day === 1 ? 'again' : 'good', ms: 90_000 });
    if (day < 2) later(DAY);
  }
  const s = (await call('GET', '/summary')).body;
  assert.equal(s.streak, 3);
  assert.deepEqual(s.today, { reviews: 1, again: 0, minutes: 2 });
  later(2 * DAY);
  assert.equal((await call('GET', '/summary')).body.streak, 0, 'a missed day ends it');
});

test('deleting a deck deletes its cards', async () => {
  const d = await wordDeck();
  await call('POST', `/decks/${d.id}/import`, { text: 'a\tb\nc\td' });
  assert.deepEqual((await call('DELETE', `/decks/${d.id}`)).body, { id: d.id, cards: 2 });
  assert.deepEqual(table.keys(), []);
});
