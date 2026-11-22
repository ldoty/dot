// Read-only checks against the deployed SDC/SCE Budget: `npm run test:live` (uses AWS profile ldoty).
// Run after every deploy. Nothing here writes to AWS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

process.env.AWS_PROFILE ??= 'ldoty';
process.env.AWS_REGION ??= 'us-east-1';
const SITE = 'https://sdc-sce-budget.dot-y.co';
const config = await (await fetch(`${SITE}/config.json`)).json();
const ssm = new SSMClient({});

test('every API route refuses requests without a token', async () => {
  const routes = [['GET', '/all'], ['PUT', '/docs/Business/state'], ['PUT', '/docs/Business/versions/x1'],
    ['DELETE', '/docs/Business/versions/x1'], ['PUT', '/docs/Business/tags/x'], ['DELETE', '/docs/Business/tags/x']];
  for (const [method, path] of routes) {
    const res = await fetch(config.apiUrl + path, { method });
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

test('CORS allows only the budget site', async () => {
  const pre = (origin) => fetch(`${config.apiUrl}/all`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' } });
  assert.equal((await pre(SITE)).headers.get('access-control-allow-origin'), SITE);
  assert.equal((await pre('https://evil.example')).headers.get('access-control-allow-origin'), null);
});

test('only SDC/SCE Finances may read it as a person: not Dot, not Claude Code', async () => {
  const { api_url, client_id } = JSON.parse((await ssm.send(new GetParameterCommand({ Name: '/family/delegation/sdc_sce_budget' }))).Parameter.Value);
  assert.equal(api_url, config.apiUrl);
  const rule = JSON.parse((await ssm.send(new GetParameterCommand({ Name: `/family/apps/${client_id}` }))).Parameter.Value);
  assert.deepEqual(rule, { app: 'sdc_sce_budget', group: 'sdc_sce_budget', delegated: true, delegates: ['sdc_sce_finances'] });
});
