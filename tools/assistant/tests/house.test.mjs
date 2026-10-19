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
