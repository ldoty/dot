// Dot's lists_change against Lists' real API and sweep (tools/lists), on Lists' fake table.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AMBER, LUKE, call, clock, dotToken, newList, outbox, reset, sweep, table, token } from '../../lists/tests/helpers/lists.mjs';
import { makeLists, zonedToIso } from '../api/lists.mjs';
import { makeTools } from '../api/tools.mjs';
import { runTurn, systemPrompt } from '../api/agent.mjs';
import { asking } from '../api/confirm.mjs';
import { fakeClaude, text, toolUse } from './helpers/fake-claude.mjs';

const API = 'https://lists.test';
function dotFor(sub) {
  const audits = [];
  const fetch = async (url, o = {}) => {
    const r = await call(o.method || 'GET', url.slice(API.length), o.body ? JSON.parse(o.body) : undefined, o.headers.authorization.slice(7));
    return { status: r.status, json: async () => r.body };
  };
  const lists = makeLists({ apiUrl: API, clientId: 'lists-via-dot', user: { sub, username: sub }, channel: 'sms', fetch, tokenFor: async () => dotToken(sub), audit: async (e) => { audits.push(e); } });
  return { lists, audits };
}
const items = (listId) => table.dump().filter(([k]) => k.startsWith(`ITEMS#${listId}|`)).map(([, v]) => v);
beforeEach(reset);

test('local reminder times become UTC, across daylight saving', () => {
  assert.equal(zonedToIso('2026-10-20T09:00', 'America/New_York'), '2026-10-20T13:00:00.000Z');
  assert.equal(zonedToIso('2026-12-20T09:00', 'America/New_York'), '2026-12-20T14:00:00.000Z');
  assert.equal(zonedToIso('2026-11-01T09:00', 'America/New_York'), '2026-11-01T14:00:00.000Z', 'the morning DST ends');
  assert.equal(zonedToIso('2026-03-08T03:30', 'America/New_York'), '2026-03-08T07:30:00.000Z', 'just after the clocks spring forward');
  assert.throws(() => zonedToIso('tomorrow 9am', 'America/New_York'), /YYYY-MM-DDTHH:MM/);
});

test('add an item with a reminder; the sweep texts it; “done” ticks it off', async () => {
  const l = await newList('Errands');
  const { lists, audits } = dotFor(LUKE);
  assert.equal(await lists.change({ action: 'add_item', list_id: l.id, text: 'Call the dentist', remind_at: '2026-10-20T09:00' }), `Added “Call the dentist” to Errands, with a reminder at 2026-10-20T13:00:00.000Z.`);
  clock.now = new Date('2026-10-20T13:00:30Z');
  await sweep();
  assert.match(outbox.texts[0].body, /^Dot-y reminder: Call the dentist \(Errands\)/);
  const [sent] = (await call('GET', '/reminders/recent', undefined, dotToken())).body;
  assert.equal(await lists.change({ action: 'complete_item', list_id: sent.listId, item_id: sent.itemId }), 'Ticked off “Call the dentist” on Errands.');
  assert.equal(items(l.id)[0].done, true);
  assert.deepEqual(audits.map((a) => a.outcome), ['ok', 'ok']);
});

test('update changes only what’s given; snoozing moves the reminder', async () => {
  const l = await newList('Work', LUKE, { layout: 'matrix' });
  await call('PUT', `/lists/${l.id}/items/i00001`, { text: 'Taxes', urgent: true, important: true, notes: 'Form 1040', order: 3 });
  const { lists } = dotFor(LUKE);
  await lists.change({ action: 'update_item', list_id: l.id, item_id: 'i00001', remind_at: '2026-10-19T11:00' });
  let [i] = items(l.id);
  assert.deepEqual([i.text, i.urgent, i.important, i.notes, i.order, i.remind.at], ['Taxes', true, true, 'Form 1040', 3, '2026-10-19T15:00:00.000Z']);
  await lists.change({ action: 'update_item', list_id: l.id, item_id: 'i00001', remind_at: '2026-10-19T12:00' }); // "snooze an hour"
  [i] = items(l.id);
  assert.equal(i.remind.at, '2026-10-19T16:00:00.000Z');
  assert.deepEqual(table.dump().filter(([k]) => k.startsWith('REMIND#')).map(([, v]) => v.sk.split('#')[0]), ['2026-10-19T16:00:00.000Z'], 'one reminder, at the new time');
  await lists.change({ action: 'update_item', list_id: l.id, item_id: 'i00001', remind_at: '' });
  assert.equal(items(l.id)[0].remind, null);
});

test('only lists the person can edit', async () => {
  const l = await newList('Plans');
  await call('PUT', `/lists/${l.id}`, { name: 'Plans', layout: 'checklist', columns: l.columns, share: [{ who: `sub:${AMBER}`, level: 'read' }], rev: 1 });
  const amber = dotFor(AMBER).lists;
  await assert.rejects(amber.change({ action: 'add_item', list_id: l.id, text: 'Paint' }), /Lists answered 403/);
  const other = await newList('Luke only');
  await assert.rejects(amber.change({ action: 'add_item', list_id: other.id, text: 'x' }), /isn’t there, or isn’t shared/);
});

test('start, rename and re-lay-out a list, keeping who it’s shared with', async () => {
  const { lists } = dotFor(LUKE);
  const said = await lists.change({ action: 'create_list', name: 'Camping' });
  const id = /\(([a-z0-9]+)\)/.exec(said)[1];
  await call('PUT', `/lists/${id}`, { name: 'Camping', layout: 'checklist', columns: ['To do', 'Doing', 'Done'], share: [{ who: `sub:${AMBER}`, level: 'edit' }], rev: 1 });
  await lists.change({ action: 'rename_list', list_id: id, name: 'Camping trip' });
  await lists.change({ action: 'set_layout', list_id: id, layout: 'board' });
  const l = table.get('LIST', id);
  assert.deepEqual([l.name, l.layout, l.share], ['Camping trip', 'board', [{ who: `sub:${AMBER}`, level: 'edit' }]]);
});

// ---- deleting a list, across real turns ----

function conversation(sub, script) {
  const { lists } = dotFor(sub);
  const claude = fakeClaude(script);
  const convs = new Map();
  const store = {
    async getConversation(u, id) { return convs.get(id)?.conv ?? null; },
    async createConversation(u, { id, title, channel }) { const conv = { id, title, channel }; convs.set(id, { conv, msgs: [] }); return conv; },
    async loadMessages(u, id) { return structuredClone(convs.get(id).msgs); },
    async appendMessage(u, id, i, m) { convs.get(id).msgs.push(structuredClone(m)); },
  };
  let id;
  const say = async (words) => {
    const r = await runTurn({ client: claude.client, store, model: 'm', timeZone: 'America/New_York', tools: makeTools({ lists }), userId: sub, conversationId: id, text: words, channel: 'sms' });
    id = r.conversationId;
  };
  const results = () => claude.calls.flatMap((c) => c.params.messages.at(-1).content).filter((b) => b.type === 'tool_result');
  return { say, results, claude };
}

test('deleting a list: Dot asks, can’t approve itself, and deletes after the person’s yes', async () => {
  const l = await newList('Old stuff');
  const c = conversation(LUKE, [
    toolUse('lists_change', { action: 'delete_list', list_id: l.id }, 't1'),
    toolUse('lists_change', { action: 'delete_list', list_id: l.id, confirm: true }, 't2'),
    text('Delete the list “Old stuff” and everything on it?'),
    toolUse('lists_change', { action: 'delete_list', list_id: l.id, confirm: true }, 't3'),
    text('Deleted.'),
  ]);
  await c.say('delete my old stuff list');
  const [ask, self] = c.results();
  assert.match(ask.content, /Delete the list “Old stuff”/);
  assert.equal(self.content, 'Wait for the person’s reply before confirming.');
  assert.ok(table.get('LIST', l.id));
  await c.say('yes');
  assert.equal(c.results().at(-1).content, 'Deleted the list.');
  assert.equal(table.get('LIST', l.id), undefined);
  assert.match(c.claude.calls[0].params.system[0].text, /Deleting a whole list asks them first/);
});

test('a confirmation for something else (the house) never approves deleting a list', async () => {
  const l = await newList('Keep me');
  const { lists } = dotFor(LUKE);
  const history = [
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: asking('house', { ask_them: 'Open the garage?', confirm_id: 'a'.repeat(24), list_id: l.id }) }] },
    { role: 'user', content: [{ type: 'text', text: 'yes' }] },
  ];
  await assert.rejects(lists.change({ action: 'delete_list', list_id: l.id, confirm: true }, { history }), /Nothing like that is waiting/);
  assert.ok(table.get('LIST', l.id));
});

test('lists_change is offered only to people who can use Lists, and the prompt explains it', () => {
  const { lists } = dotFor(LUKE);
  assert.ok(makeTools({ lists }).definitions.some((d) => d.name === 'lists_change'));
  assert.ok(!makeTools({}).definitions.some((d) => d.name === 'lists_change'));
  assert.match(systemPrompt({ lists: true }), /remind_at on an item in their local time/);
  assert.equal(token(LUKE).length > 0, true);
});

test('a reminder with no list goes on the person’s own Reminders list, started once', async () => {
  const groceries = await newList('Groceries');
  const { lists } = dotFor(LUKE);
  await lists.change({ action: 'add_item', text: 'Move the car', remind_at: '2026-10-19T17:00' });
  await lists.change({ action: 'add_item', text: 'Water the plants', remind_at: '2026-10-19T18:00' });
  const mine = (await call('GET', '/lists')).body;
  assert.deepEqual(mine.map((l) => [l.name, l.total]), [['Groceries', 0], ['Reminders', 2]], 'one Reminders list, reused');
  const r = mine.find((l) => l.name === 'Reminders');
  assert.equal(table.get('LIST', r.id).share.length, 0, 'private');
  await call('PUT', `/lists/${groceries.id}`, { name: 'Groceries', layout: 'checklist', columns: groceries.columns, share: [{ who: `sub:${AMBER}`, level: 'edit' }], rev: 1 });
  await dotFor(AMBER).lists.change({ action: 'add_item', text: 'Call mom', remind_at: '2026-10-19T19:00' });
  const amberLists = (await call('GET', '/lists', undefined, token(AMBER))).body.map((l) => l.name);
  assert.deepEqual(amberLists, ['Groceries', 'Reminders'], 'Amber gets her own, not Luke’s');
  assert.match(systemPrompt({ lists: true }), /leave out list_id and it goes on their own Reminders list/);
});

test('a Reminders list someone shared with you isn’t yours: Dot starts your own', async () => {
  const { lists } = dotFor(LUKE);
  await lists.change({ action: 'add_item', text: 'Move the car', remind_at: '2026-10-19T17:00' });
  const lukes = (await call('GET', '/lists')).body.find((l) => l.name === 'Reminders');
  const row = table.get('LIST', lukes.id);
  await call('PUT', `/lists/${lukes.id}`, { name: 'Reminders', layout: 'checklist', columns: row.columns, share: [{ who: `sub:${AMBER}`, level: 'edit' }], rev: row.rev });
  await dotFor(AMBER).lists.change({ action: 'add_item', text: 'Call mom', remind_at: '2026-10-19T19:00' });
  assert.equal((await call('GET', `/lists/${lukes.id}`)).body.items.length, 1, 'nothing of Amber’s on Luke’s');
  const theirs = (await call('GET', '/lists', undefined, token(AMBER))).body.filter((l) => l.name === 'Reminders');
  assert.deepEqual(theirs.map((l) => l.owner).sort(), [AMBER, LUKE].sort());
});

test('Dot sets a repeat; ticking it off moves it on and says when next', async () => {
  const l = await newList('Bills');
  const { lists } = dotFor(LUKE);
  const said = await lists.change({ action: 'add_item', list_id: l.id, text: 'Rent', due: '2026-11-01', repeat: 'FREQ=MONTHLY;BYMONTHDAY=1' });
  assert.match(said, /repeating every month on the 1st/);
  const [i] = items(l.id);
  assert.deepEqual([i.repeat.mode, i.repeat.tz, i.repeat.start], ['when_done', 'America/New_York', '2026-11-01']);
  assert.equal(await lists.change({ action: 'complete_item', list_id: l.id, item_id: i.sk }), 'Ticked off “Rent” on Bills. It repeats every month on the 1st; the next one is 2026-12-01.');
  await lists.change({ action: 'update_item', list_id: l.id, item_id: i.sk, notes: 'Autopay?' });
  assert.equal(items(l.id)[0].repeat.rule, 'FREQ=MONTHLY;BYMONTHDAY=1', 'other changes keep the repeat');
  await lists.change({ action: 'update_item', list_id: l.id, item_id: i.sk, repeat: '' });
  assert.equal(items(l.id)[0].repeat, null);
});

test('Dot: every other Tuesday at 7 PM, reminding every time', async () => {
  const l = await newList('House');
  const { lists } = dotFor(LUKE);
  await lists.change({ action: 'add_item', list_id: l.id, text: 'Recycling out', remind_at: '2026-10-20T19:00', repeat: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU', repeat_mode: 'schedule' });
  const [i] = items(l.id);
  assert.deepEqual([i.remind.at, i.repeat.mode], ['2026-10-20T23:00:00.000Z', 'schedule']);
  await assert.rejects(lists.change({ action: 'add_item', list_id: l.id, text: 'x', repeat: 'FREQ=HOURLY' }), /Lists answered 400/);
  assert.match(systemPrompt({ lists: true }), /every other Tuesday/);
});
