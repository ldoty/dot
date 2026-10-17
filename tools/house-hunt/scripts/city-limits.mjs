#!/usr/bin/env node
// Fills in cityLimits ('in' / 'out' Greer's city limits, by the Census map; geocode.mjs) on listings
// that don't have it: ones from before 2026-10-16, and ones added by hand (the email ingest looks
// up its own). A row someone saved since it was read is skipped. Safe to re-run. Dry run unless --apply.
//   AWS_PROFILE=ldoty node tools/house-hunt/scripts/city-limits.mjs [--apply]
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { locate } from '../api/geocode.mjs';

const TABLE = 'family-house-hunt';
const APPLY = process.argv.includes('--apply');
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));

const { Items } = await db.send(new QueryCommand({
  TableName: TABLE, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)', ExpressionAttributeValues: { ':pk': 'TOOL', ':p': 'LISTING#' },
}));
const todo = Items.filter((row) => !row.cityLimits);
const count = { in: 0, out: 0, '': 0 };
for (const row of todo) {
  const limits = await locate(row.address, row.city, { log: () => {} });
  count[limits]++;
  console.log(`${row.address} | ${limits || 'unknown'}${row.rejected ? ' | rejected' : ''}`);
  if (!APPLY || !limits) continue;
  try {
    await db.send(new PutCommand({
      TableName: TABLE, Item: { ...row, cityLimits: limits, rev: row.rev + 1 },
      ConditionExpression: 'rev = :rev', ExpressionAttributeValues: { ':rev': row.rev },
    }));
  } catch (e) {
    if (e.name !== 'ConditionalCheckFailedException') throw e;
    console.log('  skipped: changed meanwhile, run again');
  }
}
console.log(`\n${todo.length} to check: ${count.in} in, ${count.out} out, ${count['']} unknown.${APPLY ? '' : ' Dry run; --apply to save.'}`);
