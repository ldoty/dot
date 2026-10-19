// Dot's calendar tools against the Calendars tool's real API (tools/calendars), with its fake Google.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AMBER, LUKE, call, dotToken, google, seed } from '../../calendars/tests/helpers/calendars.mjs';
import { makeCalendars } from '../api/calendars.mjs';
import { makeTools } from '../api/tools.mjs';
import { runTurn } from '../api/agent.mjs';
import { fakeClaude, text, toolUse } from './helpers/fake-claude.mjs';

const API = 'https://cal.test';
function dotFor(sub) {
  const audits = [];
  const fetch = async (url, o = {}) => {
    const r = await call(o.method || 'GET', url.slice(API.length), o.body ? JSON.parse(o.body) : undefined, o.headers.authorization.slice(7));
    return { ok: r.status < 300, status: r.status, json: async () => r.body };
  };
  const calendar = makeCalendars({ apiUrl: API, clientId: 'cal-via-dot', user: { sub, username: sub }, channel: 'sms', fetch, tokenFor: async () => dotToken(sub), audit: async (e) => { audits.push(e); } });
  return { calendar, audits };
}
async function toolsFor(sub) {
  const { calendar, audits } = dotFor(sub);
  const mine = await calendar.listCalendars();
  return { tools: makeTools({ calendar, calendarNames: mine.map((c) => c.calendar), readOnlyCalendars: mine.filter((c) => c.read_only).map((c) => c.calendar) }), audits };
}
beforeEach(seed);

test('Dot offers changes only on calendars the person may edit', async () => {
  const luke = (await toolsFor(LUKE)).tools.definitions.find((d) => d.name === 'create_event');
  assert.deepEqual(luke.input_schema.properties.calendar.enum.sort(), ['kids', 'luke']);
  const amber = (await toolsFor(AMBER)).tools.definitions;
  assert.equal(amber.find((d) => d.name === 'create_event'), undefined, 'Amber may edit nothing Google lets Dot write');
  assert.deepEqual(amber.find((d) => d.name === 'list_events').input_schema.properties.calendar.enum.sort(), ['amber', 'kids', 'luke']);
});

test('create, read and update through Calendars, audited', async () => {
  const { calendar, audits } = dotFor(LUKE);
  const made = await calendar.createEvent({ calendar: 'kids', title: 'Soccer', start: '2026-10-21T18:00', end: '2026-10-21T19:00' });
  assert.equal(made.title, 'Soccer');
  const listed = await calendar.listEvents({ calendar: 'kids', start: '2026-10-19', end: '2026-10-26' });
  assert.deepEqual(listed.map((e) => e.title), ['Soccer']);
  await calendar.updateEvent({ calendar: 'kids', event_id: made.id, title: 'Soccer (away)' });
  assert.equal(google.events['kids@group.calendar.google.com'][0].summary, 'Soccer (away)');
  assert.deepEqual(audits.map((a) => [a.tool, a.outcome]), [['family_calendars', 'ok'], ['family_calendars', 'ok']]);
  await assert.rejects(dotFor(AMBER).calendar.createEvent({ calendar: 'kids', title: 'x', start: '2026-10-21' }), /read-only for you/);
});

test('deleting an event: Dot asks, can’t approve itself, and deletes after the person’s yes', async () => {
  const { calendar } = dotFor(LUKE);
  const made = await calendar.createEvent({ calendar: 'kids', title: 'Old practice', start: '2026-10-22T18:00', end: '2026-10-22T19:00' });
  const claude = fakeClaude([
    toolUse('delete_event', { calendar: 'kids', event_id: made.id }, 't1'),
    toolUse('delete_event', { calendar: 'kids', event_id: made.id, confirm: true }, 't2'),
    text('Delete “Old practice” on Thursday?'),
    toolUse('delete_event', { calendar: 'kids', event_id: made.id, confirm: true }, 't3'),
    text('Deleted.'),
  ]);
  const convs = new Map();
  const store = {
    async getConversation(u, id) { return convs.get(id)?.conv ?? null; },
    async createConversation(u, { id, title, channel }) { const conv = { id, title, channel }; convs.set(id, { conv, msgs: [] }); return conv; },
    async loadMessages(u, id) { return structuredClone(convs.get(id).msgs); },
    async appendMessage(u, id, i, m) { convs.get(id).msgs.push(structuredClone(m)); },
  };
  const { tools } = await toolsFor(LUKE);
  let id;
  const say = async (words) => { id = (await runTurn({ client: claude.client, store, model: 'm', timeZone: 'America/New_York', tools, userId: LUKE, conversationId: id, text: words, channel: 'sms' })).conversationId; };
  const results = () => claude.calls.flatMap((c) => c.params.messages.at(-1).content).filter((b) => b.type === 'tool_result');
  await say('delete the old practice on the kids calendar');
  assert.match(results()[0].content, /needs_confirmation/);
  assert.equal(results()[1].content, 'Wait for the person’s reply before confirming.');
  assert.equal(google.events['kids@group.calendar.google.com'].length, 1);
  await say('yes');
  assert.equal(google.events['kids@group.calendar.google.com'].length, 0);
});
