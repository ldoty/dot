// The real links handler on an in-memory table, called the way API Gateway calls it, with the family's
// groups on the same table (as platform/family stores them).
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ISSUER, accessToken } from '../../../../platform/tests/helpers/tokens.mjs';
import { fakeTable } from '../../../../platform/tests/helpers/fake-table.mjs';
import { caller } from '../../../../platform/tests/helpers/http.mjs';
import { makePeople } from '../../api/people.mjs';

export const CLIENT_ID = 'links-client';
export const LUKE = '44f8c468-4011-70b8-76aa-ec2b68b0b004';
export const AMBER = '74c8b418-e0b1-7075-7ae5-ca791980dd07';
export const KID = '11111111-1111-1111-1111-111111111111';
Object.assign(process.env, { TABLE: 'family-links', GROUP: 'family_links', ISSUER, CLIENT_ID, PEOPLE_TABLE: 'family-people' });
export const table = fakeTable({ pageSize: 2 }); // everything must follow pages
const { createApi } = await import('../../api/api.mjs');
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
const handler = createApi({
  db, table: 'family-links', group: 'family_links', issuer: ISSUER, clientId: CLIENT_ID,
  people: makePeople({ db, table: 'family-people', ttlMs: 0 }),
  members: async () => [{ sub: LUKE, name: 'Luke' }, { sub: AMBER, name: 'amber@x.test' }, { sub: KID, name: 'Kid' }],
});
export const ROUTES = ['GET /all', 'PUT /sections/{id}', 'DELETE /sections/{id}', 'PUT /links/{id}', 'DELETE /links/{id}', 'GET /share-options'];
export const memberToken = (sub = LUKE) => accessToken({ clientId: CLIENT_ID, group: 'family_links', sub, username: sub });
const callApi = caller(handler, ROUTES);
export const call = (method, path, body, token = memberToken()) => callApi(method, path, body, token);
/** A family group, as dot-y.co/family stores it */
export const familyGroup = (id, name, members) => table.put({ pk: 'GROUP', sk: id, name, members, rev: 1 });
