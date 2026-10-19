import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateCeiling, exposed, refuseCommand, reportState } from '../relay/ceiling.mjs';
import { parseCommand, parseData, parseResult, parseSync, MAX_ENTITIES } from '../relay/protocol.mjs';

const ceiling = validateCeiling({
  expose: { areas: ['kitchen'], entities: ['switch.away'], exclude: ['light.kitchen_secret'] },
  domains: {
    light: { attributes: ['brightness'], actions: { turn_on: ['brightness_pct'], turn_off: [] } },
    switch: { attributes: [], actions: { turn_on: [], turn_off: [] } },
  },
});

test('the committed ceiling is valid', () => {
  validateCeiling(JSON.parse(readFileSync(new URL('../relay/ceiling.json', import.meta.url), 'utf8')));
});

test('an area exposes only configured domains', () => {
  assert.equal(exposed(ceiling, 'light.kitchen_main', 'kitchen'), true);
  assert.equal(exposed(ceiling, 'lock.kitchen_door', 'kitchen'), false, 'a lock added to the kitchen stays hidden');
  assert.equal(exposed(ceiling, 'light.bedroom', 'master_bedroom'), false, 'unlisted area');
  assert.equal(exposed(ceiling, 'light.nowhere', null), false, 'no area, not listed');
});

test('listed entities are exposed anywhere; excluded ones never', () => {
  assert.equal(exposed(ceiling, 'switch.away', null), true);
  assert.equal(exposed(ceiling, 'light.kitchen_secret', 'kitchen'), false);
});

test('a listed entity still needs its domain configured', () => {
  const c = validateCeiling({ expose: { entities: ['camera.porch'] }, domains: { light: { attributes: [], actions: {} } } });
  assert.equal(exposed(c, 'camera.porch', null), false);
});

test('only allowed attributes are reported', () => {
  const s = { entity_id: 'light.kitchen_main', state: 'on', last_updated: '2026-10-18T20:00:00Z', attributes: { brightness: 153, friendly_name: 'Kitchen', supported_features: 32, latitude: 1 } };
  assert.deepEqual(reportState(ceiling, s, { name: 'Kitchen Main Lights', area: 'kitchen' }), {
    id: 'light.kitchen_main', name: 'Kitchen Main Lights', area: 'kitchen', domain: 'light', state: 'on', attrs: { brightness: 153 }, updated: '2026-10-18T20:00:00Z',
    actions: { turn_on: ['brightness_pct'], turn_off: [] },
  });
});

test('refuses a malformed ceiling', () => {
  assert.throws(() => validateCeiling({ expose: {} }), /domains/);
  assert.throws(() => validateCeiling({ expose: { areas: ['Kitchen!'] }, domains: {} }), /expose.areas/);
  assert.throws(() => validateCeiling({ expose: {}, domains: { light: { actions: {} } } }), /attributes/);
});

const e = (over = {}) => ({ id: 'light.kitchen_main', name: 'Kitchen', area: 'kitchen', domain: 'light', state: 'on', attrs: { brightness: 3 }, updated: '2026-10-18T20:00:00Z', actions: { turn_on: ['brightness_pct'] }, ...over });

test('sync messages are checked field by field', () => {
  assert.deepEqual(parseSync({ type: 'sync', full: false, entities: [e({ extra: 'dropped' })] }), { full: false, entities: [e()] });
  assert.throws(() => parseSync({ type: 'sync', full: false, entities: [e({ domain: 'switch' })] }), /entity/, 'domain must match the id');
  assert.throws(() => parseSync({ type: 'sync', full: false, entities: [e({ attrs: { nested: { a: 1 } } })] }), /entity/);
  assert.throws(() => parseSync({ type: 'sync', full: false, entities: [e({ id: 'Light.X' })] }), /entity/);
  assert.throws(() => parseSync({ type: 'sync', full: false, entities: [e({ actions: undefined })] }), /entity/, 'actions required');
  assert.throws(() => parseSync({ type: 'sync', full: false, entities: [e({ actions: { turn_on: 'all' } })] }), /entity/);
  assert.throws(() => parseSync({ type: 'sync', full: true, entities: [] }), /areas/, 'a full sync names its areas');
  assert.throws(() => parseSync({ type: 'sync', full: false, entities: Array(MAX_ENTITIES + 1).fill(e()) }), /entities/);
});

const cmd = (over = {}) => ({ entity_id: 'light.kitchen_main', action: 'turn_on', data: {}, ...over });

test('the ceiling refuses commands outside it', () => {
  assert.equal(refuseCommand(ceiling, cmd({ data: { brightness_pct: 50 } }), 'kitchen'), null);
  assert.equal(refuseCommand(ceiling, cmd(), 'master_bedroom'), 'not exposed', 'moved out of an exposed area');
  assert.equal(refuseCommand(ceiling, cmd({ entity_id: 'lock.kitchen_door', action: 'unlock' }), 'kitchen'), 'not exposed');
  assert.equal(refuseCommand(ceiling, cmd({ action: 'toggle' }), 'kitchen'), 'toggle not allowed');
  assert.equal(refuseCommand(ceiling, cmd({ data: { brightness_pct: 50, flash: 'long' } }), 'kitchen'), 'flash not allowed for turn_on');
  assert.equal(refuseCommand(ceiling, cmd({ action: 'turn_off', data: { brightness_pct: 5 } }), 'kitchen'), 'brightness_pct not allowed for turn_off');
});

test('commands and results are checked on the way through', () => {
  const m = { type: 'command', id: 'a'.repeat(24), entity_id: 'light.kitchen_main', action: 'turn_on', data: { brightness_pct: 40 }, expires: 1 };
  assert.deepEqual(parseCommand({ ...m, extra: 1 }), { id: m.id, entity_id: m.entity_id, action: 'turn_on', data: { brightness_pct: 40 }, expires: 1 });
  assert.throws(() => parseCommand({ ...m, id: 'short' }), /id/);
  assert.throws(() => parseCommand({ ...m, expires: undefined }), /expires/);
  assert.throws(() => parseCommand({ ...m, action: 'turn on' }), /target/);
  assert.deepEqual(parseData(undefined), {});
  assert.throws(() => parseData({ a: { b: 1 } }), /data a/);
  assert.throws(() => parseData([1]), /data/);
  assert.throws(() => parseData({ a: Infinity }), /data a/);
  assert.deepEqual(parseResult({ type: 'result', id: m.id, ok: false, error: 'x'.repeat(300) }).error.length, 200);
  assert.equal(parseResult({ type: 'result', id: m.id, ok: true, error: 'ignored' }).error, null);
  assert.throws(() => parseResult({ type: 'result', id: m.id }), /bad result/);
});
