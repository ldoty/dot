// A House API wired to the fake table and a fake relay that answers through the real relay
// Lambda (api/relay-ws.mjs), checking the real ceiling the way relay.mjs does.
import { readFileSync } from 'node:fs';
import { ISSUER, accessToken } from '../../../../platform/tests/helpers/tokens.mjs';
import { fakeTable } from '../../../../platform/tests/helpers/fake-table.mjs';
import { caller } from '../../../../platform/tests/helpers/http.mjs';
import { validateCeiling, refuseCommand } from '../../relay/ceiling.mjs';
import { makePeople } from '../../api/people.mjs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export const table = fakeTable({ pageSize: 2 }); // the API must follow pages
const { createApi } = await import('../../api/api.mjs');
const { createRelayWs } = await import('../../api/relay-ws.mjs');

export const ROUTES = [
  'GET /home', 'GET /dot', 'POST /commands',
  'GET /access', 'PUT /grants/{id}', 'DELETE /grants/{id}', 'GET /log',
  'GET /automations', 'POST /automations', 'PUT /automations/{id}', 'DELETE /automations/{id}',
];
export const LUKE = '22222222-2222-2222-2222-222222222222';
export const KID = '11111111-1111-1111-1111-111111111111';
export const ceiling = validateCeiling(JSON.parse(readFileSync(new URL('../../relay/ceiling.json', import.meta.url), 'utf8')));

export const relay = {
  sent: [],
  mode: 'answer', // 'answer' | 'silent' | 'gone'
  error: null,    // set to make Home Assistant fail
  automations: null, // the last automation set AWS sent it
};
const relayWs = createRelayWs({ table: 'family-house', relayKey: async () => 'k' });
async function toRelay(connectionId, msg) {
  if (relay.mode === 'gone') throw Object.assign(new Error('gone'), { name: 'GoneException' });
  if (msg.type === 'automations') { relay.automations = msg; return; }
  relay.sent.push(msg);
  if (relay.mode === 'silent') return;
  const area = table.get('ENTITY', msg.entity_id)?.area ?? null;
  const refused = refuseCommand(ceiling, msg, area);
  const why = refused ? `refused: ${refused}` : relay.error; // as relay.mjs answers
  const result = { type: 'result', id: msg.id, ok: !why, ...(why ? { error: why } : {}) };
  setTimeout(() => relayWs({ requestContext: { routeKey: 'result', connectionId }, body: JSON.stringify(result) }), 5);
}

// Who's in family_house and family_house:admin (Cognito), changeable by a test
export const people = { members: [], admins: [] };

export const handler = createApi({
  table: 'family-house', group: 'family_house', issuer: ISSUER,
  clientIds: ['house-client', 'house-via-dot'], dotClientId: 'house-via-dot',
  toRelay, now: () => new Date(), timeZone: 'America/New_York', sleep: (ms) => new Promise((r) => setTimeout(r, ms / 50)),
  members: async () => people.members,
  admins: async () => people.admins,
  // The family's groups and names (platform/family) on the same fake table, never cached here
  people: makePeople({ db: DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' })), table: 'family-people', ttlMs: 0 }),
});

export const token = ({ sub = LUKE, groups = ['family_house'], clientId = 'house-client', ...over } = {}) =>
  accessToken({ clientId, sub, 'cognito:groups': groups, ...over });
export const adminToken = () => token({ groups: ['family_house', 'family_house:admin'] });
const callApi = caller(handler, [...ROUTES, 'POST /home']); // POST /home only to prove Dot is refused
export const call = (m, p, b, t = adminToken()) => callApi(m, p, b, t);

const ACTIONS = { light: ceiling.domains.light.actions, switch: ceiling.domains.switch.actions };
export const entity = (id, area, state = 'on', attrs = {}) => ({
  pk: 'ENTITY', sk: id, name: id.split('.')[1].replace(/_/g, ' '), area, domain: id.split('.')[0], state, attrs, updated: '2026-10-18T20:00:00Z', actions: ACTIONS[id.split('.')[0]],
});

/** The house as the relay reports it: three rooms, five things, relay connected */
export function seed() {
  table.clear();
  relay.sent = [];
  relay.mode = 'answer';
  relay.error = null;
  relay.automations = null;
  people.members = [{ sub: LUKE, name: 'Luke' }, { sub: KID, name: 'kid@x.test' }];
  people.admins = [{ sub: LUKE, name: 'Luke' }];
  table.put({ pk: 'AREA', sk: 'kitchen', name: 'Kitchen' });
  table.put({ pk: 'AREA', sk: 'master_bedroom', name: 'Master Bedroom' });
  table.put({ pk: 'AREA', sk: 'dining_room', name: 'Dining Room' });
  table.put(entity('light.kitchen_main', 'kitchen', 'on', { brightness: 153 }));
  table.put(entity('light.kitchen_island_pendants', 'kitchen'));
  table.put(entity('light.master_bedroom_main', 'master_bedroom'));
  table.put(entity('light.dining_room_main', 'dining_room', 'off'));
  table.put(entity('switch.lutron_smart_away', null, 'off'));
  table.put({ pk: 'RELAY', sk: 'CONN', connectionId: 'c1', lastSync: new Date().toISOString() });
}

/** Audit rows, oldest first */
export const audit = () => table.dump().filter(([k]) => k.startsWith('CMD#')).map(([, v]) => v);

/** A family group, as dot-y.co/family stores it (platform/family) */
export const familyGroup = (id, name, members) => table.put({ pk: 'GROUP', sk: id, name, members, rev: 1 });
