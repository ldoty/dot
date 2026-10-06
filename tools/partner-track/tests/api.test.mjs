import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ISSUER, accessToken, forgedToken } from '../../../platform/tests/helpers/tokens.mjs';
import { fakeTable } from '../../../platform/tests/helpers/fake-table.mjs';
import { caller } from '../../../platform/tests/helpers/http.mjs';

const ROUTES = ['GET /course', 'GET /progress', 'PUT /progress'];
Object.assign(process.env, { TABLE: 'family-partner-track', GROUP: 'lukes_partner_track', ISSUER, CLIENT_ID: 'pt-client' });
const table = fakeTable();
const { handler } = await import('../api/api.mjs');
const member = (sub = 'u1') => accessToken({ clientId: 'pt-client', group: 'lukes_partner_track', sub });
const callApi = caller(handler, ROUTES);
const call = (m, p, b, t = member()) => callApi(m, p, b, t);
beforeEach(() => table.clear());

test('infra/api.tf routes match the handler', () => {
  const tf = readFileSync(new URL('../infra/api.tf', import.meta.url), 'utf8');
  const routes = JSON.parse(tf.match(/routes\s*=\s*(\[[^\]]*\])/)[1]);
  assert.deepEqual(routes.sort(), [...ROUTES].sort());
});

test('refuses missing, forged, wrong-group and other-tool tokens', async () => {
  assert.equal((await call('GET', '/course', undefined, null)).status, 401);
  assert.equal((await call('GET', '/course', undefined, forgedToken({ clientId: 'pt-client', group: 'lukes_partner_track' }))).status, 401);
  assert.equal((await call('GET', '/course', undefined, accessToken({ clientId: 'pt-client', group: 'family_tempi' }))).status, 403);
  assert.equal((await call('GET', '/progress', undefined, accessToken({ clientId: 'other-tool', group: 'lukes_partner_track' }))).status, 401);
});

test('serves the course to members', async () => {
  const r = await call('GET', '/course');
  assert.equal(r.status, 200);
  assert.match(r.body.html, /^<div class="shell"/);
  assert.match(r.body.html, /id="p-start"/);
  assert.match(r.body.html, /id="quiz-data"/);
});

test('saves and loads progress per user', async () => {
  assert.equal((await call('GET', '/progress')).status, 404);
  const progress = { done: { m1: true }, j: { m1a: 'Two people' }, preds: [{ id: 'a', text: 'x', prob: 70, due: '2027-01-01', outcome: null }] };
  assert.equal((await call('PUT', '/progress', { progress })).status, 200);
  assert.deepEqual((await call('GET', '/progress')).body.progress, progress);
  assert.equal((await call('GET', '/progress', undefined, member('u2'))).status, 404, 'another user sees their own');
});

test('validates progress', async () => {
  assert.equal((await call('PUT', '/progress', { progress: [] })).status, 400);
  assert.equal((await call('PUT', '/progress', {})).status, 400);
  assert.equal((await call('PUT', '/progress', { progress: { j: { a: 'x'.repeat(400_000) } } })).status, 413);
});
