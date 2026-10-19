import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical, changeKey, describe, dueKey, minuteToday, parseAutomation, parseAutomations, parseRan } from '../relay/automation.mjs';

const TZ = 'America/New_York';
const at = (hhmm, over = {}) => parseAutomation({ name: 'Morning', when: { at: hhmm }, actions: [{ entity_id: 'light.kitchen_main', action: 'turn_on', data: { brightness_pct: 80 } }], ...over });

test('an automation is checked field by field, with every day by default', () => {
  const a = at('06:00');
  assert.deepEqual(a, { name: 'Morning', when: { at: '06:00' }, days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'], actions: [{ entity_id: 'light.kitchen_main', action: 'turn_on', data: { brightness_pct: 80 } }], notify: null, enabled: true });
  assert.deepEqual(at('06:00', { days: ['fri', 'mon'] }).days, ['mon', 'fri'], 'days in week order');
  for (const [over, why] of [
    [{ name: ' ' }, 'name'], [{ name: 'x'.repeat(61) }, 'name'],
    [{ when: { at: '6:00' } }, 'when.at'], [{ when: { at: '24:00' } }, 'when.at'], [{ when: { at: '06:00', sun: 'sunrise' } }, 'when'],
    [{ when: { sun: 'noon' } }, 'when'], [{ when: { sun: 'sunset', offset: 181 } }, 'offset'], [{ when: { sun: 'sunset', offset: 1.5 } }, 'offset'],
    [{ days: [] }, 'days'], [{ days: ['mon', 'mon'] }, 'days'], [{ days: ['monday'] }, 'days'],
    [{ actions: [] }, 'actions'], [{ actions: Array(21).fill({ entity_id: 'light.a', action: 'turn_on' }) }, 'actions'],
    [{ actions: [{ entity_id: 'Light.A', action: 'turn_on' }] }, 'actions[0]'],
    [{ actions: [{ entity_id: 'light.a', action: 'turn_on', data: { x: { y: 1 } } }] }, 'actions[0].data'],
    [{ enabled: 'yes' }, 'enabled'],
  ]) assert.throws(() => at('06:00', over), new RegExp(why.replace(/[[\].]/g, '\\$&')), JSON.stringify(over));
  assert.deepEqual(parseAutomation({ ...at('06:00'), when: { sun: 'sunset' } }).when, { sun: 'sunset', offset: 0 });
});

test('it says what it does in words', () => {
  const names = { 'light.kitchen_main': 'Kitchen main', 'light.porch': 'Porch' };
  assert.equal(describe(at('06:00', { days: ['mon', 'tue', 'wed', 'thu', 'fri'] }), (id) => names[id]), 'Every weekday at 6:00 AM: turn on Kitchen main (80%)');
  const evening = parseAutomation({
    name: 'Porch', when: { sun: 'sunset', offset: -30 }, days: ['sat', 'sun'],
    actions: [{ entity_id: 'light.porch', action: 'turn_on', data: { transition: 60 } }, { entity_id: 'light.kitchen_main', action: 'turn_off' }],
  });
  assert.equal(describe(evening, (id) => names[id]), 'Every weekend day 30 minutes before sunset: turn on Porch (fading over 60 s) and turn off Kitchen main');
  const three = parseAutomation({ ...at('06:00'), days: ['mon', 'wed', 'fri'], actions: [
    { entity_id: 'light.a', action: 'turn_on', data: { brightness_pct: 40, transition: 5 } }, { entity_id: 'light.b', action: 'turn_off' }, { entity_id: 'light.c', action: 'turn_off' }] });
  assert.equal(describe(three), 'Every Monday, Wednesday and Friday at 6:00 AM: turn on light.a (40%, fading over 5 s), turn off light.b and turn off light.c');
  assert.equal(describe(at('18:05', { days: ['tue', 'thu'] })), 'Every Tuesday and Thursday at 6:05 PM: turn on light.kitchen_main (80%)');
  assert.equal(describe(at('00:30', { when: { sun: 'sunrise', offset: 15 }, days: ['mon'] })), 'Every Monday 15 minutes after sunrise: turn on light.kitchen_main (80%)');
});

test('canonical: the same automation, however its data is ordered', () => {
  const a = at('06:00', { actions: [{ entity_id: 'light.a', action: 'turn_on', data: { brightness_pct: 5, transition: 2 } }] });
  const b = at('06:00', { actions: [{ entity_id: 'light.a', action: 'turn_on', data: { transition: 2, brightness_pct: 5 } }] });
  assert.equal(canonical(a), canonical(b));
  assert.notEqual(canonical(a), canonical({ ...a, enabled: false }));
});

// Monday 2026-10-19 in New York (EDT, UTC-4)
const ny = (local) => new Date(`${local}-04:00`);

test('due at its minute on its days, for up to five minutes late, never after', () => {
  const a = at('06:00', { days: ['mon'] });
  assert.equal(dueKey(a, ny('2026-10-19T05:59:59'), TZ), null);
  assert.equal(dueKey(a, ny('2026-10-19T06:00:00'), TZ), '2026-10-19@360');
  assert.equal(dueKey(a, ny('2026-10-19T06:04:59'), TZ), '2026-10-19@360', 'the relay was down at 6:00');
  assert.equal(dueKey(a, ny('2026-10-19T06:05:00'), TZ), null, 'too late: a 6 AM light doesn’t come on at noon');
  assert.equal(dueKey(a, ny('2026-10-20T06:00:00'), TZ), null, 'not on Tuesday');
  assert.equal(dueKey({ ...a, enabled: false }, ny('2026-10-19T06:00:00'), TZ), null, 'paused');
});

test('6:00 stays 6:00 in the house’s time zone across DST', () => {
  const a = at('06:00');
  assert.equal(dueKey(a, new Date('2026-11-02T11:00:00Z'), TZ), '2026-11-02@360', 'after DST ends, 6:00 EST is 11:00 UTC');
  assert.equal(dueKey(a, new Date('2026-11-02T10:00:00Z'), TZ), null);
  assert.equal(dueKey(a, new Date('2026-11-02T06:00:00Z'), 'UTC'), '2026-11-02@360', 'another house, another zone');
});

test('sunrise and sunset come from Home Assistant’s sun, with the offset', () => {
  const rise = parseAutomation({ ...at('06:00'), when: { sun: 'sunrise', offset: -30 } });
  // Before today's sunrise, next_rising is today's
  const before = { next_rising: '2026-10-19T11:39:00Z', next_setting: '2026-10-19T22:27:00Z' };
  assert.equal(minuteToday(rise, '2026-10-19', TZ, before), 7 * 60 + 9, '7:39 AM less 30 minutes');
  assert.equal(dueKey(rise, ny('2026-10-19T07:09:00'), TZ, before), '2026-10-19@429');
  // After it, next_rising is tomorrow's: a day earlier is near enough today's
  const after = { next_rising: '2026-10-20T11:40:00Z', next_setting: '2026-10-19T22:27:00Z' };
  assert.equal(minuteToday(rise, '2026-10-19', TZ, after), 7 * 60 + 10);
  const set = parseAutomation({ ...at('06:00'), when: { sun: 'sunset', offset: 15 } });
  assert.equal(minuteToday(set, '2026-10-19', TZ, before), 18 * 60 + 42);
  assert.equal(minuteToday(set, '2026-10-19', TZ, undefined), null, 'no sun, no run');
  assert.equal(minuteToday(set, '2026-10-19', TZ, { next_setting: 'soon' }), null);
});

test('the set from AWS and the run reports are checked', () => {
  const a = { id: 'abcdefgh12', ...at('06:00') };
  assert.deepEqual(parseAutomations({ type: 'automations', at: '2026-10-19T10:00:00Z', items: [a] }).items, [a]);
  assert.throws(() => parseAutomations({ type: 'automations', at: 'x', items: [] }));
  assert.throws(() => parseAutomations({ type: 'automations', at: '2026-10-19T10:00:00Z', items: [{ ...a, id: 'BAD' }] }));
  assert.throws(() => parseAutomations({ type: 'automations', at: '2026-10-19T10:00:00Z', items: Array(41).fill(a) }));
  const ran = { type: 'ran', id: 'abcdefgh12', key: '2026-10-19@360', at: '2026-10-19T10:00:05Z', results: [{ entity_id: 'light.a', action: 'turn_on', ok: false, error: 'x'.repeat(300) }] };
  assert.equal(parseRan(ran).results[0].error.length, 200);
  assert.equal(parseRan(ran).at, '2026-10-19T10:00:05.000Z');
  for (const bad of [{ id: 'nope' }, { key: 'today' }, { results: [] }, { results: [{ entity_id: 'light.a', action: 'turn_on', ok: 'yes' }] }]) {
    assert.throws(() => parseRan({ ...ran, ...bad }), JSON.stringify(bad));
  }
});

// ---- set off by a change, and texts ----

const leaves = (over = {}) => parseAutomation({ name: 'Luke leaves', when: { changes: 'person.luke_doty', to: 'not_home' }, notify: { message: 'You left: check the garage.' }, ...over });

test('a change sets it off; it can just text, but must do something, with no links', () => {
  const a = leaves();
  assert.deepEqual([a.when, a.actions, a.notify], [{ changes: 'person.luke_doty', to: 'not_home' }, [], { message: 'You left: check the garage.' }]);
  assert.throws(() => leaves({ notify: null }), /must do something/);
  assert.throws(() => leaves({ notify: { message: 'see https://x.test' } }), /no links/);
  assert.throws(() => leaves({ notify: { message: 'go to dot-y.co' } }), /no links/);
  assert.throws(() => leaves({ notify: { message: 'x'.repeat(161) } }), /160/);
  assert.throws(() => leaves({ when: { changes: 'person.luke_doty', to: 'Not Home' } }), /changes/);
  assert.throws(() => leaves({ when: { changes: 'person.luke_doty', to: 'home', at: '06:00' } }));
  assert.notEqual(canonical(a), canonical(leaves({ notify: { message: 'Other' } })), 'the message is part of what it is');
});

test('in words: leaving and coming home, on which days, and the text', () => {
  const name = (id) => ({ 'person.luke_doty': 'Luke Doty', 'light.porch': 'Porch' }[id]);
  assert.equal(describe(leaves(), name), 'When Luke Doty leaves home: text “You left: check the garage.”');
  assert.equal(describe(leaves({ when: { changes: 'person.luke_doty', to: 'home' }, days: ['mon', 'tue', 'wed', 'thu', 'fri'], actions: [{ entity_id: 'light.porch', action: 'turn_on' }] }), name),
    'When Luke Doty comes home on a weekday: turn on Porch and text “You left: check the garage.”');
});

test('a change sets it off once, never from unavailable or unknown, only on its days', () => {
  const at = { entityId: 'person.luke_doty', now: new Date('2026-10-19T17:30:00Z'), timeZone: TZ }; // Monday 1:30 PM EDT
  assert.equal(changeKey(leaves(), { ...at, from: 'home', to: 'not_home' }), '2026-10-19@810');
  assert.equal(changeKey(leaves(), { ...at, from: 'not_home', to: 'home' }), null, 'the other way');
  assert.equal(changeKey(leaves(), { ...at, from: 'unknown', to: 'not_home' }), null, 'Home Assistant restarting isn’t leaving');
  assert.equal(changeKey(leaves(), { ...at, from: 'unavailable', to: 'not_home' }), null);
  assert.equal(changeKey(leaves(), { ...at, from: undefined, to: 'not_home' }), null);
  assert.equal(changeKey(leaves(), { ...at, entityId: 'person.amber', from: 'home', to: 'not_home' }), null);
  assert.equal(changeKey(leaves({ days: ['sat'] }), { ...at, from: 'home', to: 'not_home' }), null);
  assert.equal(changeKey(leaves({ enabled: false }), { ...at, from: 'home', to: 'not_home' }), null);
  assert.equal(dueKey(leaves(), at.now, TZ), null, 'never on a clock');
  const ran = { type: 'ran', id: 'abcdefgh12', key: '2026-10-19@810', at: '2026-10-19T17:30:00Z', results: [], notify: true };
  assert.equal(parseRan(ran).notify, true);
  assert.throws(() => parseRan({ ...ran, notify: false }), 'nothing ran and nothing to send');
});
