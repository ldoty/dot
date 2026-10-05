#!/usr/bin/env node
// End-to-end check of Dot with real Claude (Bedrock), real Google Calendar and real delegated
// Budget reads, built exactly as the deployed Lambda builds it (liveDeps, with the Lambda's own
// environment). The conversation store and audit log are in memory, so nothing is written to the
// lukes-assistant table.
//   AWS_PROFILE=ldoty node tools/assistant/scripts/e2e-check.mjs [--as luke|amber] ["question"]
// Read-only by default: the default question only lists events.
import { LambdaClient, GetFunctionConfigurationCommand } from '@aws-sdk/client-lambda';
import { BetaFallbackState } from '@anthropic-ai/sdk';
import { fakeTable } from '../../../platform/tests/helpers/fake-table.mjs';
import { liveDeps } from '../api/handler.mjs';
import { runTurn } from '../api/agent.mjs';

const args = process.argv.slice(2);
const asIdx = args.indexOf('--as');
const as = asIdx >= 0 ? args.splice(asIdx, 2)[1] : 'luke';
const question = args[0] || 'What’s on my calendars on Monday? Just a short summary.';
const region = process.env.AWS_REGION || 'us-east-1';

const { Environment } = await new LambdaClient({ region }).send(new GetFunctionConfigurationCommand({ FunctionName: 'lukes-assistant-api' }));
const env = { ...Environment.Variables, AWS_REGION: region };
const people = JSON.parse(env.PEOPLE);
const sub = Object.keys(people).find((k) => people[k].name.toLowerCase() === as.toLowerCase());
if (!sub) throw new Error(`--as must be one of: ${Object.values(people).map((p) => p.name).join(', ')}`);

const table = fakeTable(); // the store and audit log below write to memory only
const deps = liveDeps(env);
const { tools, person } = await deps.forUser({ sub, username: sub }, 'e2e-check');
const ran = [];
const r = await runTurn({
  ...deps, person, fallbackState: new BetaFallbackState(),
  tools: { ...tools, run: (b) => { ran.push(`${b.name}(${JSON.stringify(b.input)})`); return tools.run(b); } },
  log: (e) => console.log('usage:', JSON.stringify(e.usage), 'model:', e.model, 'stop:', e.stop_reason),
  userId: sub, text: question,
});
console.log(`\nas ${person.name}; tools available: ${tools.definitions.map((d) => d.name).join(', ')}`);
console.log('tools run:\n  ' + (ran.join('\n  ') || '(none)'));
console.log('audit:', JSON.stringify(table.dump().filter(([k]) => k.startsWith('AUDIT')).map(([, v]) => [v.tool, v.outcome])));
console.log('\nreply:\n' + r.text);
