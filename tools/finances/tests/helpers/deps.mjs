// The tool's dependencies, with an in-memory table and fakes for SSM, Budget, SimpleFIN and Claude
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ISSUER } from '../../../../platform/tests/helpers/tokens.mjs';
import { makeStore } from '../../api/store.mjs';
import { fakeNet, fakeClaude, ACCESS_URL } from './fixtures.mjs';

/** What API Gateway routes to the handler (infra/api.tf; api.test.mjs checks they match) */
export const ROUTES = ['GET /month/{month}', 'PUT /transactions/{id}', 'PUT /accounts/{id}', 'PUT /settings', 'POST /sync', 'GET /export/{month}', 'GET /dot', 'GET /shared/{from}'];
export const LUKE = { sub: 'luke-sub', username: 'luke-sub' };

export function testDeps({ secret = ACCESS_URL, net = fakeNet(), client = fakeClaude(), now = Date.parse('2026-10-04T18:00:00Z'), tokenFor } = {}) {
  const secrets = { value: secret, puts: [] };
  const borrowed = [], syncs = [];
  const deps = {
    auth: { issuer: ISSUER, clientId: ['fin-client', 'fin-dot'], group: 'luke_finances' },
    dotClientId: 'fin-dot',
    store: makeStore({ db: DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' })), table: 'family-luke-finances' }),
    secret: { get: async () => secrets.value, put: async (v) => { secrets.puts.push(v); secrets.value = v; } },
    tokenFor: tokenFor || (async (who) => { borrowed.push(who); return 'budget-token'; }),
    budgetApp: { api_url: 'https://budget.api', client_id: 'budget-dot' },
    person: 'Luke',
    owner: LUKE,
    client,
    model: 'test-model',
    timeZone: 'America/New_York',
    now: () => now,
    fetch: net.fetch,
    startSync: async () => { syncs.push(now); },
  };
  return { deps, secrets, borrowed, syncs, net, client };
}
