import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { accessToken, forgedToken } from '../../../platform/tests/helpers/tokens.mjs';
import { CLIENT_ID, DOT_CLIENT_ID, PK, call, seed, sharedDoc, table } from './helpers/budget-api.mjs';

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

// --- Dot reading for someone (delegated client) ---

const dotToken = (over = {}) => accessToken({ clientId: DOT_CLIENT_ID, group: 'family_budget', via: 'dot', ...over });

test('Dot can read the budget for a member', async () => {
  const all = await call('GET', '/all', undefined, dotToken());
  assert.equal(all.status, 200);
  assert.deepEqual(Object.keys(all.body.docs).sort(), ['Amber', 'Luke', 'shared']);
  assert.equal((await call('GET', '/defaults', undefined, dotToken())).status !== 401, true);
});

test('Dot is read-only: every write is refused and nothing changes', async () => {
  const before = JSON.stringify(table.dump());
  for (const [m, p, b] of [
    ['PUT', '/docs/shared/state', { state: { income: [], categories: [] }, rev: 1 }],
    ['PUT', '/docs/Luke/versions/v9', { name: 'x', savedAt: 1, state: {} }],
    ['DELETE', '/docs/shared/versions/v1'],
    ['PUT', '/docs/shared/tags/mine', { versionId: 'v1' }],
    ['DELETE', '/docs/shared/tags/default'],
  ]) {
    const r = await call(m, p, b, dotToken());
    assert.deepEqual([r.status, r.body.error], [403, 'read-only'], `${m} ${p}`);
  }
  // also refused when only one of the two markers is present
  assert.equal((await call('PUT', '/docs/shared/state', { state: {}, rev: 1 }, dotToken({ via: undefined }))).status, 403);
  assert.equal((await call('PUT', '/docs/shared/state', { state: {}, rev: 1 }, accessToken({ clientId: CLIENT_ID, group: 'family_budget', via: 'dot' }))).status, 403);
  assert.equal(JSON.stringify(table.dump()), before);
});

test('Dot gets nothing for someone outside family_budget', async () => {
  assert.equal((await call('GET', '/all', undefined, dotToken({ group: 'family_assistant' }))).status, 403);
});

// --- The plan (Planning tab) ---

const plan = (over = {}) => ({
  start: '2026-11', months: 24, balance: 5000,
  steps: [{ from: '2026-11', tag: 'default' }, { from: '2027-03', tag: 'stretch' }],
  oneOffs: [{ id: 'o1', month: '2026-12', label: 'Settlement check', amount: 200000 }],
  ...over,
});

test('the plan starts empty, saves with a rev, and comes back in GET /all', async () => {
  assert.equal((await call('GET', '/all')).body.plan, null);
  assert.deepEqual(await call('PUT', '/plan', { plan: plan(), rev: null }), { status: 200, body: { rev: 1 } });
  const { body } = await call('GET', '/all');
  assert.deepEqual(body.plan, { plan: plan(), rev: 1 });
});

test('a stale plan save gets 409 with the current plan', async () => {
  await call('PUT', '/plan', { plan: plan(), rev: null });
  assert.equal((await call('PUT', '/plan', { plan: plan({ months: 12 }), rev: 1 })).status, 200);
  const stale = await call('PUT', '/plan', { plan: plan({ months: 36 }), rev: 1 });
  assert.equal(stale.status, 409);
  assert.deepEqual([stale.body.rev, stale.body.plan.months], [2, 12]);
  assert.equal((await call('PUT', '/plan', { plan: plan(), rev: null })).status, 409, 'creating over an existing plan');
});

test('a malformed plan is refused and extra fields are dropped', async () => {
  for (const bad of [
    plan({ start: '2026-13' }), plan({ months: 3 }), plan({ months: 61 }), plan({ balance: 'lots' }),
    plan({ steps: [{ from: '2026-11', tag: 'Bad Tag' }] }), plan({ steps: 'x' }),
    plan({ oneOffs: [{ id: 'o1', month: '2026-12', label: 'x', amount: 'big' }] }),
    plan({ oneOffs: [{ id: 'bad id', month: '2026-12', label: 'x', amount: 1 }] }),
  ]) assert.equal((await call('PUT', '/plan', { plan: bad, rev: null })).status, 400, JSON.stringify(bad));
  await call('PUT', '/plan', { plan: plan({ steps: [{ from: '2026-11', tag: 'default', junk: 1 }], extra: true }), rev: null });
  assert.deepEqual(JSON.parse(table.get(PK, 'PLAN').plan).steps, [{ from: '2026-11', tag: 'default' }]);
  assert.equal(JSON.parse(table.get(PK, 'PLAN').plan).extra, undefined);
});

test('Dot can read the plan but not change it', async () => {
  await call('PUT', '/plan', { plan: plan(), rev: null });
  assert.equal((await call('GET', '/all', undefined, dotToken())).body.plan.plan.start, '2026-11');
  const r = await call('PUT', '/plan', { plan: plan({ months: 12 }), rev: 1 }, dotToken());
  assert.deepEqual([r.status, r.body.error], [403, 'read-only']);
  assert.equal(JSON.parse(table.get(PK, 'PLAN').plan).months, 24);
});

test('API Gateway routes match the ones the handler serves', async () => {
  const { readFile } = await import('node:fs/promises');
  const tf = await readFile(new URL('../infra/api.tf', import.meta.url), 'utf8');
  const src = await readFile(new URL('../api/api.mjs', import.meta.url), 'utf8');
  const block = /for_each = toset\(\[([\s\S]*?)\]\)/.exec(tf)[1];
  const served = [...src.matchAll(/case '([A-Z]+ \/[^']*)'/g)].map((m) => m[1]);
  assert.deepEqual([...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort(), served.sort());
});
