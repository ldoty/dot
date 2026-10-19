// The Lists API and reminder sweep on the fake table, with the family's groups on the same table
// (as platform/family stores them) and fake senders that record what would have gone out.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ISSUER, accessToken } from '../../../../platform/tests/helpers/tokens.mjs';
import { fakeTable } from '../../../../platform/tests/helpers/fake-table.mjs';
import { caller } from '../../../../platform/tests/helpers/http.mjs';
import { makePeople } from '../../api/people.mjs';

export const table = fakeTable({ pageSize: 2 }); // everything must follow pages
const { createApi } = await import('../../api/api.mjs');
const { createSweep } = await import('../../api/sweep.mjs');

export const LUKE = '44f8c468-4011-70b8-76aa-ec2b68b0b004';
export const AMBER = '74c8b418-e0b1-7075-7ae5-ca791980dd07';
export const KID = '11111111-1111-1111-1111-111111111111';
export const ROUTES = [
  'GET /lists', 'POST /lists', 'GET /lists/{id}', 'PUT /lists/{id}', 'DELETE /lists/{id}',
  'PUT /lists/{id}/items/{itemId}', 'DELETE /lists/{id}/items/{itemId}',
  'GET /prefs', 'PUT /prefs', 'GET /reminders/recent', 'GET /automations', 'GET /share-options', 'GET /dot',
];

export const clock = { now: new Date('2026-10-19T14:00:00Z') };
export const handler = createApi({
  table: 'family-lists', group: 'family_lists', issuer: ISSUER,
  clientIds: ['lists-client', 'lists-via-dot'], dotClientId: 'lists-via-dot',
  people: makePeople({ db: DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' })), table: 'family-people', ttlMs: 0 }),
  members: async () => [{ sub: LUKE, name: 'Luke' }, { sub: AMBER, name: 'amber@x.test' }, { sub: KID, name: 'Kid' }],
  now: () => clock.now, timeZone: 'America/New_York',
});

export const outbox = { texts: [], emails: [], fail: null };
export const contacts = {
  [LUKE]: { phone: '+18645550100', email: 'luke@x.test' },
  [AMBER]: { phone: null, email: 'amber@x.test' },
  [KID]: { phone: null, email: null },
};
export const sweep = createSweep({
  table: 'family-lists', now: () => clock.now, contact: async (sub) => contacts[sub] ?? { phone: null, email: null },
  sendText: async (phone, body) => { if (outbox.fail) throw new Error(outbox.fail); outbox.texts.push({ phone, body }); },
  sendEmail: async (m) => { if (outbox.fail) throw new Error(outbox.fail); outbox.emails.push(m); },
});

export const token = (sub = LUKE, over = {}) => accessToken({ clientId: 'lists-client', sub, 'cognito:groups': ['family_lists'], ...over });
export const dotToken = (sub = LUKE) => token(sub, { clientId: 'lists-via-dot', via: 'dot' });
const callApi = caller(handler, ROUTES);
export const call = (m, p, b, t = token()) => callApi(m, p, b, t);

export function reset() {
  table.clear();
  outbox.texts = []; outbox.emails = []; outbox.fail = null;
  clock.now = new Date('2026-10-19T14:00:00Z');
}
/** A family group, as dot-y.co/family stores it */
export const familyGroup = (id, name, members) => table.put({ pk: 'GROUP', sk: id, name, members, rev: 1 });
/** A new list owned by `sub`; returns it */
export const newList = async (name = 'Errands', sub = LUKE, extra = {}) => (await call('POST', '/lists', { name, ...extra }, token(sub))).body;
