#!/usr/bin/env node
// One-off (2026-10-16): we want 2,700–3,200 sqft at $450k–$700k. Rejects listings outside those
// ranges (inSearch: an unknown price or size is kept), the same rule the email ingest now
// applies. Rejected, not deleted: hidden on the page,
// undoable there, and a later alert about the house won't bring it back. A row someone saved since it
// was read is skipped. Dry run unless --apply.
//   AWS_PROFILE=ldoty node tools/house-hunt/scripts/reject-out-of-range.mjs [--apply]
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { inSearch } from '../api/listing.mjs';

const TABLE = 'family-house-hunt';
const APPLY = process.argv.includes('--apply');
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));

const { Items } = await db.send(new QueryCommand({
  TableName: TABLE, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)', ExpressionAttributeValues: { ':pk': 'TOOL', ':p': 'LISTING#' },
}));
const gone = Items.filter((row) => !row.rejected && !inSearch(row.price, row.sqft));
for (const row of gone) {
  console.log(`${row.address} | $${row.price ?? "?"} | ${row.sqft ?? "?"} sqft | ${row.hoodId || 'unsorted'}${row.rejected ? ' | rejected' : ''}${row.notes ? ' | has notes' : ''}`);
  if (!APPLY) continue;
  try {
    await db.send(new PutCommand({
      TableName: TABLE, Item: { ...row, rejected: true, reviewed: true, rev: row.rev + 1,
        updatedAt: new Date().toISOString(), updatedBy: 'script', updatedByName: 'Size and price cleanup' },
      ConditionExpression: 'rev = :rev', ExpressionAttributeValues: { ':rev': row.rev },
    }));
  } catch (e) {
    if (e.name !== 'ConditionalCheckFailedException') throw e;
    console.log('  skipped: changed meanwhile, run again');
  }
}
console.log(`\n${gone.length} of ${Items.length} listings out of range.${APPLY ? '' : ' Dry run; --apply to reject them.'}`);
