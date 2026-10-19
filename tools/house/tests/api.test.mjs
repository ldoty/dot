import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ISSUER, accessToken, forgedToken } from '../../../platform/tests/helpers/tokens.mjs';
import { fakeTable } from '../../../platform/tests/helpers/fake-table.mjs';
import { caller } from '../../../platform/tests/helpers/http.mjs';

Object.assign(process.env, { TABLE: 'family-house', GROUP: 'family_house', ISSUER, CLIENT_ID: 'house-client', DOT_CLIENT_ID: 'house-via-dot' });
const table = fakeTable({ pageSize: 2 }); // the API must follow pages
const { handler, MANIFEST } = await import('../api/api.mjs');

const ROUTES = ['GET /home', 'GET /dot'];
const KID = '11111111-1111-1111-1111-111111111111';
const LUKE = '22222222-2222-2222-2222-222222222222';
const token = ({ sub = LUKE, groups = ['family_house'], clientId = 'house-client', ...over } = {}) =>
  accessToken({ clientId, sub, 'cognito:groups': groups, ...over });
const admin = () => token({ groups: ['family_house', 'family_house:admin'] });
const callApi = caller(handler, [...ROUTES, 'POST /home']); // POST only to prove Dot is refused
const call = (m, p, b, t = admin()) => callApi(m, p, b, t);

const light = (id, area, state = 'on') => ({ pk: 'ENTITY', sk: id, name: id, area, domain: 'light', state, attrs: { brightness: 255 }, updated: '2026-10-18T20:00:00Z' });

beforeEach(() => {
  table.clear();
  table.put({ pk: 'AREA', sk: 'kitchen', name: 'Kitchen' });
  table.put({ pk: 'AREA', sk: 'master_bedroom', name: 'Master Bedroom' });
  table.put({ pk: 'AREA', sk: 'dining_room', name: 'Dining Room' });
  table.put(light('light.kitchen_main', 'kitchen'));
  table.put(light('light.kitchen_island_pendants', 'kitchen'));
  table.put(light('light.master_bedroom_main', 'master_bedroom'));
  table.put(light('light.dining_room_main', 'dining_room', 'off'));
  table.put({ ...light('switch.lutron_smart_away', null, 'off'), domain: 'switch', attrs: {} });
  table.put({ pk: 'RELAY', sk: 'CONN', connectionId: 'c1', lastSync: new Date().toISOString() });
});

test('refuses missing, forged, wrong-group and other-tool tokens', async () => {
  assert.equal((await call('GET', '/home', undefined, null)).status, 401);
  assert.equal((await call('GET', '/home', undefined, forgedToken({ clientId: 'house-client', group: 'family_house' }))).status, 401);
  assert.equal((await call('GET', '/home', undefined, token({ groups: ['someone_else'] }))).status, 403);
  assert.equal((await call('GET', '/home', undefined, token({ clientId: 'other-tool' }))).status, 401);
});

test('an admin sees every room, by name, with Other last, all at control', async () => {
  const r = await call('GET', '/home');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.you, { admin: true });
  assert.deepEqual(r.body.areas.map((a) => a.name), ['Dining Room', 'Kitchen', 'Master Bedroom', 'Other']);
  assert.deepEqual(r.body.areas[1].entities.map((e) => e.id), ['light.kitchen_island_pendants', 'light.kitchen_main']);
  assert.ok(r.body.areas.flatMap((a) => a.entities).every((e) => e.level === 'control'));
  assert.deepEqual(r.body.relay.connected, true);
  assert.equal(r.body.relay.stale, false);
});

test('a member sees only what their grants allow', async () => {
  table.put({ pk: 'GROUP', sk: 'kids', name: 'kids', members: [KID] });
  table.put({ pk: 'GRANT', sk: 'g1', who: 'group:kids', where: 'area:kitchen', level: 'control' });
  table.put({ pk: 'GRANT', sk: 'g2', who: `sub:${KID}`, where: 'entity:light.dining_room_main', level: 'read' });
  const r = await call('GET', '/home', undefined, token({ sub: KID }));
  assert.deepEqual(r.body.you, { admin: false });
  assert.deepEqual(r.body.areas.map((a) => [a.name, a.entities.map((e) => `${e.id}:${e.level}`)]), [
    ['Dining Room', ['light.dining_room_main:read']],
    ['Kitchen', ['light.kitchen_island_pendants:control', 'light.kitchen_main:control']],
  ], 'no master bedroom, no Other');
});

test('a member with no grants sees nothing', async () => {
  const r = await call('GET', '/home', undefined, token({ sub: KID }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.areas, []);
});

test('one room by id', async () => {
  const r = await call('GET', '/home?area=kitchen');
  assert.deepEqual(r.body.areas.map((a) => a.id), ['kitchen']);
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

test('Dot reads as the person asking, with their grants', async () => {
  table.put({ pk: 'GRANT', sk: 'g1', who: `sub:${KID}`, where: 'area:kitchen', level: 'read' });
  const dot = token({ sub: KID, clientId: 'house-via-dot', via: 'dot' });
  const r = await call('GET', '/home', undefined, dot);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.areas.map((a) => a.id), ['kitchen']);
  assert.deepEqual((await call('GET', '/dot', undefined, dot)).body, MANIFEST);
});

test('Dot can’t change anything (yet)', async () => {
  const r = await call('POST', '/home', {}, token({ clientId: 'house-via-dot', via: 'dot' }));
  assert.deepEqual([r.status, r.body.error], [403, 'read-only']);
});

test('the routes in infra/api.tf match the handler', async () => {
  const tf = await readFile(new URL('../infra/api.tf', import.meta.url), 'utf8');
  const block = /routes = \[([\s\S]*?)\]/.exec(tf)[1];
  assert.deepEqual([...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort(), [...ROUTES].sort());
  const relay = await readFile(new URL('../infra/relay.tf', import.meta.url), 'utf8');
  assert.match(relay, /protocol_type\s+= "WEBSOCKET"/);
  assert.doesNotMatch(relay, /authorization_type/, 'the relay has no token; the Lambda checks its key');
});
