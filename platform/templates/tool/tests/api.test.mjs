import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ISSUER, accessToken, forgedToken } from '../../../platform/tests/helpers/tokens.mjs';
import { fakeTable } from '../../../platform/tests/helpers/fake-table.mjs';
import { caller } from '../../../platform/tests/helpers/http.mjs';

Object.assign(process.env, { TABLE: 'family-__TOOL__', GROUP: '__GROUP__', ISSUER, CLIENT_ID: '__TOOL__-client' });
const table = fakeTable();
const { handler } = await import('../api/api.mjs');
const member = () => accessToken({ clientId: '__TOOL__-client', group: '__GROUP__' });
const callApi = caller(handler, ['GET /items', 'PUT /items/{id}', 'DELETE /items/{id}']);
const call = (m, p, b, t = member()) => callApi(m, p, b, t);
beforeEach(() => table.clear());

test('refuses missing, forged, wrong-group and other-tool tokens', async () => {
  assert.equal((await call('GET', '/items', undefined, null)).status, 401);
  assert.equal((await call('GET', '/items', undefined, forgedToken({ clientId: '__TOOL__-client', group: '__GROUP__' }))).status, 401);
  assert.equal((await call('GET', '/items', undefined, accessToken({ clientId: '__TOOL__-client', group: 'someone_else' }))).status, 403);
  assert.equal((await call('GET', '/items', undefined, accessToken({ clientId: 'other-tool', group: '__GROUP__' }))).status, 401);
});

test('add, list and remove items', async () => {
  assert.equal((await call('PUT', '/items/a1', { name: 'First' })).status, 200);
  assert.deepEqual((await call('GET', '/items')).body.map((i) => i.name), ['First']);
  assert.equal((await call('DELETE', '/items/a1')).status, 200);
  assert.deepEqual((await call('GET', '/items')).body, []);
});

test('validates input', async () => {
  assert.equal((await call('PUT', '/items/a1', { name: '' })).status, 400);
  assert.equal((await call('PUT', '/items/bad%20id', { name: 'x' })).status, 400);
});
