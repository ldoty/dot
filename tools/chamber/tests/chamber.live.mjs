// Read-only checks against the deployed Chamber: `npm run test:live`
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.AWS_PROFILE ??= 'ldoty';
process.env.AWS_REGION ??= 'us-east-1';
const SITE = 'https://chamber.dot-y.co';
const config = await (await fetch(`${SITE}/config.json`)).json();
const { ROUTES } = await import('../api/api.mjs');

test('every page API route refuses requests without a token', async () => {
  for (const route of ROUTES) {
    const [method, path] = route.split(' ');
    assert.equal((await fetch(config.apiUrl + path, { method })).status, 401, route);
  }
});

test('the board’s endpoint refuses a missing or wrong device key', async () => {
  const body = 'chamber rh_pct=50';
  assert.equal((await fetch(`${config.apiUrl}/ingest`, { method: 'POST', body })).status, 401);
  const wrong = await fetch(`${config.apiUrl}/ingest`, { method: 'POST', body, headers: { 'x-chamber-key': 'not-the-key' } });
  assert.equal(wrong.status, 401);
});

test('the deployed Lambdas load; the API does its own token check, ingest its own key check', async () => {
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  const lambda = new LambdaClient({});
  for (const [FunctionName, event] of [
    ['family-chamber-api', { routeKey: 'GET /settings', headers: {} }],
    ['family-chamber-ingest', { routeKey: 'POST /ingest', headers: {}, body: 'chamber rh_pct=50' }],
  ]) {
    const out = await lambda.send(new InvokeCommand({ FunctionName, Payload: Buffer.from(JSON.stringify(event)) }));
    const payload = Buffer.from(out.Payload).toString();
    assert.equal(out.FunctionError, undefined, payload);
    assert.equal(JSON.parse(payload).statusCode, 401, FunctionName);
  }
});
