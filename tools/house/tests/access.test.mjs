import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { KID, LUKE, call, familyGroup, relay, seed, table, token } from './helpers/house.mjs';

const dot = () => token({ sub: LUKE, clientId: 'house-via-dot', via: 'dot', groups: ['family_house', 'family_house:admin'] });
const kid = () => token({ sub: KID });
const off = (entity_id) => ({ entity_id, action: 'turn_off' });

beforeEach(seed);

test('only admins, and never through Dot', async () => {
  for (const [m, p, b] of [['GET', '/access'], ['GET', '/log'], ['PUT', '/grants/g1abcd', { who: `sub:${KID}`, where: '*', level: 'control' }], ['DELETE', '/grants/g1abcd']]) {
    assert.deepEqual((await call(m, p, b, kid())).body, { error: 'admins only' }, `${m} ${p} as a member`);
    assert.deepEqual((await call(m, p, b, dot())).body, { error: 'read-only' }, `${m} ${p} via Dot, even as an admin`);
  }
  assert.equal(table.get('GRANT', 'g1abcd'), undefined);
});

test('the access view: grants, the family’s groups, people by their family names, what to pick from', async () => {
  familyGroup('gkids00001', 'Kids', [KID]);
  table.put({ pk: 'PERSON', sk: KID, name: 'Junior' });
  await call('PUT', '/grants/g1abcd', { who: 'group:gkids00001', where: 'area:kitchen', level: 'control' });
  const r = (await call('GET', '/access')).body;
  assert.deepEqual(r.grants, [{ id: 'g1abcd', who: 'group:gkids00001', where: 'area:kitchen', level: 'control', rev: 1 }]);
  assert.deepEqual(r.groups, [{ id: 'gkids00001', name: 'Kids' }]);
  assert.deepEqual(r.people.map((p) => p.name), ['Junior', 'Luke'], 'dot-y.co/family’s name over the account’s');
  assert.deepEqual(r.areas.map((a) => a.id), ['dining_room', 'kitchen', 'master_bedroom']);
  assert.ok(r.entities.some((e) => e.id === 'switch.lutron_smart_away' && e.area === null));
});

test('a grant takes effect at once: the kid can work the kitchen, not the master bedroom', async () => {
  assert.equal((await call('POST', '/commands', off('light.kitchen_main'), kid())).status, 403);
  assert.equal((await call('PUT', '/grants/g1abcd', { who: `sub:${KID}`, where: 'area:kitchen', level: 'control' })).status, 200);
  assert.equal((await call('POST', '/commands', off('light.kitchen_main'), kid())).status, 200);
  assert.equal((await call('POST', '/commands', off('light.master_bedroom_main'), kid())).status, 403);
  await call('DELETE', '/grants/g1abcd');
  assert.equal((await call('POST', '/commands', { entity_id: 'light.kitchen_main', action: 'turn_on' }, kid())).status, 403);
  assert.equal(relay.sent.length, 1);
});

test('edits are rev-checked: a stale edit gets 409 and the current grant', async () => {
  const g = { who: `sub:${KID}`, where: 'area:kitchen', level: 'read' };
  assert.equal((await call('PUT', '/grants/g1abcd', g)).body.rev, 1);
  assert.equal((await call('PUT', '/grants/g1abcd', g)).status, 409, 'a new grant can’t overwrite one that exists');
  assert.equal((await call('PUT', '/grants/g1abcd', { ...g, level: 'control', rev: 1 })).body.rev, 2);
  const stale = await call('PUT', '/grants/g1abcd', { ...g, level: 'confirm', rev: 1 });
  assert.deepEqual([stale.status, stale.body.current.level, stale.body.current.rev], [409, 'control', 2]);
  assert.equal(table.get('GRANT', 'g1abcd').changedBy, 'test-user');
});

test('bad grants are refused', async () => {
  assert.equal((await call('PUT', '/grants/g1abcd', { who: 'luke', where: '*', level: 'read' })).status, 400);
  assert.equal((await call('PUT', '/grants/g1abcd', { who: `sub:${KID}`, where: 'kitchen', level: 'read' })).status, 400);
  assert.equal((await call('PUT', '/grants/g1abcd', { who: `sub:${KID}`, where: '*', level: 'owner' })).status, 400);
  assert.equal((await call('PUT', '/grants/Bad!', { who: `sub:${KID}`, where: '*', level: 'read' })).status, 400);
  assert.equal((await call('PUT', '/grants/g1abcd', { who: `sub:${KID}`, where: '*', level: 'read', rev: 'x' })).status, 400);
  assert.deepEqual(table.dump().filter(([k]) => k.startsWith('GRANT')), []);
});

test('a family group’s grant follows its members; a removed group’s grant stays dead, even if the name comes back', async () => {
  familyGroup('gkids00001', 'Kids', [KID]);
  await call('PUT', '/grants/g1abcd', { who: 'group:gkids00001', where: 'area:kitchen', level: 'control' });
  assert.equal((await call('POST', '/commands', off('light.kitchen_main'), kid())).status, 200);
  table.put({ pk: 'GROUP', sk: 'gkids00001', name: 'Kids', members: [], rev: 2 }); // removed from Kids on dot-y.co/family
  assert.equal((await call('POST', '/commands', off('light.kitchen_main'), kid())).status, 403);
  table.delete('GROUP', 'gkids00001');
  familyGroup('gkids00002', 'Kids', [KID]); // a new group with the old name
  assert.equal((await call('POST', '/commands', off('light.kitchen_main'), kid())).status, 403);
});

test('the log: the last week of commands, newest first, allowed or not', async () => {
  await call('PUT', '/grants/g1abcd', { who: `sub:${KID}`, where: 'area:kitchen', level: 'control' });
  await call('POST', '/commands', off('light.kitchen_main'), kid());
  await call('POST', '/commands', off('light.master_bedroom_main'), kid());
  const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
  table.put({ pk: `CMD#${old.slice(0, 10)}`, sk: `${old}#x`, who: KID, outcome: 'done' });
  const r = (await call('GET', '/log')).body;
  assert.deepEqual(r.map((x) => [x.entity_id, x.outcome, x.via]), [['light.master_bedroom_main', 'denied', 'page'], ['light.kitchen_main', 'done', 'page']]);
  assert.equal(r[0].who, KID);
});
