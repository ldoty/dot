import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ISSUER, accessToken, forgedToken } from '../../../platform/tests/helpers/tokens.mjs';
import { fakeTable } from '../../../platform/tests/helpers/fake-table.mjs';
import { caller } from '../../../platform/tests/helpers/http.mjs';

Object.assign(process.env, { TABLE: 'family-tempi', GROUP: 'family_tempi', ISSUER, CLIENT_ID: 'tempi-client' });
const table = fakeTable();
const { handler } = await import('../api/api.mjs');
const member = (sub = 'u1') => accessToken({ clientId: 'tempi-client', group: 'family_tempi', sub });
const callApi = caller(handler, ['GET /course', 'GET /progress', 'PUT /progress']);
const call = (m, p, b, t = member()) => callApi(m, p, b, t);
beforeEach(() => table.clear());

test('refuses missing, forged, wrong-group and other-tool tokens', async () => {
  assert.equal((await call('GET', '/course', undefined, null)).status, 401);
  assert.equal((await call('GET', '/course', undefined, forgedToken({ clientId: 'tempi-client', group: 'family_tempi' }))).status, 401);
  assert.equal((await call('GET', '/course', undefined, accessToken({ clientId: 'tempi-client', group: 'someone_else' }))).status, 403);
  assert.equal((await call('GET', '/progress', undefined, accessToken({ clientId: 'other-tool', group: 'family_tempi' }))).status, 401);
});

test('serves the course to members', async () => {
  const r = await call('GET', '/course');
  assert.equal(r.status, 200);
  assert.match(r.body.html, /^<div class="shell"/);
  assert.match(r.body.html, /id="p-start"/);
});

test('saves and loads progress per user', async () => {
  assert.equal((await call('GET', '/progress')).status, 404);
  const progress = { done: { m1: true }, j: { a: 'My answer' }, s: {} };
  assert.equal((await call('PUT', '/progress', { progress })).status, 200);
  assert.deepEqual((await call('GET', '/progress')).body.progress, progress);
  assert.equal((await call('GET', '/progress', undefined, member('u2'))).status, 404, 'another user sees their own');
});

test('validates progress', async () => {
  assert.equal((await call('PUT', '/progress', { progress: [] })).status, 400);
  assert.equal((await call('PUT', '/progress', {})).status, 400);
  assert.equal((await call('PUT', '/progress', { progress: { j: { a: 'x'.repeat(400_000) } } })).status, 413);
});
