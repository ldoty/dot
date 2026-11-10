import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { call, table, ROUTES } from './helpers/packing-api.mjs';
import { accessToken, forgedToken } from '../../../platform/tests/helpers/tokens.mjs';

// Invented fixtures, not the real list (that lives in private/).
const LIST = {
  categories: [{ id: 'cat1', name: 'Shelter' }, { id: 'cat2', name: 'Kitchen' }],
  items: [
    { id: 'i1', text: 'Tent', categoryId: 'cat1', status: '' },
    { id: 'i2', text: 'Fuel', categoryId: 'cat2', status: 'b' },
    { id: 'i3', text: 'Stove', categoryId: 'cat2', status: 'x' },
  ],
};
beforeEach(() => table.clear());

test('the routes here are the routes in infra/api.tf', () => {
  const tf = readFileSync(new URL('../infra/api.tf', import.meta.url), 'utf8');
  const listed = [...tf.match(/routes = \[([\s\S]*?)\]/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(listed.sort(), [...ROUTES].sort());
});

test('refuses missing, forged, wrong-group and other-tool tokens', async () => {
  assert.equal((await call('GET', '/list', undefined, null)).status, 401);
  assert.equal((await call('GET', '/list', undefined, forgedToken({ clientId: 'packing-client', group: 'lukes_packing' }))).status, 401);
  assert.equal((await call('GET', '/list', undefined, accessToken({ clientId: 'packing-client', group: 'family_lists' }))).status, 403);
  assert.equal((await call('GET', '/list', undefined, accessToken({ clientId: 'other-tool', group: 'lukes_packing' }))).status, 401);
  assert.equal((await call('PUT', '/list', { ...LIST, rev: 0 }, accessToken({ clientId: 'packing-client', group: 'family_lists' }))).status, 403);
  assert.equal(table.keys().length, 0);
});

test('an empty list to start, then saved and read back whole', async () => {
  assert.deepEqual((await call('GET', '/list')).body, { categories: [], items: [], rev: 0 });
  assert.deepEqual((await call('PUT', '/list', { ...LIST, rev: 0 })).body, { rev: 1 });
  assert.deepEqual((await call('GET', '/list')).body, { ...LIST, rev: 1 });
  assert.equal((await call('PUT', '/list', { ...LIST, items: [], rev: 1 })).status, 200);
  assert.deepEqual((await call('GET', '/list')).body, { categories: LIST.categories, items: [], rev: 2 });
});

test('a save from an older rev gets 409 with the current list, and changes nothing', async () => {
  await call('PUT', '/list', { ...LIST, rev: 0 });
  await call('PUT', '/list', { ...LIST, items: LIST.items.slice(1), rev: 1 });   // another device
  const r = await call('PUT', '/list', { ...LIST, items: [], rev: 1 });
  assert.equal(r.status, 409);
  assert.equal(r.body.current.rev, 2);
  assert.equal(r.body.current.items.length, 2);
  // A second "first save" can't wipe an existing list either.
  assert.equal((await call('PUT', '/list', { categories: [], items: [], rev: 0 })).status, 409);
  assert.equal((await call('GET', '/list')).body.items.length, 2);
});

test('refuses malformed lists rather than saving part of one', async () => {
  const bad = [
    { categories: 'x', items: [] },
    { ...LIST, rev: undefined },
    { ...LIST, rev: -1 },
    { ...LIST, categories: [{ id: 'bad id', name: 'x' }] },
    { ...LIST, categories: [...LIST.categories, { id: 'cat1', name: 'again' }] },
    { ...LIST, categories: [{ id: 'c', name: '  ' }], items: [] },
    { ...LIST, items: [{ id: 'i9', text: 'Orphan', categoryId: 'nope', status: '' }] },
    { ...LIST, items: [{ id: 'i9', text: 'Hat', categoryId: 'cat1', status: 'z' }] },
    { ...LIST, items: [{ id: 'i9', text: '', categoryId: 'cat1', status: '' }] },
    { ...LIST, items: [...LIST.items, LIST.items[0]] },
    { ...LIST, items: Array.from({ length: 1501 }, (_, k) => ({ id: `i${k}`, text: 't', categoryId: 'cat1', status: '' })) },
  ];
  for (const b of bad) {
    assert.equal((await call('PUT', '/list', { rev: 0, ...b })).status, 400, JSON.stringify(b).slice(0, 120));
  }
  assert.equal(table.keys().length, 0);
});

test('keeps only the fields the page uses, and tidies text', async () => {
  await call('PUT', '/list', {
    categories: [{ id: 'cat1', name: ' Shelter ', extra: 1 }],
    items: [{ id: 'i1', text: 'Tent\n  and stakes', categoryId: 'cat1', junk: 'x' }],
    rev: 0,
  });
  const { body } = await call('GET', '/list');
  assert.deepEqual(body.categories, [{ id: 'cat1', name: 'Shelter' }]);
  assert.deepEqual(body.items, [{ id: 'i1', text: 'Tent and stakes', categoryId: 'cat1', status: '' }]);
  assert.equal(table.get('TOOL', 'LIST#main').updatedBy, 'luke');
});
