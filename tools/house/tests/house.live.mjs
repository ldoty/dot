// Read-only checks against the deployed House: `npm run test:live`
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.AWS_PROFILE ??= 'ldoty';
process.env.AWS_REGION ??= 'us-east-1';
const SITE = 'https://house.dot-y.co';
const config = await (await fetch(`${SITE}/config.json`)).json();

test('every API route refuses requests without a token', async () => {
  for (const [method, path] of [['GET', '/home'], ['GET', '/dot'], ['POST', '/commands'], ['GET', '/access'], ['GET', '/log'], ['PUT', '/grants/x1abcd'], ['DELETE', '/grants/x1abcd']]) {
    assert.equal((await fetch(config.apiUrl + path, { method })).status, 401, `${method} ${path}`);
  }
});

test('the deployed Lambdas load and do their own checks', async () => {
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  const lambda = new LambdaClient({});
  const invoke = async (FunctionName, event) => {
    const out = await lambda.send(new InvokeCommand({ FunctionName, Payload: Buffer.from(JSON.stringify(event)) }));
    assert.equal(out.FunctionError, undefined, Buffer.from(out.Payload).toString());
    return JSON.parse(Buffer.from(out.Payload).toString());
  };
  assert.equal((await invoke('family-house-api', { routeKey: 'GET /home', headers: {} })).statusCode, 401);
  // A relay without the key is refused before anything is stored
  assert.equal((await invoke('family-house-relay', { requestContext: { routeKey: '$connect', connectionId: 'live-test' }, headers: {} })).statusCode, 401);
});

test('Dot can find House', async () => {
  const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
  const p = await new SSMClient({}).send(new GetParameterCommand({ Name: '/family/delegation/family_house' }));
  const { api_url: apiUrl, client_id: clientId } = JSON.parse(p.Parameter.Value);
  assert.equal(apiUrl, config.apiUrl);
  assert.ok(clientId && clientId !== config.clientId, 'its own delegated client');
});
