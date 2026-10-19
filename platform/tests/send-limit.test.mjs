import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { fakeTable } from './helpers/fake-table.mjs';
import { makeSendLimit, PER_DAY } from '../api/send-limit.mjs';

const table = fakeTable();
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
let clock = new Date('2026-10-19T16:00:00Z');
const take = makeSendLimit({ db, table: 'dot-y-sends', timeZone: 'America/New_York', now: () => clock });
beforeEach(() => { table.clear(); clock = new Date('2026-10-19T16:00:00Z'); });

test(`at most ${PER_DAY} a person a day, counted before anything is sent`, async () => {
  for (let i = 1; i <= PER_DAY; i++) assert.deepEqual(await take('luke'), { ok: true, n: i });
  assert.deepEqual(await take('luke'), { ok: false, n: PER_DAY });
  assert.deepEqual(await take('amber'), { ok: true, n: 1 }, 'each person their own');
});

test('a day is the family’s: it starts at midnight in New York, not UTC', async () => {
  for (let i = 0; i < PER_DAY; i++) await take('luke');
  clock = new Date('2026-10-20T02:00:00Z'); // 10 PM the same evening in New York
  assert.equal((await take('luke')).ok, false);
  clock = new Date('2026-10-20T04:01:00Z'); // just past midnight there
  assert.deepEqual(await take('luke'), { ok: true, n: 1 });
  assert.deepEqual(table.get('SENDS#luke', '2026-10-20').n, 1);
});

test('two at once: both are counted, never one lost', async () => {
  const results = await Promise.all(Array.from({ length: 4 }, () => take('luke')));
  assert.ok(results.every((r) => r.ok));
  assert.equal(table.get('SENDS#luke', '2026-10-19').n, 4);
});
