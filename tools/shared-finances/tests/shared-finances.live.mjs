// Read-only checks against the deployed Shared Finances: `npm run test:live`
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.AWS_PROFILE ??= 'ldoty';
process.env.AWS_REGION ??= 'us-east-1';
const SITE = 'https://shared-finances.dot-y.co';
const config = await (await fetch(`${SITE}/config.json`)).json();

test('every API route refuses requests without a token', async () => {
  for (const [method, path] of [['GET', '/month/2026-10'], ['PUT', '/transactions/x'], ['PUT', '/accounts/x'], ['PUT', '/settings'], ['POST', '/sync'], ['GET', '/export/all']]) {
    assert.equal((await fetch(config.apiUrl + path, { method })).status, 401, `${method} ${path}`);
  }
});

test('the deployed Lambda loads and does its own token check', async () => {
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  const out = await new LambdaClient({}).send(new InvokeCommand({
    FunctionName: 'family-shared-finances-api',
    Payload: Buffer.from(JSON.stringify({ routeKey: 'GET /month/{month}', pathParameters: { month: '2026-10' }, headers: {} })),
  }));
  assert.equal(out.FunctionError, undefined, Buffer.from(out.Payload).toString());
  assert.equal(JSON.parse(Buffer.from(out.Payload).toString()).statusCode, 401);
});

test('the nightly sync is scheduled and its last run is recorded', async () => {
  const { SchedulerClient, GetScheduleCommand } = await import('@aws-sdk/client-scheduler').catch(() => ({}));
  if (SchedulerClient) {
    const s = await new SchedulerClient({}).send(new GetScheduleCommand({ Name: 'family-shared-finances-sync' }));
    assert.equal(s.State, 'ENABLED');
  }
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, GetCommand } = await import('@aws-sdk/lib-dynamodb');
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const sync = (await db.send(new GetCommand({ TableName: 'family-shared-finances', Key: { pk: 'SHARED', sk: 'SYNC' } }))).Item;
  assert.ok(sync, 'no sync has run yet');
  assert.ok(Date.now() - Date.parse(sync.at || sync.startedAt) < 36 * 3600e3, `last sync ${sync.at}`);
  if (!sync.ok || sync.errors?.length) console.log('last sync:', sync.message, sync.errors);
});

test('the page is told it’s the household view', async () => {
  assert.equal(config.mode, 'shared');
  assert.equal(config.title, 'Shared Finances');
});
