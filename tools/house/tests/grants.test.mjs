import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grantsFor, levelFor, parseGrant } from '../api/grants.mjs';

const KID = '11111111-1111-1111-1111-111111111111';
const PARENT = '22222222-2222-2222-2222-222222222222';
const grants = [
  { who: 'group:kids', where: '*', level: 'read' },
  { who: 'group:kids', where: 'area:kitchen', level: 'control' },
  { who: `sub:${KID}`, where: 'entity:light.flex_room_main', level: 'control' },
  { who: `sub:${PARENT}`, where: 'area:garage', level: 'confirm' },
];
const groups = [{ name: 'kids', members: [KID] }];
const kid = { admin: false, grants: grantsFor(KID, grants, groups) };

test('highest matching grant wins: read everywhere, control in the kitchen and their own room', () => {
  assert.equal(levelFor(kid, { id: 'light.kitchen_main', area: 'kitchen' }), 'control');
  assert.equal(levelFor(kid, { id: 'light.flex_room_main', area: 'flex_room_bedroom' }), 'control');
  assert.equal(levelFor(kid, { id: 'light.master_bedroom_main', area: 'master_bedroom' }), 'read');
});

test('no matching grant means no access', () => {
  const nobody = { admin: false, grants: grantsFor('33333333-3333-3333-3333-333333333333', grants, groups) };
  assert.equal(levelFor(nobody, { id: 'light.kitchen_main', area: 'kitchen' }), 'none');
  const parent = { admin: false, grants: grantsFor(PARENT, grants, groups) };
  assert.equal(levelFor(parent, { id: 'cover.garage_door', area: 'garage' }), 'confirm');
  assert.equal(levelFor(parent, { id: 'light.kitchen_main', area: 'kitchen' }), 'none', 'someone else’s group grants don’t apply');
});

test('area grants follow the entity’s area now', () => {
  assert.equal(levelFor(kid, { id: 'light.lamp', area: 'kitchen' }), 'control');
  assert.equal(levelFor(kid, { id: 'light.lamp', area: 'office' }), 'read');
  assert.equal(levelFor(kid, { id: 'light.lamp', area: null }), 'read', 'no area: only * applies');
});

test('admins have control everywhere', () => {
  assert.equal(levelFor({ admin: true, grants: [] }, { id: 'light.x', area: null }), 'control');
});

test('grants are checked before they’re stored', () => {
  assert.deepEqual(parseGrant({ who: 'group:kids', where: 'area:kitchen', level: 'control', extra: 1 }), { who: 'group:kids', where: 'area:kitchen', level: 'control' });
  assert.throws(() => parseGrant({ who: 'kids', where: '*', level: 'read' }), /who/);
  assert.throws(() => parseGrant({ who: 'group:kids', where: 'kitchen', level: 'read' }), /where/);
  assert.throws(() => parseGrant({ who: 'group:kids', where: '*', level: 'none' }), /level/);
  assert.throws(() => parseGrant({ who: 'group:kids', where: '*', level: 'admin' }), /level/);
});
