import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { forgedToken } from '../../../platform/tests/helpers/tokens.mjs';
import { AMBER, KID, LUKE, ROUTES, call, dotToken, familyGroup, newList, reset, table, token } from './helpers/lists.mjs';

const { MANIFEST } = await import('../api/api.mjs');
const item = (text, extra = {}) => ({ text, ...extra });
beforeEach(reset);

test('refuses missing, forged, wrong-group and other-tool tokens', async () => {
  assert.equal((await call('GET', '/lists', undefined, null)).status, 401);
  assert.equal((await call('GET', '/lists', undefined, forgedToken({ clientId: 'lists-client', group: 'family_lists' }))).status, 401);
  assert.equal((await call('GET', '/lists', undefined, token(LUKE, { 'cognito:groups': ['someone_else'] }))).status, 403);
  assert.equal((await call('GET', '/lists', undefined, token(LUKE, { clientId: 'other-tool' }))).status, 401);
});

test('a new list is yours alone', async () => {
  const l = await newList('Errands');
  assert.deepEqual([l.name, l.layout, l.columns, l.owner, l.level, l.share], ['Errands', 'checklist', ['To do', 'Doing', 'Done'], LUKE, 'owner', []]);
  assert.deepEqual((await call('GET', '/lists', undefined, token(AMBER))).body, []);
  assert.equal((await call('GET', `/lists/${l.id}`, undefined, token(AMBER))).status, 404, 'not even that it exists');
  assert.equal((await call('PUT', `/lists/${l.id}/items/i00001`, item('x'), token(AMBER))).status, 404);
});

test('items: add, change with rev checks, tick off, remove; counts on the lists', async () => {
  const l = await newList();
  const a = (await call('PUT', `/lists/${l.id}/items/i00001`, item('Milk', { order: 2 }))).body;
  await call('PUT', `/lists/${l.id}/items/i00002`, item('Stamps', { order: 1 }));
  assert.equal(a.rev, 1);
  assert.equal((await call('PUT', `/lists/${l.id}/items/i00001`, item('Milk'))).status, 409, 'a new item can’t overwrite one');
  const done = (await call('PUT', `/lists/${l.id}/items/i00001`, item('Milk', { done: true, order: 2, rev: 1 }))).body;
  assert.deepEqual([done.done, done.doneAt, done.rev], [true, '2026-10-19T14:00:00.000Z', 2]);
  const stale = await call('PUT', `/lists/${l.id}/items/i00001`, item('Oat milk', { rev: 1 }));
  assert.deepEqual([stale.status, stale.body.current.text], [409, 'Milk']);
  const got = (await call('GET', `/lists/${l.id}`)).body;
  assert.deepEqual(got.items.map((i) => i.text), ['Stamps', 'Milk'], 'by order');
  assert.deepEqual((await call('GET', '/lists')).body.map((x) => [x.name, x.open, x.total]), [['Errands', 1, 2]]);
  await call('DELETE', `/lists/${l.id}/items/i00002`);
  assert.equal((await call('GET', `/lists/${l.id}`)).body.items.length, 1);
});

test('bad lists and items are refused', async () => {
  assert.equal((await call('POST', '/lists', { name: '' })).status, 400);
  assert.equal((await call('POST', '/lists', { name: 'x', layout: 'gantt' })).status, 400);
  assert.equal((await call('POST', '/lists', { name: 'x', layout: 'board', columns: ['A', 'a'] })).status, 400);
  const l = await newList();
  for (const bad of [item(''), item('x', { due: '10/19' }), item('x', { assignee: 'luke' }), item('x', { remind: { at: 'soon' } }), item('x', { remind: { at: '2026-10-20T09:00:00Z', channel: 'pigeon' } }), item('x'.repeat(301))]) {
    assert.equal((await call('PUT', `/lists/${l.id}/items/i00001`, bad)).status, 400, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal((await call('PUT', `/lists/${l.id}/items/Bad!`, item('x'))).status, 400);
  assert.equal((await call('PUT', `/lists/${l.id}`, { name: 'x' })).status, 400, 'rev required');
});

test('sharing: read sees, edit changes, only the owner shares or deletes', async () => {
  const l = await newList('Groceries');
  const share = [{ who: `sub:${AMBER}`, level: 'edit' }, { who: `sub:${KID}`, level: 'read' }];
  assert.equal((await call('PUT', `/lists/${l.id}`, { name: 'Groceries', layout: 'checklist', columns: l.columns, share, rev: 1 })).status, 200);
  assert.equal((await call('GET', `/lists/${l.id}`, undefined, token(KID))).body.list.level, 'read');
  assert.equal((await call('PUT', `/lists/${l.id}/items/i00001`, item('Eggs'), token(KID))).status, 403);
  assert.equal((await call('PUT', `/lists/${l.id}/items/i00001`, item('Eggs'), token(AMBER))).status, 200);
  assert.equal((await call('PUT', `/lists/${l.id}`, { name: 'Food', layout: 'checklist', columns: l.columns, share, rev: 2 }, token(AMBER))).status, 200, 'an editor renames');
  assert.equal((await call('PUT', `/lists/${l.id}`, { name: 'Food', layout: 'checklist', columns: l.columns, share: [], rev: 3 }, token(AMBER))).status, 403, 'only the owner shares');
  assert.equal((await call('DELETE', `/lists/${l.id}`, undefined, token(AMBER))).status, 403);
  assert.equal((await call('DELETE', `/lists/${l.id}`)).status, 200);
  assert.deepEqual(table.dump().filter(([k]) => k.startsWith('ITEMS#') || k.startsWith('LIST')), [], 'its items go with it');
});

test('sharing with a family group follows its members, and a removed group’s share stays dead', async () => {
  familyGroup('gkids00001', 'Kids', [KID]);
  const l = await newList('Chores');
  await call('PUT', `/lists/${l.id}`, { name: 'Chores', layout: 'checklist', columns: l.columns, share: [{ who: 'group:gkids00001', level: 'edit' }], rev: 1 });
  assert.equal((await call('PUT', `/lists/${l.id}/items/i00001`, item('Dishes'), token(KID))).status, 200);
  table.delete('GROUP', 'gkids00001');
  familyGroup('gkids00002', 'Kids', [KID]);
  assert.equal((await call('GET', `/lists/${l.id}`, undefined, token(KID))).status, 404);
});

test('layouts are views: switching keeps every item and its fields', async () => {
  const l = await newList('Work');
  await call('PUT', `/lists/${l.id}/items/i00001`, item('Taxes', { urgent: true, important: true, column: 'Doing' }));
  const r = await call('PUT', `/lists/${l.id}`, { name: 'Work', layout: 'matrix', columns: l.columns, rev: 1 });
  assert.equal(r.body.layout, 'matrix');
  await call('PUT', `/lists/${l.id}`, { name: 'Work', layout: 'board', columns: ['Later', 'Doing', 'Done'], rev: 2 });
  const got = (await call('GET', `/lists/${l.id}`)).body;
  assert.deepEqual([got.list.layout, got.items[0].urgent, got.items[0].important, got.items[0].column], ['board', true, true, 'Doing']);
});

test('Dot works as the person: reads and edits what they can, never sharing', async () => {
  const l = await newList('Groceries');
  await call('PUT', `/lists/${l.id}`, { name: 'Groceries', layout: 'checklist', columns: l.columns, share: [{ who: `sub:${AMBER}`, level: 'edit' }], rev: 1 });
  assert.equal((await call('GET', '/lists', undefined, dotToken(AMBER))).body.length, 1);
  assert.equal((await call('PUT', `/lists/${l.id}/items/i00001`, item('Eggs'), dotToken(AMBER))).status, 200);
  assert.equal((await call('POST', '/lists', { name: 'Dot made this' }, dotToken(AMBER))).status, 200);
  const r = await call('PUT', `/lists/${l.id}`, { name: 'Groceries', layout: 'checklist', columns: l.columns, share: [], rev: 2 }, dotToken());
  assert.deepEqual([r.status, r.body.error], [403, 'Dot can’t change who a list is shared with']);
  assert.equal((await call('PUT', '/prefs', { channel: 'email' }, dotToken())).status, 403);
  assert.deepEqual((await call('GET', '/dot', undefined, dotToken())).body, MANIFEST);
});

test('Dot deletes a list only with a confirmation: the same person, the same list, once, within two minutes', async () => {
  const l = await newList('Old');
  const ask = await call('DELETE', `/lists/${l.id}`, undefined, dotToken());
  assert.deepEqual([ask.status, ask.body.prompt], [202, 'Delete the list “Old” and everything on it?']);
  assert.ok(table.get('LIST', l.id), 'nothing deleted yet');
  assert.equal((await call('DELETE', `/lists/${l.id}?confirm_id=${'0'.repeat(24)}`, undefined, dotToken())).status, 400);
  const ask2 = (await call('DELETE', `/lists/${l.id}`, undefined, dotToken())).body.confirm_id;
  table.put({ ...table.get('PENDING', ask2), until: Date.parse('2026-10-19T13:59:00Z') });
  assert.equal((await call('DELETE', `/lists/${l.id}?confirm_id=${ask2}`, undefined, dotToken())).status, 400, 'expired');
  const ask3 = (await call('DELETE', `/lists/${l.id}`, undefined, dotToken())).body.confirm_id;
  assert.equal((await call('DELETE', `/lists/${l.id}?confirm_id=${ask3}`, undefined, dotToken())).status, 200);
  assert.equal(table.get('LIST', l.id), undefined);
  assert.equal((await call('DELETE', `/lists/${l.id}?confirm_id=${ask3}`, undefined, dotToken())).status, 404);
});

test('reminder preference: text by default', async () => {
  assert.deepEqual((await call('GET', '/prefs')).body, { channel: 'sms' });
  assert.equal((await call('PUT', '/prefs', { channel: 'pigeon' })).status, 400);
  await call('PUT', '/prefs', { channel: 'email' });
  assert.deepEqual((await call('GET', '/prefs')).body, { channel: 'email' });
  assert.deepEqual((await call('GET', '/prefs', undefined, token(AMBER))).body, { channel: 'sms' }, 'each their own');
});

test('the routes in infra/api.tf match the handler', async () => {
  const tf = await readFile(new URL('../infra/api.tf', import.meta.url), 'utf8');
  const block = /routes = \[([\s\S]*?)\]/.exec(tf)[1];
  assert.deepEqual([...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort(), [...ROUTES].sort());
  const sweep = await readFile(new URL('../infra/sweep.tf', import.meta.url), 'utf8');
  assert.match(sweep, /rate\(1 minute\)/);
  assert.match(sweep, /reserved_concurrent_executions = 1/);
});

test('share options: the others in Lists by their family names, and the family’s groups', async () => {
  familyGroup('gkids00001', 'Kids', [KID]);
  table.put({ pk: 'PERSON', sk: AMBER, name: 'Amber' });
  const r = (await call('GET', '/share-options')).body;
  assert.deepEqual(r.people, [{ sub: AMBER, name: 'Amber' }, { sub: KID, name: 'Kid' }], 'not yourself');
  assert.deepEqual(r.groups, [{ id: 'gkids00001', name: 'Kids' }]);
});
