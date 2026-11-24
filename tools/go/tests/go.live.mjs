// Read-only checks against the deployed Go: `npm run test:live`
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.AWS_PROFILE ??= 'ldoty';
process.env.AWS_REGION ??= 'us-east-1';
const SITE = 'https://go.dot-y.co';
const config = await (await fetch(`${SITE}/config.json`)).json();

test('every API route refuses requests without a token', async () => {
  for (const [method, path] of [['GET', '/summary'], ['GET', '/study?kind=fix'], ['POST', '/drills/fix/x1/review'], ['GET', '/today'], ['POST', '/plan']]) {
    assert.equal((await fetch(config.apiUrl + path, { method })).status, 401, `${method} ${path}`);
  }
});

test('the deployed Lambda loads and does its own token check', async () => {
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  const out = await new LambdaClient({}).send(new InvokeCommand({
    FunctionName: 'family-go-api',
    Payload: Buffer.from(JSON.stringify({ routeKey: 'GET /summary', headers: {} })),
  }));
  assert.equal(out.FunctionError, undefined, Buffer.from(out.Payload).toString());
  assert.equal(JSON.parse(Buffer.from(out.Payload).toString()).statusCode, 401);
});

test('the site serves the page and the shared rules', async () => {
  for (const f of ['index.html', 'rules.js']) assert.equal((await fetch(`${SITE}/${f}`)).status, 200, f);
});
