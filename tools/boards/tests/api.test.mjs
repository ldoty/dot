import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ISSUER, accessToken, forgedToken } from '../../../platform/tests/helpers/tokens.mjs';
import { fakeTable } from '../../../platform/tests/helpers/fake-table.mjs';
import { caller } from '../../../platform/tests/helpers/http.mjs';

const ROUTES = ['GET /guide', 'GET /progress', 'PUT /progress'];
const GUIDE_FILE = fileURLToPath(new URL('./guide.fixture.json', import.meta.url));
Object.assign(process.env, { TABLE: 'family-boards', GROUP: 'lukes_boards', ISSUER, CLIENT_ID: 'bd-client', GUIDE_FILE });
const table = fakeTable();
const { handler } = await import('../api/api.mjs');
const member = (sub = 'u1') => accessToken({ clientId: 'bd-client', group: 'lukes_boards', sub });
const callApi = caller(handler, ROUTES);
const call = (m, p, b, t = member()) => callApi(m, p, b, t);
beforeEach(() => table.clear());

test('infra/api.tf routes match the handler', () => {
  const tf = readFileSync(new URL('../infra/api.tf', import.meta.url), 'utf8');
  const routes = JSON.parse(tf.match(/routes\s*=\s*(\[[^\]]*\])/)[1]);
  assert.deepEqual(routes.sort(), [...ROUTES].sort());
});

test('infra bundles the guide from the gitignored private folder', () => {
  const tf = readFileSync(new URL('../infra/api.tf', import.meta.url), 'utf8');
  assert.match(tf, /file\("\$\{path\.module\}\/\.\.\/private\/guide\.json"\)/);
  assert.match(tf, /filename = "guide\.json"/);
});

test('refuses missing, forged, wrong-group and other-tool tokens', async () => {
  assert.equal((await call('GET', '/guide', undefined, null)).status, 401);
  assert.equal((await call('GET', '/guide', undefined, forgedToken({ clientId: 'bd-client', group: 'lukes_boards' }))).status, 401);
  assert.equal((await call('GET', '/guide', undefined, accessToken({ clientId: 'bd-client', group: 'lukes_partner_track' }))).status, 403);
  assert.equal((await call('GET', '/progress', undefined, accessToken({ clientId: 'other-tool', group: 'lukes_boards' }))).status, 401);
  assert.equal((await call('PUT', '/progress', { progress: {} }, null)).status, 401);
});

test('serves the guide to members', async () => {
  const r = await call('GET', '/guide');
  assert.equal(r.status, 200);
  assert.equal(r.body.guide.people.length, 8);
  assert.equal(r.body.guide.orgs[0].short, 'Alpha');
  assert.match(r.body.guide.photos['ada-north'], /^data:image\//);
});

test('saves and loads progress per user', async () => {
  assert.equal((await call('GET', '/progress')).status, 404);
  const progress = { boxes: { 'face:ada-north': 2 }, study: { deck: 'faces', scope: 'all', mode: 'choose' }, tab: 'plan' };
  assert.equal((await call('PUT', '/progress', { progress })).status, 200);
  assert.deepEqual((await call('GET', '/progress')).body.progress, progress);
  assert.equal((await call('GET', '/progress', undefined, member('u2'))).status, 404, 'another user sees their own');
});

test('validates progress', async () => {
  assert.equal((await call('PUT', '/progress', { progress: [] })).status, 400);
  assert.equal((await call('PUT', '/progress', {})).status, 400);
  assert.equal((await call('PUT', '/progress', { progress: { boxes: { a: 'x'.repeat(400_000) } } })).status, 413);
});
