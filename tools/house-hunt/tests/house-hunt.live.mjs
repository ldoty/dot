// Read-only checks against the deployed House Hunt: `npm run test:live`
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.AWS_PROFILE ??= 'ldoty';
process.env.AWS_REGION ??= 'us-east-1';
const SITE = 'https://house-hunt.dot-y.co';
const config = await (await fetch(`${SITE}/config.json`)).json();

test('every API route refuses requests without a token', async () => {
  for (const [method, path] of [['GET', '/all'], ['PUT', '/hoods/x1'], ['DELETE', '/hoods/x1'], ['PUT', '/notes'], ['PUT', '/listings/x1'], ['DELETE', '/listings/x1']]) {
    assert.equal((await fetch(config.apiUrl + path, { method })).status, 401, `${method} ${path}`);
  }
});

test('the deployed Lambda loads and does its own token check', async () => {
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  const out = await new LambdaClient({}).send(new InvokeCommand({
    FunctionName: 'family-house-hunt-api',
    Payload: Buffer.from(JSON.stringify({ routeKey: 'GET /all', headers: {} })),
  }));
  assert.equal(out.FunctionError, undefined, Buffer.from(out.Payload).toString());
  assert.equal(JSON.parse(Buffer.from(out.Payload).toString()).statusCode, 401);
});

test('househunt@dot-y.co is routed to the ingest Lambda, which loads', async () => {
  const { execFileSync } = await import('node:child_process');
  const rules = JSON.parse(execFileSync('aws', ['ses', 'describe-active-receipt-rule-set', '--output', 'json'], { env: process.env }).toString());
  const rule = rules.Rules.find((r) => r.Name === 'house-hunt-listings');
  assert.deepEqual(rule.Recipients, ['househunt@dot-y.co']);
  assert.ok(rule.Enabled && rule.ScanEnabled);
  assert.match(rule.Actions.map((a) => a.LambdaAction?.FunctionArn).join(), /family-house-hunt-ingest/);
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  const out = await new LambdaClient({}).send(new InvokeCommand({ FunctionName: 'family-house-hunt-ingest', Payload: Buffer.from('{"Records":[]}') }));
  assert.equal(out.FunctionError, undefined, Buffer.from(out.Payload).toString());
});
