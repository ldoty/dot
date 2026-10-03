#!/usr/bin/env node
// End-to-end check of the assistant with real Claude (Bedrock) and real Google Calendar, but an
// in-memory conversation store, so nothing is written to the lukes-assistant table.
//   AWS_PROFILE=ldoty node tools/assistant/scripts/e2e-check.mjs ["question"]
// Read-only by default: the question asks about the schedule, which only lists events.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { BetaFallbackState } from '@anthropic-ai/sdk';
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { fakeTable } from '../../../platform/tests/helpers/fake-table.mjs';
import { makeStore } from '../api/store.mjs';
import { makeGoogleAuth } from '../api/google.mjs';
import { makeCalendar } from '../api/calendar.mjs';
import { makeTools } from '../api/tools.mjs';
import { runTurn } from '../api/agent.mjs';

const question = process.argv[2] || 'What’s on my calendars on Monday? Just a short summary.';
const region = process.env.AWS_REGION || 'us-east-1';
const calendars = { luke: 'luke.doty@gmail.com', shared: '19ktvn2rmaupk99h546rtjhh54@group.calendar.google.com', amber: '3ab76dc152f67dbcf8121a6f9cbf4000269ae2080de4ab6d85611d4973b44f4b@group.calendar.google.com' };
const ssm = new SSMClient({ region });
const calendar = makeCalendar({
  calendars, timeZone: 'America/New_York',
  accessToken: makeGoogleAuth({ loadKey: async () => JSON.parse((await ssm.send(new GetParameterCommand({ Name: '/family/calendar/google-key', WithDecryption: true }))).Parameter.Value) }),
});
fakeTable(); // the store below writes to memory only
const store = makeStore({ db: DynamoDBDocumentClient.from(new DynamoDBClient({ region })), table: 'in-memory' });
const tools = makeTools({ calendar, calendarNames: Object.keys(calendars) });
const ran = [];
const r = await runTurn({
  client: new AnthropicBedrock({ awsRegion: region }),
  store, tools: { ...tools, run: (b) => { ran.push(`${b.name}(${JSON.stringify(b.input)})`); return tools.run(b); } },
  model: 'us.anthropic.claude-opus-4-6-v1', timeZone: 'America/New_York', fallbackState: new BetaFallbackState(),
  log: (e) => console.log('usage:', JSON.stringify(e.usage), 'model:', e.model, 'stop:', e.stop_reason),
  userId: 'e2e-check', text: question,
});
console.log('\ntools run:\n  ' + (ran.join('\n  ') || '(none)'));
console.log('\nreply:\n' + r.text);
