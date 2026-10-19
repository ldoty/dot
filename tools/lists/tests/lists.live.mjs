// Read-only checks against the deployed Lists: `npm run test:live`
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.AWS_PROFILE ??= 'ldoty';
process.env.AWS_REGION ??= 'us-east-1';
const SITE = 'https://lists.dot-y.co';
const config = await (await fetch(`${SITE}/config.json`)).json();

test('every API route refuses requests without a token', async () => {
  for (const [method, path] of [['GET', '/lists'], ['POST', '/lists'], ['GET', '/lists/abcdef'], ['DELETE', '/lists/abcdef'], ['PUT', '/lists/abcdef/items/abcdef'], ['GET', '/prefs'], ['GET', '/reminders/recent'], ['GET', '/share-options'], ['GET', '/dot']]) {
    assert.equal((await fetch(config.apiUrl + path, { method })).status, 401, `${method} ${path}`);
  }
});

test('the API Lambda checks tokens itself; the sweep runs', async () => {
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  const lambda = new LambdaClient({});
  const invoke = async (FunctionName, event) => {
    const out = await lambda.send(new InvokeCommand({ FunctionName, Payload: Buffer.from(JSON.stringify(event)) }));
    assert.equal(out.FunctionError, undefined, Buffer.from(out.Payload).toString());
    return JSON.parse(Buffer.from(out.Payload).toString() || 'null');
  };
  assert.equal((await invoke('family-lists-api', { routeKey: 'GET /lists', headers: {} })).statusCode, 401);
  assert.ok(Array.isArray(await invoke('family-lists-sweep', {})), 'a sweep sends only what is due, so running it here is safe');
});

test('Dot can find Lists; the page installs on a phone', async () => {
  const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
  const p = await new SSMClient({}).send(new GetParameterCommand({ Name: '/family/delegation/family_lists' }));
  assert.equal(JSON.parse(p.Parameter.Value).api_url, config.apiUrl);
  const m = await fetch(`${SITE}/manifest.webmanifest`);
  assert.equal(m.status, 200);
  assert.equal((await m.json()).display, 'standalone');
});
