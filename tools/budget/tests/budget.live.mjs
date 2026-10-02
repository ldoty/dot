// Read-only checks against the deployed budget: `npm run test:live` (uses AWS profile ldoty).
// Run after every deploy. Nothing here writes to AWS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

process.env.AWS_PROFILE ??= 'ldoty';
process.env.AWS_REGION ??= 'us-east-1';
const SITE = 'https://budget.dot-y.co';
const config = await (await fetch(`${SITE}/config.json`)).json();
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

test('every API route refuses requests without a token', async () => {
  const routes = [['GET', '/all'], ['GET', '/defaults'], ['PUT', '/docs/shared/state'], ['PUT', '/docs/Luke/versions/x1'],
    ['DELETE', '/docs/Amber/versions/x1'], ['PUT', '/tags/x'], ['DELETE', '/tags/x']];
  for (const [method, path] of routes) {
    const res = await fetch(config.apiUrl + path, { method });
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

test('CORS allows only the budget site', async () => {
  const pre = (origin) => fetch(`${config.apiUrl}/all`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' } });
  assert.equal((await pre(SITE)).headers.get('access-control-allow-origin'), SITE);
  assert.equal((await pre('https://evil.example')).headers.get('access-control-allow-origin'), null);
});

test('the public page contains none of the household’s line items', async () => {
  const page = await (await fetch(`${SITE}/`)).text();
  const { Item } = await db.send(new GetCommand({ TableName: 'family-budget', Key: { pk: 'HOUSEHOLD#luke-amber', sk: 'DEFAULTS' } }));
  const d = JSON.parse(Item.state);
  const lists = [...d.categories, ...Object.values(d.people).flatMap((p) => [{ items: p.income }, ...p.categories])];
  const names = lists.flatMap((c) => c.items.map((i) => i.name)).filter((n) => n && n.length > 4);
  assert.ok(names.length > 10, 'expected item names to check against');
  // Generic line-item names the page's own calculations recognize (they follow the home value)
  const LOGIC = ['Homeowners insurance', 'Property tax'];
  const leaked = names.filter((n) => !LOGIC.includes(n) && page.includes(n));
  assert.deepEqual(leaked, []);
});

test('the real handler code reads the live table (GET /all), read-only', async () => {
  const { ISSUER, accessToken } = await import('../../../platform/tests/helpers/tokens.mjs');
  Object.assign(process.env, { TABLE: 'family-budget', HOUSEHOLD: 'luke-amber', GROUP: 'family_budget', ISSUER, CLIENT_ID: 'live-check' });
  const { handler } = await import('../api/api.mjs');
  const res = await handler({ routeKey: 'GET /all', headers: { authorization: `Bearer ${accessToken({ clientId: 'live-check', group: 'family_budget' })}` } });
  assert.equal(res.statusCode, 200);
  const all = JSON.parse(res.body);
  assert.deepEqual(Object.keys(all.docs).sort(), ['Amber', 'Luke', 'shared']);
  assert.ok(all.tags.some((t) => t.name === 'default'), 'default tag exists');
  const def = all.tags.find((t) => t.name === 'default');
  assert.ok(all.versions.shared.some((v) => v.id === def.versionId), 'default points at a real version');
});

test('the deployed Lambda loads (its bundle is complete) and does its own token check', async () => {
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  const out = await new LambdaClient({}).send(new InvokeCommand({
    FunctionName: 'family-budget-api',
    Payload: Buffer.from(JSON.stringify({ routeKey: 'GET /all', headers: {} })),
  }));
  assert.equal(out.FunctionError, undefined, Buffer.from(out.Payload).toString());
  assert.equal(JSON.parse(Buffer.from(out.Payload).toString()).statusCode, 401);
});
