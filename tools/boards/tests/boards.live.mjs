// Read-only checks against the deployed Two Boards: `npm run test:live`
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.AWS_PROFILE ??= 'ldoty';
process.env.AWS_REGION ??= 'us-east-1';
const SITE = 'https://boards.dot-y.co';
const config = await (await fetch(`${SITE}/config.json`)).json();

test('every API route refuses requests without a token', async () => {
  for (const [method, path] of [['GET', '/guide'], ['GET', '/progress'], ['PUT', '/progress']]) {
    assert.equal((await fetch(config.apiUrl + path, { method })).status, 401, `${method} ${path}`);
  }
});

test('the public page does not contain the guide', async () => {
  const html = await (await fetch(`${SITE}/`)).text();
  assert.match(html, /window\.startGuide/);
  assert.doesNotMatch(html, /"people":|"bio":|data:image\/jpeg/);
});

test('the deployed Lambda loads its guide and does its own token check', async () => {
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  const out = await new LambdaClient({}).send(new InvokeCommand({
    FunctionName: 'family-boards-api',
    Payload: Buffer.from(JSON.stringify({ routeKey: 'GET /guide', headers: {} })),
  }));
  assert.equal(out.FunctionError, undefined, Buffer.from(out.Payload).toString());
  assert.equal(JSON.parse(Buffer.from(out.Payload).toString()).statusCode, 401);
});
