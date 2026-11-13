import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { call, table, trip, ROUTES } from './helpers/trips-api.mjs';
import { accessToken, forgedToken } from '../../../platform/tests/helpers/tokens.mjs';

beforeEach(() => table.clear());
const book = (id, over, rev = 0) => call('PUT', `/trips/${id}`, { ...trip(over), rev });

test('the routes here are the routes in infra/api.tf', () => {
  const tf = readFileSync(new URL('../infra/api.tf', import.meta.url), 'utf8');
  const listed = [...tf.match(/routes = \[([\s\S]*?)\]/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(listed.sort(), [...ROUTES].sort());
});

test('refuses missing, forged, wrong-group and other-tool tokens', async () => {
  const good = { clientId: 'trips-client', group: 'lukes_trip_planner' };
  assert.equal((await call('GET', '/trips', undefined, null)).status, 401);
  assert.equal((await call('GET', '/trips', undefined, forgedToken(good))).status, 401);
  assert.equal((await call('GET', '/trips', undefined, accessToken({ ...good, group: 'family_lists' }))).status, 403);
  assert.equal((await call('GET', '/trips', undefined, accessToken({ ...good, clientId: 'other-tool' }))).status, 401);
  assert.equal((await call('PUT', '/trips/t1', { ...trip(), rev: 0 }, accessToken({ ...good, group: 'family_lists' }))).status, 403);
  assert.equal((await call('DELETE', '/trips/t1', undefined, accessToken({ ...good, group: 'family_lists' }))).status, 403);
  assert.equal(table.keys().length, 0);
});

test('book a trip, read it back whole, list it, delete it', async () => {
  assert.deepEqual((await book('t1')).body, { rev: 1 });
  const { body } = await call('GET', '/trips/t1');
  assert.deepEqual(body, { id: 't1', ...trip(), rev: 1 });
  assert.equal(body.itinerary, 'Sat: hike in\nSun: hike out', 'line breaks kept');
  assert.deepEqual((await call('GET', '/trips')).body.map(({ updatedAt, ...t }) => t), [{
    id: 't1', name: 'Ridge loop', type: 'backpacking', where: 'Site 3', start: '2026-11-14', end: '2026-11-15', items: 3, packed: 1,
  }]);
  assert.equal((await call('DELETE', '/trips/t1')).status, 200);
  assert.equal((await call('GET', '/trips/t1')).status, 404);
  assert.deepEqual((await call('GET', '/trips')).body, []);
});

test('lists every trip by start date, across pages', async () => {
  for (const [id, start] of [['a', '2027-03-01'], ['b', '2026-06-10'], ['c', '2026-11-14'], ['d', '2025-09-01'], ['e', '2026-07-04']]) {
    await book(id, { start, end: start });
  }
  assert.deepEqual((await call('GET', '/trips')).body.map((t) => t.id), ['d', 'b', 'e', 'c', 'a']);
});

test('a save from an older rev gets 409 with the current trip and changes nothing; a deleted trip gets 404', async () => {
  await book('t1');
  await book('t1', { notes: 'from the phone' }, 1);
  const r = await book('t1', { notes: 'from the laptop' }, 1);
  assert.equal(r.status, 409);
  assert.equal(r.body.current.rev, 2);
  assert.equal(r.body.current.notes, 'from the phone');
  assert.equal((await book('t1', {}, 0)).status, 409, 'booking over an existing trip');
  assert.equal((await call('GET', '/trips/t1')).body.notes, 'from the phone');
  await call('DELETE', '/trips/t1');
  assert.equal((await book('t1', {}, 2)).status, 404);
});

test('refuses malformed trips rather than saving part of one', async () => {
  const items = trip().items;
  const bad = [
    { name: '  ' },
    { type: 'cruise' },
    { start: '2026-11-31', end: '2026-12-01' },
    { start: 'Nov 14' },
    { start: '2026-11-15', end: '2026-11-14' },
    { notes: 'x'.repeat(20001) },
    { categories: 'x' },
    { categories: [{ id: 'bad id', name: 'x' }], items: [] },
    { items: [...items, items[0]] },
    { items: [{ id: 'i9', text: 'Orphan', categoryId: 'nope', status: '' }] },
    { items: [{ id: 'i9', text: 'Hat', categoryId: 'cat1', status: 'z' }] },
    { items: Array.from({ length: 1501 }, (_, k) => ({ id: `i${k}`, text: 't', categoryId: 'cat1', status: '' })) },
  ];
  for (const over of bad) assert.equal((await book('t1', over)).status, 400, JSON.stringify(over).slice(0, 100));
  assert.equal((await call('PUT', '/trips/t1', trip())).status, 400, 'no rev');
  assert.equal((await call('PUT', '/trips/bad%20id', { ...trip(), rev: 0 })).status, 400);
  assert.equal(table.keys().length, 0);
});

test('every packing status is accepted: to pack, verify, packed list, buy, check, packed', async () => {
  const items = ['', 'v', 'p', 'b', 'c', 'x'].map((status, k) => ({ id: `s${k}`, text: `Item ${k}`, categoryId: 'cat1', status }));
  assert.equal((await book('t1', { items })).status, 200);
  assert.deepEqual((await call('GET', '/trips/t1')).body.items.map((i) => i.status), ['', 'v', 'p', 'b', 'c', 'x']);
});

test('keeps only the fields the page uses, and tidies text', async () => {
  await call('PUT', '/trips/t1', {
    ...trip(), name: ' Ridge\n loop ', notes: 'Line one\r\nLine two  \n\n', junk: 1, rev: 0,
    categories: [{ id: 'cat1', name: ' Shelter ', extra: 1 }],
    items: [{ id: 'i1', text: 'Tent\n  and stakes', categoryId: 'cat1', junk: 'x' }],
  });
  const row = table.get('TOOL', 'TRIP#t1');
  assert.equal(row.name, 'Ridge loop');
  assert.equal(row.notes, 'Line one\nLine two');
  assert.equal(row.junk, undefined);
  assert.deepEqual(row.categories, [{ id: 'cat1', name: 'Shelter' }]);
  assert.deepEqual(row.items, [{ id: 'i1', text: 'Tent and stakes', categoryId: 'cat1', status: '' }]);
  assert.equal(row.updatedBy, 'luke');
});
