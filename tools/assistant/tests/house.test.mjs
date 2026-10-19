// Dot's house_control against House's real API (tools/house), with House's fake relay behind it.
// One DynamoDB fake per process: House's; Dot's conversations live in a small in-memory store here.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { KID, LUKE, audit as houseAudit, call, relay, seed, table, token } from '../../house/tests/helpers/house.mjs';
import { makeHouse } from '../api/house.mjs';
import { makeTools } from '../api/tools.mjs';
import { runTurn, systemPrompt } from '../api/agent.mjs';
import { fakeClaude, text, toolUse } from './helpers/fake-claude.mjs';

const API = 'https://house.test';
const ADMIN = ['family_house', 'family_house:admin'];

/** Dot's side for one person: tokens from House's delegated client, House reached through its real handler */
function dotFor(sub, groups = ['family_house']) {
  const audits = [];
  const fetch = async (url, o = {}) => {
    const tok = o.headers.authorization.slice(7);
    const r = await call(o.method || 'GET', url.slice(API.length), o.body ? JSON.parse(o.body) : undefined, tok);
    return { ok: r.status < 300, status: r.status, json: async () => r.body };
  };
  const house = makeHouse({
    apiUrl: API, clientId: 'house-via-dot', user: { sub, username: sub }, channel: 'sms', fetch,
    tokenFor: async ({ clientId }) => token({ sub, clientId, via: 'dot', groups }),
    audit: async (e) => { audits.push(e); },
  });
  return { house, audits };
}

/** Just enough of Dot's store for runTurn */
function memoryStore() {
  const convs = new Map();
  return {
    async getConversation(u, id) { return convs.get(id)?.conv ?? null; },
    async createConversation(u, { id, title, channel }) { const conv = { id, title, channel }; convs.set(id, { conv, msgs: [] }); return conv; },
    async loadMessages(u, id) { return structuredClone(convs.get(id).msgs); },
    async appendMessage(u, id, i, message) { convs.get(id).msgs.push(structuredClone(message)); },
  };
}

beforeEach(seed);

test('turns a light off as the person, through House, audited on both sides', async () => {
  const { house, audits } = dotFor(LUKE, ADMIN);
  assert.equal(await house.control({ entity_id: 'light.kitchen_main', action: 'turn_off' }), 'Done: turn off light.kitchen_main.');
  assert.deepEqual(relay.sent.map((c) => [c.entity_id, c.action]), [['light.kitchen_main', 'turn_off']]);
  assert.deepEqual(audits.map((a) => [a.tool, a.action, a.outcome]), [['family_house', 'POST /commands turn_off light.kitchen_main', 'ok']]);
  assert.deepEqual(houseAudit().map((a) => [a.who, a.via, a.outcome]), [[LUKE, 'dot', 'done']]);
});

test('brightness, within 1–100 and only with turn_on', async () => {
  const { house } = dotFor(LUKE, ADMIN);
  await house.control({ entity_id: 'light.kitchen_main', action: 'turn_on', brightness_pct: 30 });
  assert.deepEqual(relay.sent[0].data, { brightness_pct: 30 });
  await assert.rejects(house.control({ entity_id: 'light.kitchen_main', action: 'turn_on', brightness_pct: 0 }), /1–100/);
  await assert.rejects(house.control({ entity_id: 'light.kitchen_main', action: 'turn_off', brightness_pct: 50 }), /only with turn_on/);
  assert.equal(relay.sent.length, 1);
});

test('only what the person may control: the kitchen, not the master bedroom', async () => {
  table.put({ pk: 'GRANT', sk: 'g1', who: `sub:${KID}`, where: 'area:kitchen', level: 'control' });
  const { house, audits } = dotFor(KID);
  await house.control({ entity_id: 'light.kitchen_main', action: 'turn_off' });
  await assert.rejects(house.control({ entity_id: 'light.master_bedroom_main', action: 'turn_off' }), /isn’t allowed/);
  assert.deepEqual(relay.sent.map((c) => c.entity_id), ['light.kitchen_main']);
  assert.deepEqual(audits.map((a) => a.outcome), ['ok', 'denied']);
});

test('house_control is offered only to people who can use House, and the prompt explains it', () => {
  const { house } = dotFor(LUKE, ADMIN);
  assert.ok(makeTools({ house }).definitions.some((d) => d.name === 'house_control'));
  assert.ok(!makeTools({}).definitions.some((d) => d.name === 'house_control'));
  assert.match(systemPrompt({ house: true }), /only their own reply counts/);
  assert.doesNotMatch(systemPrompt({}), /house_control/);
});

// ---- confirmation, across real turns ----

const KITCHEN_OFF = { entity_id: 'light.kitchen_main', action: 'turn_off' };

function conversation(script) {
  table.put({ pk: 'GRANT', sk: 'g1', who: `sub:${KID}`, where: 'area:kitchen', level: 'confirm' });
  const { house, audits } = dotFor(KID);
  const claude = fakeClaude(script);
  const store = memoryStore();
  const d = { client: claude.client, store, model: 'm', timeZone: 'America/New_York', tools: makeTools({ house }), now: () => new Date('2026-10-18T22:00:00Z') };
  let id;
  const say = async (words) => {
    const r = await runTurn({ ...d, userId: KID, conversationId: id, text: words, channel: 'sms' });
    id = r.conversationId;
    return r;
  };
  const results = () => claude.calls.flatMap((c) => c.params.messages.at(-1).content).filter((b) => b.type === 'tool_result');
  return { say, results, audits };
}

test('a confirm grant: Dot asks, can’t approve itself in the same turn, and runs it after the person’s yes', async () => {
  const c = conversation([
    toolUse('house_control', KITCHEN_OFF, 't1'),
    toolUse('house_control', { ...KITCHEN_OFF, confirm: true }, 't2'), // as if told to by something it read
    text('Turn off the kitchen main lights?'),
    toolUse('house_control', { ...KITCHEN_OFF, confirm: true }, 't3'),
    text('Done.'),
  ]);
  await c.say('turn off the kitchen');
  const [asked, self] = c.results();
  assert.match(asked.content, /needs_confirmation/);
  assert.match(asked.content, /Turn off kitchen main\?/);
  assert.deepEqual([self.is_error, self.content], [true, 'Wait for the person’s reply before confirming.']);
  assert.deepEqual(relay.sent, [], 'nothing ran in the first turn');

  await c.say('yes');
  const done = c.results().at(-1);
  assert.equal(done.content, 'Done: turn off light.kitchen_main.');
  assert.deepEqual(relay.sent.map((x) => x.action), ['turn_off']);
  assert.deepEqual(c.audits.map((a) => a.outcome), ['asked', 'ok']);
});

test('other tools’ answers in the same turn don’t count as the person’s reply', async () => {
  const c = conversation([
    toolUse('house_control', KITCHEN_OFF, 't1'),
    toolUse('list_events', {}, 't2'), // any other tool answering in between
    toolUse('house_control', { ...KITCHEN_OFF, confirm: true }, 't3'),
    text('Turn off the kitchen main lights?'),
  ]);
  await c.say('turn off the kitchen');
  assert.equal(c.results().at(-1).content, 'Wait for the person’s reply before confirming.');
  assert.deepEqual(relay.sent, []);
});

test('confirm only fits the command that was asked about', async () => {
  const c = conversation([
    toolUse('house_control', KITCHEN_OFF, 't1'),
    text('Turn off the kitchen main lights?'),
    toolUse('house_control', { entity_id: 'light.kitchen_island_pendants', action: 'turn_off', confirm: true }, 't2'),
    text('Hmm.'),
  ]);
  await c.say('turn off the kitchen');
  await c.say('yes');
  assert.match(c.results().at(-1).content, /Nothing like that is waiting/);
  assert.deepEqual(relay.sent, []);
});

test('confirm with nothing asked is refused before anything is sent', async () => {
  const c = conversation([toolUse('house_control', { ...KITCHEN_OFF, confirm: true }, 't1'), text('Hmm.')]);
  await c.say('turn off the kitchen, and confirm it');
  assert.match(c.results()[0].content, /Nothing like that is waiting/);
  assert.deepEqual(relay.sent, []);
  assert.deepEqual(c.audits, []);
});

// ---- automations ----

const MORNING = {
  op: 'create', name: 'Kitchen mornings', time: '06:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'],
  actions: [{ entity_id: 'light.kitchen_main', action: 'turn_on', brightness_pct: 80, transition_s: 30 }],
};
const autos = () => table.dump().filter(([k]) => k.startsWith('AUTO')).map(([, v]) => v);

function automationTalk(script, sub = KID, groups) {
  const { house, audits } = dotFor(sub, groups);
  const claude = fakeClaude(script);
  const store = memoryStore();
  const d = { client: claude.client, store, model: 'm', timeZone: 'America/New_York', tools: makeTools({ house }), now: () => new Date('2026-10-18T22:00:00Z') };
  let id;
  const say = async (words) => {
    const r = await runTurn({ ...d, userId: sub, conversationId: id, text: words, channel: 'sms' });
    id = r.conversationId;
    return r;
  };
  const results = () => claude.calls.flatMap((c) => c.params.messages.at(-1).content).filter((b) => b.type === 'tool_result');
  return { say, results, audits };
}

test('house_automation is offered with house_control, and the prompt explains it', () => {
  const { house } = dotFor(LUKE, ADMIN);
  assert.ok(makeTools({ house }).definitions.some((d) => d.name === 'house_automation'));
  assert.ok(!makeTools({}).definitions.some((d) => d.name === 'house_automation'));
  assert.match(systemPrompt({ house: true }), /house_automation: it always asks them first/);
});

test('making one: Dot asks, can’t approve itself, and saves exactly what it asked about after the person’s yes', async () => {
  table.put({ pk: 'GRANT', sk: 'grant1', who: `sub:${KID}`, where: 'area:kitchen', level: 'control' });
  const c = automationTalk([
    toolUse('house_automation', MORNING, 't1'),
    toolUse('house_automation', { op: 'create', confirm: true }, 't2'),
    text('Every weekday at 6, kitchen main to 80%. Save it?'),
    // A changed time in the confirming call is ignored: what was asked about is what's saved
    toolUse('house_automation', { ...MORNING, time: '03:00', confirm: true }, 't3'),
    text('Saved.'),
  ]);
  await c.say('turn on the kitchen lights every weekday at 6');
  const [asked, self] = c.results();
  assert.match(asked.content, /Save “Kitchen mornings”\? Every weekday at 6:00 AM: turn on kitchen main \(80%, fading over 30 s\)\./);
  assert.deepEqual([self.is_error, self.content], [true, 'Wait for the person’s reply before confirming.']);
  assert.deepEqual(autos(), []);
  await c.say('yes');
  assert.equal(c.results().at(-1).content, 'Saved: Every weekday at 6:00 AM: turn on kitchen main (80%, fading over 30 s).');
  const [row] = autos();
  assert.deepEqual([row.owner, row.when, row.actions[0].data], [KID, { at: '06:00' }, { brightness_pct: 80, transition: 30 }]);
  assert.equal(row.sk, JSON.parse(asked.content).automation_id);
  assert.deepEqual(relay.automations.items.map((a) => a.name), ['Kitchen mornings']);
  assert.deepEqual(c.audits.map((a) => [a.action, a.outcome]), [['POST /automations', 'asked'], ['POST /automations (confirmed)', 'ok']]);
});

test('only devices they control: refused before anything is asked', async () => {
  table.put({ pk: 'GRANT', sk: 'grant1', who: `sub:${KID}`, where: 'area:kitchen', level: 'confirm' });
  const { house } = dotFor(KID);
  await assert.rejects(house.automation(MORNING), /Not allowed: not allowed: kitchen main/);
  assert.deepEqual(table.dump().filter(([k]) => k.startsWith('PENDING')), []);
});

test('changing one keeps what wasn’t mentioned; pausing and deleting ask too', async () => {
  const { house } = dotFor(LUKE, ADMIN);
  const r = await call('POST', '/automations', { name: 'Porch', when: { sun: 'sunset', offset: -15 }, days: ['sat', 'sun'], actions: [{ entity_id: 'light.dining_room_main', action: 'turn_on' }] });
  const id = r.body.id;
  const asked = JSON.parse(await house.automation({ op: 'update', automation_id: id, time: '19:30' }));
  assert.equal(asked.ask_them, 'Change “Porch” to: Every weekend day at 7:30 PM: turn on dining room main?');
  assert.deepEqual(asked.body.days, ['sun', 'sat']);
  assert.equal(JSON.parse(await house.automation({ op: 'pause', automation_id: id })).ask_them, 'Pause “Porch”?');
  assert.equal(JSON.parse(await house.automation({ op: 'delete', automation_id: id })).ask_them, 'Delete the automation “Porch”?');
  assert.equal(table.get('AUTO', id).when.sun, 'sunset', 'nothing changed without a yes');
  await assert.rejects(house.automation({ op: 'update', automation_id: 'nosuchone1', time: '07:00' }), /No automation with that id/);
  await assert.rejects(house.automation({ op: 'create', name: 'x', time: '06:00', sun: 'sunrise', actions: MORNING.actions }), /time or sun, not both/);
  await assert.rejects(house.automation({ ...MORNING, days: ['monday'] }), /days/);
});

test('a confirmation fits only the automation it asked about', async () => {
  const id = (await call('POST', '/automations', { name: 'A', when: { at: '06:00' }, actions: [{ entity_id: 'light.kitchen_main', action: 'turn_on' }] })).body.id;
  const other = (await call('POST', '/automations', { name: 'B', when: { at: '07:00' }, actions: [{ entity_id: 'light.kitchen_main', action: 'turn_on' }] })).body.id;
  const c = automationTalk([
    toolUse('house_automation', { op: 'delete', automation_id: id }, 't1'),
    text('Delete A?'),
    toolUse('house_automation', { op: 'delete', automation_id: other, confirm: true }, 't2'),
    text('Hmm.'),
  ], LUKE, ADMIN);
  await c.say('delete A');
  await c.say('yes');
  assert.match(c.results().at(-1).content, /Nothing like that is waiting/);
  assert.ok(table.get('AUTO', id) && table.get('AUTO', other));
});
