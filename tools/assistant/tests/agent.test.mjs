import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { runTurn, stamp, toTranscript, SYSTEM_PROMPT } from '../api/agent.mjs';
import { deps, NOW, store, table } from './helpers/deps.mjs';
import { text, toolUse } from './helpers/fake-claude.mjs';

const USER = 'luke-sub';
beforeEach(() => table.clear());
const run = (d, t, extra = {}) => {
  const events = [];
  return runTurn({ ...d, userId: USER, text: t, onEvent: (e) => events.push(e), ...extra }).then((r) => ({ ...r, events }));
};

test('a plain question: new conversation, streamed reply, history saved', async () => {
  const { deps: d, claude } = deps([text('You have nothing on Saturday.')]);
  const r = await run(d, 'Anything Saturday?');
  assert.equal(r.text, 'You have nothing on Saturday.');
  assert.equal(r.events[0].type, 'conversation');
  assert.equal(r.events.filter((e) => e.type === 'text').map((e) => e.delta).join(''), 'You have nothing on Saturday.');
  const msgs = await store.loadMessages(USER, r.conversationId);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant']);
  assert.deepEqual(msgs[0].content.map((b) => b.text), ['[Fri, Oct 2, 2026, 4:45 PM EDT]', 'Anything Saturday?']);
  assert.equal((await store.getConversation(USER, r.conversationId)).title, 'Anything Saturday?');
  const req = claude.calls[0].params;
  assert.equal(req.model, 'us.anthropic.claude-opus-4-6-v1');
  assert.deepEqual(req.output_config, { effort: 'low' });
  assert.equal(req.system[0].text, SYSTEM_PROMPT);
  assert.deepEqual(req.system[0].cache_control, { type: 'ephemeral' });
});

test('cache breakpoint goes on the request copy only; stored history stays unmarked', async () => {
  const { deps: d, claude } = deps([text('Hi'), text('Sure')]);
  const first = await run(d, 'Hello');
  await run(d, 'And again', { conversationId: first.conversationId });
  const req = claude.calls[1].params;
  assert.deepEqual(req.messages.at(-1).content.at(-1).cache_control, { type: 'ephemeral' });
  assert.equal(req.messages.slice(0, -1).flatMap((m) => m.content).filter((b) => b.cache_control).length, 0);
  const stored = await store.loadMessages(USER, first.conversationId);
  assert.equal(stored.flatMap((m) => m.content).filter((b) => b.cache_control).length, 0);
});

test('history is append-only: each request extends the previous one unchanged', async () => {
  const { deps: d, claude } = deps([text('One'), text('Two')]);
  const first = await run(d, 'First');
  await run(d, 'Second', { conversationId: first.conversationId });
  const strip = (msgs) => JSON.stringify(msgs.map((m) => ({ ...m, content: m.content.map(({ cache_control: _c, ...b }) => b) })));
  const a = JSON.parse(strip(claude.calls[0].params.messages)), b = JSON.parse(strip(claude.calls[1].params.messages));
  assert.deepEqual(b.slice(0, a.length), a, 'second request starts with the first request’s messages');
  assert.deepEqual(b.map((m) => m.role), ['user', 'assistant', 'user']);
});

test('a tool call runs the tool, sends the result back, and reports progress', async () => {
  const thinking = { type: 'thinking', thinking: '', signature: 'sig' };
  const { deps: d, claude, calendar } = deps([
    toolUse('create_event', { calendar: 'shared', title: 'Dentist', start: '2026-10-05T14:00', end: '2026-10-05T15:00' }, 'tu1', [thinking]),
    text('Added Dentist to the shared calendar, Mon Oct 5, 2–3 PM.'),
  ]);
  const r = await run(d, 'Dentist Monday at 2 on the family calendar');
  assert.deepEqual(calendar.calls, [{ name: 'createEvent', input: { calendar: 'shared', title: 'Dentist', start: '2026-10-05T14:00', end: '2026-10-05T15:00' } }]);
  assert.deepEqual(r.events.filter((e) => e.type === 'tool'), [
    { type: 'tool', name: 'create_event', status: 'running' }, { type: 'tool', name: 'create_event', status: 'done' }]);
  const msgs = await store.loadMessages(USER, r.conversationId);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.deepEqual(msgs[1].content[0], thinking, 'thinking blocks are kept exactly as returned');
  assert.equal(msgs[2].content[0].type, 'tool_result');
  assert.equal(msgs[2].content[0].tool_use_id, 'tu1');
  assert.equal(JSON.parse(msgs[2].content[0].content).title, 'Dentist');
  assert.equal(claude.calls[1].params.messages.length, 3);
});

test('bad tool input never reaches the calendar; Claude gets an error result', async () => {
  const { deps: d, calendar } = deps([
    toolUse('create_event', { calendar: 'work', title: 'X', start: '2026-10-05' }, 'tu1'),
    text('Which calendar?'),
  ]);
  const r = await run(d, 'Add X');
  assert.equal(calendar.calls.length, 0);
  const result = (await store.loadMessages(USER, r.conversationId))[2].content[0];
  assert.equal(result.is_error, true);
  assert.match(result.content, /must be one of luke, shared/);
});

test('a refusal ends the turn with an error event and keeps history valid', async () => {
  const { deps: d } = deps([{ content: [], stop_reason: 'refusal' }]);
  const r = await run(d, 'something declined');
  assert.ok(r.events.some((e) => e.type === 'error'));
  assert.deepEqual((await store.loadMessages(USER, r.conversationId)).map((m) => m.role), ['user', 'assistant']);
});

test('a tool call cut off by max_tokens is answered with an error, not run', async () => {
  const { deps: d, calendar } = deps([{ ...toolUse('delete_event', { calendar: 'luke', event_id: 'e1' }), stop_reason: 'max_tokens' }]);
  const r = await run(d, 'delete it');
  assert.equal(calendar.calls.length, 0);
  const msgs = await store.loadMessages(USER, r.conversationId);
  assert.equal(msgs.at(-1).content[0].is_error, true);
});

test('an unknown conversation id is a 404', async () => {
  const { deps: d } = deps([]);
  await assert.rejects(run(d, 'hi', { conversationId: 'nope' }), (e) => e.status === 404);
});

test('the fallback state is passed on every request', async () => {
  const { deps: d, claude } = deps([toolUse('list_calendars', {}), text('ok')]);
  const fallbackState = { marker: true };
  await run(d, 'calendars?', { fallbackState });
  assert.ok(claude.calls.every((c) => c.options.fallbackState === fallbackState));
});

test('stamp uses the configured time zone', () => {
  assert.equal(stamp(NOW, 'America/New_York'), '[Fri, Oct 2, 2026, 4:45 PM EDT]');
  assert.equal(stamp(new Date('2026-12-01T17:00:00Z'), 'America/New_York'), '[Tue, Dec 1, 2026, 12:00 PM EST]');
});

test('transcript shows your text (not the time stamp), replies, and tools used', () => {
  const t = toTranscript([
    { role: 'user', content: [{ type: 'text', text: '[stamp]' }, { type: 'text', text: 'Add dentist' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: '' }, { type: 'tool_use', id: 'a', name: 'create_event', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: '{}' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
  ]);
  assert.deepEqual(t, [{ role: 'user', text: 'Add dentist' }, { role: 'assistant', text: 'Done.', tools: ['create_event'] }]);
});
