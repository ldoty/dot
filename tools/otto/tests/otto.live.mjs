// Read-only checks against the deployed Otto: `npm run test:live`
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.AWS_PROFILE ??= 'ldoty';
process.env.AWS_REGION ??= 'us-east-1';
const SITE = 'https://otto.dot-y.co';
const config = await (await fetch(`${SITE}/config.json`)).json();

test('every person route refuses requests without a token', async () => {
  for (const [method, path] of [['GET', '/dot'], ['GET', '/commands'], ['POST', '/commands'], ['POST', '/commands/c0/approve'], ['GET', '/schedules'], ['POST', '/schedules']]) {
    assert.equal((await fetch(config.apiUrl + path, { method })).status, 401, `${method} ${path}`);
  }
});

test('the agent routes refuse a missing or wrong key', async () => {
  for (const path of ['/agent/next', '/agent/send', '/agent/commands/c0000000000000000']) {
    assert.equal((await fetch(config.apiUrl + path, { method: 'POST' })).status, 401, path);
    assert.equal((await fetch(config.apiUrl + path, { method: 'POST', headers: { 'x-otto-key': 'wrong' } })).status, 401, path);
  }
});

test('the deployed Lambdas load', async () => {
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  const lambda = new LambdaClient({});
  const out = await lambda.send(new InvokeCommand({ FunctionName: 'family-otto-api', Payload: Buffer.from(JSON.stringify({ routeKey: 'GET /dot', headers: {} })) }));
  assert.equal(out.FunctionError, undefined, Buffer.from(out.Payload).toString());
  assert.equal(JSON.parse(Buffer.from(out.Payload).toString()).statusCode, 401);
});

test('Dot and Claude Code can find Otto', async () => {
  const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
  const p = await new SSMClient({}).send(new GetParameterCommand({ Name: '/family/delegation/lukes_otto' }));
  const { api_url: apiUrl, client_id: clientId } = JSON.parse(p.Parameter.Value);
  assert.equal(apiUrl, config.apiUrl);
  assert.ok(clientId && clientId !== config.clientId, 'its own delegated client');
});
