import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { accessToken, forgedToken } from '../../../platform/tests/helpers/tokens.mjs';
import { resolveLines } from '../../finances/api/budget-lines.mjs';
import { CLIENT_ID, DELEGATED_CLIENT_ID, GROUP, PK, ROUTES, businessDoc, call, seed, table } from './helpers/budget-api.mjs';

beforeEach(() => seed());

test('GET /all returns the business budget, its versions and tags', async () => {
  const { status, body } = await call('GET', '/all');
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body.docs), ['Business']);
  assert.equal(body.docs.Business.rev, 1);
  assert.deepEqual(body.versions.Business.map((v) => v.name), ['Plan']);
  assert.deepEqual(body.tags, { Business: [{ name: 'default', versionId: 'v1' }] });
});

test('every route refuses missing, forged, wrong-group and other-tool tokens', async () => {
  for (const [m, p] of [['GET', '/all'], ['PUT', '/docs/Business/state'], ['PUT', '/docs/Business/tags/default'], ['DELETE', '/docs/Business/versions/v1']]) {
    assert.equal((await call(m, p, {}, null)).status, 401, `${m} ${p} no token`);
    assert.equal((await call(m, p, {}, forgedToken({ clientId: CLIENT_ID, group: GROUP }))).status, 401, `${m} ${p} forged`);
    // A household Budget member isn't a member of this one
    assert.equal((await call(m, p, {}, accessToken({ clientId: CLIENT_ID, group: 'family_budget' }))).status, 403, `${m} ${p} wrong group`);
    assert.equal((await call(m, p, {}, accessToken({ clientId: 'budget-client', group: GROUP }))).status, 401, `${m} ${p} other tool`);
  }
});

test('the delegated client (SDC/SCE Finances, as its person) may read but never write', async () => {
  const delegated = accessToken({ clientId: DELEGATED_CLIENT_ID, group: GROUP });
  assert.equal((await call('GET', '/all', undefined, delegated)).status, 200);
  const w = await call('PUT', '/docs/Business/state', { state: { income: [] }, rev: 1 }, delegated);
  assert.deepEqual(w, { status: 403, body: { error: 'read-only' } });
  assert.equal((await call('PUT', '/docs/Business/tags/x', { versionId: 'v1' }, delegated)).status, 403);
  assert.equal((await call('DELETE', '/docs/Business/versions/v1', undefined, delegated)).status, 403);
  assert.equal(JSON.parse(table.get(PK, 'DOC#Business#STATE').state).income.length, 1);
});

test('saving bumps the rev; a stale rev gets 409 with the current copy', async () => {
  assert.deepEqual(await call('PUT', '/docs/Business/state', { state: { income: [], categories: [] }, rev: 1 }), { status: 200, body: { rev: 2 } });
  const stale = await call('PUT', '/docs/Business/state', { state: { income: [], categories: [], x: 1 }, rev: 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.rev, 2);
  assert.equal(stale.body.state.x, undefined);
});

test('the first save of a new budget needs no rev, and only once', async () => {
  table.clear();
  assert.deepEqual(await call('PUT', '/docs/Business/state', { state: businessDoc() }), { status: 200, body: { rev: 1 } });
  assert.equal((await call('PUT', '/docs/Business/state', { state: businessDoc() })).status, 409);
});

test('rejects other docs, bad ids and bad tag names', async () => {
  for (const d of ['shared', 'Luke', 'Bob']) assert.equal((await call('PUT', `/docs/${d}/state`, { state: {}, rev: 1 })).status, 400, d);
  assert.equal((await call('PUT', '/docs/Business/versions/bad%20id', { name: 'x', state: {} })).status, 400);
  assert.equal((await call('PUT', '/docs/Business/tags/Bad Tag', { versionId: 'v1' })).status, 400);
});

test('tags must point at an existing version; default can’t be deleted', async () => {
  assert.equal((await call('PUT', '/docs/Business/tags/lean', { versionId: 'nope' })).status, 400);
  assert.equal((await call('PUT', '/docs/Business/tags/lean', { versionId: 'v1' })).status, 200);
  assert.equal(table.get(PK, 'TAG#Business#lean').versionId, 'v1');
  assert.equal((await call('DELETE', '/docs/Business/tags/default')).status, 400);
  assert.equal((await call('DELETE', '/docs/Business/tags/lean')).status, 200);
  assert.equal(table.get(PK, 'TAG#Business#lean'), undefined);
});

test('a tagged version can’t be deleted', async () => {
  const r = await call('DELETE', '/docs/Business/versions/v1');
  assert.deepEqual(r, { status: 409, body: { error: 'tagged', tags: ['default'] } });
  await call('PUT', '/docs/Business/versions/v2', { name: 'Lean', savedAt: 2, state: businessDoc(1000) });
  assert.equal((await call('DELETE', '/docs/Business/versions/v2')).status, 200);
});

test('versions come newest first', async () => {
  await call('PUT', '/docs/Business/versions/v2', { name: 'Lean', savedAt: 5, state: businessDoc(1000) });
  const { body } = await call('GET', '/all');
  assert.deepEqual(body.versions.Business.map((v) => v.name), ['Lean', 'Plan']);
});

// What SDC/SCE Finances does with GET /all: the household finances code, with person "Business"
test('the finances tool resolves its lines from this budget’s tagged version', async () => {
  await call('PUT', '/docs/Business/versions/v2', { name: 'Lean', savedAt: 5, state: businessDoc(1000) });
  await call('PUT', '/docs/Business/tags/lean', { versionId: 'v2' });
  const { body } = await call('GET', '/all');
  const r = resolveLines(body, { person: 'Business', tag: 'lean' });
  assert.equal(r.version.name, 'Lean');
  assert.equal(r.sharedVersion, null, 'a business budget follows no household Shared version');
  const by = Object.fromEntries(r.lines.map((l) => [l.id, l]));
  assert.equal(by['L.r1'].target, 1000);
  assert.equal(by['L.i1'].kind, 'income');
  assert.equal(by['L.s1'].kind, 'save');
  assert.equal(by['L.s1'].annual, true);
  assert.equal(by['L.r1'].group, 'Business');
  assert.ok(by['LC.c1'].general);
  assert.ok(!r.lines.some((l) => /^(S|SC)\./.test(l.id)));
  // The working copy too
  assert.equal(resolveLines(body, { person: 'Business', tag: '@working' }).lines.find((l) => l.id === 'L.r1').target, 2000);
});

test('API Gateway routes match the ones the handler serves', async () => {
  const tf = await readFile(new URL('../infra/api.tf', import.meta.url), 'utf8');
  const routes = [.../routes = \[([\s\S]*?)\]/.exec(tf)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(routes.sort(), [...ROUTES].sort());
  for (const r of ROUTES) {
    const [method, path] = r.split(' ');
    const res = await call(method, path.replace('{doc}', 'Business').replace('{id}', 'v9').replace('{name}', 'x'), {});
    assert.notEqual(res.body?.error, 'no route', r);
  }
});
