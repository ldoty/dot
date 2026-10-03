// Real store (on the fake table), fake Claude, and a fake calendar behind the real tools module
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { fakeTable } from '../../../../platform/tests/helpers/fake-table.mjs';
import { makeStore } from '../../api/store.mjs';
import { makeTools } from '../../api/tools.mjs';
import { fakeClaude } from './fake-claude.mjs';

export const table = fakeTable();
export const store = makeStore({ db: DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' })), table: 'lukes-assistant' });
export const NOW = new Date('2026-10-02T20:45:00Z'); // Fri Oct 2, 4:45 PM EDT

export function fakeCalendar() {
  const calls = [];
  const rec = (name, result) => async (input) => { calls.push({ name, input }); return typeof result === 'function' ? result(input) : result; };
  return {
    calls,
    listCalendars: rec('listCalendars', [{ calendar: 'luke', name: 'Luke Doty' }, { calendar: 'shared', name: 'Family' }]),
    listEvents: rec('listEvents', []),
    createEvent: rec('createEvent', (i) => ({ id: 'ev1', title: i.title, start: i.start, created_by_assistant: true })),
    updateEvent: rec('updateEvent', (i) => ({ id: i.event_id })),
    deleteEvent: rec('deleteEvent', (i) => ({ deleted: i.event_id })),
  };
}

export function deps(script, calendar = fakeCalendar()) {
  const claude = fakeClaude(script);
  return {
    claude, calendar,
    deps: {
      client: claude.client, store, model: 'anthropic.claude-opus-5-5', timeZone: 'America/New_York',
      tools: makeTools({ calendar, calendarNames: ['luke', 'shared'] }), now: () => NOW,
    },
  };
}
