// Scheduled asks: when they run, making one only after the person's own yes, and the runner: once,
// as its owner, read-only, by text or email, never late, never for someone who left Dot.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSchedule, describeSchedule, makeScheduleTool, makeSchedules, nextRun } from '../api/schedules.mjs';
import { createScheduleRunner, runText } from '../api/scheduled.mjs';
import { pendingIn, SCHEDULED_MARK } from '../api/confirm.mjs';
import { makeTools, WRITE_TOOLS } from '../api/tools.mjs';
import { runTurn, systemPrompt } from '../api/agent.mjs';
import { conversationIdFor } from '../api/email.mjs';
import { db, fakeCalendar, store, table } from './helpers/deps.mjs';
import { fakeClaude, text, toolUse } from './helpers/fake-claude.mjs';

const TZ = 'America/New_York';
const LUKE = 'luke-sub', AMBER = 'amber-sub';
let clock = new Date('2026-10-19T16:00:00Z'); // Monday, 12:00 PM EDT
const schedules = makeSchedules({ db, table: 'lukes-assistant', now: () => clock });
const SUNDAY = { title: 'Sunday budget', ask: 'Give me an overview of this month’s budget.', time: '13:00', repeat: 'FREQ=WEEKLY;BYDAY=SU' };
const clean = (over = {}) => cleanSchedule({ ...SUNDAY, ...over }, { tz: TZ, today: '2026-10-19' });

beforeEach(() => { table.clear(); clock = new Date('2026-10-19T16:00:00Z'); });

// ---- when ----

test('the next run: its day and local time, across daylight saving', () => {
  const s = { ...clean(), by: 'sms' };
  assert.deepEqual(nextRun(s, '2026-10-19T16:00:00Z'), { at: '2026-10-25T17:00:00.000Z', day: '2026-10-25' }, 'Sunday 1 PM EDT');
  assert.equal(nextRun(s, '2026-10-25T17:00:00.000Z').at, '2026-11-01T18:00:00.000Z', 'the next Sunday is after DST ends: 1 PM EST');
  const daily = { ...clean({ repeat: 'FREQ=DAILY', time: '07:00' }), by: 'sms' };
  assert.equal(nextRun(daily, '2026-10-19T10:59:00Z').at, '2026-10-19T11:00:00.000Z', 'later today');
  assert.equal(nextRun(daily, '2026-10-19T11:00:00.000Z').at, '2026-10-20T11:00:00.000Z', 'then tomorrow');
  const later = { ...clean({ start: '2026-11-03', repeat: 'FREQ=MONTHLY;BYMONTHDAY=1', time: '08:00' }), by: 'sms' };
  assert.equal(nextRun(later, '2026-10-19T16:00:00Z').at, '2026-12-01T13:00:00.000Z', 'not before its start');
  const ends = { ...clean({ repeat: 'FREQ=DAILY;UNTIL=20261020' }), by: 'sms' };
  assert.equal(nextRun(ends, '2026-10-20T18:00:00Z'), null, 'ended');
});

test('a schedule is checked: no faster than daily, a real time, sms or email', () => {
  assert.deepEqual(clean().repeat, { rule: 'FREQ=WEEKLY;BYDAY=SU', tz: TZ, start: '2026-10-19', n: 0 });
  for (const [over, why] of [
    [{ title: '' }, 'title'], [{ ask: 'x'.repeat(601) }, 'ask'], [{ time: '1pm' }, 'time'], [{ repeat: 'FREQ=HOURLY' }, 'FREQ'],
    [{ repeat: 'FREQ=DAILY;COUNT=3' }, 'UNTIL'], [{ start: 'tomorrow' }, 'start'], [{ by: 'fax' }, 'by'],
  ]) assert.throws(() => clean(over), new RegExp(why), JSON.stringify(over));
  assert.equal(describeSchedule({ ...clean(), by: 'email' }), 'Every Sunday at 1:00 PM, by email');
  assert.equal(describeSchedule({ ...clean({ repeat: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', time: '07:05' }), by: 'sms' }), 'Every weekday at 7:05 AM, by text');
});

// ---- making one, through Dot ----

const reach = { phone: '+18645550100', email: 'luke@x.test', member: true };

function talk(script, { channel = 'sms', contact = async () => reach } = {}) {
  const audits = [];
  const tool = makeScheduleTool({ schedules, userId: LUKE, channel, timeZone: TZ, contact, audit: async (e) => audits.push(e), now: () => clock });
  const claude = fakeClaude(script);
  const d = { client: claude.client, store, model: 'm', timeZone: TZ, tools: makeTools({ schedule: tool }), now: () => clock };
  let id;
  const say = async (words) => {
    const r = await runTurn({ ...d, userId: LUKE, conversationId: id, text: words, channel });
    id = r.conversationId;
    return r;
  };
  const results = () => claude.calls.flatMap((c) => c.params.messages.at(-1).content).filter((b) => b.type === 'tool_result');
  return { say, results, audits, tool };
}

test('making one: Dot asks, can’t approve itself, and saves what it asked about after the person’s yes', async () => {
  const c = talk([
    toolUse('schedule', { op: 'create', ...SUNDAY }, 't1'),
    toolUse('schedule', { op: 'create', confirm: true }, 't2'),
    text('Every Sunday at 1, a budget overview by text. Set it up?'),
    toolUse('schedule', { op: 'create', ...SUNDAY, time: '03:00', confirm: true }, 't3'),
    text('Done.'),
  ]);
  await c.say('text me a budget overview every Sunday at 1');
  const [asked, self] = c.results();
  assert.equal(JSON.parse(asked.content).ask_them, 'Every Sunday at 1:00 PM, by text: “Give me an overview of this month’s budget.” (first on Sunday, Oct 25, 1:00 PM). Set that up?');
  assert.deepEqual([self.is_error, self.content], [true, 'Wait for the person’s reply before confirming.']);
  assert.deepEqual(await schedules.list(LUKE), []);
  await c.say('yes');
  assert.match(c.results().at(-1).content, /^Set up: Every Sunday at 1:00 PM, by text\. Next: 2026-10-25T17:00:00\.000Z\.$/);
  const [s] = await schedules.list(LUKE);
  assert.deepEqual([s.time, s.by, s.createdVia], ['13:00', 'sms', 'sms'], 'the time it asked about, not the changed one');
  assert.deepEqual(table.dump().filter(([k]) => k.startsWith('SCHEDDUE|')).map(([, v]) => v.sk), [`2026-10-25T17:00:00.000Z#${LUKE}#${s.id}`], 'indexed for the runner');
  assert.deepEqual(c.audits.map((a) => a.outcome), ['asked', 'ok']);
});

test('by: how they’re talking now, if Dot can reach them that way', async () => {
  const email = talk([], { channel: 'email' });
  assert.match(JSON.parse(await email.tool({ op: 'create', ...SUNDAY })).ask_them, /by email/);
  const web = talk([], { channel: 'web' });
  assert.match(JSON.parse(await web.tool({ op: 'create', ...SUNDAY })).ask_them, /by text/);
  const noPhone = talk([], { contact: async () => ({ ...reach, phone: null }) });
  assert.match(JSON.parse(await noPhone.tool({ op: 'create', ...SUNDAY })).ask_them, /by email/);
  await assert.rejects(noPhone.tool({ op: 'create', ...SUNDAY, by: 'sms' }), /no verified phone/);
});

test('at most ten each; list and delete their own', async () => {
  for (let i = 0; i < 10; i++) await schedules.create(LUKE, { ...clean(), by: 'sms' }, { via: 'web' });
  await assert.rejects(schedules.create(LUKE, { ...clean(), by: 'sms' }, { via: 'web' }), /most scheduled asks one person can \(10\)/);
  await schedules.create(AMBER, { ...clean(), by: 'sms' }, { via: 'web' });
  const c = talk([]);
  const mine = JSON.parse(await c.tool({ op: 'list' }));
  assert.equal(mine.length, 10);
  assert.equal(await c.tool({ op: 'delete', id: mine[0].id }), 'Deleted: it won’t run again.');
  assert.equal((await schedules.list(LUKE)).length, 9);
  const [amber] = await schedules.list(AMBER);
  await assert.rejects(c.tool({ op: 'delete', id: amber.id }), /No scheduled ask/, 'not someone else’s');
  assert.equal(table.dump().filter(([k]) => k.startsWith('SCHEDDUE|')).length, 10, 'the deleted one’s index row went too');
});

test('a scheduled run’s own message never counts as the person’s reply', () => {
  const asked = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: JSON.stringify({ needs_confirmation: true, tool: 'house' }) }] };
  const run = { role: 'user', content: [{ type: 'text', text: '[Mon, Oct 19]' }, { type: 'text', text: `${SCHEDULED_MARK} “x”…]\n\nyes` }] };
  assert.equal(pendingIn([asked, run], 'house').answered, false);
  assert.equal(pendingIn([asked, run, { role: 'user', content: [{ type: 'text', text: 'yes' }] }], 'house').answered, true);
});

test('the prompt explains it, and a read-only toolset leaves out everything that changes things', () => {
  assert.match(systemPrompt({ schedule: true }), /Making one always asks them first/);
  const every = makeTools({ calendar: fakeCalendar(), calendarNames: ['luke'], house: {}, lists: {}, memory: {}, schedule: async () => '' });
  const reading = makeTools({ calendar: fakeCalendar(), calendarNames: ['luke'], house: {}, lists: {}, memory: {}, schedule: async () => '', readOnly: true });
  assert.ok(WRITE_TOOLS.every((n) => every.definitions.some((d) => d.name === n)), 'all of them exist');
  assert.deepEqual(reading.definitions.map((d) => d.name).sort(), ['list_calendars', 'list_events', 'recall']);
});

// ---- the runner ----

function runner(script, { contact = async () => reach } = {}) {
  const sent = { texts: [], emails: [] }, forUsers = [];
  const claude = fakeClaude(script);
  const run = createScheduleRunner({
    store, schedules, client: claude.client, model: 'm', timeZone: TZ, now: () => clock, address: 'dot@dot-y.co',
    people: { [LUKE]: { name: 'Luke' } },
    forUser: async (claims, channel, opts) => {
      forUsers.push({ claims, channel, opts });
      return { person: { name: 'Luke' }, tools: makeTools({ calendar: fakeCalendar(), calendarNames: ['luke'], house: {}, readOnly: opts.readOnly }) };
    },
    contact,
    text: async (to, body) => sent.texts.push({ to, body }),
    sendRaw: async (m) => sent.emails.push(m),
  });
  return { run, sent, forUsers, claude };
}
const at = (iso) => { clock = new Date(iso); };

test('at its time it runs once, as its owner, read-only, and texts the answer; then moves on a week', async () => {
  const s = await schedules.create(LUKE, { ...clean(), by: 'sms' }, { via: 'sms' });
  const r = runner([text('**This month:** groceries $410 of $600. See budget.dot-y.co for more.')]);
  at('2026-10-25T16:59:00Z');
  assert.deepEqual(await r.run(), [], 'not yet');
  at('2026-10-25T17:00:30Z');
  assert.deepEqual(await r.run(), [{ id: s.id, ok: true, error: undefined }]);
  assert.deepEqual(r.sent.texts, [{ to: reach.phone, body: 'Dot-y, Sunday budget: This month: groceries $410 of $600. See the family site for more.' }], 'plain, no links');
  assert.deepEqual([r.forUsers[0].claims.sub, r.forUsers[0].channel, r.forUsers[0].opts.readOnly], [LUKE, 'sms', true]);
  const sentToClaude = r.claude.calls[0].params;
  assert.ok(!sentToClaude.tools.some((t) => WRITE_TOOLS.includes(t.name)), 'no tool that changes anything');
  assert.ok(sentToClaude.messages[0].content.at(-1).text.startsWith(SCHEDULED_MARK));
  assert.match(sentToClaude.messages[0].content.at(-1).text, /Give me an overview of this month’s budget\.$/);
  // Once: a second runner in the same minute finds nothing
  assert.deepEqual(await r.run(), []);
  const [after] = await schedules.list(LUKE);
  assert.deepEqual([after.nextAt, after.lastRun.ok], ['2026-11-01T18:00:00.000Z', true]);
  // The run is the latest texting conversation, so a reply carries on from it
  const [conv] = (await store.listConversations(LUKE)).filter((x) => x.channel === 'sms');
  assert.deepEqual([conv.id, conv.title], [after.lastRun.conversationId, 'Sunday budget']);
});

test('by email: a new thread from Dot whose replies come back to the run’s conversation', async () => {
  await schedules.create(LUKE, { ...clean(), by: 'email' }, { via: 'email' });
  const r = runner([text('Groceries: $410 of $600.')]);
  at('2026-10-25T17:00:00Z');
  await r.run();
  const [m] = r.sent.emails;
  assert.equal(m.to, reach.email);
  const id = /Message-ID: (<[^>]+>)/.exec(m.raw)[1];
  assert.match(m.raw, /Subject: Sunday budget/);
  assert.match(m.raw, /Auto-Submitted: auto-generated/);
  const [s] = await schedules.list(LUKE);
  assert.equal(s.lastRun.conversationId, conversationIdFor(LUKE, id));
  assert.match(Buffer.from(m.raw.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString(), /Groceries: \$410 of \$600\.\n\n\(Your scheduled ask “Sunday budget”/);
});

test('not for someone who left Dot, not without a way to reach them, and never late', async () => {
  const s = await schedules.create(LUKE, { ...clean(), by: 'sms' }, { via: 'sms' });
  at('2026-10-25T17:00:00Z');
  let r = runner([], { contact: async () => ({ ...reach, member: false }) });
  assert.deepEqual(await r.run(), [{ id: s.id, ok: false, error: 'no longer uses Dot' }]);
  assert.deepEqual([r.sent.texts, r.claude.calls], [[], []]);
  at('2026-11-01T18:00:00Z');
  r = runner([], { contact: async () => ({ member: true, phone: null, email: null }) });
  assert.equal((await r.run())[0].error, 'no verified phone or email');
  // The runner was down for over an hour: recorded as missed, nothing sent, on to next week
  at('2026-11-08T19:30:00Z');
  r = runner([]);
  assert.equal((await r.run())[0].error, 'missed: the runner was down at that time');
  assert.deepEqual(r.sent.texts, []);
  assert.equal((await schedules.list(LUKE))[0].nextAt, '2026-11-15T18:00:00.000Z');
});

test('a failed turn says so briefly and is recorded; a deleted ask never runs', async () => {
  const s = await schedules.create(LUKE, { ...clean(), by: 'sms' }, { via: 'sms' });
  const gone = await schedules.create(LUKE, { ...clean({ title: 'Gone' }), by: 'sms' }, { via: 'sms' });
  await schedules.remove(LUKE, gone.id);
  at('2026-10-25T17:00:00Z');
  const r = runner([() => { throw new Error('Bedrock is down'); }]);
  assert.deepEqual((await r.run()).map((x) => [x.id, x.ok]), [[s.id, false]]);
  assert.deepEqual(r.sent.texts.map((t) => t.body), ['Dot-y, Sunday budget: Dot couldn’t do your scheduled “Sunday budget” this time. It will try again next time.']);
  assert.equal((await schedules.list(LUKE))[0].lastRun.error, 'Bedrock is down');
});

test('the run’s text says it’s scheduled and read-only', () => {
  const t = runText({ title: 'Sunday budget', ask: 'Overview, please.', createdAt: '2026-10-19T16:00:00Z' }, 'Luke');
  assert.ok(t.startsWith(`${SCHEDULED_MARK} “Sunday budget”, which Luke set up on Oct 19, 2026.`));
  assert.match(t, /You can only read now/);
  assert.ok(t.endsWith('Overview, please.'));
});

test('the runner’s index stays exact: one row per ask, and an out-of-date row never runs anything', async () => {
  const s = await schedules.create(LUKE, { ...clean(), by: 'sms' }, { via: 'sms' });
  const due = () => table.dump().filter(([k]) => k.startsWith('SCHEDDUE|')).map(([, v]) => v.sk);
  // A row left from an earlier time (say the ask was moved): dropped, nothing sent
  table.put({ pk: 'SCHEDDUE', sk: `2026-10-20T17:00:00.000Z#${LUKE}#${s.id}`, sub: LUKE, id: s.id });
  at('2026-10-20T17:00:00Z');
  let r = runner([]);
  assert.deepEqual(await r.run(), []);
  assert.deepEqual(r.sent.texts, []);
  assert.deepEqual(due(), [`2026-10-25T17:00:00.000Z#${LUKE}#${s.id}`]);
  at('2026-10-25T17:00:00Z');
  r = runner([text('Groceries: $410 of $600.')]);
  await r.run();
  assert.deepEqual(due(), [`2026-11-01T18:00:00.000Z#${LUKE}#${s.id}`], 'the run’s row is gone, the next one is there');
});
