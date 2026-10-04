// Pre Token Generation (V2) trigger on the shared family pool.
// Each app client registers its access rule at SSM /family/apps/<clientId>:
//   {"app": "recipes", "group": "recipes"}  -> only members of group "recipes"
//   {"app": "home", "group": "*", "portal": true} -> any family member
// Unregistered clients get no tokens (fail closed). Tokens only carry the
// caller app's own groups, so one app never learns memberships in another.
// The exception is the portal (the dot-y.co home page), which sees every group
// so it can show each person the tools they have access to. A tool's delegated client
// ({"delegated": true}) is how Dot acts for someone: same group rule, tokens marked via=dot.
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const ssm = new SSMClient({});
const cache = new Map();
const TTL_MS = 5 * 60 * 1000;

async function ruleFor(clientId) {
  const hit = cache.get(clientId);
  if (hit && hit.expires > Date.now()) return hit.rule;
  let rule = null;
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: `/family/apps/${clientId}` }));
    rule = JSON.parse(res.Parameter.Value);
  } catch (e) {
    if (e.name !== 'ParameterNotFound') throw e;
  }
  cache.set(clientId, { rule, expires: Date.now() + TTL_MS });
  return rule;
}

export const handler = async (event) => {
  const rule = await ruleFor(event.callerContext.clientId);
  if (!rule) throw new Error('This app is not registered.');

  const groups = event.request.groupConfiguration?.groupsToOverride ?? [];
  if (rule.group !== '*' && !groups.includes(rule.group)) {
    throw new Error(`You don't have access to ${rule.app}. Ask an admin to add you.`);
  }

  const own = rule.portal ? groups : groups.filter((g) => g === rule.app || g.startsWith(`${rule.app}:`));
  // Tokens Dot gets on someone's behalf (a tool's delegated client) say so; tools make them read-only
  const via = rule.delegated ? { via: 'dot' } : {};
  event.response = {
    claimsAndScopeOverrideDetails: {
      groupOverrideDetails: { groupsToOverride: own },
      accessTokenGeneration: { claimsToAddOrOverride: { app: rule.app, ...via } },
      idTokenGeneration: { claimsToAddOrOverride: { app: rule.app } },
    },
  };
  return event;
};
