// Read-only checks against the deployed Calendars: `npm run test:live`
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.AWS_PROFILE ??= 'ldoty';
process.env.AWS_REGION ??= 'us-east-1';
const SITE = 'https://calendars.dot-y.co';
const config = await (await fetch(`${SITE}/config.json`)).json();

test('every API route refuses requests without a token', async () => {
  for (const [method, path] of [['GET', '/calendars'], ['GET', '/events'], ['GET', '/agenda'], ['POST', '/events'], ['DELETE', '/events/kids/x'], ['GET', '/admin'], ['PUT', '/grants/abcdef']]) {
    assert.equal((await fetch(config.apiUrl + path, { method })).status, 401, `${method} ${path}`);
  }
});

test('the Lambda checks tokens itself; only Calendars may read the Google key', async () => {
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  const out = await new LambdaClient({}).send(new InvokeCommand({ FunctionName: 'family-calendars-api', Payload: Buffer.from(JSON.stringify({ routeKey: 'GET /calendars', headers: {} })) }));
  assert.equal(out.FunctionError, undefined);
  assert.equal(JSON.parse(Buffer.from(out.Payload).toString()).statusCode, 401);
  // Asked of IAM through the CLI (no IAM SDK client in this repo)
  const { execFileSync } = await import('node:child_process');
  const aws = (...a) => execFileSync('aws', [...a, '--profile', process.env.AWS_PROFILE, '--output', 'text']).toString().trim();
  const key = 'arn:aws:ssm:us-east-1:921782276410:parameter/family/calendar/google-key';
  for (const [role, expected] of [['family-calendars-api', 'allowed'], ['lukes-assistant-api', 'implicitDeny']]) {
    const arn = aws('iam', 'get-role', '--role-name', role, '--query', 'Role.Arn');
    assert.equal(aws('iam', 'simulate-principal-policy', '--policy-source-arn', arn, '--action-names', 'ssm:GetParameter', '--resource-arns', key, '--query', 'EvaluationResults[0].EvalDecision'), expected, role);
  }
});
