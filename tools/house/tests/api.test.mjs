import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { forgedToken } from '../../../platform/tests/helpers/tokens.mjs';
import { KID, LUKE, ROUTES, audit, call, familyGroup, relay, seed, table, token } from './helpers/house.mjs';

const { MANIFEST } = await import('../api/api.mjs');
const grant = (sk, who, where, level) => table.put({ pk: 'GRANT', sk, who, where, level });
const kid = (over) => token({ sub: KID, ...over });
const dot = (sub = KID) => token({ sub, clientId: 'house-via-dot', via: 'dot' });
const turn = (entity_id, action, extra = {}) => ({ entity_id, action, ...extra });

beforeEach(seed);

test('refuses missing, forged, wrong-group and other-tool tokens', async () => {
  assert.equal((await call('GET', '/home', undefined, null)).status, 401);
  assert.equal((await call('GET', '/home', undefined, forgedToken({ clientId: 'house-client', group: 'family_house' }))).status, 401);
  assert.equal((await call('GET', '/home', undefined, token({ groups: ['someone_else'] }))).status, 403);
  assert.equal((await call('GET', '/home', undefined, token({ clientId: 'other-tool' }))).status, 401);
  assert.equal((await call('POST', '/commands', turn('light.kitchen_main', 'turn_off'), null)).status, 401);
  assert.deepEqual(relay.sent, []);
});

// ---- reading ----

test('an admin sees every room, by name, with Other last, all at control with their actions', async () => {
  const r = await call('GET', '/home');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.you, { admin: true });
  assert.deepEqual(r.body.areas.map((a) => a.name), ['Dining Room', 'Kitchen', 'Master Bedroom', 'Other']);
  assert.deepEqual(r.body.areas[1].entities.map((e) => e.id), ['light.kitchen_island_pendants', 'light.kitchen_main']);
  const all = r.body.areas.flatMap((a) => a.entities);
  assert.ok(all.every((e) => e.level === 'control' && e.actions.turn_off));
  assert.equal(r.body.relay.connected, true);
  assert.equal(r.body.relay.stale, false);
});

test('a member sees only what their grants allow, and actions only where they may control', async () => {
  familyGroup('gkids00001', 'Kids', [KID]);
  grant('g1', 'group:gkids00001', 'area:kitchen', 'control');
  grant('g2', `sub:${KID}`, 'entity:light.dining_room_main', 'read');
  const r = await call('GET', '/home', undefined, kid());
  assert.deepEqual(r.body.you, { admin: false });
  assert.deepEqual(r.body.areas.map((a) => [a.name, a.entities.map((e) => `${e.id}:${e.level}:${!!e.actions}`)]), [
    ['Dining Room', ['light.dining_room_main:read:false']],
    ['Kitchen', ['light.kitchen_island_pendants:control:true', 'light.kitchen_main:control:true']],
  ], 'no master bedroom, no Other');
});

test('a member with no grants sees nothing', async () => {
  const r = await call('GET', '/home', undefined, kid());
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.areas, []);
});

test('one room by id', async () => {
  assert.deepEqual((await call('GET', '/home?area=kitchen')).body.areas.map((a) => a.id), ['kitchen']);
  assert.equal((await call('GET', '/home?area=Kitchen!')).status, 400);
});

test('says when the house hasn’t reported lately', async () => {
  table.put({ pk: 'RELAY', sk: 'CONN', connectionId: null, lastSync: new Date(Date.now() - 12 * 60_000).toISOString() });
  const r = await call('GET', '/home');
  assert.equal(r.body.relay.connected, false);
  assert.equal(r.body.relay.stale, true);
  table.delete('RELAY', 'CONN');
  assert.equal((await call('GET', '/home')).body.relay.stale, true, 'never synced');
});

// ---- commands ----

test('an admin turns a light off: the relay gets it, it’s done, and it’s audited', async () => {
  const r = await call('POST', '/commands', turn('light.kitchen_main', 'turn_off'));
  assert.deepEqual([r.status, r.body], [200, { ok: true }]);
  assert.equal(relay.sent.length, 1);
  const sent = relay.sent[0];
  assert.deepEqual({ ...sent, id: 'x', expires: 'x' }, { type: 'command', id: 'x', entity_id: 'light.kitchen_main', action: 'turn_off', data: {}, expires: 'x' });
  assert.ok(sent.expires > Date.now() && sent.expires <= Date.now() + 5000, 'the relay drops it after five seconds');
  const [row] = audit();
  assert.deepEqual([row.who, row.via, row.entity_id, row.action, row.outcome], [LUKE, 'page', 'light.kitchen_main', 'turn_off', 'done']);
  assert.ok(row.expires > Date.now() / 1000 + 364 * 86_400, 'kept a year');
});

test('brightness goes through as data', async () => {
  assert.equal((await call('POST', '/commands', turn('light.kitchen_main', 'turn_on', { data: { brightness_pct: 40 } }))).status, 200);
  assert.deepEqual(relay.sent[0].data, { brightness_pct: 40 });
});

test('a member controls only where granted: the kitchen, not the master bedroom', async () => {
  grant('g1', `sub:${KID}`, 'area:kitchen', 'control');
  grant('g2', `sub:${KID}`, '*', 'read');
  assert.equal((await call('POST', '/commands', turn('light.kitchen_main', 'turn_off'), kid())).status, 200);
  const r = await call('POST', '/commands', turn('light.master_bedroom_main', 'turn_off'), kid());
  assert.deepEqual([r.status, r.body.error], [403, 'not allowed']);
  assert.deepEqual(relay.sent.map((c) => c.entity_id), ['light.kitchen_main'], 'the denied one never reached the house');
  assert.deepEqual(audit().map((a) => a.outcome).sort(), ['denied', 'done']);
});

test('read access isn’t control', async () => {
  grant('g1', `sub:${KID}`, '*', 'read');
  assert.equal((await call('POST', '/commands', turn('light.kitchen_main', 'turn_off'), kid())).status, 403);
  assert.deepEqual(relay.sent, []);
});

test('only actions and data the device takes', async () => {
  assert.equal((await call('POST', '/commands', turn('light.kitchen_main', 'toggle'))).status, 400);
  assert.equal((await call('POST', '/commands', turn('switch.lutron_smart_away', 'turn_on', { data: { brightness_pct: 5 } }))).status, 400);
  assert.equal((await call('POST', '/commands', turn('light.kitchen_main', 'turn_on', { data: { brightness_pct: { a: 1 } } }))).status, 400);
  assert.equal((await call('POST', '/commands', turn('light.kitchen_main', 'turn_on', { data: { 'Bad-Key': 1 } }))).status, 400);
  assert.equal((await call('POST', '/commands', turn('Light.Kitchen', 'turn_on'))).status, 400);
  assert.equal((await call('POST', '/commands', turn('light.garage', 'turn_on'))).status, 404);
  assert.deepEqual(relay.sent, []);
});

test('the relay’s ceiling has the last word, even over AWS', async () => {
  // AWS believes the device takes `toggle`, but the ceiling on the relay doesn't list it
  table.put({ ...table.get('ENTITY', 'light.kitchen_main'), actions: { toggle: [] } });
  const r = await call('POST', '/commands', turn('light.kitchen_main', 'toggle'));
  assert.deepEqual([r.status, r.body.error], [502, 'refused: toggle not allowed']);
  assert.equal(audit()[0].outcome, 'failed');
});

test('Home Assistant failing is reported', async () => {
  relay.error = 'Entity is unavailable';
  const r = await call('POST', '/commands', turn('light.kitchen_main', 'turn_on'));
  assert.deepEqual([r.status, r.body.error], [502, 'Entity is unavailable']);
});

test('offline or silent: 504, never queued', async () => {
  table.put({ pk: 'RELAY', sk: 'CONN', connectionId: null, lastSync: null });
  assert.deepEqual((await call('POST', '/commands', turn('light.kitchen_main', 'turn_off'))).status, 504);
  table.put({ pk: 'RELAY', sk: 'CONN', connectionId: 'c1', lastSync: null });
  relay.mode = 'gone';
  assert.deepEqual((await call('POST', '/commands', turn('light.kitchen_main', 'turn_off'))).status, 504);
  relay.mode = 'silent';
  const r = await call('POST', '/commands', turn('light.kitchen_main', 'turn_off'));
  assert.deepEqual([r.status, r.body.error], [504, 'The house didn’t answer']);
  assert.deepEqual(audit().map((a) => a.outcome).sort(), ['offline', 'offline', 'timeout']);
});

test('confirm level: asks first, then runs with the confirmation, once', async () => {
  grant('g1', `sub:${KID}`, 'area:kitchen', 'confirm');
  const ask = await call('POST', '/commands', turn('light.kitchen_main', 'turn_off'), kid());
  assert.equal(ask.status, 202);
  assert.equal(ask.body.prompt, 'Turn off kitchen main?');
  assert.deepEqual(relay.sent, [], 'nothing runs until confirmed');
  const go = turn('light.kitchen_main', 'turn_off', { confirm_id: ask.body.confirm_id });
  assert.equal((await call('POST', '/commands', go, kid())).status, 200);
  assert.equal((await call('POST', '/commands', go, kid())).status, 400, 'single use');
  assert.equal(relay.sent.length, 1);
});

test('a confirmation only fits the same person, the same command, within two minutes', async () => {
  grant('g1', `sub:${KID}`, 'area:kitchen', 'confirm');
  grant('g2', `sub:${LUKE}`, 'area:kitchen', 'confirm');
  const ask = async () => (await call('POST', '/commands', turn('light.kitchen_main', 'turn_on', { data: { brightness_pct: 50 } }), kid())).body.confirm_id;
  let id = await ask();
  assert.equal((await call('POST', '/commands', turn('light.kitchen_main', 'turn_on', { data: { brightness_pct: 50 }, confirm_id: id }), token())).status, 400, 'someone else');
  id = await ask();
  assert.equal((await call('POST', '/commands', turn('light.kitchen_main', 'turn_on', { data: { brightness_pct: 100 }, confirm_id: id }), kid())).status, 400, 'other data');
  id = await ask();
  assert.equal((await call('POST', '/commands', turn('light.kitchen_island_pendants', 'turn_on', { data: { brightness_pct: 50 }, confirm_id: id }), kid())).status, 400, 'other device');
  id = await ask();
  table.put({ ...table.get('PENDING', id), until: Date.now() - 1 });
  assert.equal((await call('POST', '/commands', turn('light.kitchen_main', 'turn_on', { data: { brightness_pct: 50 }, confirm_id: id }), kid())).status, 400, 'expired');
  assert.deepEqual(relay.sent, []);
});

// ---- Dot ----

test('Dot reads as the person asking, with their grants', async () => {
  grant('g1', `sub:${KID}`, 'area:kitchen', 'read');
  const r = await call('GET', '/home', undefined, dot());
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.areas.map((a) => a.id), ['kitchen']);
  assert.deepEqual((await call('GET', '/dot', undefined, dot())).body, MANIFEST);
});

test('Dot sends commands as the person asking, within their grants, audited as Dot', async () => {
  grant('g1', `sub:${KID}`, 'area:kitchen', 'control');
  assert.equal((await call('POST', '/commands', turn('light.kitchen_main', 'turn_off'), dot())).status, 200);
  assert.equal((await call('POST', '/commands', turn('light.master_bedroom_main', 'turn_off'), dot())).status, 403);
  assert.deepEqual(audit().map((a) => [a.via, a.outcome]).sort(), [['dot', 'denied'], ['dot', 'done']]);
});

test('Dot can’t change anything else', async () => {
  const r = await call('POST', '/home', {}, dot());
  assert.deepEqual([r.status, r.body.error], [403, 'read-only']);
});

test('the routes in infra/api.tf match the handler', async () => {
  const tf = await readFile(new URL('../infra/api.tf', import.meta.url), 'utf8');
  const block = /routes = \[([\s\S]*?)\]/.exec(tf)[1];
  assert.deepEqual([...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort(), [...ROUTES].sort());
  const relayTf = await readFile(new URL('../infra/relay.tf', import.meta.url), 'utf8');
  assert.match(relayTf, /protocol_type\s+= "WEBSOCKET"/);
  assert.match(relayTf, /relay_routes\s+= \["\$connect", "\$disconnect", "sync", "result", "ran", "\$default"\]/);
  assert.doesNotMatch(relayTf, /authorization_type/, 'the relay has no token; the Lambda checks its key');
});
