// Read-only checks against the deployed Gym: `npm run test:live`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.AWS_PROFILE ??= 'ldoty';
process.env.AWS_REGION ??= 'us-east-1';
const SITE = 'https://gym.dot-y.co';
const config = await (await fetch(`${SITE}/config.json`)).json();
const tf = readFileSync(new URL('../infra/api.tf', import.meta.url), 'utf8');
const ROUTES = JSON.parse(tf.match(/routes\s*=\s*(\[[^\]]*\])/)[1]);

test('every API route refuses requests without a token', async () => {
  for (const route of ROUTES) {
    const [method, path] = route.split(' ');
    const url = config.apiUrl + path.replace('{id}', 'x1').replace('{date}', '2026-01-01');
    assert.equal((await fetch(url, { method })).status, 401, route);
  }
});

test('the deployed Lambda loads and does its own token check', async () => {
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  const out = await new LambdaClient({}).send(new InvokeCommand({
    FunctionName: 'family-gym-api',
    Payload: Buffer.from(JSON.stringify({ routeKey: 'GET /all', headers: {} })),
  }));
  assert.equal(out.FunctionError, undefined, Buffer.from(out.Payload).toString());
  assert.equal(JSON.parse(Buffer.from(out.Payload).toString()).statusCode, 401);
});

test('Dot can find Gym: its API and delegated client are published', async () => {
  const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
  const p = await new SSMClient({}).send(new GetParameterCommand({ Name: '/family/delegation/family_gym' }));
  const v = JSON.parse(p.Parameter.Value);
  assert.equal(v.api_url, config.apiUrl);
  assert.ok(v.client_id && v.client_id !== config.clientId, 'a delegated client of its own, not the page’s');
});
