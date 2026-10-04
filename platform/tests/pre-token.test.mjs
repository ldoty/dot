import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const ssm = mockClient(SSMClient);
const rules = {
  '/family/apps/home-client': { app: 'home', group: '*', portal: true },
  '/family/apps/budget-client': { app: 'family_budget', group: 'family_budget' },
  '/family/apps/budget-dot': { app: 'family_budget', group: 'family_budget', delegated: true },
};
beforeEach(() => {
  ssm.reset();
  ssm.on(GetParameterCommand).callsFake(({ Name }) => {
    if (!rules[Name]) throw Object.assign(new Error('not found'), { name: 'ParameterNotFound' });
    return { Parameter: { Value: JSON.stringify(rules[Name]) } };
  });
});
const { handler } = await import('../core/lambda/pre-token.mjs');
const event = (clientId, groups) => ({ callerContext: { clientId }, request: { groupConfiguration: { groupsToOverride: groups } }, response: {} });
const groupsOut = (e) => e.response.claimsAndScopeOverrideDetails.groupOverrideDetails.groupsToOverride;

test('unregistered clients get no token (fail closed)', async () => {
  await assert.rejects(handler(event('mystery-client', ['family_budget'])), /not registered/);
});

test('members get a token carrying only that tool’s groups', async () => {
  const e = await handler(event('budget-client', ['family_budget', 'family_budget:admin', 'recipes']));
  assert.deepEqual(groupsOut(e), ['family_budget', 'family_budget:admin']);
  assert.equal(e.response.claimsAndScopeOverrideDetails.accessTokenGeneration.claimsToAddOrOverride.app, 'family_budget');
});

test('non-members are refused', async () => {
  await assert.rejects(handler(event('budget-client', ['recipes'])), /don't have access/);
});

test('the portal (home page) sees every group, to pick which tiles to show', async () => {
  const e = await handler(event('home-client', ['family_budget', 'recipes']));
  assert.deepEqual(groupsOut(e), ['family_budget', 'recipes']);
});

test('Dot’s delegated tokens need the same group, and are marked via=dot', async () => {
  await assert.rejects(handler(event('budget-dot', ['recipes'])), /don't have access/);
  const e = await handler(event('budget-dot', ['family_budget']));
  assert.equal(e.response.claimsAndScopeOverrideDetails.accessTokenGeneration.claimsToAddOrOverride.via, 'dot');
  const normal = await handler(event('budget-client', ['family_budget']));
  assert.equal(normal.response.claimsAndScopeOverrideDetails.accessTokenGeneration.claimsToAddOrOverride.via, undefined);
});
