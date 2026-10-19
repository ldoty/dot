import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advance, describe, nextAfter, parseRule, rollAt, zonedToIso } from '../api/repeat.mjs';

const NY = 'America/New_York';
const series = (rule, start, from, k = 6) => {
  const out = [];
  let d = from, n = 0;
  while (out.length < k) { d = nextAfter({ rule, start, n }, d); if (!d) break; out.push(d); n++; }
  return out;
};

test('every month on the 1st', () => {
  assert.deepEqual(series('FREQ=MONTHLY;BYMONTHDAY=1', '2026-11-01', '2026-11-01', 3), ['2026-12-01', '2027-01-01', '2027-02-01']);
});

test('every week, and every other Tuesday (from the first one)', () => {
  assert.deepEqual(series('FREQ=WEEKLY', '2026-10-20', '2026-10-20', 2), ['2026-10-27', '2026-11-03']);
  assert.deepEqual(series('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU', '2026-10-20', '2026-10-20', 3), ['2026-11-03', '2026-11-17', '2026-12-01']);
  // asked on a Wednesday of an "off" week, the next is still on the series’ own weeks
  assert.equal(nextAfter({ rule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU', start: '2026-10-20' }, '2026-10-28'), '2026-11-03');
});

test('weekdays, and Monday and Thursday', () => {
  assert.deepEqual(series('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', '2026-10-23', '2026-10-23', 3), ['2026-10-26', '2026-10-27', '2026-10-28']);
  assert.deepEqual(series('FREQ=WEEKLY;BYDAY=MO,TH', '2026-10-19', '2026-10-19', 3), ['2026-10-22', '2026-10-26', '2026-10-29']);
});

test('every third month, keeping the date', () => {
  assert.deepEqual(series('FREQ=MONTHLY;INTERVAL=3', '2026-10-15', '2026-10-15', 3), ['2027-01-15', '2027-04-15', '2027-07-15']);
});

test('the 31st falls on the last day of shorter months; -1 is always the last day', () => {
  assert.deepEqual(series('FREQ=MONTHLY;BYMONTHDAY=31', '2027-01-31', '2027-01-31', 3), ['2027-02-28', '2027-03-31', '2027-04-30']);
  assert.deepEqual(series('FREQ=MONTHLY;BYMONTHDAY=-1', '2028-01-31', '2028-01-31', 2), ['2028-02-29', '2028-03-31']);
});

test('the 2nd Tuesday, and the last Friday', () => {
  assert.deepEqual(series('FREQ=MONTHLY;BYDAY=2TU', '2026-10-13', '2026-10-13', 3), ['2026-11-10', '2026-12-08', '2027-01-12']);
  assert.deepEqual(series('FREQ=MONTHLY;BYDAY=-1FR', '2026-10-30', '2026-10-30', 3), ['2026-11-27', '2026-12-25', '2027-01-29']);
});

test('yearly, and Feb 29 in other years', () => {
  assert.deepEqual(series('FREQ=YEARLY', '2026-04-15', '2026-04-15', 2), ['2027-04-15', '2028-04-15']);
  assert.deepEqual(series('FREQ=YEARLY', '2028-02-29', '2028-02-29', 2), ['2029-02-28', '2030-02-28']);
});

test('UNTIL and COUNT end the series', () => {
  assert.deepEqual(series('FREQ=WEEKLY;UNTIL=20261110', '2026-10-20', '2026-10-20'), ['2026-10-27', '2026-11-03', '2026-11-10']);
  assert.deepEqual(series('FREQ=DAILY;COUNT=3', '2026-10-20', '2026-10-20'), ['2026-10-21', '2026-10-22'], 'the start was the first of three');
});

test('rules outside the supported part are refused', () => {
  for (const bad of ['FREQ=HOURLY', 'FREQ=WEEKLY;BYDAY=2TU', 'FREQ=MONTHLY;BYDAY=TU', 'FREQ=MONTHLY;BYMONTHDAY=0', 'FREQ=DAILY;BYDAY=MO',
    'FREQ=WEEKLY;INTERVAL=0', 'FREQ=WEEKLY;BYSETPOS=1', 'FREQ=WEEKLY;UNTIL=20261110;COUNT=3', 'FREQ=MONTHLY;BYMONTHDAY=1;BYDAY=1MO']) {
    assert.throws(() => parseRule(bad), /repeat/, bad);
  }
});

test('in words', () => {
  assert.equal(describe('FREQ=MONTHLY;BYMONTHDAY=1'), 'every month on the 1st');
  assert.equal(describe('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU'), 'every other Tuesday');
  assert.equal(describe('FREQ=WEEKLY;INTERVAL=3;BYDAY=MO,TH'), 'every 3 weeks on Monday, Thursday');
  assert.equal(describe('FREQ=WEEKLY;BYDAY=TU'), 'every Tuesday');
  assert.equal(describe('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'), 'every weekday');
  assert.equal(describe('FREQ=MONTHLY;INTERVAL=3'), 'every 3 months');
  assert.equal(describe('FREQ=MONTHLY;BYDAY=-1FR'), 'every month on the last Friday');
  assert.equal(describe('FREQ=MONTHLY;BYMONTHDAY=22'), 'every month on the 22nd');
  assert.equal(describe('FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=6'), 'every month on the last day, 6 times');
});

test('advancing keeps 9 AM local across daylight saving, and resets the reminder', () => {
  const item = { text: 'Pills', due: null, remind: { at: zonedToIso('2026-10-30', '09:00', NY), channel: null, sentAt: '2026-10-30T13:00:30Z' }, repeat: { rule: 'FREQ=WEEKLY', mode: 'when_done', tz: NY, start: '2026-10-30', n: 0 } };
  assert.equal(item.remind.at, '2026-10-30T13:00:00.000Z');
  const next = advance(item, { at: '2026-10-30T15:00:00Z' });
  assert.deepEqual([next.remind.at, next.remind.sentAt, next.done, next.repeat.n, next.repeat.lastDoneAt], ['2026-11-06T14:00:00.000Z', null, false, 1, '2026-10-30T15:00:00Z']);
});

test('advancing moves the due date; the end of a series is just done', () => {
  const item = { text: 'Rent', due: '2026-11-01', remind: null, repeat: { rule: 'FREQ=MONTHLY;BYMONTHDAY=1;COUNT=2', mode: 'when_done', tz: NY, start: '2026-11-01', n: 0 } };
  const a = advance(item, { at: 'x' });
  assert.deepEqual([a.due, a.done], ['2026-12-01', false]);
  const b = advance(a, { at: 'y' });
  assert.deepEqual([b.due, b.done, b.repeat.ended], ['2026-12-01', true, true]);
});

test('schedule mode rolls on once reminded; when_done mode waits', () => {
  const base = { text: 'Bins', remind: { at: '2026-10-20T23:00:00.000Z', channel: null, sentAt: '2026-10-20T23:00:20Z' } };
  assert.equal(rollAt({ ...base, repeat: { rule: 'FREQ=WEEKLY', mode: 'schedule', tz: NY, start: '2026-10-20', n: 0 } }), '2026-10-27T23:00:00.000Z');
  assert.equal(rollAt({ ...base, repeat: { rule: 'FREQ=WEEKLY', mode: 'when_done', tz: NY, start: '2026-10-20', n: 0 } }), null);
  assert.equal(rollAt({ ...base, remind: { ...base.remind, sentAt: null }, repeat: { rule: 'FREQ=WEEKLY', mode: 'schedule', tz: NY, start: '2026-10-20', n: 0 } }), null, 'not before it’s been sent');
});

test('local times right after the clocks change land correctly', () => {
  // Clocks jump from 2:00 to 3:00 on Mar 8, 2026: 3:30 that morning is EDT, 07:30 UTC
  assert.equal(zonedToIso('2026-03-08', '03:30', NY), '2026-03-08T07:30:00.000Z');
  assert.equal(zonedToIso('2026-11-01', '09:00', NY), '2026-11-01T14:00:00.000Z');
});
