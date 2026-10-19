import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { KID, LUKE, call, relay, seed, table, token } from './helpers/house.mjs';

const dot = () => token({ sub: LUKE, clientId: 'house-via-dot', via: 'dot', groups: ['family_house', 'family_house:admin'] });
const kid = () => token({ sub: KID });

beforeEach(seed);

test('only admins, and never through Dot', async () => {
  for (const [m, p, b] of [['GET', '/access'], ['GET', '/log'], ['PUT', '/grants/g1abcd', { who: `sub:${KID}`, where: '*', level: 'control' }], ['DELETE', '/grants/g1abcd'],
    ['PUT', '/groups/kids', { members: [KID] }], ['DELETE', '/groups/kids']]) {
    assert.deepEqual((await call(m, p, b, kid())).body, { error: 'admins only' }, `${m} ${p} as a member`);
    assert.deepEqual((await call(m, p, b, dot())).body, { error: 'read-only' }, `${m} ${p} via Dot, even as an admin`);
  }
  assert.equal(table.get('GRANT', 'g1abcd'), undefined);
});

test('the access view lists grants, groups, people and what to pick from', async () => {
  await call('PUT', '/grants/g1abcd', { who: 'group:kids', where: 'area:kitchen', level: 'control' });
  await call('PUT', '/groups/kids', { members: [KID] });
  const r = (await call('GET', '/access')).body;
  assert.deepEqual(r.grants, [{ id: 'g1abcd', who: 'group:kids', where: 'area:kitchen', level: 'control', rev: 1 }]);
  assert.deepEqual(r.groups, [{ name: 'kids', members: [KID], rev: 1 }]);
  assert.deepEqual(r.people.map((p) => p.name), ['Kid', 'Luke']);
  assert.deepEqual(r.areas.map((a) => a.id), ['dining_room', 'kitchen', 'master_bedroom']);
  assert.ok(r.entities.some((e) => e.id === 'switch.lutron_smart_away' && e.area === null));
});

test('a grant takes effect at once: the kid can work the kitchen, not the master bedroom', async () => {
  assert.equal((await call('POST', '/commands', { entity_id: 'light.kitchen_main', action: 'turn_off' }, kid())).status, 403);
  assert.equal((await call('PUT', '/grants/g1abcd', { who: `sub:${KID}`, where: 'area:kitchen', level: 'control' })).status, 200);
  assert.equal((await call('POST', '/commands', { entity_id: 'light.kitchen_main', action: 'turn_off' }, kid())).status, 200);
  assert.equal((await call('POST', '/commands', { entity_id: 'light.master_bedroom_main', action: 'turn_off' }, kid())).status, 403);
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

test('bad grants and groups are refused', async () => {
  assert.equal((await call('PUT', '/grants/g1abcd', { who: 'luke', where: '*', level: 'read' })).status, 400);
  assert.equal((await call('PUT', '/grants/g1abcd', { who: `sub:${KID}`, where: 'kitchen', level: 'read' })).status, 400);
  assert.equal((await call('PUT', '/grants/g1abcd', { who: `sub:${KID}`, where: '*', level: 'owner' })).status, 400);
  assert.equal((await call('PUT', '/grants/Bad!', { who: `sub:${KID}`, where: '*', level: 'read' })).status, 400);
  assert.equal((await call('PUT', '/grants/g1abcd', { who: `sub:${KID}`, where: '*', level: 'read', rev: 'x' })).status, 400);
  assert.equal((await call('PUT', '/groups/Kids!', { members: [] })).status, 400);
  assert.equal((await call('PUT', '/groups/kids', { members: ['not-a-sub'] })).status, 400);
  assert.deepEqual(table.dump().filter(([k]) => k.startsWith('GRANT') || k.startsWith('GROUP')), []);
});

test('a group’s grants apply to its members; removing the group removes its grants', async () => {
  await call('PUT', '/groups/kids', { members: [KID, KID] });
  assert.deepEqual(table.get('GROUP', 'kids').members, [KID], 'no duplicates');
  await call('PUT', '/grants/g1abcd', { who: 'group:kids', where: 'area:kitchen', level: 'control' });
  await call('PUT', '/grants/g2abcd', { who: `sub:${KID}`, where: 'area:dining_room', level: 'read' });
  assert.equal((await call('POST', '/commands', { entity_id: 'light.kitchen_main', action: 'turn_off' }, kid())).status, 200);
  const r = await call('DELETE', '/groups/kids');
  assert.deepEqual(r.body.removedGrants, ['g1abcd']);
  assert.equal(table.get('GRANT', 'g1abcd'), undefined, 'gone, so a new group of the same name starts empty');
  assert.equal(table.get('GRANT', 'g2abcd').level, 'read', 'their own grant stays');
  assert.equal((await call('POST', '/commands', { entity_id: 'light.kitchen_main', action: 'turn_on' }, kid())).status, 403);
});

test('the log: the last week of commands, newest first, allowed or not', async () => {
  await call('PUT', '/grants/g1abcd', { who: `sub:${KID}`, where: 'area:kitchen', level: 'control' });
  await call('POST', '/commands', { entity_id: 'light.kitchen_main', action: 'turn_off' }, kid());
  await call('POST', '/commands', { entity_id: 'light.master_bedroom_main', action: 'turn_off' }, kid());
  const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
  table.put({ pk: `CMD#${old.slice(0, 10)}`, sk: `${old}#x`, who: KID, outcome: 'done' });
  const r = (await call('GET', '/log')).body;
  assert.deepEqual(r.map((x) => [x.entity_id, x.outcome, x.via]), [['light.master_bedroom_main', 'denied', 'page'], ['light.kitchen_main', 'done', 'page']]);
  assert.equal(r[0].who, KID);
});
