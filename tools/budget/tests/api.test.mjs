import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { accessToken, forgedToken } from '../../../platform/tests/helpers/tokens.mjs';
import { CLIENT_ID, PK, call, seed, sharedDoc, table } from './helpers/budget-api.mjs';

beforeEach(() => seed());

test('GET /all returns every doc, version and tag', async () => {
  const { status, body } = await call('GET', '/all');
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body.docs).sort(), ['Amber', 'Luke', 'shared']);
  assert.equal(body.docs.shared.rev, 1);
  assert.deepEqual(body.versions.shared.map((v) => v.name), ['Starting point']);
  assert.deepEqual(body.tags, { shared: [{ name: 'default', versionId: 'v1' }], Luke: [], Amber: [] });
});

test('every route refuses missing, forged, wrong-group and other-tool tokens', async () => {
  for (const [m, p] of [['GET', '/all'], ['PUT', '/docs/shared/state'], ['PUT', '/docs/shared/tags/default'], ['DELETE', '/docs/Luke/versions/v1']]) {
    assert.equal((await call(m, p, {}, null)).status, 401, `${m} ${p} no token`);
    assert.equal((await call(m, p, {}, forgedToken({ clientId: CLIENT_ID, group: 'family_budget' }))).status, 401, `${m} ${p} forged`);
    assert.equal((await call(m, p, {}, accessToken({ clientId: CLIENT_ID, group: 'recipes' }))).status, 403, `${m} ${p} wrong group`);
    assert.equal((await call(m, p, {}, accessToken({ clientId: 'home', group: 'family_budget' }))).status, 401, `${m} ${p} other tool`);
  }
});

test('saving a doc bumps its rev; a stale rev gets 409 with the current copy', async () => {
  const first = await call('PUT', '/docs/Luke/state', { state: { income: [], categories: [] }, rev: 1 });
  assert.deepEqual(first, { status: 200, body: { rev: 2 } });
  const stale = await call('PUT', '/docs/Luke/state', { state: { income: [], categories: [], x: 1 }, rev: 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.rev, 2);
  assert.equal(stale.body.state.x, undefined);
});

test('docs are independent: saving Luke doesn’t touch Shared or Amber', async () => {
  await call('PUT', '/docs/Luke/state', { state: { income: [], categories: [] }, rev: 1 });
  const { body } = await call('GET', '/all');
  assert.equal(body.docs.Luke.rev, 2);
  assert.equal(body.docs.shared.rev, 1);
  assert.equal(body.docs.Amber.rev, 1);
});

test('rejects unknown docs, bad ids and bad tag names', async () => {
  assert.equal((await call('PUT', '/docs/Bob/state', { state: {}, rev: 1 })).status, 400);
  assert.equal((await call('PUT', '/docs/Luke/versions/bad%20id', { name: 'x', state: {} })).status, 400);
  assert.equal((await call('PUT', '/docs/shared/tags/Bad Tag', { versionId: 'v1' })).status, 400);
});

test('versions are per doc', async () => {
  await call('PUT', '/docs/Luke/versions/lv1', { name: 'Luke lean', savedAt: 5, state: { income: [] } });
  const { body } = await call('GET', '/all');
  assert.deepEqual(body.versions.Luke.map((v) => v.name), ['Luke lean']);
  assert.deepEqual(body.versions.Amber, []);
});

test('tags must point at an existing shared version', async () => {
  assert.equal((await call('PUT', '/docs/shared/tags/stretch', { versionId: 'nope' })).status, 400);
  assert.equal((await call('PUT', '/docs/shared/tags/stretch', { versionId: 'v1' })).status, 200);
  assert.equal(table.get(PK, 'TAG#shared#stretch').versionId, 'v1');
});

test('a tagged shared version can’t be deleted; untagged can', async () => {
  const blocked = await call('DELETE', '/docs/shared/versions/v1');
  assert.equal(blocked.status, 409);
  assert.deepEqual(blocked.body.tags, ['default']);
  await call('PUT', '/docs/shared/versions/v2', { name: 'Other', state: sharedDoc() });
  assert.equal((await call('DELETE', '/docs/shared/versions/v2')).status, 200);
  assert.equal(table.get(PK, 'DOC#shared#VERSION#v2'), undefined);
});

test('the default tag can’t be deleted; others can', async () => {
  assert.equal((await call('DELETE', '/docs/shared/tags/default')).status, 400);
  await call('PUT', '/docs/shared/tags/stretch', { versionId: 'v1' });
  assert.equal((await call('DELETE', '/docs/shared/tags/stretch')).status, 200);
});

test('GET /defaults returns the combined starting numbers', async () => {
  const { status, body } = await call('GET', '/defaults');
  assert.equal(status, 200);
  assert.ok(body.state.people.Luke);
});

test('tags are per doc: a personal tag must point at that person’s version', async () => {
  await call('PUT', '/docs/Luke/versions/lv1', { name: 'Lean', savedAt: 5, state: { income: [] } });
  assert.equal((await call('PUT', '/docs/Luke/tags/default', { versionId: 'v1' })).status, 400, 'a Shared version id is refused');
  assert.equal((await call('PUT', '/docs/Luke/tags/default', { versionId: 'lv1' })).status, 200);
  const { body } = await call('GET', '/all');
  assert.deepEqual(body.tags.Luke, [{ name: 'default', versionId: 'lv1' }]);
  assert.deepEqual(body.tags.Amber, []);
  assert.deepEqual(body.tags.shared, [{ name: 'default', versionId: 'v1' }]);
});

test('a tagged personal version can’t be deleted, and personal default can’t be removed', async () => {
  await call('PUT', '/docs/Amber/versions/av1', { name: 'Plan', savedAt: 5, state: { income: [] } });
  await call('PUT', '/docs/Amber/tags/default', { versionId: 'av1' });
  assert.equal((await call('DELETE', '/docs/Amber/versions/av1')).status, 409);
  assert.equal((await call('DELETE', '/docs/Amber/tags/default')).status, 400);
});
