import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { ISSUER, accessToken, forgedToken } from '../../../platform/tests/helpers/tokens.mjs';
import { fakeTable } from '../../../platform/tests/helpers/fake-table.mjs';
import { caller } from '../../../platform/tests/helpers/http.mjs';

Object.assign(process.env, {
  TABLE: 'family-biomap', BUCKET: 'biomap-bucket', GROUP: 'lukes_biomap', ISSUER, CLIENT_ID: 'biomap-client',
  AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'AKIATEST', AWS_SECRET_ACCESS_KEY: 'test-secret',
});
const table = fakeTable();
const s3 = mockClient(S3Client);
let published = null;
const { handler } = await import('../api/api.mjs');
const member = (sub = 'luke') => accessToken({ clientId: 'biomap-client', group: 'lukes_biomap', sub });
const callApi = caller(handler, ['GET /deck', 'GET /progress', 'PUT /progress']);
const call = (m, p, b, t = member()) => callApi(m, p, b, t);
const DECK = { taxa: [{ id: 'a', image_path: 'site/Fungi/x/x.jpg' }, { id: 'b', image_path: 'site/Fungi/x/x.jpg' }, { id: 'c' }], cards: [{ id: 'a::photo' }] };

beforeEach(() => {
  table.clear(); s3.reset(); published = JSON.stringify(DECK);
  s3.on(GetObjectCommand).callsFake(({ Key }) => {
    if (Key !== 'deck.json' || !published) throw Object.assign(new Error('nope'), { name: 'NoSuchKey' });
    return { Body: { transformToString: async () => published } };
  });
});

test('refuses missing, forged, wrong-group and other-tool tokens', async () => {
  assert.equal((await call('GET', '/deck', undefined, null)).status, 401);
  assert.equal((await call('GET', '/deck', undefined, forgedToken({ clientId: 'biomap-client', group: 'lukes_biomap' }))).status, 401);
  assert.equal((await call('GET', '/deck', undefined, accessToken({ clientId: 'biomap-client', group: 'family_assistant' }))).status, 403);
  assert.equal((await call('GET', '/progress', undefined, accessToken({ clientId: 'assistant-client', group: 'lukes_biomap' }))).status, 401);
});

test('GET /deck returns the deck with a short-lived signed URL for each photo', async () => {
  const { status, body } = await call('GET', '/deck');
  assert.equal(status, 200);
  assert.equal(body.taxa.length, 3);
  assert.deepEqual(Object.keys(body.images), ['site/Fungi/x/x.jpg'], 'one URL per photo, not per taxon');
  const url = new URL(body.images['site/Fungi/x/x.jpg']);
  assert.equal(url.hostname, 'biomap-bucket.s3.us-east-1.amazonaws.com');
  assert.equal(url.pathname, '/photos/site/Fungi/x/x.jpg');
  assert.equal(url.searchParams.get('X-Amz-Expires'), '3600');
  assert.ok(url.searchParams.get('X-Amz-Signature'));
});

test('GET /deck before anything is published is a 404 with a hint', async () => {
  published = null;
  const r = await call('GET', '/deck');
  assert.equal(r.status, 404);
  assert.match(r.body.error, /publish\.sh/);
});

test('progress: create, read back, conflict on a stale rev, and per-user separation', async () => {
  assert.equal((await call('GET', '/progress')).status, 404);
  const p1 = { cards: { 'a::photo': { reps: 1, due: 5 } }, days: {} };
  assert.deepEqual((await call('PUT', '/progress', { progress: p1, rev: null })).body, { rev: 1 });
  assert.deepEqual((await call('GET', '/progress')).body, { progress: p1, rev: 1 });
  const stale = await call('PUT', '/progress', { progress: { cards: {} }, rev: null });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body, { progress: p1, rev: 1 });
  assert.equal((await call('PUT', '/progress', { progress: { cards: {} }, rev: 1 })).body.rev, 2);
  assert.equal((await call('GET', '/progress', undefined, member('someone-else'))).status, 404);
});

test('progress input is validated', async () => {
  assert.equal((await call('PUT', '/progress', { progress: 'x', rev: null })).status, 400);
  assert.equal((await call('PUT', '/progress', { progress: { days: {} }, rev: null })).status, 400);
  assert.equal((await call('PUT', '/progress', { progress: { cards: {} }, rev: 'one' })).status, 400);
  assert.equal((await call('PUT', '/progress', { progress: { cards: { big: 'x'.repeat(400_000) } }, rev: null })).status, 413);
});
