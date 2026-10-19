import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical, changeKey, describe, dueKey, hasDaysLeft, minuteToday, nextTime, parseAutomation, parseAutomations, parseRan } from '../relay/automation.mjs';

const TZ = 'America/New_York';
const DAILY = { rule: 'FREQ=DAILY', start: '2026-10-01' };
const on = (rule, start = '2026-10-01') => ({ repeat: { rule, start } });
const WEEKDAYS = on('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
const at = (hhmm, over = {}) => parseAutomation({ name: 'Morning', when: { at: hhmm }, repeat: DAILY, actions: [{ entity_id: 'light.kitchen_main', action: 'turn_on', data: { brightness_pct: 80 } }], ...over });

test('an automation is checked field by field; its days are a repeat rule', () => {
  const a = at('06:00');
  assert.deepEqual(a, { name: 'Morning', when: { at: '06:00' }, repeat: DAILY, actions: [{ entity_id: 'light.kitchen_main', action: 'turn_on', data: { brightness_pct: 80 } }], notify: null, enabled: true });
  assert.deepEqual(at('06:00', on('rrule:freq=weekly;byday=mo')).repeat, { rule: 'FREQ=WEEKLY;BYDAY=MO', start: '2026-10-01' }, 'the rule as the other tools keep it');
  for (const [over, why] of [
    [{ name: ' ' }, 'name'], [{ name: 'x'.repeat(61) }, 'name'],
    [{ when: { at: '6:00' } }, 'when.at'], [{ when: { at: '24:00' } }, 'when.at'], [{ when: { at: '06:00', sun: 'sunrise' } }, 'when'],
    [{ when: { sun: 'noon' } }, 'when'], [{ when: { sun: 'sunset', offset: 181 } }, 'offset'], [{ when: { sun: 'sunset', offset: 1.5 } }, 'offset'],
    [{ days: ['mon'] }, 'days: use repeat'], [{ repeat: undefined }, 'repeat'], [on('FREQ=HOURLY'), 'FREQ'], [on('FREQ=DAILY;COUNT=3'), 'COUNT'],
    [on('FREQ=WEEKLY;BYDAY=XX'), 'BYDAY'], [on('FREQ=DAILY', '2026-13-01'), 'repeat.start'], [on('FREQ=DAILY', 'today'), 'repeat.start'],
    [{ actions: [] }, 'actions'], [{ actions: Array(21).fill({ entity_id: 'light.a', action: 'turn_on' }) }, 'actions'],
    [{ actions: [{ entity_id: 'Light.A', action: 'turn_on' }] }, 'actions[0]'],
    [{ actions: [{ entity_id: 'light.a', action: 'turn_on', data: { x: { y: 1 } } }] }, 'actions[0].data'],
    [{ enabled: 'yes' }, 'enabled'],
  ]) assert.throws(() => at('06:00', over), new RegExp(why.replace(/[[\].]/g, '\\$&')), JSON.stringify(over));
  assert.deepEqual(parseAutomation({ ...at('06:00'), when: { sun: 'sunset' } }).when, { sun: 'sunset', offset: 0 });
});

test('it says what it does in words', () => {
  const names = { 'light.kitchen_main': 'Kitchen main', 'light.porch': 'Porch' };
  assert.equal(describe(at('06:00', WEEKDAYS), (id) => names[id]), 'Every weekday at 6:00 AM: turn on Kitchen main (80%)');
  assert.equal(describe(at('06:00'), (id) => names[id]), 'Every day at 6:00 AM: turn on Kitchen main (80%)');
  const evening = parseAutomation({
    name: 'Porch', when: { sun: 'sunset', offset: -30 }, ...on('FREQ=WEEKLY;BYDAY=SA,SU'),
    actions: [{ entity_id: 'light.porch', action: 'turn_on', data: { transition: 60 } }, { entity_id: 'light.kitchen_main', action: 'turn_off' }],
  });
  assert.equal(describe(evening, (id) => names[id]), 'Every Saturday, Sunday 30 minutes before sunset: turn on Porch (fading over 60 s) and turn off Kitchen main');
  const three = parseAutomation({ ...at('06:00'), ...on('FREQ=WEEKLY;BYDAY=MO,WE,FR'), actions: [
    { entity_id: 'light.a', action: 'turn_on', data: { brightness_pct: 40, transition: 5 } }, { entity_id: 'light.b', action: 'turn_off' }, { entity_id: 'light.c', action: 'turn_off' }] });
  assert.equal(describe(three), 'Every Monday, Wednesday, Friday at 6:00 AM: turn on light.a (40%, fading over 5 s), turn off light.b and turn off light.c');
  assert.equal(describe(at('18:05', on('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU'))), 'Every other Tuesday at 6:05 PM: turn on light.kitchen_main (80%)');
  assert.equal(describe(at('00:30', { when: { sun: 'sunrise', offset: 15 }, ...on('FREQ=MONTHLY;BYDAY=1MO') })), 'Every month on the 1st Monday 15 minutes after sunrise: turn on light.kitchen_main (80%)');
  assert.equal(describe(at('07:00', on('FREQ=DAILY;UNTIL=20261231'))), 'Every day, until 2026-12-31 at 7:00 AM: turn on light.kitchen_main (80%)');
});

test('canonical: the same automation, however its data is ordered', () => {
  const a = at('06:00', { actions: [{ entity_id: 'light.a', action: 'turn_on', data: { brightness_pct: 5, transition: 2 } }] });
  const b = at('06:00', { actions: [{ entity_id: 'light.a', action: 'turn_on', data: { transition: 2, brightness_pct: 5 } }] });
  assert.equal(canonical(a), canonical(b));
  assert.notEqual(canonical(a), canonical({ ...a, enabled: false }));
  assert.notEqual(canonical(a), canonical({ ...a, repeat: { ...a.repeat, start: '2026-10-02' } }), 'the start is part of it (it fixes which weeks)');
});

// Monday 2026-10-19 in New York (EDT, UTC-4)
const ny = (local) => new Date(`${local}-04:00`);

test('due at its minute on its days, for up to five minutes late, never after', () => {
  const a = at('06:00', on('FREQ=WEEKLY;BYDAY=MO'));
  assert.equal(dueKey(a, ny('2026-10-19T05:59:59'), TZ), null);
  assert.equal(dueKey(a, ny('2026-10-19T06:00:00'), TZ), '2026-10-19@360');
  assert.equal(dueKey(a, ny('2026-10-19T06:04:59'), TZ), '2026-10-19@360', 'the relay was down at 6:00');
  assert.equal(dueKey(a, ny('2026-10-19T06:05:00'), TZ), null, 'too late: a 6 AM light doesn’t come on at noon');
  assert.equal(dueKey(a, ny('2026-10-20T06:00:00'), TZ), null, 'not on Tuesday');
  assert.equal(dueKey({ ...a, enabled: false }, ny('2026-10-19T06:00:00'), TZ), null, 'paused');
});

test('the repeat rule decides the days: every other week from its start, a monthly day, until its end, not before its start', () => {
  const fortnight = at('06:00', on('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO', '2026-10-12'));
  assert.equal(dueKey(fortnight, ny('2026-10-19T06:00:00'), TZ), null, 'the off week');
  assert.equal(dueKey(fortnight, ny('2026-10-26T06:00:00'), TZ), '2026-10-26@360');
  const firstMonday = at('06:00', on('FREQ=MONTHLY;BYDAY=1MO'));
  assert.equal(dueKey(firstMonday, ny('2026-10-05T06:00:00'), TZ), '2026-10-05@360');
  assert.equal(dueKey(firstMonday, ny('2026-10-12T06:00:00'), TZ), null);
  const ends = at('06:00', on('FREQ=DAILY;UNTIL=20261019'));
  assert.equal(dueKey(ends, ny('2026-10-19T06:00:00'), TZ), '2026-10-19@360', 'its last day');
  assert.equal(dueKey(ends, ny('2026-10-20T06:00:00'), TZ), null, 'past UNTIL');
  assert.equal(dueKey(at('06:00', on('FREQ=DAILY', '2026-10-20')), ny('2026-10-19T06:00:00'), TZ), null, 'not before its start');
  assert.equal(hasDaysLeft(ends, '2026-10-19'), true);
  assert.equal(hasDaysLeft(ends, '2026-10-20'), false);
});

test('next time: later today, else its next day; none when paused, on a change, by the sun, or ended', () => {
  const a = at('06:00', WEEKDAYS);
  assert.equal(nextTime(a, ny('2026-10-19T05:00:00'), TZ), '2026-10-19T10:00:00.000Z', 'Monday, later today');
  assert.equal(nextTime(a, ny('2026-10-19T06:00:00'), TZ), '2026-10-20T10:00:00.000Z', 'at 6:00 it’s running: next is Tuesday');
  assert.equal(nextTime(a, ny('2026-10-23T07:00:00'), TZ), '2026-10-26T10:00:00.000Z', 'Friday after: Monday');
  assert.equal(nextTime(a, new Date('2026-10-30T12:00:00Z'), TZ), '2026-11-02T11:00:00.000Z', '6:00 EST once DST ends');
  assert.equal(nextTime({ ...a, enabled: false }, ny('2026-10-19T05:00:00'), TZ), null);
  assert.equal(nextTime(at('06:00', { when: { sun: 'sunset', offset: 0 } }), ny('2026-10-19T05:00:00'), TZ), null);
  assert.equal(nextTime(at('06:00', on('FREQ=DAILY;UNTIL=20261019')), ny('2026-10-19T07:00:00'), TZ), null);
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

const leaves = (over = {}) => parseAutomation({ name: 'Luke leaves', when: { changes: 'person.luke_doty', to: 'not_home' }, repeat: DAILY, notify: { message: 'You left: check the garage.' }, ...over });

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
  assert.equal(describe(leaves({ when: { changes: 'person.luke_doty', to: 'home' }, ...WEEKDAYS, actions: [{ entity_id: 'light.porch', action: 'turn_on' }] }), name),
    'When Luke Doty comes home, every weekday: turn on Porch and text “You left: check the garage.”');
});

test('a change sets it off once, never from unavailable or unknown, only on its days', () => {
  const at = { entityId: 'person.luke_doty', now: new Date('2026-10-19T17:30:00Z'), timeZone: TZ }; // Monday 1:30 PM EDT
  assert.equal(changeKey(leaves(), { ...at, from: 'home', to: 'not_home' }), '2026-10-19@810');
  assert.equal(changeKey(leaves(), { ...at, from: 'not_home', to: 'home' }), null, 'the other way');
  assert.equal(changeKey(leaves(), { ...at, from: 'unknown', to: 'not_home' }), null, 'Home Assistant restarting isn’t leaving');
  assert.equal(changeKey(leaves(), { ...at, from: 'unavailable', to: 'not_home' }), null);
  assert.equal(changeKey(leaves(), { ...at, from: undefined, to: 'not_home' }), null);
  assert.equal(changeKey(leaves(), { ...at, entityId: 'person.amber', from: 'home', to: 'not_home' }), null);
  assert.equal(changeKey(leaves(on('FREQ=WEEKLY;BYDAY=SA')), { ...at, from: 'home', to: 'not_home' }), null);
  assert.equal(changeKey(leaves({ enabled: false }), { ...at, from: 'home', to: 'not_home' }), null);
  assert.equal(dueKey(leaves(), at.now, TZ), null, 'never on a clock');
  const ran = { type: 'ran', id: 'abcdefgh12', key: '2026-10-19@810', at: '2026-10-19T17:30:00Z', results: [], notify: true };
  assert.equal(parseRan(ran).notify, true);
  assert.throws(() => parseRan({ ...ran, notify: false }), 'nothing ran and nothing to send');
});
