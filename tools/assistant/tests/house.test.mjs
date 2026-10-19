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

// ---- automations: House's declared writes, through discovery ----

import { makeDiscovery } from '../api/discovery.mjs';

/** Dot's discovered House tools for one person, House reached through its real handler */
async function discoveredFor(sub, groups = ['family_house']) {
  const audits = [];
  const d = makeDiscovery({
    listApps: async () => [{ app: 'family_house', api_url: API, client_id: 'house-via-dot' }],
    tokenFor: async ({ clientId }) => token({ sub, clientId, via: 'dot', groups }),
    fetch: async (url, o = {}) => {
      const r = await call(o.method || 'GET', url.slice(API.length), o.body ? JSON.parse(o.body) : undefined, o.headers.authorization.slice(7));
      return { ok: r.status < 300, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) };
    },
  });
  const discovered = await d.forUser({ user: { sub, username: sub }, channel: 'sms', audit: async (e) => audits.push(e) });
  const { house } = dotFor(sub, groups);
  return { discovered, audits, tools: (o = {}) => makeTools({ house, discovered, ...o }) };
}

const MORNING = {
  name: 'Kitchen mornings', when: { at: '06:00' }, repeat: { rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' },
  actions: [{ entity_id: 'light.kitchen_main', action: 'turn_on', data: { brightness_pct: 80, transition: 30 } }],
};
const autos = () => table.dump().filter(([k]) => k.startsWith('AUTO')).map(([, v]) => v);
const use = (tools, name, input, history = []) => tools.run({ type: 'tool_use', id: 't', name, input }, { history });
const answered = (asked, reply = 'yes') => [
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: asked }] },
  ...(reply ? [{ role: 'user', content: [{ type: 'text', text: reply }] }] : []),
];

async function automationTalk(script, sub = KID, groups) {
  const { tools, audits } = await discoveredFor(sub, groups);
  const claude = fakeClaude(script);
  const store = memoryStore();
  const d = { client: claude.client, store, model: 'm', timeZone: 'America/New_York', tools: tools(), now: () => new Date('2026-10-18T22:00:00Z') };
  let id;
  const say = async (words) => {
    const r = await runTurn({ ...d, userId: sub, conversationId: id, text: words, channel: 'sms' });
    id = r.conversationId;
    return r;
  };
  const results = () => claude.calls.flatMap((c) => c.params.messages.at(-1).content).filter((b) => b.type === 'tool_result');
  return { say, results, audits };
}

test('House’s automation writes are discovered, with confirm; a read-only run never gets them', async () => {
  const { discovered, tools } = await discoveredFor(LUKE, ADMIN);
  assert.deepEqual(discovered.writes, ['house_automation_create', 'house_automation_change', 'house_automation_delete']);
  const create = tools().definitions.find((d) => d.name === 'house_automation_create');
  assert.match(create.description, /\(changes things, as them\)/);
  assert.equal(create.input_schema.properties.confirm.type, 'boolean');
  assert.ok(!tools().definitions.some((d) => d.name === 'house_automation'), 'the old built-in is gone');
  const reading = tools({ readOnly: true }).definitions.map((d) => d.name);
  assert.ok(reading.includes('house_automations') && !reading.some((n) => /^house_automation_/.test(n)));
  assert.match(systemPrompt({ house: true }), /house_automation_create/);
});

test('making one: Dot asks, can’t approve itself, and saves exactly what it asked about after the person’s yes', async () => {
  table.put({ pk: 'GRANT', sk: 'grant1', who: `sub:${KID}`, where: 'area:kitchen', level: 'control' });
  const c = await automationTalk([
    toolUse('house_automation_create', MORNING, 't1'),
    toolUse('house_automation_create', { confirm: true }, 't2'),
    text('Every weekday at 6, kitchen main to 80%. Save it?'),
    // A changed time in the confirming call is ignored: what was asked about is what's saved
    toolUse('house_automation_create', { ...MORNING, when: { at: '03:00' }, confirm: true }, 't3'),
    text('Saved.'),
  ]);
  await c.say('turn on the kitchen lights every weekday at 6');
  const [asked, self] = c.results();
  assert.match(asked.content, /Save “Kitchen mornings”\? Every weekday at 6:00 AM: turn on kitchen main \(80%, fading over 30 s\)\./);
  assert.deepEqual([self.is_error, self.content], [true, 'Wait for the person’s reply before confirming.']);
  assert.deepEqual(autos(), []);
  await c.say('yes');
  assert.equal(JSON.parse(c.results().at(-1).content).says, 'Every weekday at 6:00 AM: turn on kitchen main (80%, fading over 30 s)');
  const [row] = autos();
  assert.deepEqual([row.owner, row.when, row.actions[0].data], [KID, { at: '06:00' }, { brightness_pct: 80, transition: 30 }]);
  assert.deepEqual(relay.automations.items.map((a) => a.name), ['Kitchen mornings']);
  assert.deepEqual(c.audits.map((a) => [a.action, a.outcome]), [['POST /automations', 'asked'], ['POST /automations (confirmed)', 'ok']]);
});

test('only devices they control: refused before anything is asked', async () => {
  table.put({ pk: 'GRANT', sk: 'grant1', who: `sub:${KID}`, where: 'area:kitchen', level: 'confirm' });
  const { tools } = await discoveredFor(KID);
  const r = await use(tools(), 'house_automation_create', MORNING);
  assert.deepEqual([r.is_error, r.content], [true, 'House answered 403: not allowed: kitchen main']);
  assert.deepEqual(table.dump().filter(([k]) => k.startsWith('PENDING')), []);
});

test('changing one keeps what wasn’t mentioned; pausing and deleting ask too', async () => {
  const { tools } = await discoveredFor(LUKE, ADMIN);
  const t = tools();
  const r = await call('POST', '/automations', { name: 'Porch', when: { sun: 'sunset', offset: -15 }, repeat: { rule: 'FREQ=WEEKLY;BYDAY=SA,SU', start: '2026-10-03' }, actions: [{ entity_id: 'light.dining_room_main', action: 'turn_on' }] });
  const id = r.body.id;
  const asked = JSON.parse((await use(t, 'house_automation_change', { id, when: { at: '19:30' } })).content);
  assert.equal(asked.ask_them, 'Change “Porch” to: Every Saturday, Sunday at 7:30 PM: turn on dining room main?');
  const fortnight = JSON.parse((await use(t, 'house_automation_change', { id, repeat: { rule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SA', start: '2026-10-24' } })).content);
  assert.equal(fortnight.ask_them, 'Change “Porch” to: Every other Saturday 15 minutes before sunset: turn on dining room main?');
  assert.equal(JSON.parse((await use(t, 'house_automation_change', { id, enabled: false })).content).ask_them, 'Pause “Porch”?');
  const del = (await use(t, 'house_automation_delete', { id })).content;
  assert.equal(JSON.parse(del).ask_them, 'Delete the automation “Porch”?');
  assert.equal(table.get('AUTO', id).when.sun, 'sunset', 'nothing changed without a yes');
  assert.match((await use(t, 'house_automation_change', { id: 'nosuchone1', when: { at: '07:00' } })).content, /House answered 404/);
  // The yes goes through, and only for the one asked about
  assert.match((await use(t, 'house_automation_delete', { id: 'nosuchone1', confirm: true }, answered(del))).content, /Nothing like that is waiting/);
  assert.match((await use(t, 'house_automation_delete', { id, confirm: true }, answered(del))).content, /"id"/);
  assert.equal(table.get('AUTO', id), undefined);
});

test('a confirmation fits only the tool and automation it asked about', async () => {
  const id = (await call('POST', '/automations', { name: 'A', when: { at: '06:00' }, actions: [{ entity_id: 'light.kitchen_main', action: 'turn_on' }] })).body.id;
  const other = (await call('POST', '/automations', { name: 'B', when: { at: '07:00' }, actions: [{ entity_id: 'light.kitchen_main', action: 'turn_on' }] })).body.id;
  const c = await automationTalk([
    toolUse('house_automation_delete', { id }, 't1'),
    text('Delete A?'),
    toolUse('house_automation_delete', { id: other, confirm: true }, 't2'),
    toolUse('house_automation_change', { id, enabled: false, confirm: true }, 't3'),
    text('Hmm.'),
  ], LUKE, ADMIN);
  await c.say('delete A');
  await c.say('yes');
  const [, b, change] = c.results();
  assert.match(b.content, /Nothing like that is waiting/);
  assert.match(change.content, /Nothing like that is waiting/, 'a yes to deleting isn’t a yes to changing');
  assert.ok(table.get('AUTO', id) && table.get('AUTO', other));
});

test('an automation set off by someone leaving home, that texts: asked about in words, saved as asked', async () => {
  table.put({ pk: 'ENTITY', sk: 'person.luke_doty', name: 'Luke Doty', area: null, domain: 'person', state: 'home', attrs: {}, updated: '2026-10-19T17:00:00Z', actions: {} });
  const { tools } = await discoveredFor(LUKE, ADMIN);
  const input = { name: 'Garage check', when: { changes: 'person.luke_doty', to: 'not_home' }, notify: { message: 'You left: is the garage shut?' } };
  const asked = JSON.parse((await use(tools(), 'house_automation_create', input)).content);
  assert.equal(asked.ask_them, 'Save “Garage check”? When Luke Doty leaves home: text “You left: is the garage shut?”.');
  assert.deepEqual(asked.body.when, { changes: 'person.luke_doty', to: 'not_home' });
  const bad = await use(tools(), 'house_automation_create', { ...input, notify: { message: 'see www.example.com' } });
  assert.match(bad.content, /no links/);
});
