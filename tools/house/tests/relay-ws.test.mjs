import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeTable } from '../../../platform/tests/helpers/fake-table.mjs';

const table = fakeTable({ pageSize: 2 }); // removing stale rows must follow pages
const { createRelayWs } = await import('../api/relay-ws.mjs');
const NOW = new Date('2026-10-18T20:00:00Z');
const ws = createRelayWs({ table: 'family-house', relayKey: async () => 'right-key', now: () => NOW });

const connect = (connectionId, key = 'right-key') => ws({ requestContext: { routeKey: '$connect', connectionId }, headers: key ? { 'x-house-key': key } : {} });
const message = (connectionId, body) => ws({ requestContext: { routeKey: 'sync', connectionId }, body: JSON.stringify(body) });
const e = (id, area, state = 'on') => ({ id, name: id, area, domain: id.split('.')[0], state, attrs: {}, updated: '2026-10-18T19:59:00Z', actions: { turn_on: [], turn_off: [] } });
const full = (entities, areas = [{ id: 'kitchen', name: 'Kitchen' }]) => ({ type: 'sync', full: true, areas, entities });

beforeEach(() => table.clear());

test('refuses a relay without the right key', async () => {
  assert.equal((await connect('c1', 'wrong')).statusCode, 401);
  assert.equal((await connect('c1', null)).statusCode, 401);
  assert.equal(table.get('RELAY', 'CONN'), undefined);
  assert.equal((await connect('c1')).statusCode, 200);
  assert.equal(table.get('RELAY', 'CONN').connectionId, 'c1');
});

test('a full sync stores areas and entities, and removes what’s gone', async () => {
  await connect('c1');
  table.put({ pk: 'ENTITY', sk: 'light.old', name: 'Old' });
  table.put({ pk: 'AREA', sk: 'garage', name: 'Garage' });
  const entities = [e('light.a', 'kitchen'), e('light.b', 'kitchen'), e('light.c', 'kitchen'), e('switch.away', null, 'off')];
  assert.equal((await message('c1', full(entities))).statusCode, 200);
  assert.deepEqual(table.keys().filter((k) => k !== 'CONN'), ['kitchen', 'light.a', 'light.b', 'light.c', 'switch.away']);
  assert.deepEqual(table.get('ENTITY', 'switch.away'), { pk: 'ENTITY', sk: 'switch.away', name: 'switch.away', area: null, domain: 'switch', state: 'off', attrs: {}, updated: '2026-10-18T19:59:00Z', actions: { turn_on: [], turn_off: [] } });
  assert.equal(table.get('RELAY', 'CONN').lastSync, NOW.toISOString());
});

test('a change sync updates only what changed', async () => {
  await connect('c1');
  await message('c1', full([e('light.a', 'kitchen'), e('light.b', 'kitchen')]));
  await message('c1', { type: 'sync', full: false, entities: [e('light.a', 'kitchen', 'off')] });
  assert.equal(table.get('ENTITY', 'light.a').state, 'off');
  assert.equal(table.get('ENTITY', 'light.b').state, 'on');
});

test('only the current connection may sync', async () => {
  await connect('c1');
  await connect('c2'); // the relay reconnected
  assert.equal((await message('c1', full([e('light.a', 'kitchen')]))).statusCode, 403);
  assert.equal(table.get('ENTITY', 'light.a'), undefined);
  assert.equal((await message('c2', full([e('light.a', 'kitchen')]))).statusCode, 200);
});

test('an old connection closing doesn’t forget the new one', async () => {
  await connect('c1');
  await connect('c2');
  await ws({ requestContext: { routeKey: '$disconnect', connectionId: 'c1' } });
  assert.equal(table.get('RELAY', 'CONN').connectionId, 'c2');
  await ws({ requestContext: { routeKey: '$disconnect', connectionId: 'c2' } });
  assert.equal(table.get('RELAY', 'CONN').connectionId, null);
});

test('refuses malformed or oversized messages, and other routes', async () => {
  await connect('c1');
  assert.equal((await message('c1', { type: 'sync', full: false, entities: [{ id: 'light.a' }] })).statusCode, 400);
  assert.equal((await ws({ requestContext: { routeKey: 'sync', connectionId: 'c1' }, body: '{nope' })).statusCode, 400);
  assert.equal((await ws({ requestContext: { routeKey: 'sync', connectionId: 'c1' }, body: 'x'.repeat(129 * 1024) })).statusCode, 413);
  assert.equal((await ws({ requestContext: { routeKey: '$default', connectionId: 'c1' }, body: '{}' })).statusCode, 400);
  assert.deepEqual(table.keys(), ['CONN']);
});

const result = (connectionId, body) => ws({ requestContext: { routeKey: 'result', connectionId }, body: JSON.stringify(body) });
const ID = 'b'.repeat(24);

test('results are stored for the waiting API, from the current connection only', async () => {
  await connect('c1');
  await connect('c2');
  assert.equal((await result('c1', { type: 'result', id: ID, ok: true })).statusCode, 403);
  assert.equal(table.get('RESULT', ID), undefined);
  assert.equal((await result('c2', { type: 'result', id: ID, ok: false, error: 'refused: not exposed' })).statusCode, 200);
  const r = table.get('RESULT', ID);
  assert.deepEqual([r.ok, r.error], [false, 'refused: not exposed']);
  assert.equal(r.expires, Math.floor(NOW.getTime() / 1000) + 86_400, 'gone in a day');
  assert.equal((await result('c2', { type: 'result', id: 'nope', ok: true })).statusCode, 400);
});
