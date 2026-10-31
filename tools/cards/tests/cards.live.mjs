// Read-only checks against the deployed Cards: `npm run test:live`
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.AWS_PROFILE ??= 'ldoty';
process.env.AWS_REGION ??= 'us-east-1';
const SITE = 'https://cards.dot-y.co';
const config = await (await fetch(`${SITE}/config.json`)).json();

test('every API route refuses requests without a token', async () => {
  for (const [method, path] of [['GET', '/decks'], ['POST', '/decks'], ['GET', '/study'], ['GET', '/dot'], ['DELETE', '/decks/abcdef123456']]) {
    assert.equal((await fetch(config.apiUrl + path, { method })).status, 401, `${method} ${path}`);
  }
});

test('the deployed Lambda loads and does its own token check', async () => {
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  const out = await new LambdaClient({}).send(new InvokeCommand({
    FunctionName: 'family-cards-api',
    Payload: Buffer.from(JSON.stringify({ routeKey: 'GET /decks', headers: {} })),
  }));
  assert.equal(out.FunctionError, undefined, Buffer.from(out.Payload).toString());
  assert.equal(JSON.parse(Buffer.from(out.Payload).toString()).statusCode, 401);
});

test('Dot and Claude Code can find Cards', async () => {
  const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
  const p = await new SSMClient({}).send(new GetParameterCommand({ Name: '/family/delegation/lukes_cards' }));
  const { api_url: apiUrl, client_id: clientId } = JSON.parse(p.Parameter.Value);
  assert.equal(apiUrl, config.apiUrl);
  assert.ok(clientId && clientId !== config.clientId, 'its own delegated client');
});
