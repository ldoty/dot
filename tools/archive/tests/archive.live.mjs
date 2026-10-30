// Read-only checks against the deployed Archive: `npm run test:live`
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.AWS_PROFILE ??= 'ldoty';
process.env.AWS_REGION ??= 'us-east-1';
const SITE = 'https://archive.dot-y.co';
const config = await (await fetch(`${SITE}/config.json`)).json();

test('/mcp refuses requests without a token, and says where to sign in', async () => {
  const r = await fetch(`${config.apiUrl}/mcp`, { method: 'POST', body: '{}' });
  assert.equal(r.status, 401);
  const meta = await (await fetch(`${config.apiUrl}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.deepEqual(meta.authorization_servers, [config.apiUrl]);
  const as = await (await fetch(`${config.apiUrl}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.equal(meta.resource, `${config.apiUrl}/mcp`);
});

test('the deployed Lambda loads and does its own token check', async () => {
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  const out = await new LambdaClient({}).send(new InvokeCommand({
    FunctionName: 'family-archive-api',
    Payload: Buffer.from(JSON.stringify({ routeKey: 'POST /mcp', headers: {} })),
  }));
  assert.equal(out.FunctionError, undefined, Buffer.from(out.Payload).toString());
  assert.equal(JSON.parse(Buffer.from(out.Payload).toString()).statusCode, 401);
});
