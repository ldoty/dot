// Read-only checks against the deployed SDC/SCE Finances: `npm run test:live`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

process.env.AWS_PROFILE ??= 'ldoty';
process.env.AWS_REGION ??= 'us-east-1';
const SITE = 'https://sdc-sce-finances.dot-y.co';
const config = await (await fetch(`${SITE}/config.json`)).json();

test('every API route refuses requests without a token', async () => {
  for (const [method, path] of [['GET', '/month/2026-10'], ['PUT', '/transactions/x'], ['PUT', '/accounts/x'], ['PUT', '/settings'], ['POST', '/sync'], ['GET', '/export/all'], ['GET', '/shared/2026-01-01']]) {
    assert.equal((await fetch(config.apiUrl + path, { method })).status, 401, `${method} ${path}`);
  }
});

test('the deployed Lambda loads, does its own token check, and follows the SDC/SCE Budget', async () => {
  const { LambdaClient, InvokeCommand, GetFunctionConfigurationCommand } = await import('@aws-sdk/client-lambda');
  const lambda = new LambdaClient({});
  const out = await lambda.send(new InvokeCommand({
    FunctionName: 'family-sdc-sce-finances-api',
    Payload: Buffer.from(JSON.stringify({ routeKey: 'GET /month/{month}', pathParameters: { month: '2026-10' }, headers: {} })),
  }));
  assert.equal(out.FunctionError, undefined, Buffer.from(out.Payload).toString());
  assert.equal(JSON.parse(Buffer.from(out.Payload).toString()).statusCode, 401);
  const env = (await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: 'family-sdc-sce-finances-api' }))).Environment.Variables;
  const budget = JSON.parse((await new SSMClient({}).send(new GetParameterCommand({ Name: '/family/delegation/sdc_sce_budget' }))).Parameter.Value);
  assert.deepEqual(JSON.parse(env.BUDGET), budget);
  assert.equal(env.PERSON, 'Business');
  assert.equal(env.JOINT, 'false');
  assert.equal(env.DOT_CLIENT_ID, '-', 'no delegated client');
});

test('nothing else can find it to read it as a person', async () => {
  await assert.rejects(new SSMClient({}).send(new GetParameterCommand({ Name: '/family/delegation/sdc_sce_finances' })), { name: 'ParameterNotFound' });
});

test('the page is told it’s a personal view without joint accounts', async () => {
  assert.equal(config.mode, 'personal');
  assert.equal(config.joint, false);
  assert.equal(config.title, 'SDC/SCE Finances');
});
